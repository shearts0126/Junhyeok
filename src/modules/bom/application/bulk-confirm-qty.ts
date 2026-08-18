import { z } from 'zod';

import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { isEqual } from '@/shared/decimal';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { assertQuantityConsistency } from '../domain';

import { BOM_HEADER_ENTITY_TYPE, type BomMutateDependencies } from './create-bom';
import { parseBomId, type BulkConfirmQtyInput } from './dto';
import { assertBomEditable } from './editability';
import { lockBomHeaderRow } from './locks';
import { BOM_UPDATE_PERMISSION } from './policy';
import { bomLineNotFound, bomNotFound } from './refs';
import {
  BOM_HEADER_VIEW_INCLUDE,
  BOM_LINE_VIEW_INCLUDE,
  toBomDetailView,
  type BomDetailView,
} from './views';

/**
 * `POST /api/boms/{id}/lines/bulk-confirm-qty` — 소요량 일괄 확정 (T07-4).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-10 · §D-6 · §D-15 · §D-16 · §D-17 ·
 *    §D-28 + "T07-4 bulk-confirm gap closure".
 *
 * ## 이 endpoint 가 하는 일
 *
 * `[{lineId, quantityPer}]` 를 받아 각 라인을 **요청한 `quantityPer` +
 * `quantityStatus = CONFIRMED`** 로 만든다. `UNKNOWN`·`SUGGESTED`·`CONFIRMED`
 * 어느 상태에서 출발하든 결과는 `CONFIRMED` 다 (D-10).
 *
 * ⛔ **generic line PATCH 가 아니다.** 쓰는 컬럼은 `quantityPer` 와
 *    `quantityStatus` **둘뿐**이다 — `componentSkuId`·`alternateGroup`·
 *    `componentRole`·`supplyType`·`isRequired`·`uom`·`lineNo`·
 *    `issueWarehouseId`·`packQuantity` 는 요청 계약에 없으므로 건드리지 않는다.
 * ⛔ **자동 `"1"` 입력 없음** (D-10 · TC-BOM-010) — 값은 요청이 준 것뿐이다.
 * ⛔ **`packQuantity` → `quantityPer` 자동 계산 없음** (D-10 · TC-BOM-003).
 *    `pack=30` 이라고 서버가 `1/30` 을 확정하지 않는다.
 * ⛔ downgrade(`CONFIRMED → SUGGESTED/UNKNOWN`)를 만들지 않는다 — 그 편집은
 *    line PATCH(T07-3)의 영역이다.
 * ⛔ workflow(submit 등)로 이어지지 않는다 — T07-5 다.
 *
 * ## cycle advisory lock 을 잡지 않는다 ★
 *
 * D-28 의 advisory lock 대상 표가 이 endpoint 를 **⛔** 로 명시한다:
 * "`quantityPer` 만 바꾼다 — edge 불변". cycle 그래프의 edge 는
 * `(parentSkuId → componentSkuId)` 이며 수량은 edge 집합에 들어가지 않는다
 * (T07-2 `cycle-graph.ts` 의 line→edge 포함 계약 참조 — `quantityStatus`·
 * `quantityPer` 로 거르지 않는다는 것은 곧 **수량이 topology 와 무관**하다는
 * 뜻이다). 따라서 DFS 도 실행하지 않는다.
 *
 * lock 은 D-28 "그 밖의 lock" 표대로 **`bom_header` 행 `FOR UPDATE`** 하나다.
 * 대상 라인이 전부 이 header 소속이므로 header 한 행이 곧 이 작업의 직렬화
 * 지점이며, 동시 line PATCH·동시 bulk-confirm 이 같은 자원을 기다린다.
 *
 * ## 원자성
 *
 * **전량 검증 후 한 트랜잭션에서 전부 반영**한다 (D-10). 라인 하나라도
 * `<= 0` 이거나 다른 BOM 소속이면 **전체 rollback** 이다 — 부분 성공을
 * 만들지 않는다.
 *
 * ## 실변경만 쓴다 (gap closure B4)
 *
 * 이미 `CONFIRMED` 이고 `quantityPer` 가 요청값과 **같은** 라인은 write 대상이
 * 아니다. 전부 그런 경우(= business no-op)면 `BomLine` write 0 · **Audit 0**
 * 이고 현재 `BomDetail` 을 200 으로 돌려준다.
 *
 * ⚠️ **idempotency replay 와 business no-op 은 다른 것이다.** 전자는 같은 키가
 *    다시 온 것이고, 후자는 새 키로 온 정상 command 인데 바꿀 것이 없는 것이다.
 *    후자도 성공이므로 snapshot 은 idempotency record 에 저장된다.
 *
 * ## Audit (D-16)
 *
 * 라인마다 남기지 않는다 — 383행이면 383건이 되어 이력이 무의미해진다. 대신
 * **`BomHeader` `UPDATE` 1건**에 `{confirmedLineCount, lineIds}` 요약을 담고,
 * 그 둘은 **실제로 변경된 라인만** 센다. 변경 0건이면 Audit 자체가 없다.
 */

