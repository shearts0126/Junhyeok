import type { PrismaClient, SkuBarcode } from '@/generated/prisma/client';
import type { TransactionClient } from '@/shared/db';
import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * 부모 SKU · 바코드 소유권 확인 (T04-3).
 *
 * ⚠️ 근거: `docs/10_설계복구_BarcodeCRUD.md` §9·§10.
 *
 * - 경로의 `{skuId}` 가 **유일한 부모 출처**다. body 로 `skuId` 를 받지 않는다.
 * - 부모 SKU 가 없거나 soft-delete 면 404 (기존 SKU 404 convention 과 동일).
 * - ⛔ SKU status(`DRAFT`/`ACTIVE`/`ARCHIVED` …) 기반 제한을 **발명하지 않는다** —
 *   authoritative 근거가 없다. `hasTransaction` 도 `skuCode` 변경 규칙이지
 *   바코드 CRUD 규칙이 아니다.
 */

export type BarcodeParentClient = Pick<PrismaClient, 'sku'> | TransactionClient;
export type BarcodeRowClient = Pick<PrismaClient, 'skuBarcode'> | TransactionClient;

export function skuNotFound(skuId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `SKU '${skuId}' 이(가) 없습니다.`,
    context: { skuId },
  });
}

/**
 * 바코드가 없거나 **다른 SKU 의 것**일 때의 404.
 *
 * ⚠️ 두 경우를 구분하지 않는다 — 다른 SKU 의 바코드 존재 여부를 노출하지 않는다.
 */
export function barcodeNotFound(skuId: string, barcodeId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `SKU '${skuId}' 의 바코드 '${barcodeId}' 이(가) 없습니다.`,
    context: { skuId, barcodeId },
  });
}

/** 부모 SKU 존재를 확인한다. 없으면 404. */
export async function assertParentSkuExists(db: BarcodeParentClient, skuId: string): Promise<void> {
  const row = await db.sku.findFirst({
    where: { id: skuId, deletedAt: null },
    select: { id: true },
  });
  if (row === null) throw skuNotFound(skuId);
}

/**
 * 경로가 가리키는 바코드를 **소유권까지 확인해** 읽는다.
 *
 * 조회 조건은 `id = barcodeId AND skuId = path skuId` 다 — 다른 SKU 의 바코드는
 * 존재하더라도 404 이며 수정 대상이 되지 않는다.
 */
export async function findOwnedBarcode(
  db: BarcodeRowClient,
  skuId: string,
  barcodeId: string,
): Promise<SkuBarcode> {
  const row = await db.skuBarcode.findFirst({ where: { id: barcodeId, skuId } });
  if (row === null) throw barcodeNotFound(skuId, barcodeId);
  return row;
}
