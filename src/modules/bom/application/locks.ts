import type { TransactionClient } from '@/shared/db';

/**
 * BOM mutation 의 **secondary row lock** (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-28.
 *
 * ## row lock 은 2차 방어선이다 — 순환은 이것으로 막지 못한다
 *
 * `A→B`, `C→D` 에 동시에 `B→C`, `D→A` 를 추가하면 두 lock set 이 disjoint 라
 * 서로 대기하지 않는다. 순환 판정은 그래프 전역 속성이므로 **primary 는 언제나
 * `BOM_CYCLE_GRAPH` transaction advisory lock**(T07-2 `cycle-graph-lock.ts`)이다.
 *
 * row lock 이 여전히 필요한 이유는 다르다:
 *   - 같은 BOM 에 대한 동시 편집이 lost update 를 만들지 않게 한다
 *   - **status 를 lock 뒤에 다시 읽어** editable 판정을 확정한다
 *     (동시 activate 와의 경합에서 "읽을 때 DRAFT, 쓸 때 ACTIVE" 를 막는다)
 *
 * ## 순서 (§D-28 lock acquisition order)
 *
 * ```
 * 1. transaction begin
 * 2. pg_advisory_xact_lock(BOM_CYCLE_GRAPH_LOCK_KEY)   ← 항상 가장 먼저
 * 3. row lock ─ 여기                                     ← 결정적 순서로
 * 4. evaluation date 확정
 * 5. graph read → 6. DFS → 7. write → 8. audit → 9. commit
 * ```
 *
 * ⛔ advisory lock 보다 먼저 row lock 을 잡지 않는다 — 모든 cycle-affecting
 *    트랜잭션이 **같은 첫 자원**을 기다려야 deadlock 이 생기지 않는다.
 * ⛔ id 를 정렬 없이 잠그지 않는다 — 여러 행을 잠글 때는 항상 오름차순이다.
 */

/** `bom_header` 한 행을 잠근다. 존재하지 않으면 잠글 것이 없다(0행). */
export async function lockBomHeaderRow(tx: TransactionClient, bomId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM bom_header WHERE id = ${bomId}::uuid FOR UPDATE`;
}

/**
 * 참조 SKU 행들을 **id 오름차순**으로 잠근다.
 *
 * line mutation 은 parent·component(변경 시 old/new 둘 다)를 건드리므로 여러
 * 행을 잠근다. 정렬하지 않으면 두 트랜잭션이 서로 다른 순서로 잡아 deadlock 이
 * 난다. 빈 배열이면 아무것도 하지 않는다.
 */
export async function lockSkuRows(tx: TransactionClient, skuIds: readonly string[]): Promise<void> {
  const ordered = [...new Set(skuIds)].sort();
  if (ordered.length === 0) return;
  await tx.$queryRaw`SELECT id FROM sku WHERE id = ANY(${ordered}::uuid[]) ORDER BY id FOR UPDATE`;
}
