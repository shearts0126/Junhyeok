/**
 * 공급조건 폼 상태 ↔ API payload (T06-4, D-14~D-19) — 순수 함수만.
 *
 * ## 공급조건은 제자리 수정이 없다
 *
 * backend `PATCH /api/supplier-skus/{id}` 는 두 mode 뿐이다 (T06-2 D-15·D-16):
 *
 *   - **mode A — 기간 종료/단축**: body 가 **정확히 `{effectiveTo}`**
 *   - **mode B — 새 버전 생성**: `effectiveFrom` + 실질 변경 최소 1개
 *
 * business field 만 보내면 400 이다. 그래서 화면에도 "수정" 버튼이 없고
 * `기간 종료/단축` 과 `새 버전 생성` 두 action 으로 분리한다 (D-17·D-18·D-19).
 *
 * ⚠️ Decimal(`moq`·`orderMultiple`)은 **문자열 그대로** 주고받는다 —
 *    `Number()`/`parseFloat()` 를 쓰지 않는다 (D-15, T1-3 convention 동일).
 */

export const SUPPLY_TYPE_VALUES = ['SELF_SUPPLIED', 'TURNKEY'] as const;

export type SupplyTypeValue = (typeof SUPPLY_TYPE_VALUES)[number];

/**
 * 화면 라벨 (D-14). API payload 에는 **enum 원문**을 쓴다 — 라벨은 표시 전용이다.
 * 근거: `docs/01:161`·`docs/03:48` 의 `사급/턴키` 표기와 enum 선언 순서.
 */
export const SUPPLY_TYPE_LABELS: Readonly<Record<SupplyTypeValue, string>> = {
  SELF_SUPPLIED: '사급',
  TURNKEY: '턴키',
};

export function supplyTypeLabel(value: string): string {
  return (SUPPLY_TYPE_LABELS as Record<string, string | undefined>)[value] ?? value;
}

export interface SupplierSkuFormValues {
  supplierSkuCode: string;
  supplierSkuName: string;
  supplyType: SupplyTypeValue;
  moq: string;
  orderMultiple: string;
  leadTimeDays: string;
  purchaseUom: string;
  currency: string;
  isPrimary: boolean;
  effectiveTo: string;
}

export interface SupplierSkuCreateForm extends SupplierSkuFormValues {
  skuId: string;
  /** 선택한 SKU 표시용 — payload 에 들어가지 않는다. */
  skuLabel: string;
  effectiveFrom: string;
}

/** mode B — 기존 값을 prefill 하고 새 시작일을 반드시 입력받는다 (D-18). */
export interface SupplierSkuVersionForm extends SupplierSkuFormValues {
  effectiveFrom: string;
}

export const EMPTY_TERM_CREATE_FORM: SupplierSkuCreateForm = {
  skuId: '',
  skuLabel: '',
  supplierSkuCode: '',
  supplierSkuName: '',
  supplyType: 'SELF_SUPPLIED',
  moq: '',
  orderMultiple: '',
  leadTimeDays: '',
  purchaseUom: '',
  currency: '',
  isPrimary: false,
  effectiveFrom: '',
  effectiveTo: '',
};

