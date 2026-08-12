import { z } from 'zod';

import { ValidationError } from '@/shared/errors';

/**
 * 거래처·공급조건 API DTO (T06-2).
 *
 * ⚠️ 근거: `docs/17_설계복구_거래처공급조건.md` §39~ (T06-2 Recovery — D-2·D-4~
 *    D-8·D-12~D-15). 원 API 문서(`05:97`)는 `CreateSupplierDto` 라는 이름만 있고
 *    필드 정의가 없었으며, 공급조건 DTO 는 `{skuId, supplyType, moq?, ...}` 로
 *    말줄임표였다. 추론하지 않고 Recovery Decision 이 확정한 계약으로 고정한다.
 *
 * ⛔ `strictObject` — unknown field 는 400 이다. 조용히 무시하지 않는다.
 */

/** DB 물리 용량 (T06-1 `supplier` / `supplier_sku`). 업무 길이 규칙이 아니다. */
export const SUPPLIER_CODE_MAX_LENGTH = 50;
export const SUPPLIER_NAME_MAX_LENGTH = 150;
export const SUPPLIER_TYPE_MAX_LENGTH = 30;
export const BUSINESS_REGISTRATION_NO_MAX_LENGTH = 30;
export const SUPPLIER_SKU_CODE_MAX_LENGTH = 100;
export const SUPPLIER_SKU_NAME_MAX_LENGTH = 255;
export const PURCHASE_UOM_MAX_LENGTH = 20;
export const CURRENCY_MAX_LENGTH = 3;

/** 서버 고정 페이지 크기 — `pageSize` 쿼리를 받지 않는다 (D-2·D-10). */
export const SUPPLIER_PAGE_SIZE = 50;

/** T06-1 `SupplyType` enum 과 동일한 2종. 세 번째 값을 발명하지 않는다. */
export const SUPPLY_TYPES = ['SELF_SUPPLIED', 'TURNKEY'] as const;
export type SupplyTypeValue = (typeof SUPPLY_TYPES)[number];

// ═══════════════════════════════════════════════════════════════
// 공통 조각
// ═══════════════════════════════════════════════════════════════

/** `YYYY-MM-DD` — DB `@db.Date` 와 동일한 date-only semantics. */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다.')
  .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()), {
    error: '존재하지 않는 날짜입니다.',
  });

/** date-only 문자열 → UTC 자정 Date. DB timezone 에 따라 하루 밀리지 않는다. */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * `moq`/`orderMultiple` — Decimal(18,6) **문자열 전용** (D-8·§19 Decimal 계약).
 *
 * ⛔ JSON number 입력은 400 이다 — `z.string()` 이 타입 자체로 거부한다.
 * ⛔ `Number()`/`parseFloat()` 를 쓰지 않는다 — 정밀도 손실 금지.
 * ★ 값이 있으면 **0 보다 커야** 한다 (DB CHECK 와 동일). 0·음수는 400.
 */
const positiveDecimalString = z
  .string()
  .regex(/^\d{1,12}(?:\.\d{1,6})?$/, {
    error: '수량은 소수 6자리 이하의 십진 문자열이어야 합니다. (예: "100" / "12.5")',
  })
  .refine((value) => /[1-9]/.test(value), { error: '0 보다 커야 합니다.' });

/** 음수 없는 정수 일수. `0` 은 명시적 즉시납으로 **유효한 값**이다 (§00 G-03). */
const leadTimeDaysSchema = z.number().int().min(0, '리드타임은 0 이상이어야 합니다.');

const requiredCode = (max: number) => z.string().trim().min(1).max(max);

export function toValidationError(
  issues: readonly z.core.$ZodIssue[],
  message: string,
): ValidationError {
  return new ValidationError(
    issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'body',
      message: issue.message,
    })),
    { message },
  );
}

// ═══════════════════════════════════════════════════════════════
// Supplier — 목록
// ═══════════════════════════════════════════════════════════════

/**
 * `GET /api/suppliers` 쿼리 — 정확히 `q`·`supplierType`·`status`·`page` 4개 (D-2).
 *
 * ⛔ `pageSize`·`sort` 를 받지 않는다 — 크기는 서버 고정 50, 정렬은
 *    `supplierCode ASC, id ASC` 고정이다.
 */
