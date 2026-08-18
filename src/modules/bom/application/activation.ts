import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { businessDateOf } from '@/shared/business-date';
import { withTransaction } from '@/shared/db';
import { ValidationError } from '@/shared/errors';

import { withBomCycleGraphLock } from '../infrastructure/cycle-graph-lock';

import { assertNoBomCycleForCandidate } from './cycle-graph';

import { translateBomHeaderWriteError } from './constraint-errors';
import { type BomMutateDependencies } from './create-bom';
import { parseBomId, parseDateOnly, toDateOnlyString } from './dto';
import { lockSkuRows } from './locks';
import { BOM_APPROVE_PERMISSION } from './policy';
import { shouldPerformBomTransition } from './transitions';
import {
  lockAndLoadHeader,
  loadBomDetailInTransaction,
  writeWorkflowAudit,
  type BomWorkflowResult,
} from './workflow';
import type { ActivateBomInput, DeactivateBomInput } from './workflow-dto';

/**
 * BOM 활성화 · 사용종료 (T07-5) — **temporal chain 을 다루는 두 endpoint**.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-7(chain 알고리즘 · edge case) ·
 *    §D-8(approve 와의 분리) · §D-13(activate 는 최종 `T` 로 재검사) ·
 *    §D-28(lock) · §D-29 + `★ T07-5 workflow gap closure` W-2 · W-3
 *    (+ D-7 의 `★ effectiveFrom 불변의 범위` clarification).
 *
 * ## `ACTIVE` 는 "오늘 유효" 가 아니다 (D-7)
 *
 * `ACTIVE` 는 **이 버전의 적용기간이 발효 승인되었다** 는 뜻이다. 어느 시점에
 * 실제로 유효한지는 `[effectiveFrom, effectiveTo)` 와 asOf 가 정한다. 그래서
 * 새 버전을 activate 해도 predecessor 의 **`status` 를 바꾸지 않고**
 * `effectiveTo` 만 닫는다. `INACTIVE` 는 **명시적 `deactivate` 전용**이다.
 */

