import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { assertApprovalActor } from '@/modules/settings/domain/self-approval';
import { withTransaction, type TransactionClient } from '@/shared/db';

import { assertAllRequiredQuantitiesConfirmed } from '../domain';

import { assertNoBomCycleForCandidate } from './cycle-graph';
import { withBomCycleGraphLock } from '../infrastructure/cycle-graph-lock';

import { type BomMutateDependencies } from './create-bom';
import { parseBomId } from './dto';
import { lockBomHeaderRow } from './locks';
import { BOM_APPROVE_PERMISSION, BOM_SUBMIT_PERMISSION } from './policy';
import { bomNotFound } from './refs';
import { shouldPerformBomTransition, type BomWorkflowAction } from './transitions';
import {
  BOM_HEADER_VIEW_INCLUDE,
  BOM_LINE_VIEW_INCLUDE,
  toBomDetailView,
  type BomDetailView,
} from './views';
import type {
  ApproveBomInput,
  ArchiveBomInput,
  RejectBomInput,
  SubmitBomInput,
} from './workflow-dto';

/**
 * BOM workflow — submit · approve · reject · archive (T07-5).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-6(전이) · §D-8(approve vs activate) ·
 *    §D-10(submit 게이트) · §D-13(submit cycle 검사) · §D-15(권한) ·
 *    §D-16(audit) · §D-17(멱등 없음 · 반복 200 no-op) · §D-28(lock) +
 *    `★ T07-5 workflow gap closure` W-1 · W-8.
 *
 * `activate`·`deactivate` 는 temporal chain 을 다루므로 `activation.ts`,
 * `clone` 은 복제이므로 `clone-bom.ts` 에 있다.
 *
 * ## 공통 계약
 *
 * - **응답은 언제나 `BomDetail`** + HTTP 200 (W-8). 별도 result DTO 없음.
 * - **멱등 키를 받지 않는다** (D-17). 자연 멱등이며 이미 목표 상태면
 *   **200 no-op · write 0 · Audit 0** 이다.
 * - transaction 안에서 header 를 **lock 한 뒤 status 를 다시 읽어** 판정한다
 *   (TOCTOU 금지 · D-28).
 * - `note`·`reason` 은 **`AuditLog.reason`** 에만 남는다 — BomHeader 에
 *   컬럼을 신설하지 않는다.
 *
 * ⛔ generic status PATCH 를 만들지 않는다.
 * ⛔ 자가승인 검사는 **approve 에만** 있다 (D-8).
 */

/** workflow 응답 — W-8. 6종 모두 같은 모양이다. */
export interface BomWorkflowResult {
  readonly bom: BomDetailView;
}

/** `AuditLog.entityType`. */
export const BOM_WORKFLOW_ENTITY_TYPE = 'BomHeader';

interface LockedHeader {
  readonly id: string;
  readonly status: string;
  readonly parentSkuId: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly createdBy: string | null;
}

/**
 * header 를 잠그고 **잠근 뒤에** 다시 읽는다.
 *
 * ⚠️ 트랜잭션 밖에서 읽은 status 를 믿고 update 하면 동시 workflow 와 경합해
 *    stale 판정이 된다 (D-28).
 */
export async function lockAndLoadHeader(
  tx: TransactionClient,
  bomId: string,
): Promise<LockedHeader> {
  await lockBomHeaderRow(tx, bomId);
  const header = await tx.bomHeader.findUnique({
    where: { id: bomId },
    select: {
      id: true,
      status: true,
      parentSkuId: true,
      effectiveFrom: true,
      effectiveTo: true,
      createdBy: true,
    },
  });
  if (header === null) throw bomNotFound(bomId);
  return header;
}

/** 응답용 `BomDetail` — `GET /api/boms/{id}` 와 **같은 정렬**이다. */
export async function loadBomDetailInTransaction(
  tx: TransactionClient,
  bomId: string,
): Promise<BomDetailView> {
  const header = await tx.bomHeader.findUnique({
    where: { id: bomId },
    include: BOM_HEADER_VIEW_INCLUDE,
  });
  if (header === null) throw bomNotFound(bomId);
  const lines = await tx.bomLine.findMany({
    where: { bomHeaderId: bomId },
    include: BOM_LINE_VIEW_INCLUDE,
    orderBy: [{ lineNo: 'asc' }, { id: 'asc' }],
  });
  return toBomDetailView(header, lines);
}

/** `BomHeader` workflow audit 1건 — D-16. */
export async function writeWorkflowAudit(
  tx: TransactionClient,
  logger: AuditLogger,
  actor: ActorContext,
  bomId: string,
  action: string,
  before: unknown,
  after: unknown,
  reason?: string,
): Promise<void> {
  await logger.write(tx, {
    actor,
    entityType: BOM_WORKFLOW_ENTITY_TYPE,
    entityId: bomId,
    action,
    beforeValue: before,
    afterValue: after,
    ...(reason !== undefined ? { reason } : {}),
  });
}

