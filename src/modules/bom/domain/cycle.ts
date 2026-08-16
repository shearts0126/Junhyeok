import { DomainError, ERROR_CODES } from '@/shared/errors';

import { BOM_MAX_LEVEL } from './constants';

/**
 * BOM 순환 탐지 (T07-2) — **순수 함수**. Prisma 를 import 하지 않는다.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-13.
 *
 * ## 이 모듈이 보는 것은 "한 시점의 graph" 다
 *
 * 그래프 구성(= evaluation date 에서 parent 마다 **버전 하나**를 고르는 일)은
 * `application/cycle-graph.ts` 의 몫이고, 이 모듈은 **이미 확정된 인접 관계**만
 * 받아 순환을 판정한다. 그래서 DB 도 날짜도 모른다.
 *
 * ## 전역 visited 로 판정하지 않는다
 *
 * ⛔ `visited` 하나로 "이미 본 노드 = 순환" 이라고 하면 **다이아몬드를 순환으로
 *    오판**한다(`07v2:427` 이 다이아몬드를 "순환 아님"으로 명시).
 *
 * ```
 *   A → B → D
 *   A → C → D      ← D 를 두 번 만나지만 순환이 아니다
 * ```
 *
 * 판정은 오직 **현재 재귀 경로(`path`)** 로 한다. `done` 은 이미 안전을 확인한
 * 노드를 다시 파고들지 않기 위한 **가지치기 전용**이며 판정에 쓰지 않는다.
 */

/** 인접 관계 조회. `skuId` 의 구성품 SKU 목록을 준다. 없으면 leaf 다. */
export type BomChildrenLookup = (skuId: string) => readonly string[];

export interface DetectBomCycleInput {
  /** 탐색 시작 노드 — candidate BOM 의 `parentSkuId`. */
  readonly rootSkuId: string;
  readonly childrenOf: BomChildrenLookup;
  /** 기본값 `BOM_MAX_LEVEL`. 테스트·향후 explode 가 낮출 수 있다. */
  readonly maxLevel?: number;
}

export function bomCycleDetected(path: readonly string[]): DomainError {
  return new DomainError(ERROR_CODES.BOM_CYCLE_DETECTED, {
    message: `BOM 구성이 순환합니다: ${path.join(' → ')}`,
    // 진단에 경로 전체가 필요하다 — 어느 edge 를 지워야 하는지 알려준다.
    context: { cyclePath: [...path] },
    publicDetails: { cyclePath: [...path] },
  });
}

export function bomMaxLevelExceeded(path: readonly string[], maxLevel: number): DomainError {
  return new DomainError(ERROR_CODES.BOM_MAX_LEVEL_EXCEEDED, {
    message: `BOM 전개 깊이가 ${maxLevel} 단계를 넘었습니다: ${path.join(' → ')}`,
    context: { maxLevel, path: [...path] },
    publicDetails: { maxLevel },
  });
}

/**
 * 순환이면 `BOM_CYCLE_DETECTED`, 깊이 초과면 `BOM_MAX_LEVEL_EXCEEDED` 를 던진다.
 * 정상이면 아무것도 반환하지 않는다.
 *
 * `rootSkuId` 자신이 자기 구성품이면(`A → A`) 그것도 순환이다 — D-12 의
 * `BOM_SELF_COMPONENT` 는 입력 단계의 빠른 거부이고, 여기서 그래프 차원의
 * 방어가 한 번 더 걸린다 (§D-13, 두 방어를 모두 둔다).
 *
 * @throws {DomainError} `BOM_CYCLE_DETECTED` / `BOM_MAX_LEVEL_EXCEEDED`
 */
export function assertNoBomCycle(input: DetectBomCycleInput): void {
  const maxLevel = input.maxLevel ?? BOM_MAX_LEVEL;

  /** 현재 재귀 경로 — **순환 판정은 오직 이것으로 한다**. */
  const path: string[] = [];
  const onPath = new Set<string>();
  /** 이미 안전 확인된 노드 — 가지치기 전용, 판정에 미사용. */
  const done = new Set<string>();

  const visit = (skuId: string, level: number): void => {
    if (onPath.has(skuId)) {
      // 순환 구간만 잘라 보여준다 — 앞쪽 진입 경로는 원인이 아니다.
      const start = path.indexOf(skuId);
      throw bomCycleDetected([...path.slice(start), skuId]);
    }
    if (done.has(skuId)) return; // 다이아몬드: 순환이 아니다
    if (level > maxLevel) throw bomMaxLevelExceeded([...path, skuId], maxLevel);

    path.push(skuId);
    onPath.add(skuId);
    for (const child of input.childrenOf(skuId)) {
      visit(child, level + 1);
    }
    path.pop();
    onPath.delete(skuId);
    done.add(skuId);
  };

  visit(input.rootSkuId, 0);
}

/**
 * 던지지 않는 형태. 순환이면 경로를, 아니면 `null` 을 준다.
 * ⚠️ 깊이 초과는 여기서도 **던진다** — "순환 없음"으로 오해되면 안 되기 때문이다.
 */
export function findBomCyclePath(input: DetectBomCycleInput): readonly string[] | null {
  try {
    assertNoBomCycle(input);
    return null;
  } catch (error) {
    if (error instanceof DomainError && error.code === ERROR_CODES.BOM_CYCLE_DETECTED) {
      const detail = error.context as { cyclePath?: readonly string[] } | undefined;
      return detail?.cyclePath ?? [];
    }
    throw error;
  }
}
