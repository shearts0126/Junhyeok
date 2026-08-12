import type { Prisma } from '@/generated/prisma/client';
import { toDecimalString } from '@/shared/decimal';

/**
 * 거래처·공급조건 외부 표현 (T06-2).
 *
 * ⚠️ 근거: `docs/17_설계복구_거래처공급조건.md` §39~ (D-3·D-11·D-18).
 *
 * ⛔ **`defaultWarehouseId`·`destinationWarehouseId` 를 노출하지 않는다** —
 *    Warehouse 가 없는 staged scalar 를 production API 에 내보내지 않는다 (D-9).
 * ⛔ 가격(`SupplierSkuPrice`)을 join·노출하지 않는다 — T06-3 범위다 (D-30).
 * ⚠️ Decimal 은 **문자열**로 직렬화한다 — `Number()` 변환 금지.
 * ⚠️ `@db.Date` 는 `YYYY-MM-DD`, `@db.Timestamptz` 는 ISO 8601 로 직렬화한다 —
 *    DB timezone 에 따라 날짜가 하루 밀리지 않게 date-only serializer 를 쓴다.
 */

export interface SupplierView {
  readonly id: string;
  readonly supplierCode: string;
  readonly supplierName: string;
  /** open string — MANUFACTURER 등 4종은 예시일 뿐 closed enum 이 아니다 (D-5). */
  readonly supplierType: string;
  readonly businessRegistrationNo: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  /** null = 미입력/미확정. `0` 은 명시적 즉시납 — 0 으로 대체하지 않는다 (G-03). */
  readonly defaultLeadTimeDays: number | null;
  readonly status: string;
  readonly note: string | null;
  /** ISO 8601 */
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SupplierRow = Prisma.SupplierGetPayload<Record<string, never>>;

export function toSupplierView(row: SupplierRow): SupplierView {
  return {
    id: row.id,
    supplierCode: row.supplierCode,
    supplierName: row.supplierName,
    supplierType: row.supplierType,
    businessRegistrationNo: row.businessRegistrationNo,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    defaultLeadTimeDays: row.defaultLeadTimeDays,
    status: row.status,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 공급조건 view include.
 *
 * `supplier` 는 **`defaultLeadTimeDays` 파생 계산 전용**이다 — Supplier 객체를
 * 응답에 통째로 join 하지 않는다 (D-11). `sku` 는 목록 식별에 필요한 최소
 * projection 4필드만 낸다.
 */
export const SUPPLIER_SKU_VIEW_INCLUDE = {
  sku: { select: { id: true, skuCode: true, skuName: true, status: true } },
  supplier: { select: { defaultLeadTimeDays: true } },
} as const satisfies Prisma.SupplierSkuInclude;

export type SupplierSkuRow = Prisma.SupplierSkuGetPayload<{
  include: typeof SUPPLIER_SKU_VIEW_INCLUDE;
}>;

export interface SupplierSkuView {
  readonly id: string;
  readonly supplierId: string;
  readonly skuId: string;
  readonly supplierSkuCode: string | null;
  readonly supplierSkuName: string | null;
  readonly supplyType: string;
  /** Decimal(18,6) 문자열. null = 미지정. */
  readonly moq: string | null;
  readonly orderMultiple: string | null;
  /** **저장값 그대로.** null = 미입력 — 폴백값으로 덮어쓰지 않는다 (D-18). */
  readonly leadTimeDays: number | null;
  /**
   * 조회 시 파생값: `leadTimeDays ?? supplier.defaultLeadTimeDays ?? null`.
   * ⛔ `||` 금지 — 저장값 `0`(즉시납)은 폴백 대상이 아니라 그대로 `0` 이다.
   */
  readonly effectiveLeadTimeDays: number | null;
  readonly purchaseUom: string | null;
  readonly currency: string;
  readonly isPrimary: boolean;
  /** `YYYY-MM-DD` — half-open `[from, to)` 의 시작(포함). */
  readonly effectiveFrom: string;
  /** `YYYY-MM-DD` — 종료 경계(미포함). null = open-ended. */
  readonly effectiveTo: string | null;
  /** ISO 8601 */
  readonly createdAt: string;
  readonly sku: {
    readonly id: string;
    readonly skuCode: string;
    readonly skuName: string;
    readonly status: string;
  };
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function toSupplierSkuView(row: SupplierSkuRow): SupplierSkuView {
  return {
    id: row.id,
    supplierId: row.supplierId,
    skuId: row.skuId,
    supplierSkuCode: row.supplierSkuCode,
    supplierSkuName: row.supplierSkuName,
    supplyType: row.supplyType,
    moq: row.moq === null ? null : toDecimalString(row.moq),
    orderMultiple: row.orderMultiple === null ? null : toDecimalString(row.orderMultiple),
    leadTimeDays: row.leadTimeDays,
    // ★ G-03 폴백 — `??` 만 쓴다. `0` 은 falsy 지만 유효한 저장값이다.
    effectiveLeadTimeDays: row.leadTimeDays ?? row.supplier.defaultLeadTimeDays ?? null,
    purchaseUom: row.purchaseUom,
    currency: row.currency,
    isPrimary: row.isPrimary,
    effectiveFrom: toDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : toDateOnly(row.effectiveTo),
    createdAt: row.createdAt.toISOString(),
    sku: {
      id: row.sku.id,
      skuCode: row.sku.skuCode,
      skuName: row.sku.skuName,
      status: row.sku.status,
    },
  };
}
