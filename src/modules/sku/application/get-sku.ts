import type { PrismaClient } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';

import { parseSkuId } from './dto';
import { SKU_READ_PERMISSION } from './policy';
import { skuNotFound } from './update-sku';
import { SKU_VIEW_INCLUDE, toSkuView, type SkuView } from './views';

/**
 * SKU 단건 조회 (T1-3).
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `sku.read` 를 재검사한다.
 *
 * - id 는 UUID 형식 검증 (형식 오류 400, 실존하지 않으면 404).
 * - soft-delete(`deletedAt` 채워짐) 행은 404 — 존재를 노출하지 않는다.
 * - ⛔ 미래 모델(BOM·바코드·매핑 등) 관계를 가짜로 채우지 않는다.
 */

/** 조회에 필요한 최소 클라이언트. 테스트에서 대역을 주입한다. */
export type SkuReadClient = Pick<PrismaClient, 'sku'>;

export interface SkuReadDependencies {
  readonly db?: SkuReadClient;
}

async function defaultClient(): Promise<SkuReadClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

export async function getSku(
  actor: ActorContext,
  id: string,
  dependencies: SkuReadDependencies = {},
): Promise<SkuView> {
  assertPermission(actor, SKU_READ_PERMISSION);
  const skuId = parseSkuId(id);

  const db = dependencies.db ?? (await defaultClient());

  const row = await db.sku.findFirst({
    where: { id: skuId, deletedAt: null },
    include: SKU_VIEW_INCLUDE,
  });
  if (row === null) throw skuNotFound(skuId);

  return toSkuView(row);
}
