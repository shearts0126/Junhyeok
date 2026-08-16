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
export type BomReadClient = Pick<PrismaClient, 'bomHeader' | 'bomLine' | 'sku'>;
export type BomDbClient = BomReadClient | TransactionClient;

export function bomNotFound(id: string): DomainError {
  return new DomainError(ERROR_CODES.BOM_NOT_FOUND, {
    message: `BOM '${id}' 이(가) 없습니다.`,
    context: { bomHeaderId: id },
  });
}
