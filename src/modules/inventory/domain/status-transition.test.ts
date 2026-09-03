import { describe, expect, it } from 'vitest';

import type { InventoryStatus, TransactionType } from '@/generated/prisma/client';
import { AppError } from '@/shared/errors';

import { assertBalancedIfStatusMove, assertStatusTransitionByNet } from './status-transition';
import { groupByStockKey, normalizeEntries, type StockKeyGroup } from './stock-key';

/**
 * 재고상태 전이 검증 · 거래유형별 균형 검증 (T2-7).
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.2 · §8.4 · §8.12,
 *    `docs/PENDING_v0.3_보완사항.md` §5, `docs/07_개발백로그와_테스트전략_v0.2.md:155`
 *    — 테스트 유형은 **단위**다.
 *
 * ⛔ 다음은 계약으로 고정하지 않는다 — 정본이 정하지 않았다.
 *    · **어느 위반이 먼저 던져지는가** — 복수 invalid pair·복수 unbalanced
 *      bucket 이 동시에 있을 때의 순서. 각 케이스는 위반을 **하나만** 둔다.
 *    · balance-key 직렬화 문자열·구분자 (module-private 구현 세부사항)
 *    · group 반환 순서
 *
 * ⛔ `TC-POST-104` 본체(통합)·DB·E2E 는 여기서 만들지 않는다.
 * ⛔ `REVERSAL` 테스트를 만들지 않는다 — **T2-13** 소유다.
 */

// ═══════════════════════════════════════════════════════════════
// fixture
// ═══════════════════════════════════════════════════════════════

const SKU_A = '11111111-1111-4111-8111-111111111111';
const SKU_B = '11111111-1111-4111-8111-111111111112';
const WAREHOUSE_SOURCE = '22222222-2222-4222-8222-222222222221';
const WAREHOUSE_DESTINATION = '22222222-2222-4222-8222-222222222222';
/** `IN_TRANSIT` 시스템 예약 창고 (`docs/19` §W-D11) — 이동중 버킷의 자리. */
const WAREHOUSE_TRANSIT = '22222222-2222-4222-8222-222222222299';
const LOCATION_A = '33333333-3333-4333-8333-333333333331';
const DEFAULT_LOCATION = '33333333-3333-4333-8333-33333333DEF0';

const CONTEXT = { defaultLocationId: DEFAULT_LOCATION };

const ALL_STATUSES: readonly InventoryStatus[] = [
  'AVAILABLE',
  'RESERVED',
  'OUTBOUND_PENDING',
  'HOLD',
  'INSPECTION',
  'DEFECTIVE',
  'RETURN_PENDING',
  'DISPOSAL_PENDING',
  'IN_TRANSIT',
];

interface EntryInput {
  readonly skuId?: string;
  readonly warehouseId?: string;
  readonly locationId?: string;
  readonly inventoryStatus: InventoryStatus;
  readonly quantityDelta: string;
  readonly lotNo?: string;
  readonly serialNo?: string;
  readonly expiryDate?: Date;
}

/** 입력 entry 들을 T2-6 의 정규화 → 그룹화를 그대로 거쳐 groups 로 만든다. */
function groupsOf(entries: readonly EntryInput[]): StockKeyGroup<unknown>[] {
  const normalized = normalizeEntries(
    entries.map((entry) => ({
      skuId: entry.skuId ?? SKU_A,
      warehouseId: entry.warehouseId ?? WAREHOUSE_SOURCE,
      locationId: entry.locationId ?? LOCATION_A,
      inventoryStatus: entry.inventoryStatus,
      quantityDelta: entry.quantityDelta,
      ...(entry.lotNo === undefined ? {} : { lotNo: entry.lotNo }),
      ...(entry.serialNo === undefined ? {} : { serialNo: entry.serialNo }),
      ...(entry.expiryDate === undefined ? {} : { expiryDate: entry.expiryDate }),
    })),
    () => CONTEXT,
  );
  return groupByStockKey(normalized);
}

/** 상태 하나에서 다른 상태 하나로 net 이 옮겨가는 최소 groups. */
function moveGroups(from: InventoryStatus, to: InventoryStatus): StockKeyGroup<unknown>[] {
  return groupsOf([
    { inventoryStatus: from, quantityDelta: '-10' },
    { inventoryStatus: to, quantityDelta: '10' },
  ]);
}

function codeOfThrown(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return '(did not throw)';
}