/** D-17 routeScope — 서로 다른 BOM 이 같은 키를 써도 충돌하지 않는다. */
export function bomLineBulkConfirmRouteScope(bomId: string): string {
  return `bom:${bomId}:line:bulk-confirm`;
}

export interface BulkConfirmQtyResult {
  readonly bom: BomDetailView;
  readonly replayed: boolean;
}

/** Audit `afterValue` 요약 (D-16). ⛔ 라인 전문을 담지 않는다. */
export interface BulkConfirmQtyAuditSummary {
  readonly confirmedLineCount: number;
  readonly lineIds: readonly string[];
}

/**
 * idempotency snapshot 파서.
 *
 * 저장된 것은 `BomDetail` 그대로다 — replay 는 **그때 저장된 값**을 돌려주며
 * 현재 DB 를 다시 읽지 않는다(기존 T07-3 선례와 동일).
 */
const bomDetailSnapshotSchema = z.looseObject({
  id: z.uuid(),
  parentSkuId: z.uuid(),
  version: z.string(),
  status: z.string(),
  lineCount: z.number(),
  unconfirmedCount: z.number(),
  lines: z.array(z.unknown()),
});

export function parseBomDetailSnapshot(raw: unknown): BomDetailView {
  const result = bomDetailSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 BomDetailView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as BomDetailView;
}

async function loadBomDetail(tx: TransactionClient, bomId: string): Promise<BomDetailView> {
  const header = await tx.bomHeader.findUnique({
    where: { id: bomId },
    include: BOM_HEADER_VIEW_INCLUDE,
  });
  if (header === null) throw bomNotFound(bomId);

  const lines = await tx.bomLine.findMany({
    where: { bomHeaderId: bomId },
    include: BOM_LINE_VIEW_INCLUDE,
    // `GET /api/boms/{id}` 와 **같은 정렬** — 두 응답이 어긋나지 않는다.
    orderBy: [{ lineNo: 'asc' }, { id: 'asc' }],
  });

  return toBomDetailView(header, lines);
}

