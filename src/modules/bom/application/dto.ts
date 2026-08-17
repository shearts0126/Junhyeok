import { z } from 'zod';

import { ValidationError } from '@/shared/errors';

/**
 * BOM API DTO (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-14(exact DTO) · §D-9(라인 필드별 계약)
 *    · §D-5(적용기간) · §D-10(소요량) · §D-3(대체그룹).
 *
 * ⛔ `strictObject` — unknown field 는 **400** 이다. 조용히 무시하지 않는다.
 * ⛔ Decimal 은 전부 **십진 문자열** — JSON number 는 `z.string()` 이 타입으로 400.
 * ⛔ server-managed 필드(`id`·`status`·`createdBy`·`approvedAt/By`·`activatedAt`
 *    ·`createdAt`·`legacyBomCode`·`legacyCommonBomCode`·`lines`)는 요청에 있으면
 *    strict 가 400 으로 거부한다.
 */

// ═══════════════════════════════════════════════════════════════
// 상수 — DB 물리 용량 (T07-1 schema). 업무 길이 규칙이 아니다.
// ═══════════════════════════════════════════════════════════════

export const BOM_VERSION_MAX_LENGTH = 20;
export const BOM_UOM_MAX_LENGTH = 20;
export const BOM_ALTERNATE_GROUP_MAX_LENGTH = 50;

/** 서버 고정 페이지 크기 — `pageSize` 쿼리를 받지 않는다 (D-14). */
export const BOM_PAGE_SIZE = 50;

export const BOM_TYPES = ['MANUFACTURING', 'KIT', 'REPACK'] as const;
export const BOM_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'ACTIVE',
  'INACTIVE',
  'ARCHIVED',
  'REJECTED',
] as const;
export const COMPONENT_ROLES = ['PRODUCT', 'MATERIAL', 'PACKAGING', 'SERVICE'] as const;
export const BOM_SUPPLY_TYPES = ['SELF_SUPPLIED', 'TURNKEY'] as const;
export const BOM_QUANTITY_STATUSES = ['CONFIRMED', 'SUGGESTED', 'UNKNOWN'] as const;

// ═══════════════════════════════════════════════════════════════
// 공통 조각
// ═══════════════════════════════════════════════════════════════

/** `YYYY-MM-DD` — DB `@db.Date` 와 같은 date-only semantics. */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다.')
  .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()), {
    error: '존재하지 않는 날짜입니다.',
  });

/**
 * date-only 문자열 → **UTC 자정** `Date`.
 *
 * ⛔ 로컬 타임존 파싱(`new Date('2026-08-16')` 의 런타임 의존 해석)을 쓰지 않는다 —
 *    DB `@db.Date` round-trip 에서 하루가 밀린다.
 */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** `Date`(UTC 자정) → `YYYY-MM-DD`. */
export function toDateOnlyString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * `> 0` 인 Decimal(18,6) 문자열. `outputQty` · `packQuantity` 용.
 *
 * ⛔ `Number()`/`parseFloat()` 금지 — 판정을 전부 문자열로 한다.
 */
const positiveDecimal18_6 = z
  .string()
  .regex(/^\d{1,12}(?:\.\d{1,6})?$/, {
    error: '수량은 소수 6자리 이하의 십진 문자열이어야 합니다. (예: "1" / "0.033333")',
  })
  .refine((value) => /[1-9]/.test(value), { error: '0 보다 커야 합니다.' });

/**
 * `quantityPer` — Decimal(18,6) 문자열. **여기서는 형식만 본다.**
 *
 * `> 0` 과 `quantityStatus` 정합은 T07-2 도메인(`assertQuantityConsistency`)이
 * 422 로 판정한다 — 400/422 구분을 유지하기 위해 DTO 는 형식만 거른다 (D-10).
 */
const quantityDecimalShape = z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/, {
  error: '소요량은 소수 6자리 이하의 십진 문자열이어야 합니다.',
});

