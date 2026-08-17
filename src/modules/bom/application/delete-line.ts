import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';

import { withBomCycleGraphLock } from '../infrastructure/cycle-graph-lock';

import { type BomMutateDependencies } from './create-bom';
import { BOM_LINE_ENTITY_TYPE } from './create-line';
import { parseBomId, parseBomLineId } from './dto';
import { assertBomEditable } from './editability';
import { lockBomHeaderRow } from './locks';
import { BOM_UPDATE_PERMISSION } from './policy';
import { bomLineNotFound, bomNotFound } from './refs';
import { BOM_LINE_VIEW_INCLUDE, toBomLineView } from './views';

/**
 * `DELETE /api/boms/{id}/lines/{lineId}` — BOM 라인 삭제 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-6(편집 가능 상태 · `05:123` "line DELETE
 *    는 DRAFT/REJECTED 만") · §D-28(lock) · §D-16(audit).
 *
 * ⚠️ **2차 권한 가드** `bom.update`. ⛔ ADMIN bypass 없음.
 *
 * ## 물리삭제가 허용되는 **유일한** BOM business row 다
 *
 * 프로젝트 공통 규약은 물리삭제 금지지만, `05:123` 이 라인 DELETE 를 명시했고
 * D-6 이 `DRAFT`·`REJECTED` 로 범위를 좁혔다. 한 번이라도 승인/발효된 BOM 의
 * 라인은 이력이므로 삭제할 수 없다. ⛔ 헤더 DELETE 는 만들지 않는다 —
 * `DRAFT`·`REJECTED` 헤더는 T07-5 의 `archive` 로 감춘다.
 *
 * ## 왜 삭제에도 graph advisory lock 을 잡는가 (D-28)
 *
 * edge 제거는 **새 순환을 만들 수 없다.** 그럼에도 lock 을 잡는 이유는
 * §D-28 의 계약이 "cycle graph 에 영향을 줄 수 있는 **모든 mutation**" 을
 * 대상으로 하기 때문이다 — 동시에 진행 중인 다른 트랜잭션의 graph read 가
 * 삭제 중간 상태를 보지 않아야 snapshot 이 일관된다.
 *
 * ⛔ DFS 재실행은 하지 않는다. 삭제로 순환이 생길 수 없고, docs/18 에
 *    삭제 후 재검사를 요구하는 조항이 없다 — 없는 검사를 발명하지 않는다.
 *
 * ## 응답
 *
 * **204 No Content** (기존 API 규약). ⛔ `Idempotency-Key` framework 를 붙이지
 * 않는다 (D-17: PATCH·DELETE·GET 은 멱등 키를 받지 않으며 있으면 400).
 * 이미 없는 라인의 재삭제는 **404** 다 — DELETE 를 200/204 로 흡수하면
 * "내가 지웠다"와 "원래 없었다"를 구분할 수 없고, nested ownership 404 계약과도
 * 어긋난다.
 */
async function performDeleteLine(
  tx: TransactionClient,
  actor: ActorContext,
  bomId: string,
  lineId: string,
  logger: AuditLogger,
): Promise<void> {
  await lockBomHeaderRow(tx, bomId);

  const header = await tx.bomHeader.findUnique({
    where: { id: bomId },
    select: { id: true, status: true },
  });
  if (header === null) throw bomNotFound(bomId);
  assertBomEditable(bomId, header.status);

  // ★ 소속 확인 — 다른 BOM 의 라인이면 404.
  const current = await tx.bomLine.findFirst({
    where: { id: lineId, bomHeaderId: bomId },
    include: BOM_LINE_VIEW_INCLUDE,
  });
  if (current === null) throw bomLineNotFound(bomId, lineId);

  const before = toBomLineView(current);

  await tx.bomLine.delete({ where: { id: lineId } });

  await logger.write(tx, {
    actor,
    entityType: BOM_LINE_ENTITY_TYPE,
    entityId: lineId,
    action: 'DELETE',
    beforeValue: before,
    afterValue: null,
  });
}

export async function deleteBomLine(
  actor: ActorContext,
  rawBomId: string,
  rawLineId: string,
  dependencies: BomMutateDependencies = {},
): Promise<void> {
  assertPermission(actor, BOM_UPDATE_PERMISSION);
  const bomId = parseBomId(rawBomId);
  const lineId = parseBomLineId(rawLineId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  await run(async (tx) =>
    withBomCycleGraphLock(tx, () => performDeleteLine(tx, actor, bomId, lineId, logger)),
  );
}
