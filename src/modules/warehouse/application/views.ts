import type { Prisma } from '@/generated/prisma/client';

/**
 * 창고·로케이션 외부 표현 (T08-2).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D31(`WarehouseView`) ·
 *    §W-D33(`LocationView`) · §W-D17(projection 경계).
 *
 * ⛔ **관계 객체를 자동 include 하지 않는다** — `supplier` object 없음 ·
 *    `externalSystem` object 없음 · list 응답에 `locations` inline 없음.
 *    scalar FK 만 노출한다 (§W-D31).
 * ⚠️ `@db.Timestamptz` 는 ISO 8601 문자열로 직렬화한다.
 */

// ═══════════════════════════════════════════════════════════════
// W-D31 — WarehouseView (scalar 정확히 12개)
// ═══════════════════════════════════════════════════════════════

export interface WarehouseView {
  readonly id: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly warehouseType: string;
  readonly externalSystemId: string | null;
  /**
   * ★ `SUPPLIER_SITE` + `null` 은 **정상 transitional state** 다 (§W-D13).
   *   마이그레이션 Phase 7(`T4-19`) 전까지 seed 11건이 이 상태다 —
   *   ⛔ null 이라는 이유로 corruption 취급하지 않는다.
   */
  readonly supplierId: string | null;
  /** ★ NOT NULL 이다 (§W-D5) — 창고가 존재하는 모든 시점에 채워져 있다. */
  readonly defaultLocationId: string;
  readonly timezone: string;
  readonly address: string | null;
  readonly active: boolean;
  /** ISO 8601 */
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WarehouseRow = Prisma.WarehouseGetPayload<Record<string, never>>;

export function toWarehouseView(row: WarehouseRow): WarehouseView {
  return {
    id: row.id,
    warehouseCode: row.warehouseCode,
    warehouseName: row.warehouseName,
    warehouseType: row.warehouseType,
    externalSystemId: row.externalSystemId,
    supplierId: row.supplierId,
    defaultLocationId: row.defaultLocationId,
    timezone: row.timezone,
    address: row.address,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// W-D33 — LocationView (scalar 정확히 6개)
// ═══════════════════════════════════════════════════════════════

/**
 * ⛔ `WarehouseLocation` 에는 감사 컬럼이 없다 (§W-D4) — `createdAt`·
 *    `updatedAt` 을 만들어 내지 않는다.
 */
export interface LocationView {
  readonly id: string;
  readonly warehouseId: string;
  readonly locationCode: string;
  readonly locationName: string;
  readonly locationType: string | null;
  readonly active: boolean;
}

export type LocationRow = Prisma.WarehouseLocationGetPayload<Record<string, never>>;

export function toLocationView(row: LocationRow): LocationView {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    locationCode: row.locationCode,
    locationName: row.locationName,
    locationType: row.locationType,
    active: row.active,
  };
}
