import type { TransactionClient } from '@/shared/db';

import { withBomCycleGraphLock } from '../infrastructure/cycle-graph-lock';

import {
  assertNoBomCycleForCandidate,
  type AssertNoBomCycleForCandidateInput,
  type BomCycleGraphSnapshot,
} from './cycle-graph';

/**
 * cycle-affecting mutation 이 재사용하는 검증 진입점 (T07-2).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-13(검사 시점 7종) · §D-28(lock 순서).
 *
 * ## 이 함수가 존재하는 이유
 *
 * D-13 은 **7개 시점**에서 같은 검사를 요구한다 — line POST · line PATCH ·
 * header PATCH(`effectiveFrom` 변경) · submit · activate · clone · import.
 * 각 endpoint 가 lock 획득과 graph 검사를 따로 구현하면 순서를 틀리는 곳이
 * 반드시 생긴다. 그래서 **한 함수**로 묶는다.
 *
 * ⚠️ T07-2 에는 아직 그 endpoint 들이 없다. T07-3/T07-5 가 이 함수를 호출한다 —
 *    ⛔ 검증을 위해 production API placeholder 를 만들지 않는다.
 *
 * ## lock acquisition order (§D-28)
 *
 * ```
 * 1. transaction 시작                         ← 호출부(withTransaction)
 * 2. pg_advisory_xact_lock(BOM_CYCLE_GRAPH)   ← ★ 이 함수가 가장 먼저
 * 3. 필요한 row lock                          ← 호출부가 beforeGraphRead 로 주입
 * 4. evaluation date 확정                     ← 호출부가 input 으로 확정
 * 5. graph read / build                       ← 이 함수
 * 6. DFS validation                           ← 이 함수
 * 7. business write · 8. audit · 9. commit    ← 호출부
 * ```
 *
 * ★ **advisory lock 을 항상 가장 먼저** 잡으므로 row lock 과의 사이에 deadlock 이
 *   생기지 않는다(모든 cycle-affecting 트랜잭션이 같은 첫 자원을 기다린다).
 *
 * ## candidate mutation 전략 (§D-44)
 *
 * docs/18 은 "이번 mutation 이 반영된 이후 상태"를 검사 대상으로 정했다.
 * 이 함수는 **A안 — same transaction write → validate → rollback** 을 전제한다:
 * 호출부가 `beforeGraphRead` 안에서 tentative mutation 을 수행하고, 검사가 실패해
 * 예외가 나면 트랜잭션 전체가 롤백된다. `candidate.componentSkuIds` 를 직접
 * 넘기는 **B안(pending edge override)** 도 같은 타입으로 표현되므로, 저장 전
 * candidate(clone·import 준비 단계)도 그대로 검사할 수 있다.
 */

export interface ValidateBomCandidateInput extends AssertNoBomCycleForCandidateInput {
  /**
   * advisory lock 획득 **직후**, graph read **직전**에 실행할 작업.
   *
   * row lock(`sku.id` ASC → `bom_header.id` ASC) 과 tentative mutation 을 여기서
   * 수행한다. ⛔ 여기서 graph 를 미리 읽어 캐싱하지 않는다.
   */
  readonly beforeGraphRead?: (tx: TransactionClient) => Promise<void>;
}

/**
 * advisory lock → (선택) row lock·tentative mutation → graph read → DFS.
 *
 * @throws 422 `BOM_CYCLE_DETECTED` · 422 `BOM_MAX_LEVEL_EXCEEDED`
 *         · 409 `BOM_EFFECTIVE_CONFLICT`
 */
export async function validateBomCandidateInTransaction(
  tx: TransactionClient,
  input: ValidateBomCandidateInput,
): Promise<BomCycleGraphSnapshot> {
  return withBomCycleGraphLock(tx, async () => {
    if (input.beforeGraphRead !== undefined) await input.beforeGraphRead(tx);
    return assertNoBomCycleForCandidate(tx, input);
  });
}
