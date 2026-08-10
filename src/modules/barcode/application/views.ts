import type { SkuBarcode } from '@/generated/prisma/client';

/**
 * 바코드 외부 표현 (T04-3).
 *
 * DB 행의 **모든 업무 필드**를 그대로 낸다 — V1 이 입력받지 않는
 * `countryCode`·`channelCode`·`effectiveFrom`·`effectiveTo` 와 T04-4 필드
 * (`duplicateException`·`exceptionReason`·`approvedBy`)도 **조회에는 포함**한다.
 * 마이그레이션으로 들어온 값을 화면이 볼 수 있어야 하기 때문이다.
 *
 * ⚠️ Date 는 문자열로 직렬화한다 — `@db.Date` 는 `YYYY-MM-DD`,
 *    `@db.Timestamptz` 는 ISO 8601.
 */

export interface SkuBarcodeView {
  readonly id: string;
  readonly skuId: string;
  readonly barcode: string;
  readonly barcodeType: string;
  readonly isPrimary: boolean;
  readonly countryCode: string | null;
  readonly channelCode: string | null;
  readonly status: string;
  readonly duplicateException: boolean;
  readonly exceptionReason: string | null;
  readonly approvedBy: string | null;
  /** `YYYY-MM-DD` */
  readonly effectiveFrom: string | null;
  /** `YYYY-MM-DD` */
  readonly effectiveTo: string | null;
  /** ISO 8601 */
  readonly createdAt: string;
}

function toDateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

export function toSkuBarcodeView(row: SkuBarcode): SkuBarcodeView {
  return {
    id: row.id,
    skuId: row.skuId,
    barcode: row.barcode,
    barcodeType: row.barcodeType,
    isPrimary: row.isPrimary,
    countryCode: row.countryCode,
    channelCode: row.channelCode,
    status: row.status,
    duplicateException: row.duplicateException,
    exceptionReason: row.exceptionReason,
    approvedBy: row.approvedBy,
    effectiveFrom: toDateOnly(row.effectiveFrom),
    effectiveTo: toDateOnly(row.effectiveTo),
    createdAt: row.createdAt.toISOString(),
  };
}
