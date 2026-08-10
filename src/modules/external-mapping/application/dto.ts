import { z } from 'zod';

import { ValidationError } from '@/shared/errors';

/**
 * 외부 상품 매핑 API DTO (T05-2) — **V1 최소 계약**.
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §4·§5·§6·§13.
 *    원 API 문서(`05:81`)는 `CreateMappingDto` 라는 **이름만** 있고 필드 정의가
 *    없었다. 추론하지 않고 Recovery Decision 이 확정한 계약으로 고정한다.
 *
 * ⛔ `strictObject` — unknown field 는 400 이다. 조용히 무시하지 않는다.
 */

/** T05-1 `MappingStatus` enum 과 동일한 3종. 새 상태를 발명하지 않는다. */
export const MAPPING_STATUSES = ['MATCHED', 'UNMATCHED', 'REVIEW_REQUIRED'] as const;
export type MappingStatusValue = (typeof MAPPING_STATUSES)[number];

/** DB 물리 용량 (T05-1 `sku_external_mapping`). 업무 길이 규칙이 아니다. */
export const EXTERNAL_PRODUCT_CODE_MAX_LENGTH = 150;
export const EXTERNAL_PRODUCT_NAME_MAX_LENGTH = 500;
export const EXTERNAL_BARCODE_MAX_LENGTH = 100;

/**
 * 외부 원문 문자열 입력.
 *
 * ★ SKU DTO 와 달리 **API 가 canonicalize** 한다 — trim 하고, 그 결과가 비면
 *   `null` 로 저장한다 (§6·§7). 외부 시스템에서 복사되는 값이라 앞뒤 공백이
 *   일상적으로 섞이기 때문이다. 내부 문자(대소문자·앞자리 0·내부 하이픈·
 *   내부 공백)는 **변경하지 않는다**.
 */
function externalText(max: number) {
  return z.string().max(max).nullable();
}

/**
 * POST body.
 *
 * ⛔ server-managed 라 받지 않는다: `id` · `mappingStatus`(§4 자동판정) · `createdAt`
 * ⛔ T08-1 전까지 받지 않는다: `warehouseId` (Warehouse FK 가 없어 검증 불가 — §5)
 * ⛔ V1 대상이 아니다: `effectiveFrom` · `effectiveTo`(생성 시 종료일을 받지 않는다)
 *
 * ★ `externalBarcode` 는 **string 전용**이다. `{"externalBarcode": 8809619961373}`
 *   은 여기서 400 이며 도메인 정규화까지 가지 않는다 — 그래서
 *   `BARCODE_READ_AS_NUMBER` 는 이 API 의 공개 오류코드가 아니다.
 */
export const createMappingSchema = z.strictObject({
  skuId: z.uuid({ error: 'SKU id 는 UUID 형식이어야 합니다.' }),
  externalSystemId: z.uuid({ error: '외부시스템 id 는 UUID 형식이어야 합니다.' }),
  externalProductCode: externalText(EXTERNAL_PRODUCT_CODE_MAX_LENGTH).optional(),
  externalProductName: externalText(EXTERNAL_PRODUCT_NAME_MAX_LENGTH).optional(),
  externalBarcode: externalText(EXTERNAL_BARCODE_MAX_LENGTH).optional(),
  isPrimary: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

export type CreateMappingInput = z.infer<typeof createMappingSchema>;

/** `YYYY-MM-DD`. */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다.')
  .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()), {
    error: '존재하지 않는 날짜입니다.',
  });

const PATCH_FIELDS = [
  'externalProductCode',
  'externalProductName',
  'externalBarcode',
  'isPrimary',
  'effectiveTo',
  'note',
] as const;

/**
 * PATCH body — 최소 하나 필수. `{}` 는 400 이다.
 *
 * ★ **identifier 수정을 허용한다.** 원 PATCH DTO(`{mappingStatus?, isPrimary?,
 *   effectiveTo?}`)에는 identifier 가 없어 `REVIEW_REQUIRED → MATCHED`
 *   ("외부코드·바코드 확보 시에만", `05:344`)로 갈 경로가 아예 없었다.
 *   Recovery Decision §6 이 이 gap 을 identifier PATCH 로 메운다.
 *
 * ⛔ `mappingStatus` 는 받지 않는다 — server-derived 다 (§4).
 * ⛔ `skuId`·`externalSystemId` 는 매핑 identity 라 **immutable** 이다.
 * ⛔ `warehouseId`·`effectiveFrom`·`createdAt` 도 대상이 아니다.
 *
 * ★ `effectiveTo` 는 `null` 을 받지 않는다 — 종료(`null → date`)만 지원하며
 *   재활성(`date → null`)은 V1 범위 밖이다 (§8). DTO 타입 자체로 막는다.
 */
