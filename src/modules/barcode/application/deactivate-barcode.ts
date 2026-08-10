import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { parseSkuId } from '@/modules/sku/application';
import { withTransaction } from '@/shared/db';

import type { BarcodeMutateDependencies } from './create-barcode';
import { BARCODE_ENTITY_TYPE } from './create-barcode';
import { parseBarcodeId } from './dto';
import { assertParentSkuExists, findOwnedBarcode } from './parent-sku';
import { BARCODE_DEACTIVATE_PERMISSION } from './policy';
import { toSkuBarcodeView, type SkuBarcodeView } from './views';

/**
 * `DELETE /api/skus/{id}/barcodes/{bid}` — **비활성** (T04-3).
 *
 * ⚠️ 근거: `docs/10_설계복구_BarcodeCRUD.md` §23·§24·§25.
 *
 * ⚠️ **2차 권한 가드.** `barcode.deactivate` 를 재검사한다. ADMIN bypass 없음.
 *
 * ⛔ **물리삭제하지 않는다** — `status = 'INACTIVE'` 만 수행한다 (05 §10.4,
 *    PRD §33.2, 02 §478 ④). 행은 그대로 남는다.
 *
 * ## 반복 호출은 idempotent
 *
 * 이미 `INACTIVE` 면 **DB UPDATE 도 AuditLog 도 없이** 현재 행을 200 으로 낸다.
 * 409·422 를 내지 않는다.
 *
 * ## 대표 바코드
 *
 * `isPrimary=true` 인 활성 대표도 비활성할 수 있다. 결과는
 * `isPrimary=true` + `status='INACTIVE'` 이며 **`isPrimary` 를 자동으로 내리지
 * 않는다** — 과거에 대표였다는 이력으로 남는다. `ux_barcode_primary` 는
 * `status='ACTIVE'` 조건이라 충돌하지 않는다.
 *
 * ⛔ 다른 바코드를 자동으로 대표 승격하지 않는다. 활성 대표가 0개인 SKU 상태를
 *    허용한다 — DB 는 "최대 1개"를 강제할 뿐 "정확히 1개"를 강제하지 않는다.
 *
 * ## 중복 예외 후보 취소 (T04-4A, docs/11 §24)
 *
 * `status='PENDING_DUPLICATE'` 인 승인 대기 후보도 이 경로로 `INACTIVE` 가 된다 —
 * 그것이 **후보 취소**다. 별도 취소 endpoint 를 만들지 않으며 감사 action 도
 * 기존 `DEACTIVATE` 를 그대로 쓴다. 취소 후 승인을 시도하면 422
 * `BARCODE_DUPLICATE_APPROVAL_INVALID_STATE` 다.
 */

export async function deactivateSkuBarcode(
  actor: ActorContext,
  rawSkuId: string,
  rawBarcodeId: string,
  dependencies: BarcodeMutateDependencies = {},
): Promise<SkuBarcodeView> {
  assertPermission(actor, BARCODE_DEACTIVATE_PERMISSION);
  const skuId = parseSkuId(rawSkuId);
  const barcodeId = parseBarcodeId(rawBarcodeId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger: AuditLogger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    await assertParentSkuExists(tx, skuId);
    const current = await findOwnedBarcode(tx, skuId, barcodeId);
    const before = toSkuBarcodeView(current);

    // ★ 이미 비활성 — 반복 호출은 성공이며 아무 것도 쓰지 않는다.
    if (current.status === 'INACTIVE') return before;

    const updated = await tx.skuBarcode.update({
      where: { id: barcodeId },
      // ⚠️ isPrimary 를 건드리지 않는다.
      data: { status: 'INACTIVE' },
    });
    const after = toSkuBarcodeView(updated);

    await logger.write(tx, {
      actor,
      entityType: BARCODE_ENTITY_TYPE,
      entityId: barcodeId,
      action: 'DEACTIVATE',
      beforeValue: before,
      afterValue: after,
    });

    return after;
  });
}
