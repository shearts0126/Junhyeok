import type { PrismaClient } from '@/generated/prisma/client';
import type { TransactionClient } from '@/shared/db';
import { DomainError, ERROR_CODES } from '@/shared/errors';

import { EXTERNAL_MAPPING_VIEW_INCLUDE, type ExternalMappingRow } from './views';

/**
 * 참조 대상 확인 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §5.
 *
 * - SKU: 존재 + `deletedAt IS NULL` 아니면 404 — 기존 SKU 404 convention 과 동일.
 *   ⛔ SKU status(`DRAFT`/`PENDING_APPROVAL`/`ACTIVE`/`INACTIVE` …) 기반 제한을
 *      **발명하지 않는다** — authoritative 근거가 없다.
 * - ExternalSystem: 존재하지 않으면 404.
 *   ⛔ `active = false` 라는 이유로 생성·수정을 차단하지 **않는다** — active
 *      lifecycle 의 사용 규칙이 문서에 없고 ExternalSystem 관리 API 도 없다.
 *      lifecycle 은 별도 Task 에서 확정한다.
 */

export type MappingRefClient = Pick<PrismaClient, 'sku' | 'externalSystem'> | TransactionClient;
export type MappingRowClient = Pick<PrismaClient, 'skuExternalMapping'> | TransactionClient;

export function skuNotFound(skuId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `SKU '${skuId}' 이(가) 없습니다.`,
    context: { skuId },
  });
}

export function externalSystemNotFound(externalSystemId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `외부시스템 '${externalSystemId}' 이(가) 없습니다.`,
    context: { externalSystemId },
  });
}

export function mappingNotFound(mappingId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `외부 매핑 '${mappingId}' 이(가) 없습니다.`,
    context: { mappingId },
  });
}

export async function assertSkuExists(db: MappingRefClient, skuId: string): Promise<void> {
  const row = await db.sku.findFirst({
    where: { id: skuId, deletedAt: null },
    select: { id: true },
  });
  if (row === null) throw skuNotFound(skuId);
}

export async function assertExternalSystemExists(
  db: MappingRefClient,
  externalSystemId: string,
): Promise<void> {
  const row = await db.externalSystem.findUnique({
    where: { id: externalSystemId },
    select: { id: true },
  });
  if (row === null) throw externalSystemNotFound(externalSystemId);
}

/** 수정 대상 매핑을 projection 까지 포함해 읽는다. 없으면 404. */
export async function findMapping(
  db: MappingRowClient,
  mappingId: string,
): Promise<ExternalMappingRow> {
  const row = await db.skuExternalMapping.findUnique({
    where: { id: mappingId },
    include: EXTERNAL_MAPPING_VIEW_INCLUDE,
  });
  if (row === null) throw mappingNotFound(mappingId);
  return row;
}
