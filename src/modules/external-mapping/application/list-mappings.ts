import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';

import type { ListMappingsQuery } from './dto';
import { EXTERNAL_MAPPING_READ_PERMISSION } from './policy';
import {
  EXTERNAL_MAPPING_VIEW_INCLUDE,
  toExternalMappingView,
  type ExternalMappingView,
} from './views';

/**
 * `GET /api/external-mappings` — 목록 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §12.
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `external_mapping.read` 를
 *    재검사한다. ADMIN bypass 없음.
 *
 * ## V1 계약
 *
 *   - 응답은 **공통 목록 envelope** 다 (`05:14`). Barcode GET 처럼 raw 배열이
 *     아니다 — 원문에 `page` query 가 실제로 있기 때문이다. shape 은 기존
 *     `listSkus` 계약(`items/page/pageSize/total/totalPages`)을 그대로 재사용한다.
 *   - `q` 는 **skuCode·skuName·externalProductCode·externalProductName 4종만**
 *     통합 검색한다(대소문자 무시 contains). ⛔ `externalBarcode` 는 화면
 *     검색조건에 없으므로 포함하지 않는다.
 *   - 정렬은 `createdAt DESC, id DESC` 고정 — `SkuExternalMapping` 에는
 *     `updatedAt` 이 없으므로 그 기준 정렬을 발명하지 않는다. `sort` query 도 없다.
 *   - 종료된(`effectiveTo != null`) 매핑도 **조회에 포함**한다. 이력이 보여야 한다.
 *   - `mappingStatus=UNMATCHED` 필터도 받는다. interactive API 가 그 상태를
 *     만들지는 않으므로 보통 0건이며, 그것은 정상이다.
 *   - 무제한 fetch 없음 — `pageSize` 상한은 DTO 가 강제한다(≤200).
 */

export type MappingListClient = Pick<PrismaClient, 'skuExternalMapping'>;

export interface MappingListDependencies {
  readonly db?: MappingListClient;
}

export interface ExternalMappingListResult {
  readonly items: readonly ExternalMappingView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

async function defaultClient(): Promise<MappingListClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

export async function listExternalMappings(
  actor: ActorContext,
  query: ListMappingsQuery,
  dependencies: MappingListDependencies = {},
): Promise<ExternalMappingListResult> {
  assertPermission(actor, EXTERNAL_MAPPING_READ_PERMISSION);

  const db = dependencies.db ?? (await defaultClient());

  const where: Prisma.SkuExternalMappingWhereInput = {
    ...(query.externalSystemId !== undefined ? { externalSystemId: query.externalSystemId } : {}),
    ...(query.skuId !== undefined ? { skuId: query.skuId } : {}),
    ...(query.mappingStatus !== undefined ? { mappingStatus: query.mappingStatus } : {}),
    ...(query.q !== undefined
      ? {
          OR: [
            { sku: { skuCode: { contains: query.q, mode: 'insensitive' as const } } },
            { sku: { skuName: { contains: query.q, mode: 'insensitive' as const } } },
            { externalProductCode: { contains: query.q, mode: 'insensitive' as const } },
            { externalProductName: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.skuExternalMapping.count({ where }),
    db.skuExternalMapping.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: EXTERNAL_MAPPING_VIEW_INCLUDE,
    }),
  ]);

  return {
    items: rows.map(toExternalMappingView),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}
