import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { parseSkuId } from '@/modules/sku/application';
import { withTransaction } from '@/shared/db';

import { translateBarcodeWriteError } from './constraint-errors';
import type { BarcodeMutateDependencies } from './create-barcode';
import { BARCODE_ENTITY_TYPE } from './create-barcode';
import { parseBarcodeId, type UpdateBarcodeInput } from './dto';
import { assertParentSkuExists, findOwnedBarcode } from './parent-sku';
import { BARCODE_UPDATE_PERMISSION } from './policy';
import { toSkuBarcodeView, type SkuBarcodeView } from './views';

/**
 * `PATCH /api/skus/{id}/barcodes/{bid}` — 바코드 수정 (T04-3).
 *
 * ⚠️ 근거: `docs/10_설계복구_BarcodeCRUD.md` §7·§8·§10·§19·§21·§22.
 *
 * ⚠️ **2차 권한 가드.** `barcode.update` 를 재검사한다. ADMIN bypass 없음.
 *
 * ## V1 수정 가능 필드는 `isPrimary` · `status` 뿐이다
 *
 * ⛔ `barcode` 값은 **생성 후 불변**이다 — 잘못 등록했으면 비활성 후 새로 추가한다.
 *    (DTO 가 이미 400 으로 막는다. 여기서 다시 열지 않는다.)
 * ⛔ `barcodeType`·`countryCode`·`channelCode`·적용기간·T04-4 필드도 대상이 아니다.
 *
 * ## 대표 지정에 숨은 side effect 가 없다
 *
 * `isPrimary=true` 로 바꿀 때 기존 활성 대표를 **자동으로 내리지 않는다.**
 * `ux_barcode_primary` 가 409 `BARCODE_PRIMARY_CONFLICT` 를 만들고, 사용자가
 * 기존 대표를 명시적으로 `isPrimary=false` 로 바꾼 뒤 다시 지정해야 한다.
 *
 * ## 재활성
 *
 * `INACTIVE → ACTIVE` 는 허용된다. 그 순간 조건부 UNIQUE 2종이 다시 적용되므로
 * 그 사이 다른 SKU 가 같은 값을 쓰고 있었다면 409 `BARCODE_DUPLICATE`,
 * 이미 활성 대표가 있으면 409 `BARCODE_PRIMARY_CONFLICT` 다. **자동 해결 없음.**
 *
 * ## 변화 없음
 *
 * 요청 결과가 현재 값과 완전히 같으면 **DB UPDATE 도 AuditLog 도 만들지 않고**
 * 현재 행을 200 으로 돌려준다. `SkuBarcode` 에는 `updatedAt` 조차 없으므로
 * 무의미한 write 를 남길 이유가 없다.
 */

export async function updateSkuBarcode(
  actor: ActorContext,
  rawSkuId: string,
  rawBarcodeId: string,
  patch: UpdateBarcodeInput,
  dependencies: BarcodeMutateDependencies = {},
): Promise<SkuBarcodeView> {
  assertPermission(actor, BARCODE_UPDATE_PERMISSION);
  const skuId = parseSkuId(rawSkuId);
  const barcodeId = parseBarcodeId(rawBarcodeId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    await assertParentSkuExists(tx, skuId);
    // ★ 소유권까지 확인 — 다른 SKU 의 바코드는 존재해도 404 다.
    const current = await findOwnedBarcode(tx, skuId, barcodeId);
    const before = toSkuBarcodeView(current);

    const nextIsPrimary = patch.isPrimary ?? current.isPrimary;
    const nextStatus = patch.status ?? current.status;

    // ★ no-op — write 도 감사로그도 만들지 않는다.
    if (nextIsPrimary === current.isPrimary && nextStatus === current.status) return before;

    let updated;
    try {
      updated = await tx.skuBarcode.update({
        where: { id: barcodeId },
        data: { isPrimary: nextIsPrimary, status: nextStatus },
      });
    } catch (error) {
      translateBarcodeWriteError(error, { skuId, barcode: current.barcode });
    }

    const after = toSkuBarcodeView(updated);

    await logger.write(tx, {
      actor,
      entityType: BARCODE_ENTITY_TYPE,
      entityId: barcodeId,
      action: 'UPDATE',
      beforeValue: before,
      afterValue: after,
    });

    return after;
  });
}