export const updateMappingSchema = z
  .strictObject({
    externalProductCode: externalText(EXTERNAL_PRODUCT_CODE_MAX_LENGTH).optional(),
    externalProductName: externalText(EXTERNAL_PRODUCT_NAME_MAX_LENGTH).optional(),
    externalBarcode: externalText(EXTERNAL_BARCODE_MAX_LENGTH).optional(),
    isPrimary: z.boolean().optional(),
    effectiveTo: dateString.optional(),
    note: z.string().nullable().optional(),
  })
  .refine((value) => PATCH_FIELDS.some((field) => value[field] !== undefined), {
    error: '변경할 필드를 최소 하나 지정해야 합니다.',
  });

export type UpdateMappingInput = z.infer<typeof updateMappingSchema>;

function toValidationError(issues: readonly z.core.$ZodIssue[], message: string): ValidationError {
  return new ValidationError(
    issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'body',
      message: issue.message,
    })),
    { message },
  );
}

export function parseCreateMappingInput(body: unknown): CreateMappingInput {
  const result = createMappingSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '외부 매핑 등록 요청이 올바르지 않습니다.');
  }
  return result.data;
}

export function parseUpdateMappingInput(body: unknown): UpdateMappingInput {
  const result = updateMappingSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '외부 매핑 수정 요청이 올바르지 않습니다.');
  }
  return result.data;
}

/** 경로 식별자는 UUID 다. 형식 오류는 400 (404 가 아니다). */
export function parseExternalMappingId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new ValidationError([{ path: 'id', message: 'UUID 형식이어야 합니다.' }], {
      message: '외부 매핑 id 가 올바르지 않습니다.',
    });
  }
  return result.data;
}

/**
 * `GET /api/external-mappings` 쿼리 (T05-2 지원 범위, §12).
 *
 * ⛔ `sort` 는 V1 에 없다 — 정렬은 `createdAt DESC, id DESC` 고정이다.
 * ⛔ `warehouse` 필터는 API 원문에 없고 화면 검색조건에만 있다 → T08-1 이후.
 *
 * ★ `mappingStatus` 는 enum 3종을 모두 받는다. interactive API 가
 *   `UNMATCHED` 를 만들지는 않지만(§3), legacy/future 데이터를 **조회**할 수는
 *   있어야 한다. 결과 0건은 정상이다.
 */
export const listMappingsQuerySchema = z.strictObject({
  /** skuCode·skuName·externalProductCode·externalProductName 통합 검색 (§12). */
  q: z.string().trim().min(1).max(100).optional(),
  externalSystemId: z.uuid().optional(),
  skuId: z.uuid().optional(),
  mappingStatus: z.enum(MAPPING_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type ListMappingsQuery = z.infer<typeof listMappingsQuerySchema>;

/** 화이트리스트에 없는 쿼리 파라미터를 명시적으로 거부한다 (SKU 목록과 동일 convention). */
export function parseListMappingsQuery(searchParams: URLSearchParams): ListMappingsQuery {
  const allowed = new Set(Object.keys(listMappingsQuerySchema.shape));
  const unknownKeys = [...new Set([...searchParams.keys()])].filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      unknownKeys.map((key) => ({
        path: key,
        message: '지원하지 않는 파라미터입니다. (warehouse 필터는 T08-1 이후, sort 는 V1 미지원)',
      })),
      { message: '지원하지 않는 목록 파라미터가 있습니다.' },
    );
  }

  const raw: Record<string, string> = {};
  for (const key of allowed) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = value;
  }

  const result = listMappingsQuerySchema.safeParse(raw);
  if (!result.success) {
    throw toValidationError(result.error.issues, '외부 매핑 목록 쿼리가 올바르지 않습니다.');
  }
  return result.data;
}
