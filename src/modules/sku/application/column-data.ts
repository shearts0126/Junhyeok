import { toDecimalString } from '@/shared/decimal';

import type { UpdateSkuInput } from './dto';

/**
 * DTO → Prisma 컬럼 데이터 변환 (T1-3).
 *
 * - `undefined` = 미제공 → 컬럼을 건드리지 않는다 (spread 로 생략).
 * - `null` = 참조·값 해제 → NULL 저장 (nullable 컬럼만 DTO 가 null 을 허용한다).
 * - Decimal 은 shared `toDecimalString` 문자열로 저장한다 — number 변환 없음.
 * - server-managed 필드(`status`·`hasTransaction`·감사 필드)는 여기 없다.
 *   호출부(create/update service)가 강제 지정한다.
 */

export interface SkuColumnData {
  readonly skuCode?: string;
  readonly skuName?: string;
  readonly skuNameEn?: string | null;
  readonly itemType?: string;
  readonly brandId?: string | null;
  readonly majorCategoryId?: string | null;
  readonly minorCategoryId?: string | null;
  readonly serialNumber?: string | null;
  readonly additionalCode?: string | null;
  readonly baseUom?: string;
  readonly purchaseUom?: string | null;
  readonly unitConversionQty?: string;
  readonly inventoryManaged?: boolean;
  readonly sellable?: boolean;
  readonly purchasable?: boolean;
  readonly manufacturable?: boolean;
  readonly lotManaged?: boolean;
  readonly expiryManaged?: boolean;
  readonly serialManaged?: boolean;
  readonly defaultShelfLifeDays?: number | null;
  readonly minimumRemainingDays?: number | null;
  readonly reconciliationToleranceQty?: string;
  readonly erpItemType?: string | null;
  readonly discontinuationDate?: Date | null;
  readonly note?: string | null;
}

export function toSkuColumnData(input: UpdateSkuInput): SkuColumnData {
  return {
    ...(input.skuCode !== undefined ? { skuCode: input.skuCode } : {}),
    ...(input.skuName !== undefined ? { skuName: input.skuName } : {}),
    ...(input.skuNameEn !== undefined ? { skuNameEn: input.skuNameEn } : {}),
    ...(input.itemType !== undefined ? { itemType: input.itemType } : {}),
    ...(input.brandId !== undefined ? { brandId: input.brandId } : {}),
    ...(input.majorCategoryId !== undefined ? { majorCategoryId: input.majorCategoryId } : {}),
    ...(input.minorCategoryId !== undefined ? { minorCategoryId: input.minorCategoryId } : {}),
    ...(input.serialNumber !== undefined ? { serialNumber: input.serialNumber } : {}),
    ...(input.additionalCode !== undefined ? { additionalCode: input.additionalCode } : {}),
    ...(input.baseUom !== undefined ? { baseUom: input.baseUom } : {}),
    ...(input.purchaseUom !== undefined ? { purchaseUom: input.purchaseUom } : {}),
    ...(input.unitConversionQty !== undefined
      ? { unitConversionQty: toDecimalString(input.unitConversionQty) }
      : {}),
    ...(input.inventoryManaged !== undefined ? { inventoryManaged: input.inventoryManaged } : {}),
    ...(input.sellable !== undefined ? { sellable: input.sellable } : {}),
    ...(input.purchasable !== undefined ? { purchasable: input.purchasable } : {}),
    ...(input.manufacturable !== undefined ? { manufacturable: input.manufacturable } : {}),
    ...(input.lotManaged !== undefined ? { lotManaged: input.lotManaged } : {}),
    ...(input.expiryManaged !== undefined ? { expiryManaged: input.expiryManaged } : {}),
    ...(input.serialManaged !== undefined ? { serialManaged: input.serialManaged } : {}),
    ...(input.defaultShelfLifeDays !== undefined
      ? { defaultShelfLifeDays: input.defaultShelfLifeDays }
      : {}),
    ...(input.minimumRemainingDays !== undefined
      ? { minimumRemainingDays: input.minimumRemainingDays }
      : {}),
    ...(input.reconciliationToleranceQty !== undefined
      ? { reconciliationToleranceQty: toDecimalString(input.reconciliationToleranceQty) }
      : {}),
    ...(input.erpItemType !== undefined ? { erpItemType: input.erpItemType } : {}),
    ...(input.discontinuationDate !== undefined
      ? {
          discontinuationDate:
            input.discontinuationDate === null
              ? null
              : new Date(`${input.discontinuationDate}T00:00:00.000Z`),
        }
      : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}
