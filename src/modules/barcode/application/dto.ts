import { z } from 'zod';

import { ValidationError } from '@/shared/errors';

/**
 * 바코드 API DTO (T04-3) — **V1 최소 계약**.
 *
 * ⚠️ 근거: `docs/10_설계복구_BarcodeCRUD.md` §5·§7 (2026-08-10 Design Recovery Decision).
 *    원 API 문서의 `{barcode, barcodeType, isPrimary?, ...}` 는 말줄임표로 끝나
 *    나머지 필드가 확정되지 않았다. 추론하지 않고 **최소 계약**으로 고정한다.
 *
 * ⛔ `strictObject` — unknown field 는 400 이다. 조용히 무시하지 않는다.
 */

/** T04-1 `BarcodeType` enum 과 동일한 5종. 새 타입을 발명하지 않는다. */
export const BARCODE_TYPES = ['UNIT', 'INNER_BOX', 'OUTER_BOX', 'CHANNEL', 'LEGACY'] as const;
export type BarcodeTypeValue = (typeof BARCODE_TYPES)[number];

/**
 * **일반 PATCH 로 지정할 수 있는** status 2종.
 *
 * ⚠️ 업무 status 는 T04-4A 에서 `PENDING_DUPLICATE` 를 포함해 3종이 되었지만,
 *    일반 PATCH DTO 는 계속 `ACTIVE|INACTIVE` 만 받는다 — 사용자가 임의로
 *    승인 대기 상태를 만들거나 승인 endpoint 를 우회할 수 없어야 한다.
 */
export const BARCODE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type BarcodeStatusValue = (typeof BARCODE_STATUSES)[number];

/**
 * 중복 예외 승인 대기 상태 (T04-4A).
 *
 * `sku_barcode.status` 는 VARCHAR(20) 이고 열거값 CHECK 가 없으므로 스키마 변경 없이
 * 저장된다. 이 값은 **승인 endpoint 만** 만들고 소비한다.
 */
export const BARCODE_STATUS_PENDING_DUPLICATE = 'PENDING_DUPLICATE';

/** 저장될 수 있는 전체 업무 status. 조회·판정용이며 입력 DTO 가 아니다. */
export const BARCODE_ALL_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  BARCODE_STATUS_PENDING_DUPLICATE,
] as const;

/**
 * POST body.
 *
 * ⛔ V1 에서 받지 않는다 (근거 불충분 — future extension):
 *    `countryCode` · `channelCode` · `effectiveFrom` · `effectiveTo`
 * ⛔ server-managed 라 절대 받지 않는다:
 *    `id` · `skuId`(경로가 유일 출처) · `status` · `createdAt`
 * ⛔ T04-4 전용이라 절대 받지 않는다:
 *    `duplicateException` · `exceptionReason` · `approvedBy`
 *
 * ★ `barcode` 는 **string 전용**이다. `{"barcode": 8809619961373}` 은 여기서
 *   400 이 되며 도메인 정규화까지 가지 않는다 — 그래서 `BARCODE_READ_AS_NUMBER`
 *   는 이 API 의 공개 오류코드가 아니다 (docs/10 §11).
 */
export const createBarcodeSchema = z.strictObject({
  barcode: z.string({ error: '바코드는 문자열이어야 합니다.' }),
  barcodeType: z.enum(BARCODE_TYPES),
  isPrimary: z.boolean().optional(),
});

export type CreateBarcodeInput = z.infer<typeof createBarcodeSchema>;

/**
 * PATCH body — 최소 하나 필수. `{}` 는 400 이다.
 *
 * ⛔ `barcode` 값은 **생성 후 불변**이다 (docs/10 §8). 잘못 등록했으면
 *    DELETE(비활성) 후 새로 POST 한다 — 과거 바코드 사용 이력을 보존하기 위함이다.
 * ⛔ `barcodeType` 도 V1 수정 대상이 아니다.
 */
export const updateBarcodeSchema = z
  .strictObject({
    isPrimary: z.boolean().optional(),
    status: z.enum(BARCODE_STATUSES).optional(),
  })
  .refine((value) => value.isPrimary !== undefined || value.status !== undefined, {
    error: '변경할 필드를 최소 하나 지정해야 합니다.',
  });

export type UpdateBarcodeInput = z.infer<typeof updateBarcodeSchema>;

function toValidationError(issues: readonly z.core.$ZodIssue[], message: string): ValidationError {
  return new ValidationError(
    issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'body',
      message: issue.message,
    })),
    { message },
  );
}

export function parseCreateBarcodeInput(body: unknown): CreateBarcodeInput {
  const result = createBarcodeSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '바코드 등록 요청이 올바르지 않습니다.');
  }
  return result.data;
}

export function parseUpdateBarcodeInput(body: unknown): UpdateBarcodeInput {
  const result = updateBarcodeSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '바코드 수정 요청이 올바르지 않습니다.');
  }
  return result.data;
}

/**
 * 중복 예외 요청 body (T04-4A) — **T04-3 POST 와 동일한 최소 strict 계약**이다.
 *
 * 정규화도 T04-2/T04-3 경로를 그대로 재사용한다. 별도 필드를 늘리지 않는다.
 */
export const requestDuplicateCandidateSchema = createBarcodeSchema;
export type RequestDuplicateCandidateInput = CreateBarcodeInput;

export function parseRequestDuplicateCandidateInput(body: unknown): RequestDuplicateCandidateInput {
  const result = requestDuplicateCandidateSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '중복 예외 요청이 올바르지 않습니다.');
  }
  return result.data;
}

/**
 * 중복 예외 승인 body (T04-4A) — `{reason}` **필수**.
 *
 * ⚠️ trim 후 비어 있으면 400 이다. 저장·기록되는 값은 **trim 된 문자열**이다.
 * ⛔ 임의 최대 길이를 추가하지 않는다 — `exception_reason`·`audit_log.reason` 모두
 *    TEXT 이고 원문에 상한 근거가 없다 (docs/11 §13).
 */
export const approveDuplicateSchema = z.strictObject({
  reason: z
    .string({ error: '사유는 문자열이어야 합니다.' })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, { error: '사유는 비워 둘 수 없습니다.' }),
});

export type ApproveDuplicateInput = z.infer<typeof approveDuplicateSchema>;

export function parseApproveDuplicateInput(body: unknown): ApproveDuplicateInput {
  const result = approveDuplicateSchema.safeParse(body);
  if (!result.success) {
    throw toValidationError(result.error.issues, '중복 예외 승인 요청이 올바르지 않습니다.');
  }
  return result.data;
}

/** 경로 식별자는 UUID 다. 형식 오류는 400 (404 가 아니다). */
export function parseBarcodeId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new ValidationError([{ path: 'bid', message: 'UUID 형식이어야 합니다.' }], {
      message: '바코드 id 가 올바르지 않습니다.',
    });
  }
  return result.data;
}