/** `docs/04 §8.4` 허용 전이표의 내부 상태 전이 — **정확히 15종.** */
const ALLOWED_TRANSITIONS: readonly (readonly [InventoryStatus, InventoryStatus])[] = [
  ['AVAILABLE', 'RESERVED'],
  ['AVAILABLE', 'HOLD'],
  ['AVAILABLE', 'IN_TRANSIT'],
  ['RESERVED', 'AVAILABLE'],
  ['RESERVED', 'OUTBOUND_PENDING'],
  ['OUTBOUND_PENDING', 'AVAILABLE'],
  ['HOLD', 'AVAILABLE'],
  ['HOLD', 'DEFECTIVE'],
  ['INSPECTION', 'AVAILABLE'],
  ['INSPECTION', 'DEFECTIVE'],
  ['DEFECTIVE', 'DISPOSAL_PENDING'],
  ['RETURN_PENDING', 'AVAILABLE'],
  ['RETURN_PENDING', 'DEFECTIVE'],
  ['IN_TRANSIT', 'AVAILABLE'],
  ['IN_TRANSIT', 'INSPECTION'],
];

/** `docs/04 §8.4` **명시적으로 금지되는 전이** 중 T2-7 범위(내부 전이) — 정확히 5종. */
const EXPLICIT_FORBIDDEN_TRANSITIONS: readonly (readonly [InventoryStatus, InventoryStatus])[] = [
  ['DEFECTIVE', 'AVAILABLE'],
  ['AVAILABLE', 'OUTBOUND_PENDING'],
  ['AVAILABLE', 'DEFECTIVE'],
  ['RESERVED', 'HOLD'],
  ['IN_TRANSIT', 'DEFECTIVE'],
];

// ═══════════════════════════════════════════════════════════════
// ⑨ 상태전이 — 허용 15종
// ═══════════════════════════════════════════════════════════════

