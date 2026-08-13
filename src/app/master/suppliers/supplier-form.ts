/**
 * 거래처 폼 상태 ↔ API payload 변환 (T06-4, D-6·D-7) — 순수 함수만.
 *
 * ⚠️ Decimal 은 이 화면에 없다(거래처 본체엔 Decimal 필드가 없다). 공급조건·
 *    가격의 Decimal 변환은 `terms-form.ts`·`price-form.ts` 가 맡는다.
 *
 * ⛔ **폼에 존재하지 않는 필드**: `status`(D-8 — 표시 전용) ·
 *    `defaultWarehouseId`(D-20 — T08 staged) · `createdBy`/`updatedBy`/
 *    `approvedBy`/`deletedAt`. 보내면 API 가 400 이다.
 * ⛔ `supplierCode` 는 create 에만 있다 — edit 에서는 **immutable** 이다 (D-7).
 */

export interface SupplierCreateForm {
  supplierCode: string;
  supplierName: string;
  supplierType: string;
  businessRegistrationNo: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  defaultLeadTimeDays: string;
  note: string;
}

export const EMPTY_SUPPLIER_CREATE_FORM: SupplierCreateForm = {
  supplierCode: '',
  supplierName: '',
  supplierType: '',
  businessRegistrationNo: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
  defaultLeadTimeDays: '',
  note: '',
};

/** edit 는 create 에서 `supplierCode` 를 뺀 정확히 8필드다 (D-7). */
export type SupplierEditForm = Omit<SupplierCreateForm, 'supplierCode'>;

export const SUPPLIER_EDIT_FIELDS = [
  'supplierName',
  'supplierType',
  'businessRegistrationNo',
  'contactName',
  'contactPhone',
  'contactEmail',
  'defaultLeadTimeDays',
  'note',
] as const;

export interface SupplierViewLike {
  readonly supplierName: string;
  readonly supplierType: string;
  readonly businessRegistrationNo: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly defaultLeadTimeDays: number | null;
  readonly note: string | null;
}

/** 서버 값 → edit 폼. `null` 은 빈 문자열, **`0` 은 `"0"`** 이다 (G-03). */
export function toSupplierEditForm(supplier: SupplierViewLike): SupplierEditForm {
  return {
    supplierName: supplier.supplierName,
    supplierType: supplier.supplierType,
    businessRegistrationNo: supplier.businessRegistrationNo ?? '',
    contactName: supplier.contactName ?? '',
    contactPhone: supplier.contactPhone ?? '',
    contactEmail: supplier.contactEmail ?? '',
    defaultLeadTimeDays:
      supplier.defaultLeadTimeDays === null ? '' : String(supplier.defaultLeadTimeDays),
    note: supplier.note ?? '',
  };
}

/** 빈 문자열 → `null`(값 제거), 그 밖에는 trim 값. */
function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 리드타임 입력 → API 값.
 *
 * ★ `''` 는 **미입력(null)**, `'0'` 은 **즉시납 0** 이다 — 둘을 합치지 않는다.
 * 숫자가 아니면 `NaN` 대신 원문을 그대로 넘겨 backend 400 을 보이게 한다.
 */
export function toLeadTimeDaysPayload(value: string): number | string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : trimmed;
}

export function buildSupplierCreatePayload(form: SupplierCreateForm): Record<string, unknown> {
  return {
    supplierCode: form.supplierCode.trim(),
    supplierName: form.supplierName.trim(),
    supplierType: form.supplierType.trim(),
    businessRegistrationNo: optionalText(form.businessRegistrationNo),
    contactName: optionalText(form.contactName),
    contactPhone: optionalText(form.contactPhone),
    contactEmail: optionalText(form.contactEmail),
    defaultLeadTimeDays: toLeadTimeDaysPayload(form.defaultLeadTimeDays),
    note: optionalText(form.note),
    // ⛔ status·defaultWarehouseId 를 넣지 않는다 (D-8·D-20).
  };
}

/**
 * edit payload — **변경된 필드만** 담는다.
 *
 * PATCH 는 `undefined`=미변경 / `null`=값 제거 계약이라, 바뀌지 않은 필드를
 * 굳이 보내지 않는다. 변경이 0건이면 `{}` 를 돌려주며 호출부가 Save 를
 * 비활성화한다(backend 는 no-op 200 이지만 요청 자체를 만들지 않는다, D-7).
 */
export function buildSupplierUpdatePayload(
  form: SupplierEditForm,
  original: SupplierViewLike,
): Record<string, unknown> {
  const base = toSupplierEditForm(original);
  const payload: Record<string, unknown> = {};

  for (const field of SUPPLIER_EDIT_FIELDS) {
    if (form[field] === base[field]) continue;
    if (field === 'defaultLeadTimeDays') {
      payload[field] = toLeadTimeDaysPayload(form[field]);
    } else if (field === 'supplierName' || field === 'supplierType') {
      // NOT NULL — null 로 비우지 않는다. 빈 값이면 그대로 보내 backend 400.
      payload[field] = form[field].trim();
    } else {
      payload[field] = optionalText(form[field]);
    }
  }

  return payload;
}

/** 변경이 하나라도 있는가 — Save 활성화 판정에 쓴다. */
export function hasSupplierChanges(form: SupplierEditForm, original: SupplierViewLike): boolean {
  return Object.keys(buildSupplierUpdatePayload(form, original)).length > 0;
}
