import { AuthorizationError, ERROR_CODES } from '@/shared/errors';

/**
 * 자기승인 정책 (T0-7) — 순수 함수.
 *
 * T0-7 은 실제 SKU·BOM·재고조정 워크플로를 구현하지 않는다. 다만 **정책은 지금
 * 확정**해 두어야 나중에 각 모듈이 제각기 다른 규칙을 만들지 않는다.
 *
 * ┌──────────────────────────────┬──────────────────────────────────┐
 * │ 워크플로                     │ 자기승인 허용                    │
 * ├──────────────────────────────┼──────────────────────────────────┤
 * │ SKU                          │ allow_self_approval_sku 설정     │
 * │ BOM                          │ allow_self_approval_bom 설정     │
 * │ INVENTORY_ADJUSTMENT         │ ❌ 항상 금지                     │
 * │ NEGATIVE_STOCK_EXCEPTION     │ ❌ 항상 금지                     │
 * │ INVENTORY_CLOSE_REOPEN       │ ❌ 항상 금지                     │
 * └──────────────────────────────┴──────────────────────────────────┘
 *
 * ⛔ 아래 3종은 **설정을 읽지 않는다.** 설정으로 열 수 있게 두면 언젠가 열린다.
 *    재고 원장은 불변이고 마감은 회계 기간을 확정하므로, 한 사람이 요청과 승인을
 *    모두 하면 통제가 성립하지 않는다. **ADMIN 도 예외가 없다.**
 */

export const APPROVAL_WORKFLOWS = [
  'SKU',
  'BOM',
  'INVENTORY_ADJUSTMENT',
  'NEGATIVE_STOCK_EXCEPTION',
  'INVENTORY_CLOSE_REOPEN',
] as const;

export type ApprovalWorkflow = (typeof APPROVAL_WORKFLOWS)[number];

/** 자기승인 판정에 필요한 설정. `SystemSetting` 의 일부다. */
export interface SelfApprovalSettings {
  readonly allowSelfApprovalSku: boolean;
  readonly allowSelfApprovalBom: boolean;
}

/** 설정과 무관하게 항상 분리해야 하는 워크플로. */
export const ALWAYS_SEPARATED_WORKFLOWS: readonly ApprovalWorkflow[] = [
  'INVENTORY_ADJUSTMENT',
  'NEGATIVE_STOCK_EXCEPTION',
  'INVENTORY_CLOSE_REOPEN',
];

export interface CanSelfApproveInput {
  readonly workflow: ApprovalWorkflow;
  readonly settings: SelfApprovalSettings;
}

/** 이 워크플로에서 요청자가 스스로 승인할 수 있는가. */
export function canSelfApprove(input: CanSelfApproveInput): boolean {
  switch (input.workflow) {
    case 'SKU':
      return input.settings.allowSelfApprovalSku;
    case 'BOM':
      return input.settings.allowSelfApprovalBom;
    // ⛔ 설정을 읽지 않는다.
    case 'INVENTORY_ADJUSTMENT':
    case 'NEGATIVE_STOCK_EXCEPTION':
    case 'INVENTORY_CLOSE_REOPEN':
      return false;
  }
}

export interface AssertApprovalActorInput {
  readonly requesterId: string;
  readonly approverId: string;
  readonly workflow: ApprovalWorkflow;
  readonly settings: SelfApprovalSettings;
}

/**
 * 승인자가 요청자와 같아도 되는지 검사한다.
 *
 * 서로 다르면 항상 통과한다. 같은 경우에만 정책을 본다.
 *
 * @throws {AuthorizationError} `SELF_APPROVAL_FORBIDDEN` / HTTP 403
 */
export function assertApprovalActor(input: AssertApprovalActorInput): void {
  if (input.requesterId !== input.approverId) return;
  if (canSelfApprove({ workflow: input.workflow, settings: input.settings })) return;

  const alwaysSeparated = ALWAYS_SEPARATED_WORKFLOWS.includes(input.workflow);

  throw new AuthorizationError(ERROR_CODES.SELF_APPROVAL_FORBIDDEN, {
    message: alwaysSeparated
      ? `${input.workflow} 은 설정과 무관하게 요청자와 승인자가 달라야 합니다.`
      : `${input.workflow} 자가승인이 허용되지 않았습니다.`,
    publicHint: '요청자와 다른 사용자가 승인해야 합니다.',
    context: {
      workflow: input.workflow,
      requesterId: input.requesterId,
      approverId: input.approverId,
      alwaysSeparated,
    },
  });
}