async function performBulkConfirm(
  tx: TransactionClient,
  actor: ActorContext,
  bomId: string,
  input: BulkConfirmQtyInput,
  logger: AuditLogger,
): Promise<BomDetailView> {
  // ── 1. header lock → 상태를 lock 뒤에 다시 읽는다 (D-28) ────────
  await lockBomHeaderRow(tx, bomId);

  const header = await tx.bomHeader.findUnique({
    where: { id: bomId },
    select: { id: true, status: true },
  });
  if (header === null) throw bomNotFound(bomId);

  // 소요량 확정은 line 수정이다 — D-6 편집표의 `DRAFT`·`REJECTED` 만 통과한다.
  assertBomEditable(bomId, header.status);

  // ── 2. 대상 라인 적재 — **이 BOM 소속만** (nested ownership) ────
  const targetIds = input.map((item) => item.lineId);
  const rows = await tx.bomLine.findMany({
    where: { bomHeaderId: bomId, id: { in: targetIds } },
    select: { id: true, quantityPer: true, quantityStatus: true },
    // ★ 결정적 순서 — 동시 bulk 끼리 같은 순서로 행을 만져 deadlock 을 줄인다.
    orderBy: { id: 'asc' },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const item of input) {
    // ⛔ 다른 BOM 의 라인을 조용히 건너뛰지 않는다 — 전체 실패다.
    //    존재 여부를 나누어 알려주지 않으므로 resource 노출도 없다.
    if (!byId.has(item.lineId)) throw bomLineNotFound(bomId, item.lineId);
  }

  // ── 3. 전량 검증 (D-10) — 쓰기 전에 모두 본다 ──────────────────
  //
  // 최종 persisted state 기준이다. `quantityStatus` 는 반드시 `CONFIRMED` 가
  // 되므로 `quantityPer` 는 값이 있어야 하고 `> 0` 이어야 한다.
  // `0`·음수는 여기서 **422 `BOM_QTY_INVALID`** 다 (TC-BOM-002).
  for (const item of input) {
    assertQuantityConsistency({ quantityPer: item.quantityPer, quantityStatus: 'CONFIRMED' });
  }

  // ── 4. 실변경 대상만 고른다 (gap closure B4) ───────────────────
  //
  // ★ 수량 비교는 **Decimal 비교**다 — `"2"` 와 `"2.000000"` 은 같은 값이다.
  //   문자열 동등 비교로 하면 DB 가 돌려준 `2.000000` 이 항상 "변경" 으로
  //   보여 없는 write 와 Audit 을 만든다. ⛔ Number() 변환은 쓰지 않는다.
  const changed = input.filter((item) => {
    const row = byId.get(item.lineId);
    if (row === undefined) return false;
    if (row.quantityStatus !== 'CONFIRMED') return true;
    if (row.quantityPer === null) return true;
    return !isEqual(row.quantityPer, item.quantityPer);
  });

  // ── 5. write — 바뀌는 라인만, id 오름차순으로 ──────────────────
  const ordered = [...changed].sort((a, b) => (a.lineId < b.lineId ? -1 : 1));
  for (const item of ordered) {
    await tx.bomLine.update({
      where: { id: item.lineId },
      // ⛔ 두 컬럼만 — 나머지는 요청 계약에 없으므로 건드리지 않는다.
      data: { quantityPer: item.quantityPer, quantityStatus: 'CONFIRMED' },
    });
  }

  // ── 6. Audit — 실변경이 있을 때만 1건 (D-16) ───────────────────
  if (ordered.length > 0) {
    const summary: BulkConfirmQtyAuditSummary = {
      confirmedLineCount: ordered.length,
      // ★ 실제로 바뀐 라인만. unchanged 는 포함하지 않는다. 순서는 id ASC 로
      //   결정적이다 — 같은 요청이 매번 같은 요약을 남긴다.
      lineIds: ordered.map((item) => item.lineId),
    };
    await logger.write(tx, {
      actor,
      entityType: BOM_HEADER_ENTITY_TYPE,
      entityId: bomId,
      action: 'UPDATE',
      beforeValue: null,
      afterValue: summary,
    });
  }

  return loadBomDetail(tx, bomId);
}

export async function bulkConfirmBomLineQuantities(
  actor: ActorContext,
  rawBomId: string,
  input: BulkConfirmQtyInput,
  dependencies: BomMutateDependencies = {},
  idempotencyKey?: string,
): Promise<BulkConfirmQtyResult> {
  // ★ 2차 권한 가드 — proxy 1차 가드(`contains:'/lines'` + POST → `bom.update`)와
  //   같은 permission 이다. ⛔ ADMIN bypass 없음 · role 이름 비교 없음.
  assertPermission(actor, BOM_UPDATE_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  // ⛔ `withBomCycleGraphLock` 을 감싸지 않는다 — D-28 표가 이 endpoint 를
  //    graph lock 대상에서 제외했다. edge 를 바꾸지 않기 때문이다.
  return run(async (tx) => {
    if (idempotencyKey === undefined) {
      return { bom: await performBulkConfirm(tx, actor, bomId, input, logger), replayed: false };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        routeScope: bomLineBulkConfirmRouteScope(bomId),
        idempotencyKey,
      },
      requestHashOf(input),
      async () => ({
        // ★ 생성이 아니므로 **200** 이다 — 201 을 쓰지 않는다.
        responseStatus: 200,
        responseBody: await performBulkConfirm(tx, actor, bomId, input, logger),
      }),
      parseBomDetailSnapshot,
    );
    return { bom: outcome.responseBody, replayed: outcome.replayed };
  });
}
