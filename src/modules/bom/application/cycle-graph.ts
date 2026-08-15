import { assertNoBomCycle } from '../domain/cycle';

import type { BomDbClient } from './refs';
import { resolveEffectiveBoms } from './resolve-effective-bom';

/**
 * evaluation-date 기반 BOM 순환 검사 (T07-2).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-13(graph 구성·DFS·검사 시점) · §D-22 · §D-28.
 *
 * ## 대전제 — "BOM row 의 집합"이 아니라 "한 시점의 graph"
 *
 * 그래프는 **하나의 evaluation date `D` 에서 parent SKU 마다 정확히 하나의
 * 버전**으로 구성한다. 여러 버전의 edge 를 union 하면 **어느 시점에도 동시에
 * 존재하지 않는 조합**으로 가짜 순환이 만들어진다.
 *
 * ```
 *   A v1 ACTIVE [2020-01-01, 2027-01-01) → B     ← 2027-01-01 에 마감됨
 *   A v2 ACTIVE [2027-01-01, ∞)          → D     ← B 를 갖지 않는다
 *   C    ACTIVE                          → A
 * ```
 *
 * candidate `B`(effectiveFrom 2027-06-01, 구성품 `C`) 를 union 으로 보면
 * `B→C→A→B` 로 **오판**하지만, `D = 2027-06-01` 에서 `A` 는 `v2` 뿐이라
 * `B→C→A→D` 로 정상이다.
 *
 * ## 두 가지 선택 규칙
 *
 *   ① candidate 의 parent → **candidate 자신을 강제 선택**
 *      (`resolveEffectiveBom` 을 쓰지 않는다. DRAFT 여도 검사 대상이므로 반드시
 *       그래프에 들어간다 — 그래야 "입력 시점에 막는다"가 성립한다.)
 *   ② 그 밖의 parent → `resolveEffectiveBom(skuId, D)` 로 **ACTIVE 0/1건만**
 *      (다른 SKU 의 DRAFT·PENDING_APPROVAL·APPROVED·historical/future ACTIVE 는
 *       들어가지 않는다. 아직 발효되지 않은 남의 초안이 내 BOM 을 막을 이유가 없다.)
 *
 * ## 동시성
 *
 * ⚠️ 이 모듈은 lock 을 잡지 않는다. 호출부가 **`withBomCycleGraphLock` 을 먼저
 *    잡은 트랜잭션 안에서** 호출해야 한다 (§D-28). graph 를 먼저 읽고 나중에
 *    잠그면 disjoint edge write skew 가 그대로 남는다.
 */

/** graph 에 강제 투입되는 검사 대상. DB 에 이미 저장돼 있든 아니든 상관없다. */
export interface BomCycleCandidate {
  readonly parentSkuId: string;
  /**
   * **이번 mutation 이 반영된 이후**의 구성품 SKU 목록 (§D-13 규칙 5).
   *
   * ⛔ 저장 전 상태를 넘기지 않는다. line POST/PATCH·clone·import 는 같은
   *    트랜잭션에서 write 한 뒤 그 결과를 읽어 넘기거나, pending edge 를 직접
   *    구성해 넘긴다(§D-44 — 두 방식 모두 이 타입으로 표현된다).
   */
  readonly componentSkuIds: readonly string[];
  /** 진단용. 저장 전 candidate 는 없을 수 있다. */
  readonly bomHeaderId?: string;
}

export interface AssertNoBomCycleForCandidateInput {
  readonly candidate: BomCycleCandidate;
  /**
   * 평가 기준일. 기본은 candidate 의 `effectiveFrom` 이지만, **activate 는 최종
   * `T`**, header PATCH 는 변경 후 값, import 는 각 header 의 값을 넘긴다
   * (§D-13 evaluation date 표).
   *
   * ⛔ 이 서비스가 내부에서 `header.effectiveFrom` 을 강제로 다시 읽지 않는다 —
   *    override 를 받을 수 있어야 activate 재검사가 성립한다.
   */
  readonly evaluationDate: Date;
  readonly maxLevel?: number;
}

