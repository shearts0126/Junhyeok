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

/** 업무 status 2종. T04-1 은 DB CHECK 를 두지 않으므로 여기가 유일한 게이트다. */
export const BARCODE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type BarcodeStatusValue = (typeof BARCODE_STATUSES)[number];

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
