import { z } from 'zod';

import { isNegative, isZero, toDecimal, type Decimal } from '@/shared/decimal';
import { ValidationError } from '@/shared/errors';

/**
 * SKU CRUD DTO (T1-3) — Zod strict.
 *
 * ## 원칙
 *
 *   - `strictObject` — 알 수 없는 필드는 조용히 버리지 않고 400 으로 거부한다.
 *   - ⛔ server-managed 필드는 입력받지 않는다:
 *     `id`·`status`·`hasTransaction`·`createdAt`·`createdBy`·`updatedAt`·
 *     `updatedBy`·`approvedAt`·`approvedBy`·`deletedAt`
 *     그리고 폐기 설계 `negativeStockAllowed`.
 *   - **정규화 금지** — `' ABC '` 를 `'ABC'` 로 자동 저장하지 않는다.
 *     trim 되지 않은 입력은 거부한다. 대소문자도 접지 않는다.
 *   - 코드 패턴 위반은 ERROR 가 아니다 — 원본에 코드체계 예외 SKU 가 실존하므로
 *     패턴 검사를 하지 않는다 (WARNING workflow 는 후속 Task).
 *   - Decimal 은 **문자열로만** 받아 shared/decimal 의 `toDecimal` 로 해석한다.
 *     JSON number 는 파싱 시점에 이미 이진 부동소수 정밀도가 적용되므로 거부한다
 *     (shared/decimal 의 `DecimalInput` 도 number 를 제외한다 — 같은 정책).
 *     기존 API 에 Decimal DTO 선례가 없어 이 계약(양방향 문자열, audit
 *     serialize 와 동일)이 첫 convention 이다.
 */

/** trim 된 비어 있지 않은 문자열 — 자동 trim 하지 않고 위반을 거부한다. */
function trimmedNonEmpty(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => value.length > 0 && value === value.trim(), {
      message: '빈 값·앞뒤 공백은 허용되지 않습니다.',
    });
}

/** trim 규칙만 적용된 선택 문자열 (내용은 원문 보존). */
function optionalTrimmedText(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => value.length > 0 && value === value.trim(), {
      message: '빈 값·앞뒤 공백은 허용되지 않습니다.',
    })
    .nullish();
}

/** Decimal 입력 — **문자열만**. shared `toDecimal` 로만 해석한다 (number 변환 금지 정책). */
const decimalInput = z
  .string({ error: '수량은 문자열이어야 합니다. (JSON number 는 정밀도 훼손 위험으로 거부)' })
  .transform((value, ctx) => {
    try {
      return toDecimal(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: '숫자 형식이 올바르지 않습니다.' });
      return z.NEVER;
    }
  });

function positiveDecimal() {
  return decimalInput.refine((value: Decimal) => !isNegative(value) && !isZero(value), {
    message: '0 보다 커야 합니다.',
  });
}

function nonNegativeDecimal() {
  return decimalInput.refine((value: Decimal) => !isNegative(value), {
    message: '0 이상이어야 합니다.',
  });
}

const nonNegativeInt = z.number().int().min(0);

/** `YYYY-MM-DD` (단종예정일). */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다.')
  .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()), {
    message: '존재하지 않는 날짜입니다.',
  });

/**
 * 사용자 입력 가능 필드 전체 — Create 는 이 중 필수 4종 + 선택,
 * Update 는 전부 선택(partial) 이다.
 */
const editableFields = {
  skuCode: trimmedNonEmpty(80),
  skuName: trimmedNonEmpty(255),
  skuNameEn: optionalTrimmedText(255),
  itemType: trimmedNonEmpty(40),

  brandId: z.uuid().nullish(),
  majorCategoryId: z.uuid().nullish(),
  minorCategoryId: z.uuid().nullish(),

  /** 앞자리 0 보존 — 문자열. 숫자 변환 금지. */
  serialNumber: optionalTrimmedText(20),
  additionalCode: optionalTrimmedText(30),

  baseUom: trimmedNonEmpty(20),
  purchaseUom: optionalTrimmedText(20),
  unitConversionQty: positiveDecimal(),

  inventoryManaged: z.boolean(),
  sellable: z.boolean(),
  purchasable: z.boolean(),
  manufacturable: z.boolean(),

  lotManaged: z.boolean(),
  expiryManaged: z.boolean(),
  serialManaged: z.boolean(),

  defaultShelfLifeDays: nonNegativeInt.nullish(),
  minimumRemainingDays: nonNegativeInt.nullish(),
  reconciliationToleranceQty: nonNegativeDecimal(),

  /** 원본 ERP 값 보존 — 의미 변환 없음. */
  erpItemType: optionalTrimmedText(10),
  discontinuationDate: dateString.nullish(),
  note: z.string().max(2000).nullish(),
} as const;

/**
 * 생성 DTO. 필수: skuCode·skuName·itemType (+ baseUom 등은 기본값).
 *
 * ⛔ strict — server-managed 필드(`status`·`hasTransaction`·`negativeStockAllowed` 등)가
 *    오면 알 수 없는 필드로 400.
 */
