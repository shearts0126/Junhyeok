import type { Prisma } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';

import type { ListWarehousesQuery } from './dto';
import { WAREHOUSE_PAGE_SIZE, WAREHOUSE_READ_PERMISSION } from './policy';
import type { WarehouseReadClient } from './refs';
import { toWarehouseView, type WarehouseView } from './views';

/**
 * `GET /api/warehouses` — 창고 목록 (T08-2).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D30(list) · §W-D31(view) ·
 *    §W-D22(권한).
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `warehouse.read` 를 재검사한다.
 *
 * - 필터는 `warehouseType`·`active` **exact match** 뿐이다. ⛔ `q` 통합검색 없음.
 * - **⛔ `active = true` 자동 필터가 없다** — 비활성 창고도 기본 목록에 포함된다
 *   (§W-D30). 재고 이력이 남은 창고를 목록에서 숨기면 추적이 끊긴다.
 * - 정렬은 `warehouseCode ASC, id ASC` 고정 — `sort` 쿼리가 없고 tie-breaker 로
 *   페이지 경계가 흔들리지 않게 한다.
 * - `pageSize` 는 서버 고정 50. 0건이면 `total 0 / totalPages 0`.
 * ⛔ 관계 객체를 include 하지 않는다 (§W-D31) — `supplier`·`externalSystem`
 *    object 도, `locations` 배열도 응답에 없다.
 */

export interface WarehouseListResult {
  readonly items: readonly WarehouseView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface WarehouseReadDependencies {
  readonly db?: WarehouseReadClient;
}

export async function defaultWarehouseClient(): Promise<WarehouseReadClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

export async function listWarehouses(
  actor: ActorContext,
  query: ListWarehousesQuery,
  dependencies: WarehouseReadDependencies = {},
): Promise<WarehouseListResult> {
  assertPermission(actor, WAREHOUSE_READ_PERMISSION);

  const db = dependencies.db ?? (await defaultWarehouseClient());

  const where: Prisma.WarehouseWhereInput = {
    ...(query.warehouseType !== undefined ? { warehouseType: query.warehouseType } : {}),
    ...(query.active !== undefined ? { active: query.active } : {}),
  };

  const [total, rows] = await Promise.all([
    db.warehouse.count({ where }),
    db.warehouse.findMany({
      where,
      orderBy: [{ warehouseCode: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * WAREHOUSE_PAGE_SIZE,
      take: WAREHOUSE_PAGE_SIZE,
    }),
  ]);

  return {
    items: rows.map(toWarehouseView),
    page: query.page,
    pageSize: WAREHOUSE_PAGE_SIZE,
    total,
    // ★ 0건이면 0 — Math.max(1, …) 로 올리지 않는다 (기존 목록 convention).
    totalPages: Math.ceil(total / WAREHOUSE_PAGE_SIZE),
  };
}