export interface SupplierSkuViewLike {
  readonly supplierSkuCode: string | null;
  readonly supplierSkuName: string | null;
  readonly supplyType: string;
  readonly moq: string | null;
  readonly orderMultiple: string | null;
  readonly leadTimeDays: number | null;
  readonly purchaseUom: string | null;
  readonly currency: string;
  readonly isPrimary: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** 기존 row → mode B 폼 prefill. `effectiveFrom` 은 **비워 둔다** (새로 입력). */
export function toVersionForm(row: SupplierSkuViewLike): SupplierSkuVersionForm {
  return {
    supplierSkuCode: row.supplierSkuCode ?? '',
    supplierSkuName: row.supplierSkuName ?? '',
    supplyType: (SUPPLY_TYPE_VALUES as readonly string[]).includes(row.supplyType)
      ? (row.supplyType as SupplyTypeValue)
      : 'SELF_SUPPLIED',
    moq: row.moq ?? '',
    orderMultiple: row.orderMultiple ?? '',
    leadTimeDays: row.leadTimeDays === null ? '' : String(row.leadTimeDays),
    purchaseUom: row.purchaseUom ?? '',
    currency: row.currency,
    isPrimary: row.isPrimary,
    effectiveFrom: '',
    effectiveTo: row.effectiveTo ?? '',
  };
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Decimal — 문자열 그대로. 빈 값은 `null`(미입력)이다. ⛔ 숫자 변환 금지. */
function optionalDecimal(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function leadTimePayload(value: string): number | string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : trimmed;
}

/** `POST /api/suppliers/{id}/skus` payload (D-31). ⛔ destinationWarehouseId 없음. */
export function buildTermCreatePayload(form: SupplierSkuCreateForm): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    skuId: form.skuId,
    supplyType: form.supplyType,
    effectiveFrom: form.effectiveFrom,
    supplierSkuCode: optionalText(form.supplierSkuCode),
    supplierSkuName: optionalText(form.supplierSkuName),
    moq: optionalDecimal(form.moq),
    orderMultiple: optionalDecimal(form.orderMultiple),
    leadTimeDays: leadTimePayload(form.leadTimeDays),
    purchaseUom: optionalText(form.purchaseUom),
    isPrimary: form.isPrimary,
  };
  // currency 는 API optional 이고 DB default 가 있다 — 빈 값이면 보내지 않는다.
  const currency = form.currency.trim();
  if (currency !== '') payload['currency'] = currency;
  const effectiveTo = form.effectiveTo.trim();
  if (effectiveTo !== '') payload['effectiveTo'] = effectiveTo;
  return payload;
}

/** mode A — body 는 **정확히 `{effectiveTo}`** 다 (D-17). 다른 필드 금지. */
export function buildTermClosePayload(effectiveTo: string): Record<string, unknown> {
  return { effectiveTo: effectiveTo.trim() };
}

const VERSION_FIELDS = [
  'supplierSkuCode',
  'supplierSkuName',
  'supplyType',
  'moq',
  'orderMultiple',
  'leadTimeDays',
  'purchaseUom',
  'currency',
  'isPrimary',
] as const;

/**
 * mode B payload — `effectiveFrom` + **변경된 필드만**.
 *
 * successor `effectiveTo` 는 명시하면 그 값, 생략하면 기존 종료일을 상속하므로
 * 원본과 다를 때만 담는다 (§28 의 "실질 변경" 판정에도 이 값이 포함된다).
 */
export function buildTermVersionPayload(
  form: SupplierSkuVersionForm,
  original: SupplierSkuViewLike,
): Record<string, unknown> {
  const base = toVersionForm(original);
  const payload: Record<string, unknown> = { effectiveFrom: form.effectiveFrom.trim() };

  for (const field of VERSION_FIELDS) {
    if (form[field] === base[field]) continue;
    if (field === 'moq' || field === 'orderMultiple') {
      payload[field] = optionalDecimal(form[field]);
    } else if (field === 'leadTimeDays') {
      payload[field] = leadTimePayload(form[field]);
    } else if (field === 'supplyType' || field === 'isPrimary') {
      payload[field] = form[field];
    } else if (field === 'currency') {
      payload[field] = form[field].trim();
    } else {
      payload[field] = optionalText(form[field]);
    }
  }

  if (form.effectiveTo !== base.effectiveTo) {
    payload['effectiveTo'] = form.effectiveTo.trim() === '' ? null : form.effectiveTo.trim();
  }

  return payload;
}

/**
 * mode B 를 제출할 수 있는가 (§28).
 *
 * 새 시작일이 있어야 하고, **실질 변경이 최소 1개** 있어야 한다 — 변경이 없으면
 * backend 가 400 이므로 요청 자체를 만들지 않는다.
 */
export function canSubmitVersion(
  form: SupplierSkuVersionForm,
  original: SupplierSkuViewLike,
): boolean {
  if (form.effectiveFrom.trim() === '') return false;
  const payload = buildTermVersionPayload(form, original);
  return Object.keys(payload).length > 1;
}
