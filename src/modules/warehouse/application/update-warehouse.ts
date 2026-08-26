import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction } from '@/shared/db';
import { ValidationError } from '@/shared/errors';

import { translateWarehouseWriteError } from './constraint-errors';
import {
  WAREHOUSE_ENTITY_TYPE,
  assertSupplierRule,
  type WarehouseMutateDependencies,
} from './create-warehouse';
import { WAREHOUSE_PATCH_FIELDS, parseWarehouseId, type UpdateWarehouseInput } from './dto';
import { IN_TRANSIT_WAREHOUSE_CODE, WAREHOUSE_UPDATE_PERMISSION } from './policy';
import { assertExternalSystemExists, assertSupplierRefExists, warehouseNotFound } from './refs';
import { toWarehouseView, type WarehouseView } from './views';

/**
 * `PATCH /api/warehouses/{id}` — 창고 metadata 수정 (T08-2).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D25(immutable) · §W-D26(DTO) ·
 *    §W-D27(active 연기) · §W-D12(IN_TRANSIT).
 *
 * ⚠️ **2차 권한 가드.** `warehouse.update` 를 재검사한다. ADMIN bypass 없음.
 *
 * - partial DTO: `undefined` = 미변경 / `null` = 값 제거 / 값 = 변경.
 * - **no-op**: 변경이 하나도 없으면 **DB UPDATE 도 AuditLog 도 만들지 않고**
 *   현재 행을 200 으로 돌려준다 — `updatedAt` 이 바뀌지 않는다 (§W-D26).
 *
 * ⛔ `warehouseCode`·`warehouseType`(§W-D25 immutable) · **`active`**(§W-D27) ·
 *    `defaultLocationId` 는 DTO 가 400 처리한다 — 이 서비스에 도달하지 않는다.
 * ⛔ `active` lifecycle 과 "재고 존재 시 비활성 차단" 은 `T2-20` 이다.
 */

export async function updateWarehouse(
  actor: ActorContext,
  rawWarehouseId: string,
  patch: UpdateWarehouseInput,
  dependencies: WarehouseMutateDependencies = {},
): Promise<WarehouseView> {
  assertPermission(actor, WAREHOUSE_UPDATE_PERMISSION);
  const warehouseId = parseWarehouseId(rawWarehouseId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const current = await tx.warehouse.findUnique({ where: { id: warehouseId } });
    if (current === null) throw warehouseNotFound(warehouseId);

    // ★ 시스템 예약 창고는 일반 PATCH 대상이 아니다 (§W-D12).
    if (current.warehouseCode === IN_TRANSIT_WAREHOUSE_CODE) {
      throw new ValidationError(
        [
          {
            path: 'warehouseId',
            message: `'${IN_TRANSIT_WAREHOUSE_CODE}' 는 시스템 예약 창고라 수정할 수 없습니다.`,
          },
        ],
        { message: '창고 수정 요청이 올바르지 않습니다.' },
      );
    }

    const before = toWarehouseView(current);

    const data: Record<string, unknown> = {};
    for (const field of WAREHOUSE_PATCH_FIELDS) {
      const next = patch[field];
      if (next === undefined) continue;
      if (next !== current[field]) data[field] = next;
    }

    // ★ no-op — DB write 0 / AuditLog 0 / updatedAt 그대로 (§W-D26).
    if (Object.keys(data).length === 0) return before;

    // ★ supplier 규칙은 **적용 후 상태**로 판정한다. `warehouseType` 이
    //   immutable 이므로 결과적으로 `SUPPLIER_SITE` 창고에서만 non-null 이 된다.
    const nextSupplierId =
      'supplierId' in data ? ((data['supplierId'] as string | null) ?? null) : current.supplierId;
    assertSupplierRule({ warehouseType: current.warehouseType, supplierId: nextSupplierId });

    // ★ 참조 존재를 미리 확인한다 — raw FK 오류(P2003)가 새지 않게.
    if ('supplierId' in data && nextSupplierId !== null) {
      await assertSupplierRefExists(tx, nextSupplierId);
    }
    if ('externalSystemId' in data) {
      const nextExternalSystemId = (data['externalSystemId'] as string | null) ?? null;
      if (nextExternalSystemId !== null) {
        await assertExternalSystemExists(tx, nextExternalSystemId);
      }
    }

    let updated;
    try {
      updated = await tx.warehouse.update({ where: { id: warehouseId }, data });
    } catch (error) {
      translateWarehouseWriteError(error, current.warehouseCode);
    }

    const after = toWarehouseView(updated);

    // ★ 같은 트랜잭션 — 로그 실패 시 수정도 롤백된다.
    await logger.write(tx, {
      actor,
      entityType: WAREHOUSE_ENTITY_TYPE,
      entityId: warehouseId,
      action: 'UPDATE',
      beforeValue: before,
      afterValue: after,
    });

    return after;
  });
}
