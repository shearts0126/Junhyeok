import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * BOM workflow 전이 그래프 (T07-5) — **순수 함수**.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-6(전이 8개) + `★ T07-5 workflow gap
 *    closure` W-1(archive) · §D-17(workflow 는 멱등 키 없음 · 반복 200 no-op).
 *
 * ## 전이는 정확히 8개다
 *
 * ```
 *   DRAFT     ──submit──▶ PENDING_APPROVAL
 *   REJECTED  ──submit──▶ PENDING_APPROVAL      ★ 재제출 (DRAFT 경유 없음)
 *   PENDING   ─approve──▶ APPROVED
 *   PENDING   ──reject──▶ REJECTED
 *   APPROVED  activate──▶ ACTIVE
 *   ACTIVE   deactivate─▶ INACTIVE
 *   DRAFT     ─archive──▶ ARCHIVED
 *   REJECTED  ─archive──▶ ARCHIVED
 * ```
 *
 * ⛔ `REJECTED → DRAFT` 를 만들지 않는다 — `REJECTED` 에서 바로 편집·재제출한다.
 * ⛔ `INACTIVE → ACTIVE` 재활성화가 없다 — 필요하면 clone 으로 새 `DRAFT`.
 * ⛔ generic status PATCH 를 만들지 않는다 (D-6).
 *
 * ## 세 가지 결과만 있다
 *
 * | 판정 | 의미 |
 * |---|---|
 * | `'transition'` | 실제 전이 — write + Audit |
 * | `'noop'` | **이미 목표 상태** — 200 · write 0 · Audit 0 (D-17) |
 * | `'invalid'` | 그 밖 — 422 `BOM_INVALID_TRANSITION` |
 *
 * ⚠️ `'noop'` 은 **같은 action 의 목표 상태에 이미 도달한 경우에만** 이다.
 *    다른 action 의 무관한 상태(`DRAFT` 에서 approve 등)를 no-op 으로
 *    위장하지 않는다 — 그것은 `'invalid'` 다.
 */

export const BOM_WORKFLOW_ACTIONS = [
  'submit',
  'approve',
  'reject',
  'activate',
  'deactivate',
  'archive',
] as const;

export type BomWorkflowAction = (typeof BOM_WORKFLOW_ACTIONS)[number];

export type BomTransitionOutcome = 'transition' | 'noop' | 'invalid';

interface TransitionRule {
  /** 이 action 이 실제 전이를 수행할 수 있는 출발 상태들. */
  readonly from: readonly string[];
  /** 도달 상태. 이미 이 상태면 `noop` 이다. */
  readonly to: string;
}

/** D-6 전이표를 그대로 옮긴 것. ⛔ 여기에 없는 전이는 존재하지 않는다. */
export const BOM_TRANSITIONS: Readonly<Record<BomWorkflowAction, TransitionRule>> = {
  submit: { from: ['DRAFT', 'REJECTED'], to: 'PENDING_APPROVAL' },
  approve: { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
  reject: { from: ['PENDING_APPROVAL'], to: 'REJECTED' },
  activate: { from: ['APPROVED'], to: 'ACTIVE' },
  deactivate: { from: ['ACTIVE'], to: 'INACTIVE' },
  archive: { from: ['DRAFT', 'REJECTED'], to: 'ARCHIVED' },
};

/**
 * 현재 status 에서 action 을 수행하면 무엇이 되는가.
 *
 * ★ `noop` 판정이 `transition` 보다 **먼저**가 아니다 — 두 집합은 서로소다.
 *   어떤 action 도 `to` 를 `from` 에 포함하지 않기 때문이다(D-6 8전이 전부).
 */
export function resolveBomTransition(
  action: BomWorkflowAction,
  currentStatus: string,
): BomTransitionOutcome {
  const rule = BOM_TRANSITIONS[action];
  if (rule.from.includes(currentStatus)) return 'transition';
  if (currentStatus === rule.to) return 'noop';
  return 'invalid';
}

/** 422 `BOM_INVALID_TRANSITION` — D-29. */
export function bomInvalidTransition(
  bomId: string,
  action: BomWorkflowAction,
  currentStatus: string,
): DomainError {
  return new DomainError(ERROR_CODES.BOM_INVALID_TRANSITION, {
    message: `상태 '${currentStatus}' 에서는 '${action}' 을(를) 할 수 없습니다.`,
    context: { bomId, action, currentStatus },
    publicDetails: { action, currentStatus },
  });
}

/**
 * `transition` 이 아니면 던지거나, no-op 임을 알린다.
 *
 * @returns `true` 면 실제 전이를 진행한다. `false` 면 **no-op** 이다.
 * @throws 422 `BOM_INVALID_TRANSITION`
 */
export function shouldPerformBomTransition(
  bomId: string,
  action: BomWorkflowAction,
  currentStatus: string,
): boolean {
  const outcome = resolveBomTransition(action, currentStatus);
  if (outcome === 'invalid') throw bomInvalidTransition(bomId, action, currentStatus);
  return outcome === 'transition';
}
