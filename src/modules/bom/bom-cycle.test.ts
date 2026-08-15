import { describe, expect, it } from 'vitest';

import { DomainError, ERROR_CODES } from '@/shared/errors';

import { BOM_MAX_LEVEL } from './domain/constants';
import { assertNoBomCycle, findBomCyclePath } from './domain/cycle';

/**
 * BOM 순환 탐지 단위 테스트 (T07-2) — DB 없이 DFS 자체를 고정한다.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-13.
 *
 * ★ 핵심은 **recursion-path 기반 판정**이다. 전역 `visited` 로 판정하면
 *   다이아몬드(`A→B→D`, `A→C→D`)가 순환으로 오판된다 — 그 회귀를 막는 것이
 *   이 파일의 존재 이유다.
 */

/** 인접 리스트 → `childrenOf`. */
function graph(edges: Record<string, string[]>) {
  return (skuId: string): readonly string[] => edges[skuId] ?? [];
}

function expectCycle(fn: () => void, expectedPath?: readonly string[]): DomainError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  const error = caught as DomainError;
  expect(error.code).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);
  if (expectedPath !== undefined) {
    const detail = error.context as { cyclePath?: readonly string[] };
    expect(detail.cyclePath).toEqual(expectedPath);
  }
  return error;
}

// ═══════════════════════════════════════════════════════════════
// 정상 그래프
// ═══════════════════════════════════════════════════════════════

