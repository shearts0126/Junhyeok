import type { Prisma } from '@/generated/prisma/client';
import { toDecimalString } from '@/shared/decimal';

import { toDateOnly } from './views';

/**
 * 가격이력 외부 표현 (T06-3, D-4).
 *
 * 정확히 이 10필드다. **추가하지 않는다**:
 *   `approved` boolean · `approvalStatus` · `approvedAt` · `attachmentId`(staged,
 *   D-26) · 작성자/승인자 이름 · SupplierSku/Supplier/SKU 객체 join.
 *
 * 승인 여부는 `approvedBy` 의 null 여부가 그 자체로 상태다 (T06-1 D-15).
 * ⚠️ `unitPrice` 는 Decimal(18,4) **문자열** — `Number()` 변환 금지.
 * ⚠️ `effectiveFrom`/`effectiveTo` 는 `YYYY-MM-DD` date-only 직렬화 —
 *    timezone 으로 하루 밀리지 않는다.
 */

export interface SupplierSkuPriceView {
  readonly id: string;
  readonly supplierSkuId: string;
  /** Decimal(18,4) 문자열. `"0.0000"` 은 실재하는 0원 가격이다. */
  readonly unitPrice: string;
  readonly currency: string;
  readonly vatIncluded: boolean;
  /** `YYYY-MM-DD` — half-open `[from, to)` 의 시작(포함). */
  readonly effectiveFrom: string;
  /** `YYYY-MM-DD` — 종료 경계(미포함). null = open-ended 또는 미승인. */
  readonly effectiveTo: string | null;
  readonly sourceDocument: string | null;
  /** null = migration/backfill 유래 — runtime POST 는 항상 actor 를 넣는다 (D-20). */
  readonly createdBy: string | null;
  /** null = 미승인. NOT NULL = 승인 — 별도 status 컬럼이 없다. */
  readonly approvedBy: string | null;
  /** ISO 8601 */
  readonly createdAt: string;
}

export type SupplierSkuPriceRow = Prisma.SupplierSkuPriceGetPayload<Record<string, never>>;

export function toSupplierSkuPriceView(row: SupplierSkuPriceRow): SupplierSkuPriceView {
  return {
    id: row.id,
    supplierSkuId: row.supplierSkuId,
    unitPrice: toDecimalString(row.unitPrice),
    currency: row.currency,
    vatIncluded: row.vatIncluded,
    effectiveFrom: toDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : toDateOnly(row.effectiveTo),
    sourceDocument: row.sourceDocument,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt.toISOString(),
    // ⛔ attachmentId 를 여기 담지 않는다 — staged scalar 는 미노출이다 (D-26).
  };
}
