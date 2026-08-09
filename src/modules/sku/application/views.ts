import type { Prisma } from '@/generated/prisma/client';
import { toDecimalString } from '@/shared/decimal';

/**
 * SKU 외부 표현 (T1-3).
 *
 * - Decimal 은 **문자열**로 직렬화한다 (audit serialize 와 동일 계약 —
 *   JS number 변환으로 정밀도를 훼손하지 않는다).
 * - 공통코드 참조는 표시용 `{ id, code, name, active }` 로 함께 낸다.
 * - ⛔ 미래 모델(SkuBarcode·ExternalMapping·SupplierSku·BOM·Inventory) 관계를
 *   가짜 빈 배열로 채우지 않는다 — 각 모델 Task 에서 추가한다.
 */

export interface SkuCodeRefView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
}

export interface SkuView {
  readonly id: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly skuNameEn: string | null;
  readonly itemType: string;
  readonly status: string;

  readonly brand: SkuCodeRefView | null;
  readonly majorCategory: SkuCodeRefView | null;
  readonly minorCategory: SkuCodeRefView | null;

  readonly serialNumber: string | null;
  readonly additionalCode: string | null;

  readonly baseUom: string;
  readonly purchaseUom: string | null;
  /** DECIMAL(18,6) — 문자열 직렬화 */
  readonly unitConversionQty: string;

  readonly inventoryManaged: boolean;
  readonly sellable: boolean;
  readonly purchasable: boolean;
  readonly manufacturable: boolean;

  readonly lotManaged: boolean;
  readonly expiryManaged: boolean;
  readonly serialManaged: boolean;

  readonly defaultShelfLifeDays: number | null;
  readonly minimumRemainingDays: number | null;
  /** DECIMAL(18,6) — 문자열 직렬화 */
  readonly reconciliationToleranceQty: string;

  readonly erpItemType: string | null;
  readonly hasTransaction: boolean;
  /** `YYYY-MM-DD` */
  readonly discontinuationDate: string | null;
  readonly note: string | null;

  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
}

/** view 를 만들 때 필요한 include 한 벌. */
export const SKU_VIEW_INCLUDE = {
  brand: { select: { id: true, code: true, name: true, active: true } },
  majorCategory: { select: { id: true, code: true, name: true, active: true } },
  minorCategory: { select: { id: true, code: true, name: true, active: true } },
} as const;

type SkuRowForView = Prisma.SkuGetPayload<{ include: typeof SKU_VIEW_INCLUDE }>;

export function toSkuView(row: SkuRowForView): SkuView {
  return {
    id: row.id,
    skuCode: row.skuCode,
    skuName: row.skuName,
    skuNameEn: row.skuNameEn,
    itemType: row.itemType,
    status: row.status,
    brand: row.brand,
    majorCategory: row.majorCategory,
    minorCategory: row.minorCategory,
    serialNumber: row.serialNumber,
    additionalCode: row.additionalCode,
    baseUom: row.baseUom,
    purchaseUom: row.purchaseUom,
    unitConversionQty: toDecimalString(row.unitConversionQty),
    inventoryManaged: row.inventoryManaged,
    sellable: row.sellable,
    purchasable: row.purchasable,
    manufacturable: row.manufacturable,
    lotManaged: row.lotManaged,
    expiryManaged: row.expiryManaged,
    serialManaged: row.serialManaged,
    defaultShelfLifeDays: row.defaultShelfLifeDays,
    minimumRemainingDays: row.minimumRemainingDays,
    reconciliationToleranceQty: toDecimalString(row.reconciliationToleranceQty),
    erpItemType: row.erpItemType,
    hasTransaction: row.hasTransaction,
    discontinuationDate:
      row.discontinuationDate === null ? null : row.discontinuationDate.toISOString().slice(0, 10),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
    approvedBy: row.approvedBy,
  };
}
