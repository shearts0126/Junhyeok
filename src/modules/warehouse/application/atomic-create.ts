import { randomUUID } from 'node:crypto';

import type { TransactionClient } from '@/shared/db';

import type { WarehouseType } from './dto';
import { DEFAULT_LOCATION_CODE } from './policy';
import type { WarehouseRow, LocationRow } from './views';

/**
 * ★★ **창고 + DEFAULT 로케이션의 원자적 생성** — T08-2 의 핵심 불변식.
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D7 · §00 G-05.
 *
 * ## 왜 UUID 를 미리 만드는가
 *
 * `warehouse.default_location_id` 는 **NOT NULL** 이다 (§W-D5). 따라서
 * "창고를 먼저 넣고 나중에 UPDATE" 는 성립하지 않는다 — 첫 INSERT 가 NOT NULL
 * 을 위반한다. `docs/00 G-05` 의 "생성 후 즉시 UPDATE" 서술은 §W-D8 이
 * CLARIFY 했고, 실제 순서는 아래와 같다:
 *
 * ```
 * transaction 밖: warehouseId · defaultLocationId 를 미리 만든다
 * BEGIN
 *   1. INSERT warehouse           (default_location_id = 미리 만든 UUID)
 *   2. INSERT warehouse_location  (id = 그 UUID, location_code = 'DEFAULT')
 *   3. (호출자) audit / idempotency
 * COMMIT                          ← deferred FK 가 여기서 검증된다
 * ```
 *
 * 1↔2 의 순환 참조는 T08-1 이 만든
 * `warehouse_id_default_location_id_fkey … DEFERRABLE INITIALLY DEFERRED` 가
 * 커밋 시점까지 미뤄 준다. **사후 UPDATE 문이 없다.**
 *
 * ⛔ 별도 트랜잭션으로 쪼개지 않는다 · ⛔ `defaultLocationId = null` 상태를
 *    commit 하지 않는다 · ⛔ raw SQL · DB trigger · constraint disable ·
 *    `session_replication_role` 을 쓰지 않는다.
 *
 * ## 이 helper 의 경계 (§39 지시)
 *
 * 여기에는 **W-D7 의 INSERT 순서만** 있다. 다음은 호출자가 각자 감싼다:
 *
 * | 관심사 | public API (`create-warehouse.ts`) | seed (`prisma/seed/warehouses.ts`) |
 * |---|---|---|
 * | permission | `warehouse.create` | 없음 (runtime actor 없음) |
 * | DTO 검증 | strict DTO | 없음 (상수 표) |
 * | `SUPPLIER_SITE` supplierId | **required** (§W-D13) | **null 허용** (transitional) |
 * | `IN_TRANSIT` | **400** (§W-D12) | seed 만이 owner |
 * | audit | CREATE 2건 | **0건** (§W-D35) |
 * | idempotency | `warehouse:create` | natural key skip |
 *
 * 그래서 seed 가 public service 를 재사용하지 **못한다** — 계약이 정반대인
 * 지점이 있기 때문이다. ⛔ 그렇다고 public 계약을 우회하는 경로를 만들지도
 * 않는다. 공유하는 것은 INSERT 순서 하나뿐이다.
 */

export interface AtomicWarehouseInput {
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly warehouseType: WarehouseType;
  readonly externalSystemId: string | null;
  readonly supplierId: string | null;
  readonly timezone: string;
  readonly address: string | null;
}

export interface AtomicWarehouseResult {
  readonly warehouse: WarehouseRow;
  readonly defaultLocation: LocationRow;
}

/**
 * DEFAULT 로케이션의 고정값 (§W-D7).
 *
 * ⛔ 이 네 값을 호출자가 바꿀 수 없다 — 인자로 받지 않는다.
 * ⛔ `locationName` 을 창고명·창고코드로 파생시키지 않는다.
 */
export const DEFAULT_LOCATION_FIXED = Object.freeze({
  locationCode: DEFAULT_LOCATION_CODE,
  locationName: DEFAULT_LOCATION_CODE,
  locationType: null,
  active: true,
} as const);

/**
 * ⚠️ **반드시 트랜잭션 클라이언트를 받는다.** 타입이 `TransactionClient` 이므로
 *    루트 `PrismaClient` 로는 호출할 수 없다 — 두 INSERT 가 서로 다른 커넥션에
 *    가면 deferred FK 가 커밋 시점에 맞물리지 않는다.
 */
export async function insertWarehouseWithDefaultLocation(
  tx: TransactionClient,
  input: AtomicWarehouseInput,
): Promise<AtomicWarehouseResult> {
  // ① 두 UUID 를 **미리** 만든다 — 서로를 가리켜야 하므로 DB default 에 맡길 수 없다.
  const warehouseId = randomUUID();
  const defaultLocationId = randomUUID();

  // ② warehouse INSERT — default_location_id 를 처음부터 채운다 (null 아님).
  const warehouse = await tx.warehouse.create({
    data: {
      id: warehouseId,
      warehouseCode: input.warehouseCode,
      warehouseName: input.warehouseName,
      warehouseType: input.warehouseType,
      externalSystemId: input.externalSystemId,
      supplierId: input.supplierId,
      defaultLocationId,
      timezone: input.timezone,
      address: input.address,
    },
  });

  // ③ DEFAULT 로케이션 INSERT — 같은 창고 소속이어야 composite FK 를 통과한다.
  const defaultLocation = await tx.warehouseLocation.create({
    data: {
      id: defaultLocationId,
      warehouseId,
      ...DEFAULT_LOCATION_FIXED,
    },
  });

  // ④ COMMIT 은 호출자의 트랜잭션이 한다 — 그때 deferred FK 가 검증된다.
  return { warehouse, defaultLocation };
}
