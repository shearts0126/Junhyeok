import { z } from 'zod';

import { DomainError, ERROR_CODES, ValidationError } from '@/shared/errors';

import { dateString, toValidationError, CURRENCY_MAX_LENGTH } from './dto';

/**
 * 가격이력 API DTO (T06-3).
 *
 * ⚠️ 근거: `docs/17_설계복구_거래처공급조건.md` §58~ (T06-3 Recovery — D-5~D-11·
 *    D-17). 원 API 문서(`05:97`)의 `Price[]`·`CreatePriceDto` 는 필드 정의가
 *    없었다 — Recovery Decision 이 확정한 계약으로 고정한다.
 *
 * ⛔ `strictObject` — unknown field 는 400 이다. 조용히 무시하지 않는다.
 */

export const SOURCE_DOCUMENT_MAX_LENGTH = 255;

/**
 * `unitPrice` — Decimal(18,4) **문자열 전용** (D-7).
 *
 * ⛔ JSON number 는 400 — `z.string()` 이 타입 자체로 거부한다.
 * ⛔ `Number()`/`parseFloat()` 금지 — 정밀도 손실 금지.
 * ★ `"0"`·`"0.0000"` 은 **유효한 가격**이다 — moq 와 달리 0 을 허용한다.
 *   0원 실가격과 "가격 없음"(asOf 200 `[]`)을 구분해야 하기 때문이다 (D-3).
 * ★ 음수는 형식이 아니라 **금액 semantics** 위반이다 → zod 400 이 아니라
 *   422 `SUPPLIER_PRICE_UNIT_PRICE_INVALID` 로 판정한다 (아래 refine 분리).
 *   scale 5자리 이상·지수표기·공백 등 malformed 는 400 이다.
 */
const unitPriceShape = z.string().regex(/^-?\d{1,14}(?:\.\d{1,4})?$/, {
  error: '단가는 소수 4자리 이하의 십진 문자열이어야 합니다. (예: "0" / "1234.5678")',
});

/** 음수 판정 — `"-0"` 도 음수 표기로 거부한다(정상 표기는 `"0"` 이다). */
export function assertUnitPriceSemantics(value: string): void {
  if (value.startsWith('-')) {
    throw new DomainError(ERROR_CODES.SUPPLIER_PRICE_UNIT_PRICE_INVALID, {
      message: '단가는 음수일 수 없습니다. 0 이상이어야 합니다.',
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// GET /api/supplier-skus/{id}/prices — 쿼리
// ═══════════════════════════════════════════════════════════════

/**
 * 쿼리는 정확히 `asOf?` 하나다 (D-5). `page`·`pageSize`·`sort` 를 받지 않는다 —
 * 가격이력은 pagination 없는 전체 반환이다.
 */
export const listPricesQuerySchema = z.strictObject({
  asOf: dateString.optional(),
});

export type ListPricesQuery = z.infer<typeof listPricesQuerySchema>;

export function parseListPricesQuery(searchParams: URLSearchParams): ListPricesQuery {
  const unknownKeys = [...new Set([...searchParams.keys()])].filter((key) => key !== 'asOf');
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      unknownKeys.map((key) => ({
        path: key,
        message: '지원하지 않는 파라미터입니다. (가격이력 조회는 asOf 만 받습니다)',
      })),
      { message: '지원하지 않는 가격 조회 파라미터가 있습니다.' },
    );
  }

  const raw: Record<string, string> = {};
  const asOf = searchParams.get('asOf');
  if (asOf !== null) raw['asOf'] = asOf;

  const result = listPricesQuerySchema.safeParse(raw);
  if (!result.success) {
    throw toValidationError(result.error.issues, '가격 조회 쿼리가 올바르지 않습니다.');
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// POST /api/supplier-skus/{id}/prices — CreatePriceDto
// ═══════════════════════════════════════════════════════════════

/**
 * `CreatePriceDto` (D-6) — 정확히 이 5필드다.
 *
 *   - `unitPrice`·`currency`·`vatIncluded`·`effectiveFrom` required —
 *     DB default(`KRW`/`false`)가 있어도 API 는 명시적으로 받는다 (D-8·D-9).
 *   - `currency` 는 trim 후 정확히 3글자. allow-list·uppercase 강제·
 *     SupplierSku.currency 일치 강제는 없다 (D-8).
 *   - `effectiveFrom` 은 과거·오늘·미래 모두 허용 — backfill + 예약가 (D-10).
 * ⛔ `effectiveTo` 는 server-owned — 승인 시 application 이 계산한다 (D-11).
 * ⛔ `attachmentId`·`supplierSkuId`·`createdBy`·`approvedBy` 등은 보내면 400.
 */
export const createPriceSchema = z.strictObject({
  unitPrice: unitPriceShape,
  currency: z.string().trim().length(CURRENCY_MAX_LENGTH, {
    error: '통화는 trim 후 정확히 3글자여야 합니다. (예: "KRW")',
  }),
  vatIncluded: z.boolean(),
  effectiveFrom: dateString,
  sourceDocument: z.string().max(SOURCE_DOCUMENT_MAX_LENGTH).nullable().optional(),
});

export interface CreatePriceInput {
  readonly unitPrice: string;
  readonly currency: string;
  readonly vatIncluded: boolean;
  readonly effectiveFrom: string;
  /** normalize 완료 값 — trim 후 blank 는 null 이다 (§47). */
  readonly sourceDocument: string | null;
}

export function parseCreatePriceInput(body: unknown): CreatePriceInput {
  const result = createPriceSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '가격 등록 요청이 올바르지 않습니다.');
  }
  // ★ 형식(400) 통과 후 금액 semantics(422) — 음수 판정 순서 고정 (D-7).
  assertUnitPriceSemantics(result.data.unitPrice);

  const trimmed = result.data.sourceDocument?.trim();
  return {
    unitPrice: result.data.unitPrice,
    currency: result.data.currency,
    vatIncluded: result.data.vatIncluded,
    effectiveFrom: result.data.effectiveFrom,
    sourceDocument: trimmed === undefined || trimmed === '' ? null : trimmed,
  };
}

// ═══════════════════════════════════════════════════════════════
// POST /api/supplier-sku-prices/{id}/approve — body
// ═══════════════════════════════════════════════════════════════

/** approve body 는 `{note?}` 뿐이다 (D-17). unknown key 는 400. */
export const approvePriceSchema = z.strictObject({
  note: z.string().optional(),
});

export interface ApprovePriceInput {
  /** trim 후 blank 는 null — `AuditLog.reason` 에 그대로 쓴다. */
  readonly note: string | null;
}

export function parseApprovePriceInput(body: unknown): ApprovePriceInput {
  // 본문 없는 POST 는 `{}` 와 동일하게 취급한다 — note 가 유일한 필드고 선택이다.
  const result = approvePriceSchema.safeParse(body ?? {});
  if (!result.success) {
    throw toValidationError(result.error.issues, '가격 승인 요청이 올바르지 않습니다.');
  }
  const trimmed = result.data.note?.trim();
  return { note: trimmed === undefined || trimmed === '' ? null : trimmed };
}

// ═══════════════════════════════════════════════════════════════
// 경로 식별자
// ═══════════════════════════════════════════════════════════════

/** 경로 식별자는 UUID 다. 형식 오류는 400 (404 가 아니다). */
export function parseSupplierSkuPriceId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new ValidationError([{ path: 'id', message: 'UUID 형식이어야 합니다.' }], {
      message: '가격 id 가 올바르지 않습니다.',
    });
  }
  return result.data;
}