export const listSuppliersQuerySchema = z.strictObject({
  /** supplierCode·supplierName **만** 통합 검색 (contains, 대소문자 무시). */
  q: z.string().trim().min(1).max(100).optional(),
  supplierType: z.string().trim().min(1).max(SUPPLIER_TYPE_MAX_LENGTH).optional(),
  status: z.string().trim().min(1).max(20).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;

export function parseListSuppliersQuery(searchParams: URLSearchParams): ListSuppliersQuery {
  const allowed = new Set(Object.keys(listSuppliersQuerySchema.shape));
  const unknownKeys = [...new Set([...searchParams.keys()])].filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      unknownKeys.map((key) => ({
        path: key,
        message: '지원하지 않는 파라미터입니다. (pageSize 는 서버 고정 50, sort 는 미지원)',
      })),
      { message: '지원하지 않는 목록 파라미터가 있습니다.' },
    );
  }

  const raw: Record<string, string> = {};
  for (const key of allowed) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = value;
  }

  const result = listSuppliersQuerySchema.safeParse(raw);
  if (!result.success) {
    throw toValidationError(result.error.issues, '거래처 목록 쿼리가 올바르지 않습니다.');
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// Supplier — 생성 · 수정
// ═══════════════════════════════════════════════════════════════

/**
 * `POST /api/suppliers` body (D-4).
 *
 * ⛔ server-managed 라 받지 않는다: `id` · `status`(항상 DB default ACTIVE) ·
 *    `createdAt` · `updatedAt`.
 * ⛔ T08-1 전까지 받지 않는다: `defaultWarehouseId` (Warehouse FK 가 없어
 *    존재 검증이 불가능하다 — 임의 UUID 를 업무 API 로 저장하지 않는다, D-9).
 *
 * ★ `supplierType` 은 **open string** 이다 (D-5) — MANUFACTURER / VENDOR /
 *   THREE_PL / FORWARDER 는 known examples 이며 allow-list 를 만들지 않는다.
 *   nonblank + 최대 30자만 본다.
 */
export const createSupplierSchema = z.strictObject({
  supplierCode: requiredCode(SUPPLIER_CODE_MAX_LENGTH),
  supplierName: requiredCode(SUPPLIER_NAME_MAX_LENGTH),
  supplierType: requiredCode(SUPPLIER_TYPE_MAX_LENGTH),

  businessRegistrationNo: z.string().max(BUSINESS_REGISTRATION_NO_MAX_LENGTH).nullable().optional(),
  contactName: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  defaultLeadTimeDays: leadTimeDaysSchema.nullable().optional(),
  note: z.string().nullable().optional(),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export function parseCreateSupplierInput(body: unknown): CreateSupplierInput {
  const result = createSupplierSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '거래처 등록 요청이 올바르지 않습니다.');
  }
  return result.data;
}

const SUPPLIER_PATCH_FIELDS = [
  'supplierName',
  'supplierType',
  'businessRegistrationNo',
  'contactName',
  'contactPhone',
  'contactEmail',
  'defaultLeadTimeDays',
  'note',
] as const;

/**
 * `PATCH /api/suppliers/{id}` body (D-8) — 최소 하나 필수, `{}` 는 400.
 *
 *   - `undefined` = 미변경 / `null` = 값 제거 / 값 = 변경.
 *   - `supplierName`·`supplierType` 은 null 불가 (DB NOT NULL).
 * ⛔ `supplierCode` 는 **create-only immutable identity** 다 (D-7) — 보내면 400.
 * ⛔ `status` 는 이번 T06-2 에서 mutation 대상이 아니다 (D-6) — 보내면 400.
 *    lifecycle(비활성화·archive)이 필요해지면 별도 Recovery 다.
 * ⛔ `defaultWarehouseId` 도 받지 않는다 (D-9).
 */
export const updateSupplierSchema = z
  .strictObject({
    supplierName: requiredCode(SUPPLIER_NAME_MAX_LENGTH).optional(),
    supplierType: requiredCode(SUPPLIER_TYPE_MAX_LENGTH).optional(),
    businessRegistrationNo: z
      .string()
      .max(BUSINESS_REGISTRATION_NO_MAX_LENGTH)
      .nullable()
      .optional(),
    contactName: z.string().nullable().optional(),
    contactPhone: z.string().nullable().optional(),
    contactEmail: z.string().nullable().optional(),
    defaultLeadTimeDays: leadTimeDaysSchema.nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .refine((value) => SUPPLIER_PATCH_FIELDS.some((field) => value[field] !== undefined), {
    error: '변경할 필드를 최소 하나 지정해야 합니다.',
  });

export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export function parseUpdateSupplierInput(body: unknown): UpdateSupplierInput {
  const result = updateSupplierSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '거래처 수정 요청이 올바르지 않습니다.');
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// SupplierSku — 목록 · 생성
// ═══════════════════════════════════════════════════════════════

/** `GET /api/suppliers/{id}/skus` 쿼리 — `page` 하나뿐 (D-10). */
export const listSupplierSkusQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
});

export type ListSupplierSkusQuery = z.infer<typeof listSupplierSkusQuerySchema>;

export function parseListSupplierSkusQuery(searchParams: URLSearchParams): ListSupplierSkusQuery {
  const unknownKeys = [...new Set([...searchParams.keys()])].filter((key) => key !== 'page');
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      unknownKeys.map((key) => ({
        path: key,
        message: '지원하지 않는 파라미터입니다. (공급조건 목록은 page 만 받습니다)',
      })),
      { message: '지원하지 않는 목록 파라미터가 있습니다.' },
    );
  }

  const raw: Record<string, string> = {};
  const page = searchParams.get('page');
  if (page !== null) raw['page'] = page;

  const result = listSupplierSkusQuerySchema.safeParse(raw);
  if (!result.success) {
    throw toValidationError(result.error.issues, '공급조건 목록 쿼리가 올바르지 않습니다.');
  }
  return result.data;
}

