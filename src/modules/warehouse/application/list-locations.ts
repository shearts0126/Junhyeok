import { assertPermission, type ActorContext } from '@/modules/auth/application';

import { parseWarehouseId } from './dto';
import { WAREHOUSE_READ_PERMISSION } from './policy';
import { warehouseNotFound, type WarehouseReadClient } from './refs';
import { toLocationView, type LocationView } from './views';

/**
 * `GET /api/warehouses/{id}/locations` — 창고의 로케이션 목록 (T08-2).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D32 · §W-D22(권한).
 *
 * ⚠️ **2차 권한 가드.** `warehouse.read` 를 재검사한다.
 *
 * - query **없음** — 하나라도 있으면 400 이다 (라우트의 `assertNoLocationListQuery`).
 * - parent 창고가 없으면 **404** — 빈 배열이 아니다.
 * - **페이지네이션 없음** (§W-D32).
 * - 정렬 `locationCode ASC, id ASC`.
 * - active·inactive **모두 포함**, **DEFAULT 포함**.
 * ★ 정상 창고라면 W-D7 때문에 **0건일 수 없다** — DEFAULT 가 반드시 있다.
 */

export interface LocationListResult {
  readonly items: readonly LocationView[];
}

export interface LocationReadDependencies {
  readonly db?: WarehouseReadClient;
}

export async function listWarehouseLocations(
  actor: ActorContext,
  rawWarehouseId: string,
  dependencies: LocationReadDependencies = {},
): Promise<LocationListResult> {
  assertPermission(actor, WAREHOUSE_READ_PERMISSION);
  const warehouseId = parseWarehouseId(rawWarehouseId);

  const db =
    dependencies.db ?? (await (await import('./list-warehouses')).defaultWarehouseClient());

  const warehouse = await db.warehouse.findUnique({
    where: { id: warehouseId },
    select: { id: true },
  });
  if (warehouse === null) throw warehouseNotFound(warehouseId);

  const rows = await db.warehouseLocation.findMany({
    where: { warehouseId },
    orderBy: [{ locationCode: 'asc' }, { id: 'asc' }],
  });

  return { items: rows.map(toLocationView) };
}
