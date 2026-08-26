import { z } from 'zod';

import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import {
  assertComponentEligible,
  assertNotSelfComponent,
  assertQuantityConsistency,
  assertUomMatchesBase,
} from '../domain';
import { withBomCycleGraphLock } from '../infrastructure/cycle-graph-lock';

import { translateBomLineWriteError } from './constraint-errors';
import { type BomMutateDependencies } from './create-bom';
import { assertNoBomCycleForCandidate } from './cycle-graph';
import { normalizeAlternateGroup, parseBomId, type CreateLineInput } from './dto';
import { assertBomEditable } from './editability';
import { lockBomHeaderRow, lockSkuRows } from './locks';
import { BOM_UPDATE_PERMISSION } from './policy';
import { assertWarehouseExists, bomNotFound, loadBomSkuRef } from './refs';
import { BOM_LINE_VIEW_INCLUDE, toBomLineView, type BomLineView } from './views';

/**
 * `POST /api/boms/{id}/lines` — BOM 라인 추가 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-14(CreateLineDto) · §D-9 · §D-10(소요량)
 *    · §D-11(UOM) · §D-12(구성품 자격) · §D-13(순환) · §D-28(lock) · §D-16 · §D-17.
 *
 * ⚠️ **2차 권한 가드** `bom.update` — 라인 추가는 BOM 수정이다 (D-15 route-policy
 *    가 `contains:'/lines'` + POST 를 `bom.update` 로 잡는 것과 같은 판단).
 *
 * ## ★ 트랜잭션 순서 — tentative INSERT 를 **먼저** 하고 그 상태로 검사한다
 *
 * ```
 * 1. transaction
 * 2. pg_advisory_xact_lock(BOM_CYCLE_GRAPH)   ← graph read 이전 (D-28)
 * 3. bom_header row lock → 참조 SKU row lock(id ASC)
 * 4. status 재확인 (lock 이후)
 * 5. 구성품·소요량·UOM 검증
 * 6. tentative BomLine INSERT                 ← §D-44 A안
 * 7. INSERT **이후** 라인 집합으로 candidate graph 구성 → DFS
 * 8. Audit BomLine CREATE
 * 9. (멱등 결과 기록) → commit
 * ```
 *
 * 순환이면 예외가 나고 **트랜잭션 전체가 롤백**된다 — 라인도, audit 도,
 * 멱등 성공 결과도 남지 않는다. ⛔ INSERT 전 상태로 검사하지 않는다: 그러면
 * 방금 넣는 edge 가 그래프에서 빠져 자기 자신이 만드는 순환을 못 본다.
 *
 * ## `lineNo`
 *
 * 생략(또는 null)이면 서버가 `max(lineNo) + 1` 로 채운다 (D-14). 동시 삽입은
 * `(bom_header_id, line_no)` UNIQUE 가 최종 판정자다 → 409 `BOM_LINE_DUPLICATE`.
 *
 * ## 멱등성 (D-17)
 *
 * routeScope 는 docs/18 이 확정한 **`bom:{bomId}:line:create`** — 실제 bomId 를
 * 포함하므로 다른 BOM 에 같은 key 를 써도 독립이다.
 */

export const BOM_LINE_ENTITY_TYPE = 'BomLine';

/** D-17 표의 exact routeScope. */
export function bomLineCreateRouteScope(bomId: string): string {
  return `bom:${bomId}:line:create`;
}

export interface CreateLineResult {
  readonly line: BomLineView;
  readonly replayed: boolean;
}

const lineSnapshotSchema = z.looseObject({
  id: z.uuid(),
  bomHeaderId: z.uuid(),
  lineNo: z.number(),
  componentSkuId: z.uuid(),
});

export function parseBomLineViewSnapshot(raw: unknown): BomLineView {
  const result = lineSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 BomLineView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as BomLineView;
}

