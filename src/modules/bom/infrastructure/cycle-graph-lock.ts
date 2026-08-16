import type { TransactionClient } from '@/shared/db';

/**
 * BOM 순환 그래프 mutation 직렬화 lock (T07-2).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-28.
 *
 * ## 왜 행 잠금으로는 안 되는가
 *
 * "이번 write 가 건드리는 두 끝점(parent·component) SKU 행만 잠그면 순환을
 * 공동으로 만드는 두 트랜잭션은 반드시 공통 SKU 를 공유한다" 는 **거짓이다.**
 *
 * ```
 *   기존:  A → B          C → D
 *   TX1:   B → C 추가     locks {B, C}
 *   TX2:   D → A 추가     locks {D, A}
 * ```
 *
 * 두 lock set 이 **완전히 disjoint** 라 서로 대기하지 않고, 각자 상대의 미커밋
 * edge 를 못 본 채 통과한다. 둘 다 커밋되면 `A → B → C → D → A` 가 된다.
 * 순환 판정은 **그래프 전역 속성**이라 국소 잠금으로 직렬화되지 않는다.
 *
 * ## `SERIALIZABLE` 을 쓰지 않는 이유 — "막지 못해서"가 아니다
 *
 * PostgreSQL 의 `SERIALIZABLE` 은 SSI(Serializable Snapshot Isolation)를 쓰며
 * **write skew 를 포함한 serialization anomaly 를 감지할 수 있다.** 위 disjoint
 * 사례에서도 serialization failure 가 발생할 수 있다. 즉 "SSI 로는 못 막는다"는
 * 서술은 정확하지 않으며, 그것이 advisory lock 을 택한 근거도 아니다.
 *
 * 채택하지 않은 실제 이유는 **도입 비용**이다:
 *   - 직렬화 실패(`40001`) 가 발생할 수 있어 **application 전역 재시도 계약**을
 *     따로 설계·검증해야 한다.
 *   - 현재 `withTransaction` 은 `ReadCommitted` 를 기본으로 쓴다. cycle 정합성
 *     하나 때문에 transaction isolation 을 전역으로 바꾸면 무관한 경로까지
 *     재시도 semantics 를 갖게 된다.
 *   - BOM 편집은 **저빈도 경로**다(실측 헤더 80 / 라인 383).
 *
 * → 그래서 격리수준·재시도 계약을 확장하는 대신, **이 경로에 한정된 명시적이고
 *   결정적인** transaction advisory lock 을 쓴다. 두 방식 모두 정합성을 얻을 수
 *   있고, 현재 architecture 에서는 후자가 더 단순하다.
 *
 * ## 확정 계약
 *
 * > 순환 그래프에 영향을 줄 수 있는 **모든 mutation** 은, cycle graph 를 **읽기
 * > 전에** 하나의 공통 transaction-scoped advisory lock 을 획득한다.
 *
 * BOM 편집은 재고 Posting 같은 초고빈도 경로가 아니다(실측 헤더 80 / 라인 383,
 * 소요량 확정도 사람이 하는 작업). correctness 를 국소 잠금으로 얻을 수 없으므로
 * 이 정도 전역 직렬화는 합리적인 교환이다.
 */

/**
 * ★ BOM 순환 그래프 전역 lock key. **고정값 하나**다.
 *
 * SKU·BOM 별로 쪼개면 위 disjoint 반례가 그대로 남으므로 **절대 분할하지 않는다.**
 *
 * 값 선정 근거:
 *   - 이 저장소에서 advisory lock 을 쓰는 **첫 사례**다(도입 시점 사용처 0건).
 *   - PostgreSQL `pg_advisory_xact_lock(bigint)` 는 signed 64-bit 를 받는다.
 *     읽을 때 출처가 드러나도록 `T07`(BOM Task) + `18`(docs/18) 을 담은
 *     고정 상수를 쓴다.
 *   - ⛔ 런타임 해시로 계산하지 않는다 — 배포마다 값이 달라지면 직렬화가 깨진다.
 *
 * 새 advisory lock 을 추가할 때는 **이 파일을 먼저 보고** 값이 겹치지 않게 한다.
 */
export const BOM_CYCLE_GRAPH_LOCK_KEY = 70_218_001n;

/**
 * transaction-scoped advisory lock 을 획득한다.
 *
 * - **`pg_advisory_xact_lock`** 이다. ⛔ `pg_advisory_lock`(session lock) 금지 —
 *   세션이 풀에 반납돼도 잠금이 남아 누수된다.
 * - 트랜잭션 종료(commit/rollback) 시 **자동 해제**된다. 명시적 unlock 이 없다.
 * - 이미 다른 트랜잭션이 잡고 있으면 **대기**한다(try 형태가 아니다). 대기 없이
 *   실패시키면 정상 요청이 산발적으로 거부된다.
 *
 * ⚠️ 반드시 **cycle graph 를 읽기 전에** 호출한다. graph 를 먼저 읽고 나중에
 *    잠그면 race 가 그대로 남는다 (§D-28 lock acquisition order).
 * ⛔ 실패를 catch 해서 무시하지 않는다.
 */
export async function acquireBomCycleGraphLock(tx: TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOM_CYCLE_GRAPH_LOCK_KEY})`;
}

/**
 * lock 을 먼저 잡고 작업을 수행한다.
 *
 * 호출부가 순서를 틀릴 여지를 없애기 위한 얇은 wrapper 다. 반환값은 그대로 전달한다.
 *
 * ```ts
 * await withTransaction(async (tx) => {
 *   return withBomCycleGraphLock(tx, async () => {
 *     // (필요하면) row lock → mutation → graph read → cycle 검사
 *   });
 * });
 * ```
 */
export async function withBomCycleGraphLock<T>(
  tx: TransactionClient,
  work: () => Promise<T>,
): Promise<T> {
  await acquireBomCycleGraphLock(tx);
  return work();
}