describe('순환이 아닌 그래프는 통과한다', () => {
  it('빈 그래프 — leaf 하나', () => {
    expect(() => assertNoBomCycle({ rootSkuId: 'A', childrenOf: graph({}) })).not.toThrow();
  });

  it('단일 edge', () => {
    expect(() =>
      assertNoBomCycle({ rootSkuId: 'A', childrenOf: graph({ A: ['B'] }) }),
    ).not.toThrow();
  });

  it('직선 체인 A→B→C→D', () => {
    expect(() =>
      assertNoBomCycle({
        rootSkuId: 'A',
        childrenOf: graph({ A: ['B'], B: ['C'], C: ['D'] }),
      }),
    ).not.toThrow();
  });

  it('★ 다이아몬드는 순환이 아니다 — 전역 visited 판정이면 여기서 깨진다', () => {
    // A → B → D
    // A → C → D      D 를 두 번 만나지만 같은 재귀 경로에 있지 않다.
    expect(() =>
      assertNoBomCycle({
        rootSkuId: 'A',
        childrenOf: graph({ A: ['B', 'C'], B: ['D'], C: ['D'] }),
      }),
    ).not.toThrow();
    expect(
      findBomCyclePath({
        rootSkuId: 'A',
        childrenOf: graph({ A: ['B', 'C'], B: ['D'], C: ['D'] }),
      }),
    ).toBeNull();
  });

  it('★ 깊은 다이아몬드 — 공유 하위 트리를 여러 번 만나도 정상', () => {
    expect(() =>
      assertNoBomCycle({
        rootSkuId: 'A',
        childrenOf: graph({
          A: ['B', 'C'],
          B: ['D', 'E'],
          C: ['D', 'E'],
          D: ['F'],
          E: ['F'],
          F: ['G'],
        }),
      }),
    ).not.toThrow();
  });

  it('같은 자식이 한 부모에 두 번 등장해도 순환이 아니다', () => {
    expect(() =>
      assertNoBomCycle({ rootSkuId: 'A', childrenOf: graph({ A: ['B', 'B'] }) }),
    ).not.toThrow();
  });

  it('연결되지 않은 다른 서브그래프의 순환은 root 탐색에 영향을 주지 않는다', () => {
    // X→Y→X 는 순환이지만 A 에서 도달할 수 없다.
    expect(() =>
      assertNoBomCycle({
        rootSkuId: 'A',
        childrenOf: graph({ A: ['B'], X: ['Y'], Y: ['X'] }),
      }),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 순환
// ═══════════════════════════════════════════════════════════════

describe('★ 순환은 BOM_CYCLE_DETECTED 다', () => {
  it('A→A 직접 자기참조', () => {
    const error = expectCycle(
      () => assertNoBomCycle({ rootSkuId: 'A', childrenOf: graph({ A: ['A'] }) }),
      ['A', 'A'],
    );
    expect(error.httpStatus).toBe(422);
  });

  it('A→B→A 2단계', () => {
    expectCycle(
      () => assertNoBomCycle({ rootSkuId: 'A', childrenOf: graph({ A: ['B'], B: ['A'] }) }),
      ['A', 'B', 'A'],
    );
  });

  it('A→B→C→A 3단계 (TC-BOM-007)', () => {
    expectCycle(
      () =>
        assertNoBomCycle({
          rootSkuId: 'A',
          childrenOf: graph({ A: ['B'], B: ['C'], C: ['A'] }),
        }),
      ['A', 'B', 'C', 'A'],
    );
  });

  it('root 를 지나지 않는 하위 순환도 잡는다 (B→C→B)', () => {
    expectCycle(
      () =>
        assertNoBomCycle({
          rootSkuId: 'A',
          childrenOf: graph({ A: ['B'], B: ['C'], C: ['B'] }),
        }),
      // 순환 구간만 보고한다 — 앞의 A 는 원인이 아니다.
      ['B', 'C', 'B'],
    );
  });

  it('정상 가지를 먼저 지나도 나중 가지의 순환을 잡는다', () => {
    expectCycle(() =>
      assertNoBomCycle({
        rootSkuId: 'A',
        childrenOf: graph({ A: ['OK', 'B'], OK: [], B: ['C'], C: ['B'] }),
      }),
    );
  });

  it('findBomCyclePath 는 던지지 않고 경로를 준다', () => {
    expect(findBomCyclePath({ rootSkuId: 'A', childrenOf: graph({ A: ['B'], B: ['A'] }) })).toEqual(
      ['A', 'B', 'A'],
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// MAX_LEVEL
// ═══════════════════════════════════════════════════════════════

describe('★ MAX_LEVEL (D-13)', () => {
  it('상수는 10 이다 — explode 기본값과 공유한다', () => {
    expect(BOM_MAX_LEVEL).toBe(10);
  });

  /** `0 → 1 → … → n` 직선 체인. */
  function chain(length: number) {
    const edges: Record<string, string[]> = {};
    for (let i = 0; i < length; i += 1) edges[`n${i}`] = [`n${i + 1}`];
    return edges;
  }

  it('깊이 = MAX_LEVEL 은 통과한다', () => {
    expect(() =>
      assertNoBomCycle({ rootSkuId: 'n0', childrenOf: graph(chain(BOM_MAX_LEVEL)) }),
    ).not.toThrow();
  });

  it('★ 깊이 초과는 BOM_MAX_LEVEL_EXCEEDED 다 — 조용히 끊고 "순환 없음" 하지 않는다', () => {
    let caught: unknown;
    try {
      assertNoBomCycle({ rootSkuId: 'n0', childrenOf: graph(chain(BOM_MAX_LEVEL + 5)) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(ERROR_CODES.BOM_MAX_LEVEL_EXCEEDED);
    expect((caught as DomainError).httpStatus).toBe(422);
  });

  it('maxLevel 을 낮추면 그 깊이에서 걸린다', () => {
    expect(() =>
      assertNoBomCycle({ rootSkuId: 'n0', childrenOf: graph(chain(3)), maxLevel: 2 }),
    ).toThrow(/깊이/);
  });

  it('★ 깊이 초과는 findBomCyclePath 에서도 던진다 — null 로 삼키지 않는다', () => {
    expect(() =>
      findBomCyclePath({ rootSkuId: 'n0', childrenOf: graph(chain(BOM_MAX_LEVEL + 1)) }),
    ).toThrow(/깊이/);
  });

  it('넓기만 한 그래프는 깊이 제한에 걸리지 않는다', () => {
    const wide: Record<string, string[]> = { A: [] };
    for (let i = 0; i < 100; i += 1) wide['A']?.push(`c${i}`);
    expect(() => assertNoBomCycle({ rootSkuId: 'A', childrenOf: graph(wide) })).not.toThrow();
  });
});
