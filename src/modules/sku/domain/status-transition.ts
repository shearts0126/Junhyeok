import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * SKU 상태 전이 규칙 (T1-2) — **순수 도메인 규칙.**
 *
 * DB·요청·프레임워크에 의존하지 않는다. 후속 승인 워크플로(T1-4)의
 * Application Service 가 이 규칙을 호출한다 — API·권한·감사로그는 여기 없다.
 *
 * ## 전이표의 출처 — 문서에 **명시**된 전이만 허용한다
 *
 *   | 전이 | 근거 |
 *   |---|---|
 *   | DRAFT → PENDING_APPROVAL | 05 v0.1 §11.2 "승인요청(DRAFT→PENDING)" / v0.2 submit |
 *   | PENDING_APPROVAL → ACTIVE | 05 v0.2 approve — 조건 "상태=PENDING" |
 *   | PENDING_APPROVAL → REJECTED | 05 v0.1 §11.3 "PENDING → ACTIVE / REJECTED" |
 *   | ACTIVE → INACTIVE | 05 v0.1 §11.2 "사용중지(ACTIVE→INACTIVE)" |
 *
 *   허용 4 / 차단 45 (7×7 기준).
 *
 * ## 문서 근거가 없어 **차단**되는 전이 (임의로 만들지 않는다)
 *
 *   - **→ ARCHIVED 전부** — archive API 의 "거래·BOM 이력 0건" 은 **자격
 *     조건이지 source status 근거가 아니다.** 어떤 상태에서 ARCHIVED 로 갈 수
 *     있는지는 현재 문서가 확정하지 않았으므로, T1-4 승인 워크플로에서
 *     source-status 정책이 명시 확정되기 전까지 일반 전이표에 넣지 않는다.
 *   - REJECTED → DRAFT / PENDING_APPROVAL (재제출 규칙 미문서화)
 *   - INACTIVE → ACTIVE (재활성 규칙 미문서화)
 *   - ACTIVE → DISCONTINUED, DISCONTINUED → ACTIVE (단종 전환 규칙 미문서화)
 *   - ARCHIVED → * (복구 규칙 미문서화 → **terminal**)
 *   - 동일 상태 → 동일 상태 (no-op 전이 허용 근거 없음)
 *
 * ## archive 자격과는 별개의 불변식이다
 *
 *   Archive **usage eligibility**(거래·BOM 사용 0건 — `archive-eligibility.ts`)와
 *   archive **source-status eligibility**(어느 상태에서 ARCHIVED 로 가는가)는
 *   서로 다른 불변식이다. T1-2 는 전자만 확정한다 — 후자는 문서 미확정이라
 *   이 전이표에 → ARCHIVED 가 **없다.**
 *
 * ⚠️ DISCONTINUED 는 INACTIVE 의 별칭이 아니다 — 재고 설계(04 §검증)상
 *    DISCONTINUED SKU 는 **출고 목적으로는 사용 가능**한 별도 상태다.
 *    진입 전이가 미문서화라 현재 전이표로는 도달 불가하며, 상태값 자체는
 *    유지한다 (이관 데이터·향후 규칙 대비).
 *
 * ⚠️ ARCHIVED 로의 상태 전이 허용과 **archive 자격**(거래·BOM 사용 0건,
 *    `archive-eligibility.ts`)은 별개다. 실제 폐기는 둘 다 통과해야 한다.
 */

/** Prisma enum 과 동일한 값. 도메인 계층은 생성 클라이언트에 의존하지 않는다. */
export const SKU_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'REJECTED',
  'ACTIVE',
  'INACTIVE',
  'DISCONTINUED',
  'ARCHIVED',
] as const;

export type SkuStatusValue = (typeof SKU_STATUSES)[number];

/**
 * 상태별 허용 next 상태 — 문서 근거가 있는 전이만.
 * 7개 상태 전부 키로 존재한다 (빠뜨림 방지, 테스트가 고정).
 */
export const SKU_STATUS_TRANSITIONS: Readonly<Record<SkuStatusValue, readonly SkuStatusValue[]>> = {
  DRAFT: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['ACTIVE', 'REJECTED'],
  REJECTED: [], // 재제출 규칙 미문서화
  ACTIVE: ['INACTIVE'],
  INACTIVE: [], // 재활성 규칙 미문서화
  DISCONTINUED: [], // 진입·복귀 규칙 미문서화 (INACTIVE 별칭 아님 — 상태값은 유지)
  ARCHIVED: [], // terminal — 복구 전이 미문서화
};

/** 전이가 허용되는가. 동일 상태 → 동일 상태는 허용하지 않는다. */
export function canTransitionSkuStatus(from: SkuStatusValue, to: SkuStatusValue): boolean {
  return SKU_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * 전이가 허용되지 않으면 던진다.
 *
 * @throws {DomainError} `INVALID_STATUS_TRANSITION` / HTTP 422.
 *   `publicDetails` 에 `from`·`to` 를 담는다 — 상태값은 공개해도 되는 값이다.
 */
export function assertSkuStatusTransition(from: SkuStatusValue, to: SkuStatusValue): void {
  if (canTransitionSkuStatus(from, to)) return;

  throw new DomainError(ERROR_CODES.INVALID_STATUS_TRANSITION, {
    message: `SKU 상태를 '${from}' 에서 '${to}' 로 바꿀 수 없습니다.`,
    publicDetails: { from, to },
    publicHint:
      from === to
        ? '이미 해당 상태입니다.'
        : `'${from}' 에서 가능한 전이: ${SKU_STATUS_TRANSITIONS[from].join(', ') || '(없음)'}`,
  });
}