async function performCreateLine(
  tx: TransactionClient,
  actor: ActorContext,
  bomId: string,
  input: CreateLineInput,
  logger: AuditLogger,
): Promise<BomLineView> {
  await lockBomHeaderRow(tx, bomId);

  const header = await tx.bomHeader.findUnique({
    where: { id: bomId },
    select: { id: true, parentSkuId: true, status: true, effectiveFrom: true },
  });
  if (header === null) throw bomNotFound(bomId);

  // ★ lock 이후 재확인.
  assertBomEditable(bomId, header.status);

  // 참조 SKU 를 결정적 순서로 잠근다 (secondary, D-28).
  await lockSkuRows(tx, [header.parentSkuId, input.componentSkuId]);

  // D-12 — 직접 자기참조는 그래프 검사보다 먼저 빠르게 거부한다.
  assertNotSelfComponent({
    parentSkuId: header.parentSkuId,
    componentSkuId: input.componentSkuId,
  });

  const component = await loadBomSkuRef(tx, input.componentSkuId);
  assertComponentEligible({ skuId: component.id, status: component.status });

  // D-11 — 생략 시 구성품 baseUom, 명시했으면 반드시 같아야 한다.
  const uom = input.uom ?? component.baseUom;
  assertUomMatchesBase({ uom, baseUom: component.baseUom, skuId: component.id });

  // D-10 — 상태·소요량 정합. ⛔ 자동 "1" 입력 없음.
  const quantityStatus = input.quantityStatus ?? 'UNKNOWN';
  const quantityPer = input.quantityPer ?? null;
  assertQuantityConsistency({ quantityPer, quantityStatus });

  // ★ T08-1 이 warehouse FK 를 landing 시켰다 — 없는 UUID 가 raw P2003 으로
  //   새지 않게 미리 확인한다 (docs/19 §W-D15). null 은 여전히 정상값이다.
  if (input.issueWarehouseId !== undefined && input.issueWarehouseId !== null) {
    await assertWarehouseExists(tx, input.issueWarehouseId);
  }

  const lineNo =
    input.lineNo ??
    ((
      await tx.bomLine.aggregate({
        where: { bomHeaderId: bomId },
        _max: { lineNo: true },
      })
    )._max.lineNo ?? 0) + 1;

  let created;
  try {
    created = await tx.bomLine.create({
      data: {
        bomHeaderId: bomId,
        lineNo,
        componentSkuId: input.componentSkuId,
        quantityPer,
        quantityStatus,
        uom,
        lossRate: input.lossRate ?? null,
        componentRole: input.componentRole,
        supplyType: input.supplyType ?? null,
        // ★ blank → null 최종 방어선 — DTO 를 거치지 않는 내부 호출에서도
        //   `''` 이 저장되지 않는다 (D-3).
        alternateGroup: normalizeAlternateGroup(input.alternateGroup),
        isRequired: input.isRequired ?? true,
        // ★ T08-1 FK landing 이후 위에서 존재를 검증한다 (docs/19 §W-D15).
        issueWarehouseId: input.issueWarehouseId ?? null,
        packQuantity: input.packQuantity ?? null,
        specification: input.specification ?? null,
        note: input.note ?? null,
        // ⛔ legacy* 는 server-owned — DTO 가 400 으로 막는다.
      },
      include: BOM_LINE_VIEW_INCLUDE,
    });
  } catch (error) {
    translateBomLineWriteError(error, input.lineNo ?? lineNo);
  }

  // ★ INSERT **이후** 상태로 검사한다 (§D-13 규칙 5 · §D-44 A안).
  const afterLines = await tx.bomLine.findMany({
    where: { bomHeaderId: bomId },
    select: { componentSkuId: true },
    orderBy: [{ lineNo: 'asc' }],
  });
  await assertNoBomCycleForCandidate(tx, {
    candidate: {
      parentSkuId: header.parentSkuId,
      componentSkuIds: afterLines.map((line) => line.componentSkuId),
      bomHeaderId: bomId,
    },
    evaluationDate: header.effectiveFrom,
  });

  const view = toBomLineView(created);

  await logger.write(tx, {
    actor,
    entityType: BOM_LINE_ENTITY_TYPE,
    entityId: created.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: view,
  });

  return view;
}

export async function createBomLine(
  actor: ActorContext,
  rawBomId: string,
  input: CreateLineInput,
  dependencies: BomMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreateLineResult> {
  assertPermission(actor, BOM_UPDATE_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) =>
    // ★ advisory lock 을 가장 먼저 — 멱등 claim 도 이 안에서 일어난다.
    withBomCycleGraphLock(tx, async () => {
      if (idempotencyKey === undefined) {
        return {
          line: await performCreateLine(tx, actor, bomId, input, logger),
          replayed: false,
        };
      }

      const outcome = await executeWithIdempotency(
        tx,
        {
          actorId: actor.userId,
          httpMethod: 'POST',
          routeScope: bomLineCreateRouteScope(bomId),
          idempotencyKey,
        },
        requestHashOf(input),
        async () => ({
          responseStatus: 201,
          responseBody: await performCreateLine(tx, actor, bomId, input, logger),
        }),
        parseBomLineViewSnapshot,
      );
      return { line: outcome.responseBody, replayed: outcome.replayed };
    }),
  );
}
