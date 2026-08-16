import type { PrismaClient } from '@/generated/prisma/client';
import type { TransactionClient } from '@/shared/db';
import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * BOM read port (T07-2).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-13 · §D-22.
 *
 * `PrismaClient` 전체가 아니라 **BOM 이 실제로 읽는 델리게이트만** 노출한다
 * (T06 `SupplierReadClient` 와 같은 방식). 트랜잭션 클라이언트도 같은 타입으로
 * 받으므로 resolver·validator 가 `withTransaction` 안팎에서 같이 쓰인다.
 */
export type BomReadClient = Pick<PrismaClient, 'bomHeader' | 'bomLine' | 'sku' | 'supplier'>;
export type BomDbClient = BomReadClient | TransactionClient;

export function bomNotFound(id: string): DomainError {
  return new DomainError(ERROR_CODES.BOM_NOT_FOUND, {
    message: `BOM '${id}' 이(가) 없습니다.`,
    context: { bomHeaderId: id },
  });
}

/**
 * nested 라인의 **소속 불일치도 404** 다 (T07-3).
 *
 * `/api/boms/{bomId}/lines/{lineId}` 에서 `lineId` 가 존재하더라도 다른 BOM 의
 * 라인이면 이 경로에서는 **없는 것**이다. ⛔ 403 이나 "다른 BOM 에 있습니다"로
 * 응답해 타 BOM 의 존재를 드러내지 않는다 (T04-3·T06-3 nested 선례).
 */
export function bomLineNotFound(bomId: string, lineId: string): DomainError {
  return new DomainError(ERROR_CODES.BOM_NOT_FOUND, {
    message: `BOM '${bomId}' 에 라인 '${lineId}' 이(가) 없습니다.`,
    context: { bomHeaderId: bomId, bomLineId: lineId },
  });
}

/**
 * where-used·생성 시 참조하는 SKU 가 없을 때 — **404**.
 *
 * ★ `/api/skus/{id}/supplier-skus`(T1-6B4)와 같은 판단이다 — 없는 SKU 의
 *   하위 컬렉션은 빈 배열이 아니라 404 다 (source precedence ⑦ existing
 *   implementation precedent). docs/18 에 명시가 없어 선례를 따랐다.
 */
export function skuRefNotFound(skuId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `SKU '${skuId}' 이(가) 없습니다.`,
    context: { skuId },
  });
}

export function productionPartnerNotFound(supplierId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `조립처 거래처 '${supplierId}' 이(가) 없습니다.`,
    context: { supplierId },
  });
}

export interface BomSkuRef {
  readonly id: string;
  readonly status: string;
  readonly baseUom: string;
}

/**
 * BOM 이 참조하는 SKU 를 읽는다. **soft-delete 된 SKU 는 없는 것**이다.
 *
 * ⚠️ `deletedAt IS NULL` 은 T06-2 `assertSkuUsable` 과 같은 판단이며 status
 *    제약과 별개다 — status eligibility(D-12)는 도메인 validator 가 본다.
 */
export async function loadBomSkuRef(db: BomDbClient, skuId: string): Promise<BomSkuRef> {
  const row = await db.sku.findFirst({
    where: { id: skuId, deletedAt: null },
    select: { id: true, status: true, baseUom: true },
  });
  if (row === null) throw skuRefNotFound(skuId);
  return row;
}

/**
 * 조립처는 **실제 FK** 다 — staged Warehouse UUID 와 다르게 존재를 검증한다
 * (D-2 "`Supplier` 가 이미 존재하므로 FK 로 연결한다").
 */
export async function assertProductionPartnerExists(
  db: BomDbClient,
  supplierId: string,
): Promise<void> {
  const row = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (row === null) throw productionPartnerNotFound(supplierId);
}