/**
 * `lossRate` — Decimal(8,6), **`0 <= x < 1`** (D-9).
 *
 * 상한 `< 1` 은 DTO 에서만 막는다 — DB CHECK 는 걸지 않는다(문서 근거 없음).
 * 정수부가 1자리이고 `1` 이상이면 거부하므로 문자열 비교만으로 판정한다.
 */
const lossRateDecimal = z.string().regex(/^0(?:\.\d{1,6})?$/, {
  error: '로스율은 0 이상 1 미만의 십진 문자열이어야 합니다. (예: "0" / "0.05")',
});

/**
 * `alternateGroup` — **trim → blank 면 `null`** (D-3·D-9).
 *
 * ★ `''` 이 DB 에 저장되는 경로를 만들지 않는다. 표현식 UNIQUE
 *   `COALESCE(alternate_group,'')` 의 센티넬 `''` 은 인덱스 전용이며
 *   business value 가 아니다.
 */
const alternateGroupShape = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value === '' ? null : value))
  .refine((value) => value === null || value.length <= BOM_ALTERNATE_GROUP_MAX_LENGTH, {
    error: `대체그룹은 ${BOM_ALTERNATE_GROUP_MAX_LENGTH}자 이하여야 합니다.`,
  });

/**
 * `alternateGroup` 정규화의 **최종 방어선** (D-3).
 *
 * DTO 가 이미 trim → blank → null 을 끝내지만, application service 는 REST 이외의
 * 경로(T07-5 clone·import 등 내부 호출)에서도 불린다. `''` 이 DB 에 들어가면
 * 표현식 UNIQUE `COALESCE(alternate_group,'')` 의 센티넬과 **구분할 수 없게**
 * 되므로, 서비스에서 한 번 더 정규화한다. 멱등이라 두 번 적용해도 같다.
 */
