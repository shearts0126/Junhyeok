import type { PrismaClient } from '@/generated/prisma/client';
import type { TransactionClient } from '@/shared/db';
import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * 거래처·공급조건 참조 조회 (T06-2).
 *
 * eligibility 는 정확히 셋뿐이다 (D-19):
 *   ① parent Supplier 존재  ② SKU 존재  ③ SKU `deletedAt IS NULL`
 * ⛔ `Supplier.status`·`Sku.status`·`purchasable`·`itemType` 제약을 발명하지
 *    않는다 — authoritative 근거가 없다 (docs/13 §5 와 동일한 판단).
 */

export type SupplierReadClient = Pick<PrismaClient, 'supplier' | 'supplierSku' | 'sku'>;
export type SupplierDbClient = SupplierReadClient | TransactionClient;

export function supplierNotFound(id: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `거래처 '${id}' 이(가) 없습니다.`,
    context: { supplierId: id },
  });
}

export function supplierSkuNotFound(id: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `공급조건 '${id}' 이(가) 없습니다.`,
    context: { supplierSkuId: id },
  });
}

export function skuRefNotFound(id: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `SKU '${id}' 이(가) 없습니다.`,
    context: { skuId: id },
  });
}

export async function assertSupplierExists(
  db: SupplierDbClient,
  supplierId: string,
): Promise<void> {
  const row = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (row === null) throw supplierNotFound(supplierId);
}

export async function assertSkuUsable(db: SupplierDbClient, skuId: string): Promise<void> {
  // soft-delete 된 SKU 는 참조 대상이 아니다 — 존재하지 않는 것으로 다룬다(404).
  const row = await db.sku.findFirst({
    where: { id: skuId, deletedAt: null },
    select: { id: true },
  });
  if (row === null) throw skuRefNotFound(skuId);
}
