import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { assertApprovalActor } from '@/modules/settings/domain/self-approval';
import { assertSkuStatusTransition, type SkuStatusValue } from '@/modules/sku/domain';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { ConflictError, DomainError, ERROR_CODES } from '@/shared/errors';

import {
  buildSkuApprovalValidationReport,
  type SkuApprovalValidationReport,
} from './approval-validation';
import type { SkuMutateDependencies } from './create-sku';
import { SKU_ENTITY_TYPE } from './create-sku';
import { parseSkuId } from './dto';
import { SKU_APPROVE_PERMISSION, SKU_DEACTIVATE_PERMISSION, SKU_SUBMIT_PERMISSION } from './policy';
import { skuNotFound } from './update-sku';
import { SKU_VIEW_INCLUDE, toSkuView, type SkuView } from './views';
import type {
  ApproveSkuInput,
  DeactivateSkuInput,
  RejectSkuInput,
  SubmitSkuInput,
} from './workflow-dto';

/**
 * SKU 승인 워크플로 (T1-4A) — submit / approve / reject / deactivate.
 *
 * ⚠️ **2차 권한 가드.** 각 action 첫 단계에서 권한을 재검사한다. ADMIN bypass 없음.
 * ⚠️ 상태전이 규칙은 **T1-2 domain guard(`assertSkuStatusTransition`) 재사용** —
 *    여기서 전이표를 복제하지 않는다.
 * ⚠️ 상태변경·감사로그는 **같은 트랜잭션** — 감사 실패 시 상태변경도 롤백된다.
 * ⚠️ **archive 는 이 파일에 없다** — BOM usage provider 부재로 T1-4B 연기
 *    (`hasBomUsage=false` 상수 가정 금지). 라우트 stub 도 만들지 않는다.
 * ⚠️ 이  5개 워크플로 POST 는 API 문서상 멱등 대상이 아니다 — T1-3 공용
 *    IdempotencyRecord 를 임의로 적용하지 않는다.
 *
 * ## 동시성 — 조건부 원자 update
 *
 * read → update 사이 경합을 막기 위해 UPDATE 에 **기대 상태를 조건으로**
 * 포함한다(`updateMany where {id, status: from}`). 영향 행이 0 이면 그 사이
 * 다른 action 이 상태를 바꾼 것이므로, 최신 상태를 다시 읽어 T1-2 guard 로
 * 판정한다 — PENDING 에 approve·reject 가 동시에 와도 정확히 하나만 성공하고
 * 나머지는 INVALID_STATUS_TRANSITION(422)이다. DB isolation 에 우연히 기대지
 * 않는다.
 */

export interface SkuWorkflowResult {
  readonly sku: SkuView;
  /** submit·approve 만 포함 — V1~V9 report (WARNING 포함). */
  readonly validation?: SkuApprovalValidationReport;
}

function approvalValidationFailed(report: SkuApprovalValidationReport): DomainError {
  return new DomainError(ERROR_CODES.SKU_APPROVAL_VALIDATION_FAILED, {
    message: '승인 전 검증(V1~V9)에서 ERROR FAIL 이 발생했습니다.',
    publicDetails: {
      checks: report.checks.map((check) => ({ ...check })),
      hasErrors: report.hasErrors,
      hasWarnings: report.hasWarnings,
    },
  });
}

type SkuRowWithRefs = NonNullable<Awaited<ReturnType<TransactionClient['sku']['findFirst']>>> & {
  brand: { id: string; code: string; name: string; active: boolean } | null;
  majorCategory: { id: string; code: string; name: string; active: boolean } | null;
  minorCategory: { id: string; code: string; name: string; active: boolean } | null;
};

async function loadSkuOr404(tx: TransactionClient, skuId: string): Promise<SkuRowWithRefs> {
  const row = await tx.sku.findFirst({
    where: { id: skuId, deletedAt: null },
    include: SKU_VIEW_INCLUDE,
  });
  if (row === null) throw skuNotFound(skuId);
  return row as SkuRowWithRefs;
}

