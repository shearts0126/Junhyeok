import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { parseSkuId } from '@/modules/sku/application';
import { withTransaction } from '@/shared/db';

import { translateBarcodeWriteError } from './constraint-errors';
import type { BarcodeMutateDependencies } from './create-barcode';
import { BARCODE_ENTITY_TYPE } from './create-barcode';
import {
  BARCODE_STATUS_PENDING_DUPLICATE,
  parseBarcodeId,
  type ApproveDuplicateInput,
} from './dto';
import {
  duplicateApprovalInvalidState,
  duplicateExceptionNotApplicable,
  lockActualDuplicates,
  lockBarcodeRow,
} from './duplicate-exception';
import { findOwnedBarcode } from './parent-sku';
import { BARCODE_APPROVE_DUPLICATE_PERMISSION } from './policy';
import { toSkuBarcodeView, type SkuBarcodeView } from './views';

/**
 * `POST /api/skus/{skuId}/barcodes/{barcodeId}/approve-duplicate` —
 * 중복 예외 **승인** (T04-4A).
 *
 * ⚠️ 근거: `docs/11_설계복구_Barcode중복예외승인.md` §13~§22.
 *
 * ## 대상
 *
 *     skuId = 경로 · status = PENDING_DUPLICATE ·
 *     duplicateException = false · approvedBy = null
 *
 * 소유권 불일치는 **404** 다 — 다른 SKU 의 후보 존재 여부를 노출하지 않는다.
 *
 * ## 승인 직전 재검증 (§15)
 *
 * 후보 생성 시 확인했더라도 승인 직전에 **다시** 확인한다. 그 사이 상대 바코드가
 * 비활성화됐다면 예외를 승인할 이유가 없으므로 422 이고, 후보는
 * `PENDING_DUPLICATE` 그대로 남는다.
 *
 * ## mutation (§16) — 정확히 4개 필드만
 *
 *     status  PENDING_DUPLICATE → ACTIVE
 *     duplicateException  false → true
 *     exceptionReason      null → trimmed reason
 *     approvedBy           null → actor.userId
 *
 * ⛔ `barcode`·`barcodeType`·`isPrimary`·`skuId`·국가/채널·적용기간은 건드리지 않는다.
 *
 * ## 재승인 (§18)
 *
 * 이미 `ACTIVE + duplicateException=true` 면 **200 no-op** 이다. 최초 승인자의
 * `approvedBy`·`exceptionReason` 을 후속 호출자가 덮어쓰지 않으며 AuditLog 도 늘지 않는다.
 * (마이그레이션으로 이관된 이미 승인된 행도 같은 경로로 no-op 이다.)
 *
 * ## 동시성 (§20·§21)
 *
 * 후보 행을 `SELECT … FOR UPDATE` 로 잠근 뒤 상태를 다시 읽는다. 두 승인자가
 * 동시에 호출해도 mutation·AuditLog 는 각각 1건이고, 두 번째는 잠금 해제 후
 * 재조회에서 "이미 승인됨"을 보고 200 no-op 이 된다.
 *
 * ⛔ 자가승인 금지 정책을 추가하지 않는다 (§12) — 바코드에는 근거가 없다.
 *    `SkuBarcode.createdBy`·`requestedBy`·`allowSelfApprovalBarcode` 를 만들지 않으며
 *    `allowSelfApprovalSku` 를 재사용하지도 않는다.
 */

export const BARCODE_APPROVE_DUPLICATE_ACTION = 'APPROVE_DUPLICATE';

export async function approveDuplicateBarcode(
  actor: ActorContext,
  rawSkuId: string,
  rawBarcodeId: string,
  input: ApproveDuplicateInput,
  dependencies: BarcodeMutateDependencies = {},
): Promise<SkuBarcodeView> {
  assertPermission(actor, BARCODE_APPROVE_DUPLICATE_PERMISSION);
  const skuId = parseSkuId(rawSkuId);
  const barcodeId = parseBarcodeId(rawBarcodeId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    // ★ 먼저 잠근다 — 잠금 해제 후 최신 상태를 읽어야 재승인 판정이 정확하다.
    await lockBarcodeRow(tx, barcodeId);

    const current = await findOwnedBarcode(tx, skuId, barcodeId);
    const before = toSkuBarcodeView(current);

    // §18 이미 승인된 행 — 아무 것도 바꾸지 않고 현재 행을 돌려준다.
    if (current.status === 'ACTIVE' && current.duplicateException) return before;

    // §19 그 밖의 비대상 상태 — 자동 상태수정 없이 거부한다.
    if (
      current.status !== BARCODE_STATUS_PENDING_DUPLICATE ||
      current.duplicateException ||
      current.approvedBy !== null
    ) {
      throw duplicateApprovalInvalidState(current);
    }

    // §15·§21 승인 직전 실제 중복 재검증 (상대 ACTIVE 행도 같은 트랜잭션에서 잠근다).
    const duplicates = await lockActualDuplicates(tx, { skuId, barcode: current.barcode });
    if (duplicates.length === 0) throw duplicateExceptionNotApplicable(current.barcode);

    let updated;
    try {
      updated = await tx.skuBarcode.update({
        where: { id: barcodeId },
        data: {
          status: 'ACTIVE',
          duplicateException: true,
          exceptionReason: input.reason,
          approvedBy: actor.userId,
        },
      });
    } catch (error) {
      // §17 대표 충돌 — 409 이고 트랜잭션 전체가 롤백되어 후보는 PENDING 그대로다.
      //     기존 대표를 자동 해제하지 않는다.
      translateBarcodeWriteError(error, { skuId, barcode: current.barcode });
    }

    const after = toSkuBarcodeView(updated);

    await logger.write(tx, {
      actor,
      entityType: BARCODE_ENTITY_TYPE,
      entityId: barcodeId,
      action: BARCODE_APPROVE_DUPLICATE_ACTION,
      beforeValue: before,
      afterValue: after,
      reason: input.reason,
      approvedBy: actor.userId,
    });

    return after;
  });
}