export function normalizeAlternateGroup(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 자유 텍스트 — trim 후 blank 면 null 로 정규화한다(기존 master 규약). */
const optionalText = (max?: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .transform((value) => (value === '' ? null : value))
    .refine((value) => value === null || max === undefined || value.length <= max, {
      error: max === undefined ? '' : `${max}자 이하여야 합니다.`,
    });

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

function parseUuidParam(raw: string, label: string): string {
  const result = z.uuid().safeParse(raw);
  if (!result.success) {
    throw new ValidationError([{ path: 'id', message: `${label} 형식이 올바르지 않습니다.` }]);
  }
  return result.data;
}

export const parseBomId = (raw: string): string => parseUuidParam(raw, 'BOM ID');
export const parseBomLineId = (raw: string): string => parseUuidParam(raw, 'BOM 라인 ID');
export const parseSkuRefId = (raw: string): string => parseUuidParam(raw, 'SKU ID');

// ═══════════════════════════════════════════════════════════════
// GET /api/boms — 목록 쿼리 (D-31 검색·필터 · D-14 페이지 고정)
// ═══════════════════════════════════════════════════════════════

/**
 * 쿼리는 정확히 **7개** — `q`·`status`·`bomType`·`parentSkuId`·`effectiveOn`
 * ·`hasUnknownQty`·`page` (D-31 검색·필터 행).
 *
 * ⛔ `pageSize`(서버 고정 50)·`sort`·창고·거래처 필터를 받지 않는다.
 *    그 밖의 키는 **400** — 조용히 무시하지 않는다.
 */
export const listBomsQuerySchema = z.strictObject({
  /** 상위 SKU 의 `skuCode`·`skuName` **만** 통합 검색 (contains, 대소문자 무시). */
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(BOM_STATUSES).optional(),
  bomType: z.enum(BOM_TYPES).optional(),
  parentSkuId: z.uuid().optional(),
  /** 반열림 `[from, to)` 기준일 필터 — status 와 **독립**이다(아래 주석). */
  effectiveOn: dateString.optional(),
  hasUnknownQty: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export type ListBomsQuery = z.infer<typeof listBomsQuerySchema>;

export function parseListBomsQuery(searchParams: URLSearchParams): ListBomsQuery {
  const allowed = new Set(Object.keys(listBomsQuerySchema.shape));
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

  const result = listBomsQuerySchema.safeParse(raw);
  if (!result.success) {
    throw toValidationError(result.error.issues, 'BOM 목록 쿼리가 올바르지 않습니다.');
  }
  return result.data;
}

/** query 를 받지 않는 read endpoint 용 — 어떤 키든 400. */
export function assertNoQueryParams(searchParams: URLSearchParams, message: string): void {
  const keys = [...new Set([...searchParams.keys()])];
  if (keys.length === 0) return;
  throw new ValidationError(
    keys.map((key) => ({ path: key, message: '지원하지 않는 파라미터입니다.' })),
    { message },
  );
}

// ═══════════════════════════════════════════════════════════════
// POST /api/boms — CreateBomDto (D-14)
// ═══════════════════════════════════════════════════════════════

export const createBomSchema = z.strictObject({
  parentSkuId: z.uuid(),
  bomType: z.enum(BOM_TYPES),
  version: z.string().trim().min(1).max(BOM_VERSION_MAX_LENGTH),
  /** 생략 시 `"1"` (D-14). */
  outputQty: positiveDecimal18_6.optional(),
  /** 생략 시 parent `baseUom` 을 서버가 채운다 (D-11). */
  outputUom: z.string().trim().min(1).max(BOM_UOM_MAX_LENGTH).optional(),
  /** ★ `DRAFT` 여도 필수 — 서버가 오늘로 채우지 않는다 (D-5). */
  effectiveFrom: dateString,
  effectiveTo: dateString.nullable().optional(),
  productionPartnerId: z.uuid().nullable().optional(),
  /** ★ staged scalar — UUID 형식만 본다. Warehouse 존재 검증 없음 (D-32). */
  destinationWarehouseId: z.uuid().nullable().optional(),
  overallLossRate: lossRateDecimal.nullable().optional(),
  description: optionalText().nullable().optional(),
  changeReason: optionalText().nullable().optional(),
});

export type CreateBomInput = z.infer<typeof createBomSchema>;

export function parseCreateBomInput(body: unknown): CreateBomInput {
  const result = createBomSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, 'BOM 생성 요청이 올바르지 않습니다.');
  }
  assertPeriodOrder(result.data.effectiveFrom, result.data.effectiveTo ?? null);
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// PATCH /api/boms/{id} — UpdateBomDto (D-14)
// ═══════════════════════════════════════════════════════════════

/**
 * `CreateBomDto` 에서 **`parentSkuId`·`version` 을 뺀** 부분집합 (D-14).
 *
 * ⛔ 둘을 바꾸면 다른 BOM 이 되므로 strict 가 400 으로 막는다.
 * ⛔ generic `status` PATCH 를 만들지 않는다 — 상태는 전용 endpoint 로만 바뀐다
 *    (D-6, T07-5).
 */
export const updateBomSchema = z.strictObject({
  bomType: z.enum(BOM_TYPES).optional(),
  outputQty: positiveDecimal18_6.optional(),
  outputUom: z.string().trim().min(1).max(BOM_UOM_MAX_LENGTH).optional(),
  effectiveFrom: dateString.optional(),
  effectiveTo: dateString.nullable().optional(),
  productionPartnerId: z.uuid().nullable().optional(),
  destinationWarehouseId: z.uuid().nullable().optional(),
  overallLossRate: lossRateDecimal.nullable().optional(),
  description: optionalText().nullable().optional(),
  changeReason: optionalText().nullable().optional(),
});

export type UpdateBomInput = z.infer<typeof updateBomSchema>;

export function parseUpdateBomInput(body: unknown): UpdateBomInput {
  const result = updateBomSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, 'BOM 수정 요청이 올바르지 않습니다.');
  }
  if (Object.keys(result.data).length === 0) {
    throw new ValidationError([{ path: 'body', message: '수정할 필드가 하나도 없습니다.' }]);
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// POST /api/boms/{id}/lines — CreateLineDto (D-14·D-9)
// ═══════════════════════════════════════════════════════════════

export const createLineSchema = z.strictObject({
  /** 생략(또는 null)이면 서버가 `max(lineNo) + 1` 로 채운다 (D-14). */
  lineNo: z.number().int().min(1).nullable().optional(),
  componentSkuId: z.uuid(),
  quantityPer: quantityDecimalShape.nullable().optional(),
  /** 생략 시 `UNKNOWN` (D-14). ⛔ 자동 `"1"` 입력 금지 (D-10). */
  quantityStatus: z.enum(BOM_QUANTITY_STATUSES).optional(),
  /** 생략 시 구성품 `baseUom` 을 서버가 채운다 (D-11). */
  uom: z.string().trim().min(1).max(BOM_UOM_MAX_LENGTH).optional(),
  lossRate: lossRateDecimal.nullable().optional(),
  componentRole: z.enum(COMPONENT_ROLES),
  supplyType: z.enum(BOM_SUPPLY_TYPES).nullable().optional(),
  alternateGroup: alternateGroupShape.nullable().optional(),
  isRequired: z.boolean().optional(),
  /** ★ staged scalar — UUID 형식만. Warehouse 존재 검증 없음 (D-32). */
  issueWarehouseId: z.uuid().nullable().optional(),
  packQuantity: positiveDecimal18_6.nullable().optional(),
  specification: optionalText().nullable().optional(),
  note: optionalText().nullable().optional(),
});

export type CreateLineInput = z.infer<typeof createLineSchema>;

export function parseCreateLineInput(body: unknown): CreateLineInput {
  const result = createLineSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, 'BOM 라인 생성 요청이 올바르지 않습니다.');
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// PATCH …/lines/{lineId} — UpdateLineDto (D-14)
// ═══════════════════════════════════════════════════════════════

/**
 * `CreateLineDto` 에서 **`lineNo` 를 뺀** 부분집합 (D-14). 최소 1개 필드 필수.
 *
 * ⛔ `bomHeaderId` 변경 금지 — 라인 이동은 없다.
 * ★ `componentSkuId` 는 **변경 가능**하다(D-14 가 제외하지 않았다). 따라서 이
 *   PATCH 는 그래프 topology 를 바꿀 수 있고 cycle 재검사 대상이다.
 */
export const updateLineSchema = z.strictObject({
  componentSkuId: z.uuid().optional(),
  quantityPer: quantityDecimalShape.nullable().optional(),
  quantityStatus: z.enum(BOM_QUANTITY_STATUSES).optional(),
  uom: z.string().trim().min(1).max(BOM_UOM_MAX_LENGTH).optional(),
  lossRate: lossRateDecimal.nullable().optional(),
  componentRole: z.enum(COMPONENT_ROLES).optional(),
  supplyType: z.enum(BOM_SUPPLY_TYPES).nullable().optional(),
  alternateGroup: alternateGroupShape.nullable().optional(),
  isRequired: z.boolean().optional(),
  issueWarehouseId: z.uuid().nullable().optional(),
  packQuantity: positiveDecimal18_6.nullable().optional(),
  specification: optionalText().nullable().optional(),
  note: optionalText().nullable().optional(),
});

export type UpdateLineInput = z.infer<typeof updateLineSchema>;

export function parseUpdateLineInput(body: unknown): UpdateLineInput {
  const result = updateLineSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, 'BOM 라인 수정 요청이 올바르지 않습니다.');
  }
  if (Object.keys(result.data).length === 0) {
    throw new ValidationError([{ path: 'body', message: '수정할 필드가 하나도 없습니다.' }]);
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// 적용기간 순서 (D-5 CHECK 와 같은 규칙)
// ═══════════════════════════════════════════════════════════════

/**
 * `effectiveTo IS NULL OR effectiveTo > effectiveFrom` (D-5).
 *
 * DB CHECK 가 최종 방어선이지만, CHECK 위반이 도달하면 계약 버그(500)이므로
 * DTO 가 먼저 400 으로 막는다 (D-29 매핑표).
 */
export function assertPeriodOrder(effectiveFrom: string, effectiveTo: string | null): void {
  if (effectiveTo === null) return;
  if (effectiveTo > effectiveFrom) return;
  throw new ValidationError([
    { path: 'effectiveTo', message: '적용 종료일은 적용 시작일보다 뒤여야 합니다.' },
  ]);
}