interface TransitionSpec {
  readonly to: SkuStatusValue;
  readonly action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'DEACTIVATE';
  /** AuditLog.reason 으로 기록될 자유 텍스트 (reject 의 reason, submit/approve 의 note 등). */
  readonly reasonText?: string;
  /** approve 만 — approvedAt/approvedBy 설정 + AuditLog.approvedBy. */
  readonly markApproved?: boolean;
}

/**
 * 조건부 원자 상태전이 + 감사로그. 호출 전에 caller 가 권한·자가승인·검증을
 * 이미 통과시킨 상태여야 한다.
 */
async function transitionSku(
  tx: TransactionClient,
  actor: ActorContext,
  logger: AuditLogger,
  row: SkuRowWithRefs,
  spec: TransitionSpec,
): Promise<SkuView> {
  // T1-2 domain guard — 전이표의 유일한 출처.
  assertSkuStatusTransition(row.status, spec.to);

  const beforeView = toSkuView(row);

  // ★ 조건부 원자 update — 기대 상태(from)가 조건이다.
  const updated = await tx.sku.updateMany({
    where: { id: row.id, status: row.status, deletedAt: null },
    data: {
      status: spec.to,
      updatedBy: actor.userId,
      ...(spec.markApproved === true ? { approvedAt: new Date(), approvedBy: actor.userId } : {}),
      // reject·deactivate 는 기존 approvedAt/approvedBy 를 건드리지 않는다.
    },
  });

  if (updated.count === 0) {
    // 그 사이 다른 action 이 상태를 바꿨다 — 최신 상태로 다시 판정한다.
    const fresh = await tx.sku.findFirst({
      where: { id: row.id, deletedAt: null },
      select: { status: true },
    });
    if (fresh === null) throw skuNotFound(row.id);
    // 같은 전이가 아직 유효할 수는 없다(상태가 바뀌었으므로). guard 가 422 를 낸다.
    assertSkuStatusTransition(fresh.status, spec.to);
    // 이론상 도달 불가 — 방어적 conflict.
    throw new ConflictError(ERROR_CODES.SERIALIZATION_FAILURE, {
      message: '동시 상태변경 경합이 발생했습니다. 다시 시도하세요.',
      retryable: true,
    });
  }

  const after = await loadSkuOr404(tx, row.id);
  const afterView = toSkuView(after);

  // ★ 같은 트랜잭션 — 실패 시 상태변경도 롤백된다.
  await logger.write(tx, {
    actor,
    entityType: SKU_ENTITY_TYPE,
    entityId: row.id,
    action: spec.action,
    beforeValue: beforeView,
    afterValue: afterView,
    ...(spec.reasonText !== undefined ? { reason: spec.reasonText } : {}),
    ...(spec.markApproved === true ? { approvedBy: actor.userId } : {}),
  });

  return afterView;
}

/** `POST /api/skus/{id}/submit` — DRAFT → PENDING_APPROVAL. `sku.submit`. */
export async function submitSku(
  actor: ActorContext,
  id: string,
  input: SubmitSkuInput,
  dependencies: SkuMutateDependencies = {},
): Promise<SkuWorkflowResult> {
  assertPermission(actor, SKU_SUBMIT_PERMISSION);
  const skuId = parseSkuId(id);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const row = await loadSkuOr404(tx, skuId);

    // 상태 오류를 검증 오류보다 먼저 — DRAFT 가 아니면 검증할 이유가 없다.
    assertSkuStatusTransition(row.status, 'PENDING_APPROVAL');

    // V1~V9 — ERROR FAIL 이면 상태변경 없이 422 + 결과 반환.
    const validation = await buildSkuApprovalValidationReport(tx, row);
    if (validation.hasErrors) throw approvalValidationFailed(validation);

    const sku = await transitionSku(tx, actor, logger, row, {
      to: 'PENDING_APPROVAL',
      action: 'SUBMIT',
      ...(input.note !== undefined ? { reasonText: input.note } : {}),
    });
    // WARNING 은 차단하지 않고 응답에 포함한다.
    return { sku, validation };
  });
}