/**
 * `POST /api/suppliers/{id}/skus` body (D-12).
 *
 * 원문 `{skuId, supplyType, moq?, leadTimeDays?, ...}` 의 말줄임표를 확정한 계약이다.
 *
 *   - `supplyType`·`effectiveFrom` 은 **required** — DB default 가 있어도 API 는
 *     명시적으로 받는다 (docs/17 §11 "DB default 와 API required 는 분리한다").
 *   - `effectiveFrom` 에 server today default 를 만들지 않는다 (D-13).
 *   - `effectiveTo` 는 optional — null/생략 = open-ended, 미래 종료일 허용 (D-14).
 * ⛔ `supplierId` 는 경로에서만 온다 — body 에 보내면 400.
 * ⛔ `destinationWarehouseId` 는 T08-1 전까지 받지 않는다 (D-9).
 * ⛔ `price`·`approvedBy`·`createdAt` 도 받지 않는다.
 */
export const createSupplierSkuSchema = z.strictObject({
  skuId: z.uuid({ error: 'SKU id 는 UUID 형식이어야 합니다.' }),
  supplyType: z.enum(SUPPLY_TYPES),
  effectiveFrom: dateString,

  supplierSkuCode: z.string().max(SUPPLIER_SKU_CODE_MAX_LENGTH).nullable().optional(),
  supplierSkuName: z.string().max(SUPPLIER_SKU_NAME_MAX_LENGTH).nullable().optional(),

  moq: positiveDecimalString.nullable().optional(),
  orderMultiple: positiveDecimalString.nullable().optional(),
  leadTimeDays: leadTimeDaysSchema.nullable().optional(),

  purchaseUom: z.string().max(PURCHASE_UOM_MAX_LENGTH).nullable().optional(),
  currency: z.string().trim().min(1).max(CURRENCY_MAX_LENGTH).optional(),

  isPrimary: z.boolean().optional(),

  effectiveTo: dateString.nullable().optional(),
});

export type CreateSupplierSkuInput = z.infer<typeof createSupplierSkuSchema>;

export function parseCreateSupplierSkuInput(body: unknown): CreateSupplierSkuInput {
  const result = createSupplierSkuSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '공급조건 등록 요청이 올바르지 않습니다.');
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// SupplierSku — PATCH (temporal versioning, D-15)
// ═══════════════════════════════════════════════════════════════

/**
 * `PATCH /api/supplier-skus/{id}` 는 **제자리 수정 API 가 아니다** —
 * 공급조건은 effective-dated history 라 두 mode 만 허용한다 (D-15·D-16).
 *
 *   - **mode A (종료)**: body 가 정확히 `{effectiveTo}` — 기존 row 의 기간을
 *     닫거나 앞당긴다. 연장·reopen(`null`) 은 불가.
 *   - **mode B (새 버전)**: body 에 `effectiveFrom` 필수 + 실질 변경 최소 1개.
 *     기존 row 를 `effectiveFrom` 에서 닫고 **후속 version row 를 새로 만든다**.
 *
 * ⛔ `supplierId`·`skuId` 는 identity 라 immutable — 보내면 400.
 * ⛔ business field 만 보내면(= `effectiveFrom` 없이) in-place 수정 요청이므로
 *    400 이다 — 과거·현재·미래 어느 row 도 제자리에서 덮어쓰지 않는다.
 * ⛔ `{}` 도 400 — 공급조건 PATCH 에 no-op 은 없다.
 */
