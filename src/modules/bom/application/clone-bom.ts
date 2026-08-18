import { z } from 'zod';

import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { translateBomHeaderWriteError, translateBomLineWriteError } from './constraint-errors';
import { BOM_HEADER_ENTITY_TYPE, type BomMutateDependencies } from './create-bom';
import { BOM_LINE_ENTITY_TYPE } from './create-line';
import { parseBomId, parseDateOnly } from './dto';
import { BOM_CREATE_PERMISSION } from './policy';
import { bomNotFound } from './refs';
import { validateBomCandidateInTransaction } from './validate-candidate';
import {
  BOM_LINE_VIEW_INCLUDE,
  toBomLineView,
  type BomDetailView,
  type BomLineView,
} from './views';
import { loadBomDetailInTransaction } from './workflow';
import type { CloneBomInput } from './workflow-dto';

/**
 * `POST /api/boms/{id}/clone` — 버전 복제 (T07-5). `bom.create`.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-4(version) · §D-6(clone 은 모든 status) ·
 *    §D-13(clone 도 cycle 검사) · §D-16(CLONE action 없음) · §D-17(멱등) ·
 *    §D-28(clone lock sequence) + `★ T07-5 workflow gap closure`
 *    W-4 · W-5(header matrix) · W-6(line matrix) · W-7(audit) · W-8 · W-9.
 *
 * ## clone 이 새 버전을 만드는 **유일한 공식 경로**다
 *
 * ⛔ `POST /versions` 를 만들지 않는다.
 * ⛔ "다음 버전" 을 계산하지 않는다 — `newVersion` 은 client supplied 이며
 *    semantic version 파싱·자동 증가가 없다 (D-4).
 *
 * ## source 는 **모든 status** 에서 가능하다 (D-6 · W-4)
 *
 * 원본을 읽기만 하기 때문이다. 결과는 **언제나 새 `DRAFT`** 다.
 *
 * ## cycle 검사 (D-13)
 *
 * 새 header 의 `effectiveFrom`(= `request.effectiveFrom`)이 evaluation date 다.
 * 원본이 통과했던 날짜와 다르므로 그 날짜의 sibling 조합에서는 순환일 수 있다.
 * 복제가 끝난 뒤 **같은 트랜잭션 안에서** candidate graph 를 검사하고, 실패하면
 * **clone 전체를 rollback** 한다 (새 header 0 · 새 line 0 · Audit 0 · 멱등
 * 성공 결과 0).
 *
 * ## lock sequence (D-28 `clone lock sequence`)
 *
 * ```
 * 1. transaction 시작
 * 2. pg_advisory_xact_lock(BOM_CYCLE_GRAPH_LOCK_KEY)
 * 3. 새 header + lines 복제
 * 4. 새 effectiveFrom 기준 candidate graph 검사 (D-13)
 * 5. cycle 이면 transaction 전체 rollback
 * 6. audit (CREATE) → commit
 * ```
 */

/** D-17 routeScope — `bomId` 는 **source** BOM 이다 (W-9). */
export function bomCloneRouteScope(sourceBomId: string): string {
  return `bom:${sourceBomId}:clone`;
}

export interface CloneBomResult {
  readonly bom: BomDetailView;
  readonly replayed: boolean;
}

const cloneSnapshotSchema = z.looseObject({
  id: z.uuid(),
  parentSkuId: z.uuid(),
  version: z.string(),
  status: z.string(),
  lines: z.array(z.unknown()),
});

export function parseCloneSnapshot(raw: unknown): BomDetailView {
  const result = cloneSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 BomDetailView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as BomDetailView;
}

