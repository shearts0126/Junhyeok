import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction } from '@/shared/db';

import { translateSupplierWriteError } from './constraint-errors';
import { SUPPLIER_ENTITY_TYPE, type SupplierMutateDependencies } from './create-supplier';
import { parseSupplierId, type UpdateSupplierInput } from './dto';
import { SUPPLIER_UPDATE_PERMISSION } from './policy';
import { supplierNotFound } from './refs';
import { toSupplierView, type SupplierView } from './views';

/**
 * `PATCH /api/suppliers/{id}` — 거래처 수정 (T06-2, D-8).
 *
 * ⚠️ **2차 권한 가드.** `supplier.update` 를 재검사한다. ADMIN bypass 없음.
 *
 * - partial DTO: `undefined` = 미변경 / `null` = 값 제거 / 값 = 변경.
 * - 변경이 전혀 없으면 **DB UPDATE 도 AuditLog 도 만들지 않고** 현재 행을
 *   200 으로 돌려준다 (매핑·SKU convention 과 동일).
 * ⛔ `supplierCode`(D-7 immutable)·`status`(D-6)·`defaultWarehouseId`(D-9)는
 *    DTO 가 400 처리한다 — 이 서비스에 도달하지 않는다.
 */

const PATCHABLE = [
  'supplierName',
  'supplierType',
  'businessRegistrationNo',
  'contactName',
  'contactPhone',
  'contactEmail',
  'defaultLeadTimeDays',
  'note',
] as const;

export async function updateSupplier(
  actor: ActorContext,
  rawSupplierId: string,
  patch: UpdateSupplierInput,
  dependencies: SupplierMutateDependencies = {},
): Promise<SupplierView> {
  assertPermission(actor, SUPPLIER_UPDATE_PERMISSION);
  const supplierId = parseSupplierId(rawSupplierId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const current = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (current === null) throw supplierNotFound(supplierId);

    const before = toSupplierView(current);

    const data: Record<string, unknown> = {};
    for (const field of PATCHABLE) {
      const next = patch[field];
      if (next === undefined) continue;
      if (next !== current[field]) data[field] = next;
    }

    // ★ no-op — DB write 0 / AuditLog 0 / updatedAt 그대로.
    if (Object.keys(data).length === 0) return before;

    let updated;
    try {
      updated = await tx.supplier.update({ where: { id: supplierId }, data });
    } catch (error) {
      translateSupplierWriteError(error, current.supplierCode);
    }

    const after = toSupplierView(updated);

    // ★ 같은 트랜잭션 — 로그 실패 시 수정도 롤백된다.
    await logger.write(tx, {
      actor,
      entityType: SUPPLIER_ENTITY_TYPE,
      entityId: supplierId,
      action: 'UPDATE',
      beforeValue: before,
      afterValue: after,
    });

    return after;
  });
}