const versionFieldsShape = {
  supplierSkuCode: z.string().max(SUPPLIER_SKU_CODE_MAX_LENGTH).nullable().optional(),
  supplierSkuName: z.string().max(SUPPLIER_SKU_NAME_MAX_LENGTH).nullable().optional(),
  supplyType: z.enum(SUPPLY_TYPES).optional(),
  moq: positiveDecimalString.nullable().optional(),
  orderMultiple: positiveDecimalString.nullable().optional(),
  leadTimeDays: leadTimeDaysSchema.nullable().optional(),
  purchaseUom: z.string().max(PURCHASE_UOM_MAX_LENGTH).nullable().optional(),
  currency: z.string().trim().min(1).max(CURRENCY_MAX_LENGTH).optional(),
  isPrimary: z.boolean().optional(),
} as const;

export const VERSION_FIELD_KEYS = [
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

/** mode A — 정확히 `{effectiveTo: "YYYY-MM-DD"}`. `null` 로 reopen 불가. */
const closeSchema = z.strictObject({ effectiveTo: dateString });

/** mode B — `effectiveFrom` 필수 + 실질 변경(version field 또는 effectiveTo) 최소 1개. */
const versionSchema = z
  .strictObject({
    effectiveFrom: dateString,
    effectiveTo: dateString.nullable().optional(),
    ...versionFieldsShape,
  })
  .refine(
    (value) =>
      value.effectiveTo !== undefined ||
      VERSION_FIELD_KEYS.some((field) => value[field] !== undefined),
    {
      error:
        'effectiveFrom 만으로는 새 버전을 만들 수 없습니다 — 변경할 조건을 최소 하나 지정하세요.',
    },
  );

export type CloseSupplierSkuInput = z.infer<typeof closeSchema>;
export type VersionSupplierSkuInput = z.infer<typeof versionSchema>;

export type UpdateSupplierSkuInput =
  | { readonly mode: 'close'; readonly input: CloseSupplierSkuInput }
  | { readonly mode: 'version'; readonly input: VersionSupplierSkuInput };

export function parseUpdateSupplierSkuInput(body: unknown): UpdateSupplierSkuInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError([{ path: 'body', message: 'JSON 객체 본문이 필요합니다.' }], {
      message: '공급조건 수정 요청이 올바르지 않습니다.',
    });
  }

  const keys = Object.keys(body);

  // identity 는 어느 mode 에서도 immutable — 구체적인 메시지로 먼저 거른다.
  for (const identity of ['supplierId', 'skuId'] as const) {
    if (keys.includes(identity)) {
      throw new ValidationError(
        [{ path: identity, message: '공급조건의 identity 필드는 변경할 수 없습니다.' }],
        { message: '공급조건 수정 요청이 올바르지 않습니다.' },
      );
    }
  }

  // ── mode B — effectiveFrom 이 있으면 새 버전 생성이다 ─────
  if (keys.includes('effectiveFrom')) {
    const result = versionSchema.safeParse(body);
    if (!result.success) {
      throw toValidationError(result.error.issues, '공급조건 버전 생성 요청이 올바르지 않습니다.');
    }
    return { mode: 'version', input: result.data };
  }

  // ── mode A — 정확히 {effectiveTo} 만 허용한다 ─────────────
  if (keys.length === 1 && keys[0] === 'effectiveTo') {
    const result = closeSchema.safeParse(body);
    if (!result.success) {
      throw toValidationError(result.error.issues, '공급조건 종료 요청이 올바르지 않습니다.');
    }
    return { mode: 'close', input: result.data };
  }

  // business field 를 제자리에서 고치려는 요청 — temporal 계약 위반이다.
  throw new ValidationError(
    [
      {
        path: 'body',
        message:
          '공급조건은 제자리 수정이 불가능합니다. 종료는 {effectiveTo}, ' +
          '조건 변경은 effectiveFrom + 변경 필드로 새 버전을 만드세요.',
      },
    ],
    { message: '공급조건 수정 요청이 올바르지 않습니다.' },
  );
}

// ═══════════════════════════════════════════════════════════════
// 경로 식별자
// ═══════════════════════════════════════════════════════════════

/** 경로 식별자는 UUID 다. 형식 오류는 400 (404 가 아니다). */
export function parseSupplierId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new ValidationError([{ path: 'id', message: 'UUID 형식이어야 합니다.' }], {
      message: '거래처 id 가 올바르지 않습니다.',
    });
  }
  return result.data;
}

export function parseSupplierSkuId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new ValidationError([{ path: 'id', message: 'UUID 형식이어야 합니다.' }], {
      message: '공급조건 id 가 올바르지 않습니다.',
    });
  }
  return result.data;
}
