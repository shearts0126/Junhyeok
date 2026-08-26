import type { PrismaClient } from '@/generated/prisma/client';
import type { TransactionClient } from '@/shared/db';
import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * 창고가 참조하는 대상의 존재 확인 (T08-2).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D13(supplier) · §W-D14(외부시스템).
 *
 * ★ **generic `NOT_FOUND` 를 재사용한다.** BOM 의 `productionPartnerNotFound()`
 *   와 같은 방식이며, ⛔ `WAREHOUSE_NOT_FOUND` 같은 전용 runtime code 를 만들지
 *   않는다. (`docs/06` 에 같은 이름이 있으나 그것은 **마이그레이션 DataIssue**
 *   코드이지 runtime API error contract 가 아니다.)
 *
 * ★ FK 위반(P2003)이 public API 로 새지 않도록 **쓰기 전에 미리 확인**한다.
 *   DB FK 는 최종 방어선으로 남지만, 사용자에게는 404 로 보인다.
 */

export type WarehouseReadClient = Pick<
  PrismaClient,
  'warehouse' | 'warehouseLocation' | 'supplier' | 'externalSystem'
>;
export type WarehouseDbClient = WarehouseReadClient | TransactionClient;

export function warehouseNotFound(id: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `창고 '${id}' 이(가) 없습니다.`,
    context: { warehouseId: id },
  });
}

export function supplierRefNotFound(id: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `거래처 '${id}' 이(가) 없습니다.`,
    context: { supplierId: id },
  });
}

export function externalSystemNotFound(id: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `외부시스템 '${id}' 이(가) 없습니다.`,
    context: { externalSystemId: id },
  });
}

export async function assertSupplierRefExists(
  db: WarehouseDbClient,
  supplierId: string,
): Promise<void> {
  const row = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (row === null) throw supplierRefNotFound(supplierId);
}

export async function assertExternalSystemExists(
  db: WarehouseDbClient,
  externalSystemId: string,
): Promise<void> {
  const row = await db.externalSystem.findUnique({
    where: { id: externalSystemId },
    select: { id: true },
  });
  if (row === null) throw externalSystemNotFound(externalSystemId);
}