export const createSkuSchema = z.strictObject({
  ...editableFields,
  skuNameEn: editableFields.skuNameEn.optional(),
  brandId: editableFields.brandId.optional(),
  majorCategoryId: editableFields.majorCategoryId.optional(),
  minorCategoryId: editableFields.minorCategoryId.optional(),
  serialNumber: editableFields.serialNumber.optional(),
  additionalCode: editableFields.additionalCode.optional(),
  baseUom: editableFields.baseUom.optional(),
  purchaseUom: editableFields.purchaseUom.optional(),
  unitConversionQty: editableFields.unitConversionQty.optional(),
  inventoryManaged: editableFields.inventoryManaged.optional(),
  sellable: editableFields.sellable.optional(),
  purchasable: editableFields.purchasable.optional(),
  manufacturable: editableFields.manufacturable.optional(),
  lotManaged: editableFields.lotManaged.optional(),
  expiryManaged: editableFields.expiryManaged.optional(),
  serialManaged: editableFields.serialManaged.optional(),
  defaultShelfLifeDays: editableFields.defaultShelfLifeDays.optional(),
  minimumRemainingDays: editableFields.minimumRemainingDays.optional(),
  reconciliationToleranceQty: editableFields.reconciliationToleranceQty.optional(),
  erpItemType: editableFields.erpItemType.optional(),
  discontinuationDate: editableFields.discontinuationDate.optional(),
  note: editableFields.note.optional(),
});

export type CreateSkuInput = z.infer<typeof createSkuSchema>;

/** 수정 DTO — partial + strict. 빈 객체는 거부한다. */
export const updateSkuSchema = z
  .strictObject(
    Object.fromEntries(
      Object.entries(editableFields).map(([key, schema]) => [key, schema.optional()]),
    ) as { [K in keyof typeof editableFields]: z.ZodOptional<(typeof editableFields)[K]> },
  )
  .refine((value) => Object.keys(value).length > 0, {
    message: '변경할 필드를 최소 하나 지정하세요.',
  });

export type UpdateSkuInput = z.infer<typeof updateSkuSchema>;

/** Zod 오류 → 공통 ValidationError (fieldErrors 공개, raw Zod 오류 비노출). */
function toValidationError(error: z.ZodError, message: string): ValidationError {
  return new ValidationError(
    error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'body',
      message: issue.message,
    })),
    { message },
  );
}

export function parseCreateSkuInput(body: unknown): CreateSkuInput {
  const result = createSkuSchema.safeParse(body);
  if (!result.success) throw toValidationError(result.error, 'SKU 생성 요청이 올바르지 않습니다.');
  return result.data;
}

export function parseUpdateSkuInput(body: unknown): UpdateSkuInput {
  const result = updateSkuSchema.safeParse(body);
  if (!result.success) throw toValidationError(result.error, 'SKU 수정 요청이 올바르지 않습니다.');
  return result.data;
}

/** 경로 파라미터 `{id}` — UUID 형식 검증 (형식 오류는 404 가 아니라 400). */
export function parseSkuId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new ValidationError([{ path: 'id', message: 'UUID 형식이어야 합니다.' }], {
      message: 'SKU id 가 올바르지 않습니다.',
    });
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// 목록 쿼리
// ═══════════════════════════════════════════════════════════════

export const SKU_SORTS = [
  'updatedAt_desc',
  'updatedAt_asc',
  'skuCode_asc',
  'skuCode_desc',
] as const;

export type SkuSort = (typeof SKU_SORTS)[number];

/**
 * `GET /api/skus` 쿼리 (T1-3 지원 범위).
 *
 * ⛔ 미래 모델 의존 필터(`hasBom`·`mappingStatus`·`hasIssue`)와 그 외 알 수 없는
 *    파라미터는 **조용히 무시하지 않는다** — 라우트가 화이트리스트 밖 키를
 *    명시적으로 400 처리한다.
 */
export const listSkusQuerySchema = z.strictObject({
  /** skuCode·skuName·skuNameEn 통합 검색 (바코드·외부별칭은 해당 모델 도입 후) */
  q: z.string().trim().min(1).max(100).optional(),
  status: z
    .enum([
      'DRAFT',
      'PENDING_APPROVAL',
      'REJECTED',
      'ACTIVE',
      'INACTIVE',
      'DISCONTINUED',
      'ARCHIVED',
    ])
    .optional(),
  itemType: z.string().trim().min(1).max(40).optional(),
  brandId: z.uuid().optional(),
  majorCategoryId: z.uuid().optional(),
  minorCategoryId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  /** 기본 updatedAt_desc (화면 문서 기준). tie-breaker 는 id ASC 고정. */
  sort: z.enum(SKU_SORTS).default('updatedAt_desc'),
});

export type ListSkusQuery = z.infer<typeof listSkusQuerySchema>;

/** 화이트리스트에 없는 쿼리 파라미터를 명시적으로 거부한다. */
export function parseListSkusQuery(searchParams: URLSearchParams): ListSkusQuery {
  const allowed = new Set(Object.keys(listSkusQuerySchema.shape));
  const unknownKeys = [...new Set([...searchParams.keys()])].filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      unknownKeys.map((key) => ({
        path: key,
        message:
          '지원하지 않는 파라미터입니다. (hasBom·mappingStatus·hasIssue 는 해당 모델 도입 후 지원)',
      })),
      { message: '지원하지 않는 목록 파라미터가 있습니다.' },
    );
  }

  const raw: Record<string, string> = {};
  for (const key of allowed) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = value;
  }

  const result = listSkusQuerySchema.safeParse(raw);
  if (!result.success) {
    throw toValidationError(result.error, 'SKU 목록 쿼리가 올바르지 않습니다.');
  }
  return result.data;
}
