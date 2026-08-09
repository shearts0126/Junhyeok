import type { Prisma } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';

import type { ListSkusQuery, SkuSort } from './dto';
import type { SkuReadDependencies } from './get-sku';
import { SKU_READ_PERMISSION } from './policy';
import { SKU_VIEW_INCLUDE, toSkuView, type SkuView } from './views';

/**
 * SKU 목록 조회 (T1-3).
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `sku.read` 를 재검사한다.
 *
 * - `q` 는 skuCode·skuName·skuNameEn **만** 통합 검색한다 (대소문자 무시 contains).
 *   바코드·외부몰 별칭 검색은 해당 모델 도입 후다.
 * - soft-delete 행은 항상 제외.
 * - 정렬은 화이트리스트(`SKU_SORTS`) 안에서만, tie-breaker `id ASC` 고정 —
 *   같은 `updatedAt` 이 흔하므로(시드·일괄 갱신) 페이지 경계가 흔들리지 않게 한다.
 * - 무제한 fetch 없음 — `pageSize` 상한은 DTO 가 강제한다(≤200).
 */

const ORDER_BY: Readonly<Record<SkuSort, Prisma.SkuOrderByWithRelationInput[]>> = {
  updatedAt_desc: [{ updatedAt: 'desc' }, { id: 'asc' }],
  updatedAt_asc: [{ updatedAt: 'asc' }, { id: 'asc' }],
  skuCode_asc: [{ skuCode: 'asc' }, { id: 'asc' }],
  skuCode_desc: [{ skuCode: 'desc' }, { id: 'asc' }],
};

export interface SkuListResult {
  readonly items: readonly SkuView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

async function defaultClient(): Promise<NonNullable<SkuReadDependencies['db']>> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

export async function listSkus(
  actor: ActorContext,
  query: ListSkusQuery,
  dependencies: SkuReadDependencies = {},
): Promise<SkuListResult> {
  assertPermission(actor, SKU_READ_PERMISSION);

  const db = dependencies.db ?? (await defaultClient());

  const where: Prisma.SkuWhereInput = {
    deletedAt: null,
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.itemType !== undefined ? { itemType: query.itemType } : {}),
    ...(query.brandId !== undefined ? { brandId: query.brandId } : {}),
    ...(query.majorCategoryId !== undefined ? { majorCategoryId: query.majorCategoryId } : {}),
    ...(query.minorCategoryId !== undefined ? { minorCategoryId: query.minorCategoryId } : {}),
    ...(query.q !== undefined
      ? {
          OR: [
            { skuCode: { contains: query.q, mode: 'insensitive' as const } },
            { skuName: { contains: query.q, mode: 'insensitive' as const } },
            { skuNameEn: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.sku.count({ where }),
    db.sku.findMany({
      where,
      orderBy: ORDER_BY[query.sort],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: SKU_VIEW_INCLUDE,
    }),
  ]);

  return {
    items: rows.map(toSkuView),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}
