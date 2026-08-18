import { z } from 'zod';

import { ValidationError } from '@/shared/errors';

/**
 * BOM 워크플로 DTO (T07-5) — Zod strict.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-6(전이표 body 열) · §D-7(activate) ·
 *    §D-8(approve body) · §D-4(version) + **`★ T07-5 workflow gap closure`**
 *    W-1(archive) · W-3(deactivate) · W-5(clone).
 *
 * | action | body | 근거 |
 * |---|---|---|
 * | `submit` | `{note?}` | T1-4A 선례 (SKU workflow 와 같은 어휘) |
 * | `approve` | `{note?}` | D-8 표 |
 * | `reject` | `{reason}` **필수** | D-6 표 |
 * | `activate` | `{effectiveFrom?}` | D-7·D-8 표 |
 * | `deactivate` | `{effectiveTo, reason}` **둘 다 필수** | D-6 표 |
 * | `archive` | `{reason}` **필수** | W-1 |
 * | `clone` | `{newVersion, effectiveFrom, changeReason}` **전부 필수** | D-4·W-5 |
 *
 * ⛔ unknown key 는 전부 **400** (D-14 공통 규칙).
 * ⛔ server-managed 필드(`status`·`createdBy`·`approvedAt/By`·`activatedAt`)는
 *    어느 DTO 에도 없으므로 요청에 넣으면 400 이다.
 *
 * ★ `note`/`reason` 은 **`AuditLog.reason`** 에 기록된다 — BomHeader 에
 *   `rejectionReason`·`archiveReason` 같은 컬럼을 신설하지 않는다 (W-1·D-16).
 */

/**
 * 자유 텍스트 — trim 된 non-blank 만 받는다.
 *
 * T1-4A `workflow-dto.ts` 의 `freeText` 와 **같은 규칙**이다. 앞뒤 공백이
 * 남은 값을 받지 않으므로 "공백만 넣어 필수를 우회" 하는 경로가 없다.
 */
const freeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0 && value === value.trim(), {
      message: '빈 값·앞뒤 공백은 허용되지 않습니다.',
    });

/** note·reason 최대 길이 — `audit_log.reason`(TEXT)에 그대로 기록된다. */
export const BOM_WORKFLOW_TEXT_MAX = 2000;

/** `YYYY-MM-DD` — ⛔ timezone 변환을 하지 않는다 (D-5 date-only 계약). */
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  error: '날짜는 YYYY-MM-DD 형식이어야 합니다.',
});

/** `BomHeader.version` — D-4. trim 후 1~20, case-sensitive, semver 파싱 없음. */
const versionShape = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length >= 1 && value.length <= 20, {
    error: '버전은 1~20자여야 합니다.',
  });

export const submitBomSchema = z.strictObject({
  note: freeText(BOM_WORKFLOW_TEXT_MAX).optional(),
});

export const approveBomSchema = z.strictObject({
  note: freeText(BOM_WORKFLOW_TEXT_MAX).optional(),
});

export const rejectBomSchema = z.strictObject({
  reason: freeText(BOM_WORKFLOW_TEXT_MAX),
});

/**
 * `{effectiveFrom?}` — 생략하면 candidate 의 기존 `effectiveFrom` 이 `T` 다.
 *
 * ★ 값을 주면 `ACTIVE` 전환 직전에 **candidate 의 `effectiveFrom` 이 `T` 로
 *   갱신된다** (D-7 3단계 · W-2 · R1). predecessor·successor 의 시작일은
 *   절대 바뀌지 않는다.
 */
export const activateBomSchema = z.strictObject({
  effectiveFrom: dateOnly.optional(),
});

/**
 * `{effectiveTo, reason}` — **둘 다 필수** (D-6).
 *
 * ⚠️ 기간 규칙(과거·오늘만 허용 · 단축/동일만 허용 · successor 경계)은 **값의
 *    업무 판정**이므로 DTO 가 아니라 서비스가 본다 (W-3). 여기서는 형식만.
 */
export const deactivateBomSchema = z.strictObject({
  effectiveTo: dateOnly,
  reason: freeText(BOM_WORKFLOW_TEXT_MAX),
});

/** `{reason}` **필수** — W-1. `DRAFT`·`REJECTED` 만 대상이다. */
export const archiveBomSchema = z.strictObject({
  reason: freeText(BOM_WORKFLOW_TEXT_MAX),
});

/**
 * `{newVersion, effectiveFrom, changeReason}` — **전부 필수** (D-4 · W-5).
 *
 * ⛔ 서버가 "다음 버전" 을 계산하지 않는다 — `version` 은 client supplied 이며
 *    semantic version 파싱·자동 증가가 없다 (D-4).
 */
export const cloneBomSchema = z.strictObject({
  newVersion: versionShape,
  effectiveFrom: dateOnly,
  changeReason: freeText(BOM_WORKFLOW_TEXT_MAX),
});

export type SubmitBomInput = z.infer<typeof submitBomSchema>;
export type ApproveBomInput = z.infer<typeof approveBomSchema>;
export type RejectBomInput = z.infer<typeof rejectBomSchema>;
export type ActivateBomInput = z.infer<typeof activateBomSchema>;
export type DeactivateBomInput = z.infer<typeof deactivateBomSchema>;
export type ArchiveBomInput = z.infer<typeof archiveBomSchema>;
export type CloneBomInput = z.infer<typeof cloneBomSchema>;

function parseWith<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  // ★ 본문 없는 요청은 `{}` 로 취급한다 — note 가 선택인 action 을 위해서다.
  //   필수 필드가 있는 action 은 `{}` 에서 그대로 400 이 난다.
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

export function parseSubmitBomInput(body: unknown): SubmitBomInput {
  return parseWith(submitBomSchema, body, 'BOM 승인 요청 본문이 올바르지 않습니다.');
}

export function parseApproveBomInput(body: unknown): ApproveBomInput {
  return parseWith(approveBomSchema, body, 'BOM 승인 본문이 올바르지 않습니다.');
}

export function parseRejectBomInput(body: unknown): RejectBomInput {
  return parseWith(rejectBomSchema, body, 'BOM 반려 본문이 올바르지 않습니다. (reason 필수)');
}

export function parseActivateBomInput(body: unknown): ActivateBomInput {
  return parseWith(activateBomSchema, body, 'BOM 활성화 본문이 올바르지 않습니다.');
}

export function parseDeactivateBomInput(body: unknown): DeactivateBomInput {
  return parseWith(
    deactivateBomSchema,
    body,
    'BOM 사용종료 본문이 올바르지 않습니다. (effectiveTo·reason 필수)',
  );
}

export function parseArchiveBomInput(body: unknown): ArchiveBomInput {
  return parseWith(archiveBomSchema, body, 'BOM 보관 본문이 올바르지 않습니다. (reason 필수)');
}

export function parseCloneBomInput(body: unknown): CloneBomInput {
  return parseWith(
    cloneBomSchema,
    body,
    'BOM 복제 본문이 올바르지 않습니다. (newVersion·effectiveFrom·changeReason 필수)',
  );
}