/** `Date`(UTC 자정) 비교용 — `@db.Date` 는 UTC 자정으로 저장된다. */
function sameDate(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

// ═══════════════════════════════════════════════════════════════
// activate — APPROVED → ACTIVE
// ═══════════════════════════════════════════════════════════════

/**
 * `POST /api/boms/{id}/activate` — 활성화. `bom.approve`.
 *
 * ## D-7 chain 알고리즘 (원문 그대로)
 *
 * ```
 * T := body.effectiveFrom ?? target.effectiveFrom
 * 1. 부모 SKU 행을 FOR UPDATE 로 잠근다
 * 2. target.status 가 APPROVED 가 아니면 422
 * 3. target.effectiveFrom := T
 * 4. 같은 parentSkuId 의 status='ACTIVE' 행만 후보로:
 *      predecessor := effectiveFrom < T 중 effectiveFrom 최대
 *      successor   := effectiveFrom > T 중 effectiveFrom 최소
 * 5. predecessor 가 있고 (effectiveTo IS NULL OR effectiveTo > T) 이면
 *      predecessor.effectiveTo := T           -- status 는 그대로 ACTIVE
 * 6. target.effectiveTo := successor?.effectiveFrom ?? null
 * 7. target.status := ACTIVE, target.activatedAt := now()
 * 8. EXCLUDE 가 최종 backstop 이다 (23P01 → 409)
 * ```
 *
 * ## `effectiveFrom` 불변의 **범위** (W-2 · R1)
 *
 * | 행 | `effectiveFrom` | `effectiveTo` | `status` |
 * |---|---|---|---|
 * | **candidate** | **`T`** (override 있으면 갱신) | `successor?.effectiveFrom ?? null` | `ACTIVE` |
 * | **predecessor** | ⛔ **변경 없음** | 필요 시 `T` | ⛔ **`ACTIVE` 유지** |
 * | **successor** | ⛔ 변경 없음 | ⛔ 변경 없음 | ⛔ 변경 없음 |
 *
 * ## cycle 재검사 — **최종 `T` 기준** (D-13)
 *
 * approve 시점 통과를 재사용하지 **않는다.** 다른 SKU 의 effective BOM 이
 * `T` 에 따라 달라지므로 activate 직전에 다시 본다. `evaluationDate = T` 를
 * caller 가 넘기며, validator 안에서 header 값을 다시 읽어 덮어쓰지 않는다.
 *
 * ⚠️ `evaluationDate = T`(graph 를 어느 날짜로 평가하는가)와
 *    `candidate.effectiveFrom := T`(무엇을 저장하는가)는 **다른 개념**이며
 *    둘 다 수행한다.
 *
 * ## lock 순서 (D-28)
 *
 * advisory lock(`BOM_CYCLE_GRAPH`) → 부모 SKU `FOR UPDATE` → chain read →
 * DFS → write → audit. 두 lock 은 목적이 달라 서로를 대체하지 않는다 —
 * 전자는 graph 안전성, 후자는 같은 parent 의 chain 직렬화다.
 *
 * ⛔ 자가승인 검사 없음 (D-8) — `bom.approve` permission 만으로 판정한다.
 */
export async function activateBom(
  actor: ActorContext,
  rawBomId: string,
  input: ActivateBomInput,
  dependencies: BomMutateDependencies = {},
): Promise<BomWorkflowResult> {
  assertPermission(actor, BOM_APPROVE_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  // ★ advisory lock 이 **항상 가장 먼저**다 (D-28). row lock 을 먼저 잡으면
  //   advisory-first 인 line CRUD 와 순서가 엇갈려 deadlock 이 난다.
  return run(async (tx) =>
    withBomCycleGraphLock(tx, async () => {
      const header = await lockAndLoadHeader(tx, bomId);
      if (!shouldPerformBomTransition(bomId, 'activate', header.status)) {
        // 이미 ACTIVE — activatedAt 을 다시 쓰지 않고 predecessor 도 재마감하지 않는다.
        return { bom: await loadBomDetailInTransaction(tx, bomId) };
      }

      // ★ T := body.effectiveFrom ?? target.effectiveFrom (D-7.1)
      const activationDate =
        input.effectiveFrom === undefined
          ? header.effectiveFrom
          : parseDateOnly(input.effectiveFrom);

      // ── 1단계: 부모 SKU row lock — 같은 parent 의 chain mutation 직렬화
      //    (D-7 요구 5 · D-28). advisory lock 은 이미 위에서 잡았다.
      await lockSkuRows(tx, [header.parentSkuId]);

      // ── cycle 재검사 — evaluationDate 는 **최종 T** 다 (D-13).
      //    ⛔ approve 시점 통과를 재사용하지 않는다.
      await assertNoBomCycleForCandidate(tx, {
        candidate: {
          parentSkuId: header.parentSkuId,
          componentSkuIds: (
            await tx.bomLine.findMany({
              where: { bomHeaderId: bomId },
              select: { componentSkuId: true },
              orderBy: [{ lineNo: 'asc' }],
            })
          ).map((line) => line.componentSkuId),
          bomHeaderId: bomId,
        },
        evaluationDate: activationDate,
      });

      // ── 4단계: 같은 parent 의 **ACTIVE 행만** 후보. candidate 자신은 APPROVED
      //    이므로 애초에 들어오지 않지만, 방어적으로 제외한다.
      const activeSiblings = await tx.bomHeader.findMany({
        where: { parentSkuId: header.parentSkuId, status: 'ACTIVE', id: { not: bomId } },
        select: { id: true, effectiveFrom: true, effectiveTo: true },
        orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
      });

      const predecessor = activeSiblings
        .filter((row) => row.effectiveFrom.getTime() < activationDate.getTime())
        .at(-1);
      const successor = activeSiblings.find(
        (row) => row.effectiveFrom.getTime() > activationDate.getTime(),
      );

      // ── 5단계: predecessor 마감. ⛔ status 는 그대로 ACTIVE 다.
      let predecessorClosed = false;
      if (
        predecessor !== undefined &&
        (predecessor.effectiveTo === null ||
          predecessor.effectiveTo.getTime() > activationDate.getTime())
      ) {
        try {
          await tx.bomHeader.update({
            where: { id: predecessor.id },
            // ⛔ effectiveFrom·status 를 건드리지 않는다 (W-2 표).
            data: { effectiveTo: activationDate },
          });
        } catch (error) {
          translateBomHeaderWriteError(error, '(predecessor)');
        }
        predecessorClosed = true;
      }

      // ── 3·6·7단계: candidate 확정.
      try {
        await tx.bomHeader.update({
          where: { id: bomId },
          data: {
            // ★ override 가 있으면 갱신, 없으면 같은 값이라 실질 무변경이다.
            effectiveFrom: activationDate,
            effectiveTo: successor?.effectiveFrom ?? null,
            status: 'ACTIVE',
            activatedAt: new Date(),
          },
        });
      } catch (error) {
        // EXCLUDE(23P01) → 409 BOM_PERIOD_OVERLAP · CHECK(23514) → 500 (D-29).
        translateBomHeaderWriteError(error, '(activate)');
      }

      // ── 8단계: audit. candidate ACTIVATE 1건 + (실변경 시) predecessor UPDATE 1건.
      await writeWorkflowAudit(
        tx,
        logger,
        actor,
        bomId,
        'ACTIVATE',
        { status: header.status, effectiveFrom: toDateOnlyString(header.effectiveFrom) },
        {
          status: 'ACTIVE',
          effectiveFrom: toDateOnlyString(activationDate),
          effectiveTo: successor === undefined ? null : toDateOnlyString(successor.effectiveFrom),
        },
      );

      if (predecessorClosed && predecessor !== undefined) {
        // ⛔ 실변경이 없으면 가짜 UPDATE audit 을 만들지 않는다 (위 조건).
        await writeWorkflowAudit(
          tx,
          logger,
          actor,
          predecessor.id,
          'UPDATE',
          {
            effectiveTo:
              predecessor.effectiveTo === null ? null : toDateOnlyString(predecessor.effectiveTo),
          },
          { effectiveTo: toDateOnlyString(activationDate), status: 'ACTIVE' },
        );
      }

      return { bom: await loadBomDetailInTransaction(tx, bomId) };
    }),
  );
}

// ═══════════════════════════════════════════════════════════════
// deactivate — ACTIVE → INACTIVE
// ═══════════════════════════════════════════════════════════════

/**
 * `requestedEffectiveTo` 기간 규칙 (W-3) — **예외 없는 네 조건**.
 *
 * ```
 * effectiveFrom < requestedEffectiveTo
 * AND requestedEffectiveTo <= businessDateOf(now)
 * AND (currentEffectiveTo == null OR requestedEffectiveTo <= currentEffectiveTo)
 * AND (successor == null OR requestedEffectiveTo <= successor.effectiveFrom)
 * ```
 *
 * ★ 현재 `effectiveTo` 와 값이 같다는 이유만으로 상한을 우회하지 않는다
 *   (CASE C). equality 는 허용하되 **그 값도 오늘 이하**여야 한다.
 *
 * ⛔ 새 BOM 오류코드를 만들지 않는다 — T07-3 `assertPeriodOrder` 선례대로
 *    공통 **`VALIDATION_ERROR` / 400** 이다 (D-29 15종 유지).
 */
function assertDeactivatePeriod(input: {
  readonly requested: string;
  readonly effectiveFrom: Date;
  readonly currentEffectiveTo: Date | null;
  readonly successorEffectiveFrom: Date | null;
  readonly businessDate: string;
}): void {
  const fail = (message: string): never => {
    throw new ValidationError([{ path: 'effectiveTo', message }]);
  };

  const from = toDateOnlyString(input.effectiveFrom);
  // ★ 전부 `YYYY-MM-DD` 문자열 비교다 — 사전순이 곧 날짜순이라 Date 재구성이
  //   필요 없고 timezone 변환으로 하루가 밀 일도 없다.
  if (input.requested <= from) {
    fail('사용종료일은 적용 시작일보다 뒤여야 합니다.');
  }
  if (input.requested > input.businessDate) {
    // 미래 예약 종료가 아니다 — 즉시·소급 withdrawal 이다 (W-3).
    fail('사용종료일은 오늘 이후일 수 없습니다. 미래 예약 종료는 지원하지 않습니다.');
  }
  if (input.currentEffectiveTo !== null) {
    const current = toDateOnlyString(input.currentEffectiveTo);
    if (input.requested > current) {
      fail('기존 사용종료일보다 뒤로 늘릴 수 없습니다.');
    }
  }
  if (input.successorEffectiveFrom !== null) {
    const successorFrom = toDateOnlyString(input.successorEffectiveFrom);
    if (input.requested > successorFrom) {
      fail('사용종료일이 다음 버전의 시작일을 넘을 수 없습니다.');
    }
  }
}

/**
 * `POST /api/boms/{id}/deactivate` — 사용종료. `bom.approve`.
 *
 * body `{effectiveTo, reason}` 둘 다 필수 (D-6).
 *
 * ## ★ 미래 예약 종료가 아니다 (W-3)
 *
 * `resolveEffectiveBom` 은 `status = 'ACTIVE'` 인 행만 후보로 고르는데
 * deactivate 는 **즉시** `INACTIVE` 로 만든다. 따라서 `effectiveTo` 를 미래로
 * 남기면 "status 는 지금 `INACTIVE` 인데 기간은 미래까지 열림" 이라는 이중
 * 의미가 생긴다. 그래서 **즉시·소급 operational withdrawal** 로 정의한다.
 *
 * ⚠️ 결과적으로 `INACTIVE` 행은 `ACTIVE`-only resolver 의 후보가 아니므로
 *    **`effectiveTo` 이전의 과거 asOf 에서도 선택되지 않는다.** 이는 현재
 *    승인된 status/resolver 계약의 귀결이며 T07-5 는 resolver 를 바꾸지 않는다.
 *
 * ⛔ `INACTIVE → ACTIVE` 재활성화 endpoint 는 없다 — clone 으로 새 버전을 만든다.
 * ⛔ cycle advisory lock·DFS 없음 (D-28 표) — edge 를 제거할 뿐이다.
 */
export async function deactivateBom(
  actor: ActorContext,
  rawBomId: string,
  input: DeactivateBomInput,
  dependencies: BomMutateDependencies = {},
): Promise<BomWorkflowResult> {
  assertPermission(actor, BOM_APPROVE_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const header = await lockAndLoadHeader(tx, bomId);
    if (!shouldPerformBomTransition(bomId, 'deactivate', header.status)) {
      // 이미 INACTIVE — 기간을 다시 쓰지 않는다.
      return { bom: await loadBomDetailInTransaction(tx, bomId) };
    }

    // 같은 parent 의 다음 ACTIVE 버전 — 경계를 넘지 않는지 본다.
    const successor = await tx.bomHeader.findFirst({
      where: {
        parentSkuId: header.parentSkuId,
        status: 'ACTIVE',
        id: { not: bomId },
        effectiveFrom: { gt: header.effectiveFrom },
      },
      select: { effectiveFrom: true },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
    });

    assertDeactivatePeriod({
      requested: input.effectiveTo,
      effectiveFrom: header.effectiveFrom,
      currentEffectiveTo: header.effectiveTo,
      successorEffectiveFrom: successor?.effectiveFrom ?? null,
      // ★ Asia/Seoul 기준 오늘 — ⛔ UTC·서버 local timezone 을 쓰지 않는다 (R3).
      businessDate: businessDateOf(new Date()),
    });

    const requestedTo = parseDateOnly(input.effectiveTo);
    // 기간이 같아도 **status 전이는 반드시 수행**한다 (W-3 CASE D·E).
    const periodChanged = header.effectiveTo === null || !sameDate(header.effectiveTo, requestedTo);

    try {
      await tx.bomHeader.update({
        where: { id: bomId },
        // ⛔ activatedAt·approvedAt/By 는 그대로 둔다.
        data: { status: 'INACTIVE', effectiveTo: requestedTo },
      });
    } catch (error) {
      translateBomHeaderWriteError(error, '(deactivate)');
    }

    await writeWorkflowAudit(
      tx,
      logger,
      actor,
      bomId,
      'DEACTIVATE',
      {
        status: header.status,
        effectiveTo: header.effectiveTo === null ? null : toDateOnlyString(header.effectiveTo),
      },
      { status: 'INACTIVE', effectiveTo: input.effectiveTo, periodChanged },
      input.reason,
    );

    return { bom: await loadBomDetailInTransaction(tx, bomId) };
  });
}