async function performClone(
  tx: TransactionClient,
  actor: ActorContext,
  sourceBomId: string,
  input: CloneBomInput,
  logger: AuditLogger,
): Promise<BomDetailView> {
  const source = await tx.bomHeader.findUnique({
    where: { id: sourceBomId },
    select: {
      id: true,
      parentSkuId: true,
      bomType: true,
      outputQty: true,
      outputUom: true,
      productionPartnerId: true,
      destinationWarehouseId: true,
      overallLossRate: true,
      description: true,
    },
  });
  if (source === null) throw bomNotFound(sourceBomId);

  const sourceLines = await tx.bomLine.findMany({
    where: { bomHeaderId: sourceBomId },
    orderBy: [{ lineNo: 'asc' }, { id: 'asc' }],
  });

  const effectiveFrom = parseDateOnly(input.effectiveFrom);

  // ── W-5 header matrix — 19 scalar 전부를 여기서 결정한다 ──────────
  //
  //   COPY     parentSkuId · bomType · outputQty · outputUom ·
  //            productionPartnerId · destinationWarehouseId ·
  //            overallLossRate · description
  //   OVERRIDE version(newVersion) · effectiveFrom · changeReason
  //   RESET    status=DRAFT · effectiveTo=null · approvedAt/By=null ·
  //            activatedAt=null · createdBy=clone actor · createdAt=now
  //
  // ⛔ source 의 승인·활성 metadata 를 승계하지 않는다 — 승계하면 "승인된 적
  //    없는 DRAFT 인데 approvedBy 가 있는 행" 이 생겨 승인 이력이 오염된다.
  // ⛔ source 의 effectiveTo 를 승계하지 않는다 — 그 값은 **source temporal
  //    chain 의 결과**이지 새 버전의 상한이 아니다. 새 상한은 이후 activation
  //    chain(D-7 6단계)이 정한다.
  let created: { id: string };
  try {
    created = await tx.bomHeader.create({
      data: {
        parentSkuId: source.parentSkuId,
        bomType: source.bomType,
        version: input.newVersion,
        status: 'DRAFT',
        outputQty: source.outputQty,
        outputUom: source.outputUom,
        effectiveFrom,
        effectiveTo: null,
        productionPartnerId: source.productionPartnerId,
        destinationWarehouseId: source.destinationWarehouseId,
        overallLossRate: source.overallLossRate,
        description: source.description,
        changeReason: input.changeReason,
        createdBy: actor.userId,
        approvedAt: null,
        approvedBy: null,
        activatedAt: null,
      },
      select: { id: true },
    });
  } catch (error) {
    // `(parentSkuId, version)` UNIQUE → 409 BOM_VERSION_DUPLICATE.
    //   `translateBomHeaderWriteError` 는 `never` 를 반환한다(항상 던진다).
    translateBomHeaderWriteError(error, input.newVersion);
  }

  // ── W-6 line matrix — 18 scalar 전부 ────────────────────────────
  //
  //   NEW    id · bomHeaderId
  //   COPY   나머지 16개 전부
  //   RESET  legacyBomCode · legacyCommonBomCode
  //
  // ⛔ `quantityPer`·`quantityStatus` 를 초기화하거나 자동 `CONFIRMED` 로
  //    만들지 않는다 (D-10 자동 1 금지와 같은 방향).
  // ⛔ `lineNo` 를 새로 채번하지 않는다 — source 의 순서·identity 를 보존한다.
  // ★ `legacy*` 는 **`BomLine` scalar** 이며 migration source row 를 가리키는
  //   추적자다. 사본이 같은 legacy source 를 주장하면 안 되므로 reset 한다.
  const clonedLines: BomLineView[] = [];
  for (const line of sourceLines) {
    try {
      const row = await tx.bomLine.create({
        data: {
          bomHeaderId: created.id,
          lineNo: line.lineNo,
          componentSkuId: line.componentSkuId,
          quantityPer: line.quantityPer,
          quantityStatus: line.quantityStatus,
          uom: line.uom,
          lossRate: line.lossRate,
          componentRole: line.componentRole,
          supplyType: line.supplyType,
          alternateGroup: line.alternateGroup,
          isRequired: line.isRequired,
          issueWarehouseId: line.issueWarehouseId,
          packQuantity: line.packQuantity,
          specification: line.specification,
          note: line.note,
          legacyBomCode: null,
          legacyCommonBomCode: null,
        },
        include: BOM_LINE_VIEW_INCLUDE,
      });
      clonedLines.push(toBomLineView(row));
    } catch (error) {
      translateBomLineWriteError(error, line.lineNo);
    }
  }

  // ── D-13: 복제 결과를 새 effectiveFrom 기준으로 검사한다 ─────────
  //   실패하면 트랜잭션 전체가 롤백되어 header·line·audit 이 전부 사라진다.
  await validateBomCandidateInTransaction(tx, {
    candidate: {
      parentSkuId: source.parentSkuId,
      componentSkuIds: sourceLines.map((line) => line.componentSkuId),
      bomHeaderId: created.id,
    },
    evaluationDate: effectiveFrom,
  });

  // ── W-7 audit: header CREATE 1건 + line CREATE N건 ──────────────
  //
  // ⛔ `CLONE` action 을 만들지 않는다 (D-16) — 결과물은 새 `BomHeader` 이므로
  //    `CREATE` 로 남기고 `afterValue` 에 원본 `sourceBomId` 를 담는다.
  // ★ 라인별 `CREATE` 를 남긴다. D-16 의 "라인마다 audit 을 만들지 않는다" 는
  //   **`bulk-confirm-qty` 전용 압축 예외**이며 clone 으로 확장하지 않는다 —
  //   그래야 source 가 나중에 바뀌어도 clone 당시의 라인 상태를 Audit 만으로
  //   독립 복원할 수 있다.
  const detail = await loadBomDetailInTransaction(tx, created.id);
  await logger.write(tx, {
    actor,
    entityType: BOM_HEADER_ENTITY_TYPE,
    entityId: created.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: { ...detail, sourceBomId: sourceBomId },
    reason: input.changeReason,
  });
  for (const line of clonedLines) {
    await logger.write(tx, {
      actor,
      entityType: BOM_LINE_ENTITY_TYPE,
      entityId: line.id,
      action: 'CREATE',
      beforeValue: null,
      afterValue: line,
    });
  }

  return detail;
}

export async function cloneBom(
  actor: ActorContext,
  rawSourceBomId: string,
  input: CloneBomInput,
  dependencies: BomMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CloneBomResult> {
  // ★ 멱등 replay 보다 먼저 — 권한을 잃은 actor 는 replay 도 403 이다.
  assertPermission(actor, BOM_CREATE_PERMISSION);
  const sourceBomId = parseBomId(rawSourceBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    if (idempotencyKey === undefined) {
      return {
        bom: await performClone(tx, actor, sourceBomId, input, logger),
        replayed: false,
      };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        routeScope: bomCloneRouteScope(sourceBomId),
        idempotencyKey,
      },
      requestHashOf(input),
      async () => ({
        // ★ 생성이므로 최초는 201, replay 는 route 가 200 으로 낸다 (W-8).
        responseStatus: 201,
        responseBody: await performClone(tx, actor, sourceBomId, input, logger),
      }),
      parseCloneSnapshot,
    );
    return { bom: outcome.responseBody, replayed: outcome.replayed };
  });
}