// ═══════════════════════════════════════════════════════════════
// submit — DRAFT·REJECTED → PENDING_APPROVAL
// ═══════════════════════════════════════════════════════════════

/**
 * `POST /api/boms/{id}/submit` — 승인 요청. `bom.submit`.
 *
 * ## 두 가지를 검사한다
 *
 * ① **소요량 게이트** (D-10) — `isRequired = true` 인 라인 중 하나라도
 *    `quantityStatus ≠ CONFIRMED` 면 **422 `BOM_QTY_UNCONFIRMED`**.
 *    `isRequired = false` 라인은 게이트 대상이 **아니다**.
 *    ⛔ submit 이 수량을 자동 확정하지 않는다 — T07-4 bulk-confirm 을 호출하지
 *       않으며 `UNKNOWN`/`SUGGESTED` 를 건드리지 않는다. **검증만** 한다.
 *
 * ② **cycle 재검사** (D-13 검사표) — evaluation date 는 candidate 의
 *    `effectiveFrom` 이다. 라인 추가 이후 다른 BOM 이 바뀌었을 수 있다.
 *    T07-2 `validateBomCandidateInTransaction` 을 그대로 재사용하며
 *    global `BOM_CYCLE_GRAPH` transaction advisory lock 아래에서 수행된다.
 */
export async function submitBom(
  actor: ActorContext,
  rawBomId: string,
  input: SubmitBomInput,
  dependencies: BomMutateDependencies = {},
): Promise<BomWorkflowResult> {
  assertPermission(actor, BOM_SUBMIT_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  // ★ advisory lock 을 **가장 먼저** 잡는다 (D-28 lock acquisition order).
  //   T07-3 의 line CRUD 도 같은 순서다 — 반대로 잡으면 header row lock 을 든
  //   채 advisory 를 기다리게 되어 line PATCH 와 **deadlock** 이 난다.
  return run(async (tx) =>
    withBomCycleGraphLock(tx, async () => {
      const header = await lockAndLoadHeader(tx, bomId);
      if (!shouldPerformBomTransition(bomId, 'submit', header.status)) {
        // 이미 PENDING_APPROVAL — write 0 · Audit 0.
        return { bom: await loadBomDetailInTransaction(tx, bomId) };
      }

      const lines = await tx.bomLine.findMany({
        where: { bomHeaderId: bomId },
        select: {
          lineNo: true,
          componentSkuId: true,
          quantityPer: true,
          quantityStatus: true,
          isRequired: true,
        },
        orderBy: [{ lineNo: 'asc' }],
      });

      // ① 소요량 게이트 — Decimal 을 숫자로 바꾸지 않는다(상태 컬럼만 본다).
      assertAllRequiredQuantitiesConfirmed(
        lines.map((line) => ({
          quantityPer: line.quantityPer === null ? null : String(line.quantityPer),
          quantityStatus: line.quantityStatus,
          isRequired: line.isRequired,
          lineNo: line.lineNo,
        })),
      );

      // ② cycle 재검사 — evaluationDate = candidate.effectiveFrom (D-13).
      //    advisory lock 은 이미 위에서 잡았으므로 DFS 만 수행한다.
      await assertNoBomCycleForCandidate(tx, {
        candidate: {
          parentSkuId: header.parentSkuId,
          componentSkuIds: lines.map((line) => line.componentSkuId),
          bomHeaderId: bomId,
        },
        evaluationDate: header.effectiveFrom,
      });

      await tx.bomHeader.update({ where: { id: bomId }, data: { status: 'PENDING_APPROVAL' } });
      await writeWorkflowAudit(
        tx,
        logger,
        actor,
        bomId,
        'SUBMIT',
        { status: header.status },
        { status: 'PENDING_APPROVAL' },
        input.note,
      );

      return { bom: await loadBomDetailInTransaction(tx, bomId) };
    }),
  );
}

// ═══════════════════════════════════════════════════════════════
// approve — PENDING_APPROVAL → APPROVED
// ═══════════════════════════════════════════════════════════════

/**
 * `POST /api/boms/{id}/approve` — 승인. `bom.approve`.
 *
 * ⛔ **활성화가 아니다** (D-8). `status = APPROVED` 와 `approvedAt/By` 만
 *    쓰고 `effectiveFrom`·`effectiveTo`·`activatedAt` 은 건드리지 않으며
 *    다른 버전의 기간도 바꾸지 않는다.
 *
 * ★ **자가승인 검사는 여기에만 있다** (D-8). 트랜잭션 안에서 최신
 *   `SystemSetting.allowSelfApprovalBom` 을 다시 읽어 판정한다 —
 *   요청 body 의 어떤 값도 믿지 않는다. 요청자 기준은 **`createdBy`** 이고
 *   `null` 이면 비교 대상이 없으므로 **통과**시킨다.
 */
export async function approveBom(
  actor: ActorContext,
  rawBomId: string,
  input: ApproveBomInput,
  dependencies: BomMutateDependencies = {},
): Promise<BomWorkflowResult> {
  assertPermission(actor, BOM_APPROVE_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const header = await lockAndLoadHeader(tx, bomId);
    if (!shouldPerformBomTransition(bomId, 'approve', header.status)) {
      // 이미 APPROVED — approvedBy 를 덮어쓰지 않는다.
      return { bom: await loadBomDetailInTransaction(tx, bomId) };
    }

    // ★ 자가승인 — 같은 트랜잭션의 최신 설정으로만 판정한다.
    if (header.createdBy !== null) {
      const settings = await tx.systemSetting.findUniqueOrThrow({
        where: { id: 1 },
        select: { allowSelfApprovalSku: true, allowSelfApprovalBom: true },
      });
      assertApprovalActor({
        requesterId: header.createdBy,
        approverId: actor.userId,
        workflow: 'BOM',
        settings,
      });
    }

    await tx.bomHeader.update({
      where: { id: bomId },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: actor.userId },
    });
    await writeWorkflowAudit(
      tx,
      logger,
      actor,
      bomId,
      'APPROVE',
      { status: header.status },
      { status: 'APPROVED', approvedBy: actor.userId },
      input.note,
    );

    return { bom: await loadBomDetailInTransaction(tx, bomId) };
  });
}