/**
 * `POST /api/skus/{id}/approve` — PENDING_APPROVAL → ACTIVE. `sku.approve`.
 *
 * - 자가승인: **트랜잭션 안에서 최신** `SystemSetting.allowSelfApprovalSku` 를
 *   읽어 판정한다 (T0-7 `assertApprovalActor` 재사용, BOM 설정 사용 금지).
 * - V1~V9 를 **재검증**한다 (08 문서 §4) — submit 후 참조 코드 비활성화 등.
 *   ERROR FAIL 이 새로 생기면 PENDING 유지 + 422.
 */
export async function approveSku(
  actor: ActorContext,
  id: string,
  input: ApproveSkuInput,
  dependencies: SkuMutateDependencies = {},
): Promise<SkuWorkflowResult> {
  assertPermission(actor, SKU_APPROVE_PERMISSION);
  const skuId = parseSkuId(id);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const row = await loadSkuOr404(tx, skuId);
    assertSkuStatusTransition(row.status, 'ACTIVE');

    // ── 자가승인 — 클라이언트 값이 아니라 같은 트랜잭션의 최신 설정으로만. ──
    if (row.createdBy !== null) {
      const settings = await tx.systemSetting.findUniqueOrThrow({
        where: { id: 1 },
        select: { allowSelfApprovalSku: true, allowSelfApprovalBom: true },
      });
      assertApprovalActor({
        requesterId: row.createdBy,
        approverId: actor.userId,
        workflow: 'SKU',
        settings,
      });
    }

    // ── V1~V9 재검증 — ERROR FAIL 이면 ACTIVE 전환 금지(PENDING 유지). ──
    const validation = await buildSkuApprovalValidationReport(tx, row);
    if (validation.hasErrors) throw approvalValidationFailed(validation);

    const sku = await transitionSku(tx, actor, logger, row, {
      to: 'ACTIVE',
      action: 'APPROVE',
      markApproved: true,
      ...(input.note !== undefined ? { reasonText: input.note } : {}),
    });
    return { sku, validation };
  });
}

/**
 * `POST /api/skus/{id}/reject` — PENDING_APPROVAL → REJECTED. `sku.approve`
 * (승인/반려는 동일 authority — 별도 sku.reject 없음). reason 필수.
 * approvedAt/approvedBy 를 설정하지 않는다.
 */
export async function rejectSku(
  actor: ActorContext,
  id: string,
  input: RejectSkuInput,
  dependencies: SkuMutateDependencies = {},
): Promise<SkuWorkflowResult> {
  assertPermission(actor, SKU_APPROVE_PERMISSION);
  const skuId = parseSkuId(id);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const row = await loadSkuOr404(tx, skuId);
    const sku = await transitionSku(tx, actor, logger, row, {
      to: 'REJECTED',
      action: 'REJECT',
      reasonText: input.reason,
    });
    return { sku };
  });
}

/**
 * `POST /api/skus/{id}/deactivate` — ACTIVE → INACTIVE. `sku.deactivate`.
 * 기존 approvedAt/approvedBy 를 유지한다.
 *
 * ⚠️ "활성 BOM 사용 중이면 경고"(05 §10.4)는 BOM 모델 부재로 **T1-4B 연기** —
 *    경고 부재가 ACTIVE→INACTIVE 자체를 막지 않는다 (문서상 차단이 아니라 경고).
 */
export async function deactivateSku(
  actor: ActorContext,
  id: string,
  input: DeactivateSkuInput,
  dependencies: SkuMutateDependencies = {},
): Promise<SkuWorkflowResult> {
  assertPermission(actor, SKU_DEACTIVATE_PERMISSION);
  const skuId = parseSkuId(id);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const row = await loadSkuOr404(tx, skuId);
    const sku = await transitionSku(tx, actor, logger, row, {
      to: 'INACTIVE',
      action: 'DEACTIVATE',
      ...(input.reason !== undefined ? { reasonText: input.reason } : {}),
    });
    return { sku };
  });
}
