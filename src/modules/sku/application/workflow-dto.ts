import { z } from 'zod';

import { ValidationError } from '@/shared/errors';

/**
 * SKU 승인 워크플로 DTO (T1-4A) — Zod strict.
 *
 * `05 §10.4` 확정 형태:
 *   - submit / approve : `{ note? }`
 *   - reject           : `{ reason }` **필수** (trimmed nonblank)
 *   - deactivate       : `{ reason? }` — 문서가 필수라고 명시하지 않으므로
 *                        임의로 필수화하지 않는다.
 *
 * 알 수 없는 필드는 400. 본문 없는 요청은 `{}` 와 동일하게 취급한다
 * (note/reason 전부 선택인 action 에 한함).
 */

const freeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0 && value === value.trim(), {
      message: '빈 값·앞뒤 공백은 허용되지 않습니다.',
    });

/** note·reason 최대 길이 — audit_log.reason(TEXT)에 그대로 기록된다. */
export const WORKFLOW_TEXT_MAX = 2000;

export const submitSkuSchema = z.strictObject({ note: freeText(WORKFLOW_TEXT_MAX).optional() });
export const approveSkuSchema = z.strictObject({ note: freeText(WORKFLOW_TEXT_MAX).optional() });
export const rejectSkuSchema = z.strictObject({ reason: freeText(WORKFLOW_TEXT_MAX) });
export const deactivateSkuSchema = z.strictObject({
  reason: freeText(WORKFLOW_TEXT_MAX).optional(),
});

export type SubmitSkuInput = z.infer<typeof submitSkuSchema>;
export type ApproveSkuInput = z.infer<typeof approveSkuSchema>;
export type RejectSkuInput = z.infer<typeof rejectSkuSchema>;
export type DeactivateSkuInput = z.infer<typeof deactivateSkuSchema>;

function parseWith<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : 'body',
        message: issue.message,
      })),
      { message },
    );
  }
  return result.data;
}

export function parseSubmitSkuInput(body: unknown): SubmitSkuInput {
  return parseWith(submitSkuSchema, body, 'SKU 승인 요청 본문이 올바르지 않습니다.');
}

export function parseApproveSkuInput(body: unknown): ApproveSkuInput {
  return parseWith(approveSkuSchema, body, 'SKU 승인 본문이 올바르지 않습니다.');
}

export function parseRejectSkuInput(body: unknown): RejectSkuInput {
  return parseWith(rejectSkuSchema, body, 'SKU 반려 본문이 올바르지 않습니다. (reason 필수)');
}

export function parseDeactivateSkuInput(body: unknown): DeactivateSkuInput {
  return parseWith(deactivateSkuSchema, body, 'SKU 사용중지 본문이 올바르지 않습니다.');
}