// ═══════════════════════════════════════════════════════════════
// reject — PENDING_APPROVAL → REJECTED
// ═══════════════════════════════════════════════════════════════

/**
 * `POST /api/boms/{id}/reject` — 반려. `bom.approve` (승인과 같은 authority).
 *
 * `reason` 필수이며 **`AuditLog.reason`** 에만 남는다 — `rejectionReason`
 * 컬럼을 만들지 않는다.
 *
 * ⛔ `approvedAt`·`approvedBy` 를 설정하지 않는다.
 * ★ `REJECTED` 는 편집 가능 상태다 (D-6) — 고친 뒤 **바로 재제출**하며
 *   `DRAFT` 로 되돌리는 전이는 없다.
 * ⛔ 자가승인 검사 없음 (D-8 은 approve 에만 요구한다).
 */
export async function rejectBom(
  actor: ActorContext,
  rawBomId: string,
  input: RejectBomInput,
  dependencies: BomMutateDependencies = {},
): Promise<BomWorkflowResult> {
  assertPermission(actor, BOM_APPROVE_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const header = await lockAndLoadHeader(tx, bomId);
    if (!shouldPerformBomTransition(bomId, 'reject', header.status)) {
      return { bom: await loadBomDetailInTransaction(tx, bomId) };
    }

    await tx.bomHeader.update({ where: { id: bomId }, data: { status: 'REJECTED' } });
    await writeWorkflowAudit(
      tx,
      logger,
      actor,
      bomId,
      'REJECT',
      { status: header.status },
      { status: 'REJECTED' },
      input.reason,
    );

    return { bom: await loadBomDetailInTransaction(tx, bomId) };
  });
}

// ═══════════════════════════════════════════════════════════════
// archive — DRAFT·REJECTED → ARCHIVED
// ═══════════════════════════════════════════════════════════════

/**
 * `POST /api/boms/{id}/archive` — 보관. `bom.approve`.
 *
 * ⚠️ body 는 **`{reason}` 필수** 다 (W-1). D-6 표가 body 를 비워 두었던 것을
 *    gap closure 가 확정했다. reason 은 `AuditLog.reason` 에만 남는다.
 *
 * 대상은 **`DRAFT`·`REJECTED` 뿐**이다 — 한 번이라도 발효된 버전
 * (`APPROVED` 이후)은 이력이므로 보관 대상이 아니다 (D-6 확정 3번).
 *
 * ⛔ 물리삭제가 아니다 — header·line·version·기간 전부 그대로 두고 status 만
 *    바꾼다. 목록에서 감추는 용도다.
 * ⛔ cycle DFS·advisory lock 을 잡지 않는다 — archive 는 edge 를 **제거**할
 *    뿐이라 순환을 만들 수 없다 (D-28 표).
 */
export async function archiveBom(
  actor: ActorContext,
  rawBomId: string,
  input: ArchiveBomInput,
  dependencies: BomMutateDependencies = {},
): Promise<BomWorkflowResult> {
  assertPermission(actor, BOM_APPROVE_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const header = await lockAndLoadHeader(tx, bomId);
    if (!shouldPerformBomTransition(bomId, 'archive', header.status)) {
      return { bom: await loadBomDetailInTransaction(tx, bomId) };
    }

    await tx.bomHeader.update({ where: { id: bomId }, data: { status: 'ARCHIVED' } });
    await writeWorkflowAudit(
      tx,
      logger,
      actor,
      bomId,
      'ARCHIVE',
      { status: header.status },
      { status: 'ARCHIVED' },
      input.reason,
    );

    return { bom: await loadBomDetailInTransaction(tx, bomId) };
  });
}

export type { BomWorkflowAction };
