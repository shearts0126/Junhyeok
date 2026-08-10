import type { Prisma } from '@/generated/prisma/client';

/**
 * 외부 매핑 외부 표현 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §12.
 *
 * DB 행의 **모든 업무 필드** + 목록 식별에 필요한 최소 read projection
 * (`sku` 3필드 · `externalSystem` 3필드)을 함께 낸다. 화면 목록 열이
 * `외부시스템 / 외부코드 / 외부상품명 / → / SKU 코드 / 표준 상품명 / …`
 * (`05:342`)이므로, 이 GET 하나로 T05-4 가 그릴 수 있어야 한다.
 *
 * ⛔ `warehouse` 객체는 없다 — `Warehouse` 모델이 T08-1 이다. `warehouseId`
 *    scalar 는 그대로 노출한다(현재는 항상 `null`).
 * ⛔ ExternalSystem 전용 read API 를 발명하지 않는다 — 이 projection 으로 족하다.
 *
 * ⚠️ Date 는 문자열로 직렬화한다 — `@db.Date` 는 `YYYY-MM-DD`,
 *    `@db.Timestamptz` 는 ISO 8601.
 */

export const EXTERNAL_MAPPING_VIEW_INCLUDE = {
  sku: { select: { id: true, skuCode: true, skuName: true } },
  externalSystem: { select: { id: true, systemCode: true, systemName: true } },
} as const satisfies Prisma.SkuExternalMappingInclude;

export type ExternalMappingRow = Prisma.SkuExternalMappingGetPayload<{
  include: typeof EXTERNAL_MAPPING_VIEW_INCLUDE;
}>;

export interface ExternalMappingView {
  readonly id: string;
  readonly skuId: string;
  readonly externalSystemId: string;
  /** T08-1 전까지 항상 `null` — API 가 입력을 받지 않는다. */
  readonly warehouseId: string | null;
  readonly externalProductCode: string | null;
  readonly externalProductName: string | null;
  readonly externalBarcode: string | null;
  /** server-derived — client 가 지정하지 않는다. */
  readonly mappingStatus: string;
  readonly isPrimary: boolean;
  /** `YYYY-MM-DD` */
  readonly effectiveFrom: string | null;
  /** `YYYY-MM-DD` */
  readonly effectiveTo: string | null;
  readonly note: string | null;
  /** ISO 8601 */
  readonly createdAt: string;
  readonly sku: {
    readonly id: string;
    readonly skuCode: string;
    /** ★ 내부 표준 상품명. `externalProductName` 이 이 값을 덮어쓰지 않는다. */
    readonly skuName: string;
  };
  readonly externalSystem: {
    readonly id: string;
    readonly systemCode: string;
    readonly systemName: string;
  };
}

function toDateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

export function toExternalMappingView(row: ExternalMappingRow): ExternalMappingView {
  return {
    id: row.id,
    skuId: row.skuId,
    externalSystemId: row.externalSystemId,
    warehouseId: row.warehouseId,
    externalProductCode: row.externalProductCode,
    externalProductName: row.externalProductName,
    externalBarcode: row.externalBarcode,
    mappingStatus: row.mappingStatus,
    isPrimary: row.isPrimary,
    effectiveFrom: toDateOnly(row.effectiveFrom),
    effectiveTo: toDateOnly(row.effectiveTo),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    sku: { id: row.sku.id, skuCode: row.sku.skuCode, skuName: row.sku.skuName },
    externalSystem: {
      id: row.externalSystem.id,
      systemCode: row.externalSystem.systemCode,
      systemName: row.externalSystem.systemName,
    },
  };
}
