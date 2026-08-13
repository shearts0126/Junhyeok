/**
 * 가격 폼 상태 ↔ API payload (T06-4, D-23~D-25) — 순수 함수만.
 *
 * ⚠️ `unitPrice` 는 Decimal(18,4) **문자열 전용**이다 — `Number()`/`parseFloat()`
 *    를 쓰지 않는다. `"0"` 은 유효한 0원 가격이라 미입력과 구분한다 (T06-3 D-7).
 *
 * ⛔ 폼에 없는 것: `attachmentId`(D-26 staged — API 400) · `effectiveTo`
 *    (server-owned, 승인 시 계산) · `createdBy`/`approvedBy`.
 */

export interface PriceCreateForm {
  unitPrice: string;
  currency: string;
  vatIncluded: boolean;
  effectiveFrom: string;
  sourceDocument: string;
}

export const EMPTY_PRICE_CREATE_FORM: PriceCreateForm = {
  unitPrice: '',
  currency: 'KRW',
  vatIncluded: false,
  effectiveFrom: '',
  sourceDocument: '',
};

/** `POST /api/supplier-skus/{id}/prices` payload — 정확히 5필드 (D-23). */
export function buildPriceCreatePayload(form: PriceCreateForm): Record<string, unknown> {
  const sourceDocument = form.sourceDocument.trim();
  return {
    // ★ 문자열 그대로 — 숫자 변환 금지.
    unitPrice: form.unitPrice.trim(),
    currency: form.currency.trim(),
    vatIncluded: form.vatIncluded,
    effectiveFrom: form.effectiveFrom.trim(),
    sourceDocument: sourceDocument === '' ? null : sourceDocument,
  };
}

/** approve body — `{note?}` 뿐. blank 는 보내지 않는다 (T06-3 D-17). */
export function buildPriceApprovePayload(note: string): Record<string, unknown> {
  const trimmed = note.trim();
  return trimmed === '' ? {} : { note: trimmed };
}

/**
 * 승인 상태는 **`approvedBy` 로만 파생**한다 (D-25).
 *
 * ⛔ DB 에 `approvalStatus` enum 이 없다 — 있는 것처럼 다루지 않는다.
 */
export function priceApprovalLabel(approvedBy: string | null): '승인' | '미승인' {
  return approvedBy === null ? '미승인' : '승인';
}

export function isPricePending(approvedBy: string | null): boolean {
  return approvedBy === null;
}
