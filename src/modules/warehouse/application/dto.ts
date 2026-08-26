import { z } from 'zod';

import { ValidationError } from '@/shared/errors';

import { DEFAULT_LOCATION_CODE, IN_TRANSIT_WAREHOUSE_CODE } from './policy';

/**
 * 창고·로케이션 DTO (T08-2).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D24(create) · §W-D25(immutable) ·
 *    §W-D26(update) · §W-D27(active 연기) · §W-D29(timezone) · §W-D30(list) ·
 *    §W-D33(location) · §W-D9(예약 코드) · §W-D12(IN_TRANSIT).
 *
 * ⚠️ 전부 `z.strictObject` 다 — 미지원 키는 **조용히 무시하지 않고 400** 이다.
 */

export const WAREHOUSE_CODE_MAX_LENGTH = 50;
export const WAREHOUSE_NAME_MAX_LENGTH = 150;
export const TIMEZONE_MAX_LENGTH = 50;
export const LOCATION_CODE_MAX_LENGTH = 50;
export const LOCATION_NAME_MAX_LENGTH = 150;
export const LOCATION_TYPE_MAX_LENGTH = 30;

/** 기본 timezone — 생략 시 서버가 채운다 (§W-D24). */
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

/**
 * 창고 유형 6종 (§W-D2).
 *
 * ⛔ 그 외 값 0. Prisma `WarehouseType` enum 과 정확히 같아야 한다.
 */
export const WAREHOUSE_TYPES = [
  'INTERNAL',
  'THREE_PL',
  'SUPPLIER_SITE',
  'OVERSEAS',
  'VIRTUAL',
  'IN_TRANSIT',
] as const;

export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];

/** trim 후 nonblank + 길이 상한. ⛔ case normalization 없음 (§W-D24). */
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
// W-D24 — CreateWarehouseDto
// ═══════════════════════════════════════════════════════════════

/**
 * `POST /api/warehouses` body (§W-D24).
 *
 * ⛔ server-owned 라 받지 않는다: `id` · **`defaultLocationId`** · `active` ·
 *    `createdAt` · `updatedAt`.
 *    특히 `defaultLocationId` 는 **서버가 DEFAULT 로케이션을 만들어 연결**하는
 *    것이 이 작업의 목적 자체이므로 client 가 정할 수 없다 (§W-D7).
 * ⛔ `active` 는 항상 DB default `true` 다 — lifecycle 은 `T2-20` (§W-D27).
 *
 * ★ `timezone` 은 **explicit `null` 금지**다 — DB NOT NULL 이며 "생략" 과
 *   "null 로 비우기" 는 다르다. 생략 시에만 `Asia/Seoul` 이 된다.
 * ⚠️ `timezone` 에 IANA validation library 를 새로 도입하지 않는다 (§W-D29).
 *   이 값은 display·외부연동 metadata 이며 재고 `business_date` 기준이 아니다.
 */
export const createWarehouseSchema = z.strictObject({
  warehouseCode: requiredCode(WAREHOUSE_CODE_MAX_LENGTH),
  warehouseName: requiredCode(WAREHOUSE_NAME_MAX_LENGTH),
  warehouseType: z.enum(WAREHOUSE_TYPES),

  externalSystemId: z.uuid().nullable().optional(),
  supplierId: z.uuid().nullable().optional(),
  timezone: requiredCode(TIMEZONE_MAX_LENGTH).optional(),
  address: z.string().nullable().optional(),
});

export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export function parseCreateWarehouseInput(body: unknown): CreateWarehouseInput {
  const result = createWarehouseSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '창고 등록 요청이 올바르지 않습니다.');
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// W-D26 — UpdateWarehouseDto
// ═══════════════════════════════════════════════════════════════

export const WAREHOUSE_PATCH_FIELDS = [
  'warehouseName',
  'externalSystemId',
  'supplierId',
  'timezone',
  'address',
] as const;

/**
 * `PATCH /api/warehouses/{id}` body (§W-D26) — 최소 하나 필수, `{}` 는 400.
 *
 *   - `undefined` = 미변경 / `null` = 값 제거 / 값 = 변경.
 *   - `warehouseName`·`timezone` 은 null 불가 (DB NOT NULL).
 *
 * ⛔ `warehouseCode`·`warehouseType` 은 **create-only immutable** 이다 (§W-D25)
 *    — 보내면 400. 향후 거래·외부연동·system warehouse semantics 의 identity
 *    field 이며 `IN_TRANSIT` 예약도 이 불변식에 의존한다.
 * ⛔ **`active` 는 받지 않는다** (§W-D27) — `true→false` lifecycle 은 "재고 존재
 *    시 비활성 차단" 을 요구하고, 그 안전장치는 current-stock capability(T09)가
 *    있어야 구현 가능하다. `hasInventory=false` 같은 상수 가정은 안전장치를
 *    무효화하므로 mutation 자체를 `T2-20` 으로 연기한다.
 *    ⛔ 조용히 무시하지 않는다 — 명시적 400 이다.
 * ⛔ `defaultLocationId` 도 받지 않는다 — server-owned invariant 다.
 */