describe('assertStatusTransitionByNet — 허용 전이', () => {
  it('★★ 허용 전이는 정확히 15종이다 (전이표 개수 고정)', () => {
    expect(ALLOWED_TRANSITIONS).toHaveLength(15);
    expect(new Set(ALLOWED_TRANSITIONS.map(([from, to]) => `${from}>${to}`)).size).toBe(15);
  });

  it.each(ALLOWED_TRANSITIONS)('%s → %s 를 통과시킨다', (from, to) => {
    expect(() => assertStatusTransitionByNet('STATUS_CHANGE', moveGroups(from, to))).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑨ 상태전이 — 명시 금지 5종
// ═══════════════════════════════════════════════════════════════

describe('assertStatusTransitionByNet — 명시적으로 금지되는 전이', () => {
  it('★★ T2-7 범위의 명시 금지는 정확히 5종이다', () => {
    // 6번째 `HOLD → 외부반출` 은 InventoryStatus pair 가 아니며 TB-12 / TC-INV-011 소유다.
    expect(EXPLICIT_FORBIDDEN_TRANSITIONS).toHaveLength(5);
  });

  it.each(EXPLICIT_FORBIDDEN_TRANSITIONS)('%s → %s 를 차단한다', (from, to) => {
    expect(
      codeOfThrown(() => assertStatusTransitionByNet('STATUS_CHANGE', moveGroups(from, to))),
    ).toBe('INVALID_STATUS_TRANSITION');
  });

  it('오류 publicDetails 에 from·to 를 담는다', () => {
    try {
      assertStatusTransitionByNet('STATUS_CHANGE', moveGroups('DEFECTIVE', 'AVAILABLE'));
      expect.unreachable('전이가 차단되어야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.httpStatus).toBe(422);
      expect(appError.publicDetails).toEqual({ from: 'DEFECTIVE', to: 'AVAILABLE' });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑨ 상태전이 — 내부 전체 매트릭스
// ═══════════════════════════════════════════════════════════════

describe('assertStatusTransitionByNet — 내부 전이 전체 매트릭스', () => {
  const allowedSet = new Set(ALLOWED_TRANSITIONS.map(([from, to]) => `${from}>${to}`));

  /**
   * 전이표의 나머지 ❌ 칸도 전부 차단되어야 한다.
   *
   * ⛔ 자기 자신(`—` 대각선)과 `외부반출` 열은 제외한다 — 전자는 표에서 `—`
   *    이고 후자는 `InventoryStatus` 가 아니다. 여기서 나온 개수를 문서
   *    완료조건("허용 15종 · 명시 금지 5종")으로 다시 정의하지 않는다.
   */
  const offDiagonal = ALL_STATUSES.flatMap((from) =>
    ALL_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it('대각선·외부반출을 뺀 내부 pair 는 72개다 (9 × 8)', () => {
    expect(offDiagonal).toHaveLength(72);
  });

  it.each(offDiagonal)('%s → %s 판정이 전이표와 일치한다', (from, to) => {
    const run = (): void => {
      assertStatusTransitionByNet('STATUS_CHANGE', moveGroups(from, to));
    };
    if (allowedSet.has(`${from}>${to}`)) {
      expect(run).not.toThrow();
    } else {
      expect(codeOfThrown(run)).toBe('INVALID_STATUS_TRANSITION');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑨ net 부호 해석
// ═══════════════════════════════════════════════════════════════

describe('assertStatusTransitionByNet — net 부호 해석', () => {
  it('net = 0 그룹은 from 에도 to 에도 들어가지 않는다', () => {
    // DEFECTIVE 는 net 0 이므로 pairing 에서 빠진다.
    // 만약 from/to 로 잡히면 AVAILABLE → DEFECTIVE (금지) 또는
    // DEFECTIVE → HOLD (금지) 가 되어 던졌을 것이다.
    const groups = groupsOf([
      { inventoryStatus: 'AVAILABLE', quantityDelta: '-10' },
      { inventoryStatus: 'HOLD', quantityDelta: '10' },
      { inventoryStatus: 'DEFECTIVE', quantityDelta: '7' },
      { inventoryStatus: 'DEFECTIVE', quantityDelta: '-7' },
    ]);

    expect(() => assertStatusTransitionByNet('STATUS_CHANGE', groups)).not.toThrow();
  });

  it('zero-net 그룹을 제거하지 않는다 (T2-6 계약)', () => {
    const groups = groupsOf([
      { inventoryStatus: 'AVAILABLE', quantityDelta: '-10' },
      { inventoryStatus: 'HOLD', quantityDelta: '10' },
      { inventoryStatus: 'DEFECTIVE', quantityDelta: '7' },
      { inventoryStatus: 'DEFECTIVE', quantityDelta: '-7' },
    ]);
    const before = groups.length;

    assertStatusTransitionByNet('STATUS_CHANGE', groups);

    expect(groups).toHaveLength(before);
    expect(groups).toHaveLength(3);
  });

  /**
   * `TC-POST-104` 의 **단위** 대응물 — 같은 상태 버킷이 여러 entry 로 쪼개져도
   * net 을 먼저 내면 방향이 정확히 하나로 정해진다. (통합 케이스 본체는
   * `docs/07:399` 가 통합으로 분류했으므로 여기서 만들지 않는다.)
   */
  it('같은 버킷이 반대 부호로 쪼개져도 net 으로 방향을 판정한다', () => {
    const groups = groupsOf([
      { inventoryStatus: 'AVAILABLE', quantityDelta: '-100' },
      { inventoryStatus: 'AVAILABLE', quantityDelta: '30' },
      { inventoryStatus: 'HOLD', quantityDelta: '70' },
    ]);

    // AVAILABLE net = −70 (from) / HOLD net = +70 (to) → AVAILABLE → HOLD 1건
    expect(groups).toHaveLength(2);
    expect(() => assertStatusTransitionByNet('STATUS_CHANGE', groups)).not.toThrow();
    expect(() => assertBalancedIfStatusMove('STATUS_CHANGE', groups)).not.toThrow();
  });

  it('상태이동 유형이 아니면 전이표를 보지 않는다', () => {
    // AVAILABLE → DEFECTIVE 는 금지 전이지만 MANUAL_ADJUSTMENT 는 상태이동이 아니다.
    expect(() =>
      assertStatusTransitionByNet('MANUAL_ADJUSTMENT', moveGroups('AVAILABLE', 'DEFECTIVE')),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑩ 균형 — STATUS_CHANGE (7열)
// ═══════════════════════════════════════════════════════════════

describe('assertBalancedIfStatusMove — STATUS_CHANGE 는 7열 단위', () => {
  it('같은 7열 안에서 상태만 옮기면 통과한다', () => {
    const groups = groupsOf([
      { inventoryStatus: 'AVAILABLE', quantityDelta: '-70' },
      { inventoryStatus: 'HOLD', quantityDelta: '70' },
    ]);

    expect(() => assertBalancedIfStatusMove('STATUS_CHANGE', groups)).not.toThrow();
  });

  /**
   * ★★ `PENDING_v0.3 §5` 의 핵심 regression — 전역 합계는 0 이지만
   *    서로 다른 7열 bucket 이므로 **차단되어야** 한다. v0.1 의 전역 Σ 는
   *    이것을 통과시켰다.
   */
  it('★★ 서로 다른 SKU 가 전역 합계로 상쇄되는 것을 차단한다', () => {
    const groups = groupsOf([
      { skuId: SKU_A, inventoryStatus: 'AVAILABLE', quantityDelta: '-100' },
      { skuId: SKU_B, inventoryStatus: 'HOLD', quantityDelta: '100' },
    ]);

    expect(codeOfThrown(() => assertBalancedIfStatusMove('STATUS_CHANGE', groups))).toBe(
      'UNBALANCED_TRANSACTION',
    );
  });

  it('★★ 창고가 다르면 7열이 다르므로 차단한다', () => {
    const groups = groupsOf([
      { warehouseId: WAREHOUSE_SOURCE, inventoryStatus: 'AVAILABLE', quantityDelta: '-10' },
      { warehouseId: WAREHOUSE_DESTINATION, inventoryStatus: 'HOLD', quantityDelta: '10' },
    ]);

    expect(codeOfThrown(() => assertBalancedIfStatusMove('STATUS_CHANGE', groups))).toBe(
      'UNBALANCED_TRANSACTION',
    );
  });

  it('단일 bucket 합계가 0 이 아니면 차단한다', () => {
    const groups = groupsOf([
      { inventoryStatus: 'AVAILABLE', quantityDelta: '-70' },
      { inventoryStatus: 'HOLD', quantityDelta: '60' },
    ]);

    expect(codeOfThrown(() => assertBalancedIfStatusMove('STATUS_CHANGE', groups))).toBe(
      'UNBALANCED_TRANSACTION',
    );
  });

  it('독립적으로 균형 잡힌 두 bucket 은 통과한다', () => {
    const groups = groupsOf([
      { skuId: SKU_A, inventoryStatus: 'AVAILABLE', quantityDelta: '-10' },
      { skuId: SKU_A, inventoryStatus: 'HOLD', quantityDelta: '10' },
      { skuId: SKU_B, inventoryStatus: 'AVAILABLE', quantityDelta: '-5' },
      { skuId: SKU_B, inventoryStatus: 'HOLD', quantityDelta: '5' },
    ]);

    expect(() => assertBalancedIfStatusMove('STATUS_CHANGE', groups)).not.toThrow();
  });

  it('오류 publicDetails 는 sum 하나이며 Decimal 문자열이다', () => {
    const groups = groupsOf([
      { inventoryStatus: 'AVAILABLE', quantityDelta: '-70' },
      { inventoryStatus: 'HOLD', quantityDelta: '60' },
    ]);

    try {
      assertBalancedIfStatusMove('STATUS_CHANGE', groups);
      expect.unreachable('균형이 맞지 않아 차단되어야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.httpStatus).toBe(422);
      expect(appError.publicDetails).toEqual({ sum: '-10' });
    }
  });

  it('소수 수량도 Decimal 로 정확히 상쇄된다', () => {
    const groups = groupsOf([
      { inventoryStatus: 'AVAILABLE', quantityDelta: '-0.000003' },
      { inventoryStatus: 'HOLD', quantityDelta: '0.000002' },
      { inventoryStatus: 'RESERVED', quantityDelta: '0.000001' },
    ]);

    expect(() => assertBalancedIfStatusMove('STATUS_CHANGE', groups)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑩ 균형 — 예약 · 예약해제
// ═══════════════════════════════════════════════════════════════

describe('예약 · 예약해제', () => {
  it('RESERVATION — AVAILABLE → RESERVED 는 전이·균형 모두 통과한다', () => {
    const groups = groupsOf([
      { inventoryStatus: 'AVAILABLE', quantityDelta: '-30' },
      { inventoryStatus: 'RESERVED', quantityDelta: '30' },
    ]);

    expect(() => assertStatusTransitionByNet('RESERVATION', groups)).not.toThrow();
    expect(() => assertBalancedIfStatusMove('RESERVATION', groups)).not.toThrow();
  });

  it('RESERVATION_RELEASE — RESERVED → AVAILABLE 는 전이·균형 모두 통과한다', () => {
    const groups = groupsOf([
      { inventoryStatus: 'RESERVED', quantityDelta: '-30' },
      { inventoryStatus: 'AVAILABLE', quantityDelta: '30' },
    ]);

    expect(() => assertStatusTransitionByNet('RESERVATION_RELEASE', groups)).not.toThrow();
    expect(() => assertBalancedIfStatusMove('RESERVATION_RELEASE', groups)).not.toThrow();
  });

  it('RESERVATION 도 7열 균형을 강제한다', () => {
    const groups = groupsOf([
      { skuId: SKU_A, inventoryStatus: 'AVAILABLE', quantityDelta: '-30' },
      { skuId: SKU_B, inventoryStatus: 'RESERVED', quantityDelta: '30' },
    ]);

    expect(codeOfThrown(() => assertBalancedIfStatusMove('RESERVATION', groups))).toBe(
      'UNBALANCED_TRANSACTION',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑩ 균형 — 창고이동 (5열)
// ═══════════════════════════════════════════════════════════════

describe('assertBalancedIfStatusMove — 창고이동은 5열 단위', () => {
  /** 출발 leg — 출발창고 `AVAILABLE −Q` + 이동중창고 `IN_TRANSIT +Q` (`docs/00` C-02). */
  const dispatchGroups = (): StockKeyGroup<unknown>[] =>
    groupsOf([
      { warehouseId: WAREHOUSE_SOURCE, inventoryStatus: 'AVAILABLE', quantityDelta: '-40' },
      { warehouseId: WAREHOUSE_TRANSIT, inventoryStatus: 'IN_TRANSIT', quantityDelta: '40' },
    ]);

  /** 도착 leg — 이동중창고 `IN_TRANSIT −Q` + 도착창고 `AVAILABLE +Q`. */
  const receiptGroups = (): StockKeyGroup<unknown>[] =>
    groupsOf([
      { warehouseId: WAREHOUSE_TRANSIT, inventoryStatus: 'IN_TRANSIT', quantityDelta: '-40' },
      { warehouseId: WAREHOUSE_DESTINATION, inventoryStatus: 'AVAILABLE', quantityDelta: '40' },
    ]);

  it('WAREHOUSE_TRANSFER_OUT — 창고가 달라도 5열 균형이 성립한다', () => {
    expect(() =>
      assertBalancedIfStatusMove('WAREHOUSE_TRANSFER_OUT', dispatchGroups()),
    ).not.toThrow();
  });

  it('WAREHOUSE_TRANSFER_OUT — AVAILABLE → IN_TRANSIT 전이도 통과한다', () => {
    expect(() =>
      assertStatusTransitionByNet('WAREHOUSE_TRANSFER_OUT', dispatchGroups()),
    ).not.toThrow();
  });

  it('WAREHOUSE_TRANSFER_IN — 5열 균형이 성립한다', () => {
    expect(() =>
      assertBalancedIfStatusMove('WAREHOUSE_TRANSFER_IN', receiptGroups()),
    ).not.toThrow();
  });

  it('WAREHOUSE_TRANSFER_IN — IN_TRANSIT → AVAILABLE 전이도 통과한다', () => {
    expect(() =>
      assertStatusTransitionByNet('WAREHOUSE_TRANSFER_IN', receiptGroups()),
    ).not.toThrow();
  });

  it('★★ 같은 창고이동을 7열로 봤다면 차단됐을 것이다 (5열이라 통과한다)', () => {
    // 같은 entries 를 STATUS_CHANGE(7열)로 검증하면 창고가 달라 균형이 깨진다.
    expect(codeOfThrown(() => assertBalancedIfStatusMove('STATUS_CHANGE', dispatchGroups()))).toBe(
      'UNBALANCED_TRANSACTION',
    );
    expect(() =>
      assertBalancedIfStatusMove('WAREHOUSE_TRANSFER_OUT', dispatchGroups()),
    ).not.toThrow();
  });

  it('★★ 수량은 같아도 LOT 이 다르면 차단한다', () => {
    const groups = groupsOf([
      {
        warehouseId: WAREHOUSE_SOURCE,
        inventoryStatus: 'AVAILABLE',
        quantityDelta: '-40',
        lotNo: 'LOT-A',
      },
      {
        warehouseId: WAREHOUSE_TRANSIT,
        inventoryStatus: 'IN_TRANSIT',
        quantityDelta: '40',
        lotNo: 'LOT-B',
      },
    ]);

    expect(codeOfThrown(() => assertBalancedIfStatusMove('WAREHOUSE_TRANSFER_OUT', groups))).toBe(
      'UNBALANCED_TRANSACTION',
    );
  });

  it('수량이 다르면 차단한다', () => {
    const groups = groupsOf([
      { warehouseId: WAREHOUSE_SOURCE, inventoryStatus: 'AVAILABLE', quantityDelta: '-40' },
      { warehouseId: WAREHOUSE_TRANSIT, inventoryStatus: 'IN_TRANSIT', quantityDelta: '35' },
    ]);

    expect(codeOfThrown(() => assertBalancedIfStatusMove('WAREHOUSE_TRANSFER_OUT', groups))).toBe(
      'UNBALANCED_TRANSACTION',
    );
  });

  it('서로 다른 SKU 의 창고이동이 전역 합계로 상쇄되는 것을 차단한다', () => {
    const groups = groupsOf([
      {
        skuId: SKU_A,
        warehouseId: WAREHOUSE_SOURCE,
        inventoryStatus: 'AVAILABLE',
        quantityDelta: '-40',
      },
      {
        skuId: SKU_B,
        warehouseId: WAREHOUSE_TRANSIT,
        inventoryStatus: 'IN_TRANSIT',
        quantityDelta: '40',
      },
    ]);

    expect(codeOfThrown(() => assertBalancedIfStatusMove('WAREHOUSE_TRANSFER_OUT', groups))).toBe(
      'UNBALANCED_TRANSACTION',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑩ 균형 — 면제 (negative space)
// ═══════════════════════════════════════════════════════════════

describe('균형 검증 면제 — 조립·분해', () => {
  /**
   * `PENDING_v0.3 §5` — 조립·분해는 **전체 합계 0 을 요구하지 않는다.**
   * 실제 "조립지시서 + BOM 기준 검증" 은 R3(세트조립·해체 실행) 소유이며
   * T2-7 에는 그 검증도, 그것을 부를 port 도 없다.
   */
  const ASSEMBLY_TYPES: readonly TransactionType[] = [
    'ASSEMBLY_RECEIPT',
    'ASSEMBLY_CONSUMPTION',
    'DISASSEMBLY_RECEIPT',
    'DISASSEMBLY_CONSUMPTION',
  ];

  it.each(ASSEMBLY_TYPES)('%s — 합계가 0 이 아니어도 균형 오류를 내지 않는다', (type) => {
    // 구성품 3 소진 → 완제품 1 생성. 전체 합계 = −2 이지만 정상이다.
    const groups = groupsOf([
      { skuId: SKU_A, inventoryStatus: 'AVAILABLE', quantityDelta: '-3' },
      { skuId: SKU_B, inventoryStatus: 'AVAILABLE', quantityDelta: '1' },
    ]);

    expect(() => assertBalancedIfStatusMove(type, groups)).not.toThrow();
    expect(() => assertStatusTransitionByNet(type, groups)).not.toThrow();
  });
});

describe('균형 검증 면제 — 일반 입고·출고·조정', () => {
  const GENERAL_TYPES: readonly TransactionType[] = [
    'PURCHASE_RECEIPT',
    'SALES_SHIPMENT',
    'MANUAL_ADJUSTMENT',
    'OPENING_BALANCE',
  ];

  it.each(GENERAL_TYPES)('%s — 균형 검증 대상이 아니다', (type) => {
    const groups = groupsOf([{ inventoryStatus: 'AVAILABLE', quantityDelta: '25' }]);

    expect(() => assertBalancedIfStatusMove(type, groups)).not.toThrow();
    expect(() => assertStatusTransitionByNet(type, groups)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 경계
// ═══════════════════════════════════════════════════════════════

describe('경계', () => {
  it('빈 groups 는 두 검증 모두 통과한다', () => {
    expect(() => assertStatusTransitionByNet('STATUS_CHANGE', [])).not.toThrow();
    expect(() => assertBalancedIfStatusMove('STATUS_CHANGE', [])).not.toThrow();
  });

  it('groups 를 변형하지 않는다', () => {
    const groups = moveGroups('AVAILABLE', 'HOLD');
    const snapshot = groups.map((group) => ({
      status: group.key.inventoryStatus,
      entries: group.entries.length,
    }));

    assertStatusTransitionByNet('STATUS_CHANGE', groups);
    assertBalancedIfStatusMove('STATUS_CHANGE', groups);

    expect(
      groups.map((group) => ({
        status: group.key.inventoryStatus,
        entries: group.entries.length,
      })),
    ).toEqual(snapshot);
  });
});