/** 진단용 그래프 스냅샷. 테스트가 sibling 선택 결과를 직접 확인한다. */
export interface BomCycleGraphSnapshot {
  readonly rootSkuId: string;
  readonly edges: ReadonlyMap<string, readonly string[]>;
  /** candidate 로 대체된 parent — 항상 `rootSkuId` 하나다. */
  readonly substitutedSkuId: string;
}

/**
 * candidate 를 강제 투입한 evaluation-date 그래프를 만든다.
 *
 * frontier(같은 depth 의 SKU 들)를 **batch resolver 로 한 번에** 해결하므로
 * DFS node 마다 query 를 날리는 N+1 이 되지 않는다 (§D-22).
 *
 * @throws 409 `BOM_EFFECTIVE_CONFLICT` — 어느 SKU 라도 유효 ACTIVE BOM 이 2건 이상
 */
export async function buildBomCycleGraph(
  db: BomDbClient,
  input: AssertNoBomCycleForCandidateInput,
): Promise<BomCycleGraphSnapshot> {
  const root = input.candidate.parentSkuId;
  const edges = new Map<string, readonly string[]>();

  // ① candidate 는 resolver 를 거치지 않는다 — 자기 자신이 곧 선택 결과다.
  edges.set(root, [...input.candidate.componentSkuIds]);

  let frontier = [...new Set(input.candidate.componentSkuIds)].filter((id) => id !== root);
  const seen = new Set<string>([root]);

  // 깊이는 DFS 가 판정한다. 여기서는 **더 확장할 노드가 없을 때까지**만 넓힌다.
  // 순환이 있어도 `seen` 때문에 유한 회차에 끝난다.
  while (frontier.length > 0) {
    const pending = frontier.filter((id) => !seen.has(id));
    for (const id of pending) seen.add(id);
    if (pending.length === 0) break;

    // ② 그 밖의 parent 는 asOf 유효 ACTIVE 버전 0/1건만 (batch 1회).
    const resolved = await resolveEffectiveBoms(db, {
      parentSkuIds: pending,
      asOf: input.evaluationDate,
    });

    const headerIds = [...resolved.values()]
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map((row) => row.id);

    const lines =
      headerIds.length === 0
        ? []
        : await db.bomLine.findMany({
            where: { bomHeaderId: { in: headerIds } },
            select: { bomHeaderId: true, componentSkuId: true, lineNo: true },
            orderBy: [{ bomHeaderId: 'asc' }, { lineNo: 'asc' }],
          });

    const childrenByHeader = new Map<string, string[]>();
    for (const line of lines) {
      const bucket = childrenByHeader.get(line.bomHeaderId);
      if (bucket === undefined) childrenByHeader.set(line.bomHeaderId, [line.componentSkuId]);
      else bucket.push(line.componentSkuId);
    }

    const next: string[] = [];
    for (const skuId of pending) {
      const header = resolved.get(skuId) ?? null;
      // ④ 유효 BOM 이 없는 SKU 는 leaf 다.
      const children = header === null ? [] : (childrenByHeader.get(header.id) ?? []);
      edges.set(skuId, children);
      next.push(...children);
    }
    frontier = [...new Set(next)];
  }

  return { rootSkuId: root, edges, substitutedSkuId: root };
}

/**
 * candidate 그래프를 만들고 순환을 판정한다.
 *
 * ⚠️ 반드시 **advisory lock 을 먼저 잡은 트랜잭션 안에서** 호출한다 (§D-28).
 *
 * @throws 422 `BOM_CYCLE_DETECTED` · 422 `BOM_MAX_LEVEL_EXCEEDED`
 *         · 409 `BOM_EFFECTIVE_CONFLICT`
 */
export async function assertNoBomCycleForCandidate(
  db: BomDbClient,
  input: AssertNoBomCycleForCandidateInput,
): Promise<BomCycleGraphSnapshot> {
  const graph = await buildBomCycleGraph(db, input);
  assertNoBomCycle({
    rootSkuId: graph.rootSkuId,
    childrenOf: (skuId) => graph.edges.get(skuId) ?? [],
    ...(input.maxLevel === undefined ? {} : { maxLevel: input.maxLevel }),
  });
  return graph;
}