export const updateWarehouseSchema = z
  .strictObject({
    warehouseName: requiredCode(WAREHOUSE_NAME_MAX_LENGTH).optional(),
    externalSystemId: z.uuid().nullable().optional(),
    supplierId: z.uuid().nullable().optional(),
    timezone: requiredCode(TIMEZONE_MAX_LENGTH).optional(),
    address: z.string().nullable().optional(),
  })
  .refine((patch) => WAREHOUSE_PATCH_FIELDS.some((field) => patch[field] !== undefined), {
    message: '수정할 항목이 최소 하나 필요합니다.',
  });

export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

export function parseUpdateWarehouseInput(body: unknown): UpdateWarehouseInput {
  const result = updateWarehouseSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '창고 수정 요청이 올바르지 않습니다.');
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// W-D30 — list query
// ═══════════════════════════════════════════════════════════════

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

const listWarehousesQuerySchema = z.strictObject({
  warehouseType: z.enum(WAREHOUSE_TYPES).optional(),
  active: booleanQuery.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
});

export type ListWarehousesQuery = z.infer<typeof listWarehousesQuerySchema>;

/**
 * `GET /api/warehouses` query (§W-D30).
 *
 * 허용은 `warehouseType?` · `active?` · `page?` **뿐**이며 그 외 키는 400 이다.
 * ⛔ `q`·`sort`·`pageSize` 를 지원하지 않는다 — 조용히 무시하지 않고 거부한다.
 */
export function parseListWarehousesQuery(params: URLSearchParams): ListWarehousesQuery {
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) raw[key] = value;

  const result = listWarehousesQuerySchema.safeParse(raw);
  if (!result.success) {
    throw toValidationError(
      result.error.issues,
      '지원하지 않는 목록 파라미터가 있습니다. (q·sort·pageSize 는 지원하지 않습니다)',
    );
  }
  return result.data;
}

/** 하위 리소스 GET 은 query 를 하나도 받지 않는다 (§W-D32). */
export function assertNoLocationListQuery(params: URLSearchParams): void {
  const keys = [...params.keys()];
  if (keys.length > 0) {
    throw new ValidationError(
      keys.map((key) => ({ path: key, message: '지원하지 않는 파라미터입니다.' })),
      { message: '로케이션 목록은 파라미터를 지원하지 않습니다.' },
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// W-D33 — CreateLocationDto
// ═══════════════════════════════════════════════════════════════

/**
 * `POST /api/warehouses/{id}/locations` body (§W-D33).
 *
 * ⛔ 입력 금지: `id` · `warehouseId`(경로가 정한다) · `active`(항상 DB default).
 * ★ `locationCode` 가 예약어 `DEFAULT` 면 400 이다 (§W-D9) — 자동 생성만이
 *   DEFAULT 의 owner 다. **예약 판정만 case-insensitive** 이며 일반 코드를
 *   uppercase 로 강제 변환하지는 않는다(`a-01` 은 `a-01` 로 저장된다).
 */
export const createLocationSchema = z.strictObject({
  locationCode: requiredCode(LOCATION_CODE_MAX_LENGTH).refine(
    (code) => code.toUpperCase() !== DEFAULT_LOCATION_CODE,
    { message: `'${DEFAULT_LOCATION_CODE}' 는 예약된 로케이션 코드입니다.` },
  ),
  locationName: requiredCode(LOCATION_NAME_MAX_LENGTH),
  locationType: requiredCode(LOCATION_TYPE_MAX_LENGTH).nullable().optional(),
});

export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export function parseCreateLocationInput(body: unknown): CreateLocationInput {
  const result = createLocationSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '로케이션 등록 요청이 올바르지 않습니다.');
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// 경로 파라미터 · 예약 코드 판정
// ═══════════════════════════════════════════════════════════════

export function parseWarehouseId(raw: string): string {
  const result = z.uuid().safeParse(raw);
  if (!result.success) {
    throw toValidationError(result.error.issues, '창고 ID 가 올바르지 않습니다.');
  }
  return result.data;
}

/**
 * public `POST /api/warehouses` 에서 금지되는 시스템 예약 창고인가 (§W-D12).
 *
 * 유형과 코드 **둘 다** 막는다 — 예약 코드로 다른 유형의 창고를 만들어
 * `IN_TRANSIT` 의 identity 를 선점하는 것도 금지다.
 */
export function isReservedWarehouseInput(input: {
  readonly warehouseCode: string;
  readonly warehouseType: string;
}): boolean {
  return (
    input.warehouseType === IN_TRANSIT_WAREHOUSE_CODE ||
    input.warehouseCode.toUpperCase() === IN_TRANSIT_WAREHOUSE_CODE
  );
}
