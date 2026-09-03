import { describe, expect, it } from 'vitest';

import type { InventoryStatus, TransactionType } from '@/generated/prisma/client';
import { AppError } from '@/shared/errors';

import {
  assertLotExpirySerial,
  assertSerialNetQty,
  type LotExpirySerialContext,
  type LotExpirySerialEntry,
  type SkuTrackingFlags,
} from './lot-expiry-serial';
import { groupByStockKey, normalizeEntries, type StockKeyGroup } from './stock-key';

/**
 * LOT · 유통기한 · 시리얼 검증 (T2-8).
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.5 · §8.12:575·580,
 *    `docs/05_API와_화면설계_v0.2.md` §10.18:351-354,
 *    `docs/07_개발백로그와_테스트전략_v0.2.md:156` — 테스트 유형은 **단위**다.
 *
 * ⛔ 다음은 계약으로 고정하지 않는다 — 정본이 정하지 않았다.
 *    · **규칙 간 판정 순서** — 각 케이스는 위반을 **하나만** 둔다.
 *    · 복수 위반 시 first-error / aggregation semantics
 *    · LOT·시리얼의 trim·대소문자·format
 *    · 유통기한 타임존 변환
 *
 * ⛔ T2-6 정규화(`'-' → ''`) 자체를 다시 테스트하지 않는다 — T2-6 소유다.
 * ⛔ `REVERSAL` 테스트를 만들지 않는다 (**T2-13**).
 * ⛔ 24종 거래유형 matrix 를 만들지 않는다 — 방향 의존 규칙은 `EXPIRED_INBOUND`
 *    하나뿐이다.
 */

// ═══════════════════════════════════════════════════════════════
// fixture
// ═══════════════════════════════════════════════════════════════

const SKU_A = '11111111-1111-4111-8111-111111111111';
const SKU_B = '11111111-1111-4111-8111-111111111112';
const WAREHOUSE_A = '22222222-2222-4222-8222-222222222221';
const LOCATION_A = '33333333-3333-4333-8333-333333333331';
const DEFAULT_LOCATION = '33333333-3333-4333-8333-33333333DEF0';

const OCCURRED_AT = new Date('2026-09-03T04:00:00.000Z');

const NO_TRACKING: SkuTrackingFlags = {
  lotManaged: false,
  expiryManaged: false,
  serialManaged: false,
};

function tracking(overrides: Partial<SkuTrackingFlags> = {}): SkuTrackingFlags {
  return { ...NO_TRACKING, ...overrides };
}

function entry(overrides: Partial<LotExpirySerialEntry> = {}): LotExpirySerialEntry {
  return { lotNo: '', serialNo: '', quantityDelta: '10', ...overrides };
}

function context(overrides: Partial<LotExpirySerialContext> = {}): LotExpirySerialContext {
  return { transactionType: 'PURCHASE_RECEIPT', occurredAt: OCCURRED_AT, ...overrides };
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

/** `docs/03 v0.1:420` 입고 — **정확히 7종.** */
const INBOUND_TYPES: readonly TransactionType[] = [
  'OPENING_BALANCE',
  'PURCHASE_RECEIPT',
  'PRODUCTION_RECEIPT',
  'RETURN_RECEIPT',
  'WAREHOUSE_TRANSFER_IN',
  'ASSEMBLY_RECEIPT',
  'DISASSEMBLY_RECEIPT',
];

// ═══════════════════════════════════════════════════════════════
// ⑦ LOT
// ═══════════════════════════════════════════════════════════════

describe('assertLotExpirySerial — LOT', () => {
  it('lotManaged = true + lotNo = "" → LOT_REQUIRED_MISSING', () => {
    expect(
      codeOfThrown(() => assertLotExpirySerial(tracking({ lotManaged: true }), entry(), context())),
    ).toBe('LOT_REQUIRED_MISSING');
  });

  it('lotManaged = true + lotNo 있음 → 통과', () => {
    expect(() =>
      assertLotExpirySerial(tracking({ lotManaged: true }), entry({ lotNo: 'LOT-A' }), context()),
    ).not.toThrow();
  });

  it('★★ lotManaged = false + lotNo 있음 → LOT_NOT_ALLOWED', () => {
    expect(
      codeOfThrown(() => assertLotExpirySerial(tracking(), entry({ lotNo: 'LOT-A' }), context())),
    ).toBe('LOT_NOT_ALLOWED');
  });

  it('lotManaged = false + lotNo = "" → 통과', () => {
    expect(() => assertLotExpirySerial(tracking(), entry(), context())).not.toThrow();
  });

  it('오류는 422 이고 publicDetails 를 추가하지 않는다', () => {
    try {
      assertLotExpirySerial(tracking({ lotManaged: true }), entry(), context());
      expect.unreachable('LOT 이 없으므로 차단되어야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.httpStatus).toBe(422);
      expect(appError.publicDetails).toBeUndefined();
      expect(appError.message).toBe('LOT 관리 대상 SKU는 LOT 번호가 필요합니다.');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑦ 유통기한
// ═══════════════════════════════════════════════════════════════

describe('assertLotExpirySerial — 유통기한 필수', () => {
  const expiryManaged = tracking({ expiryManaged: true });

  it('expiryManaged = true + expiryDate 없음 → EXPIRY_REQUIRED_MISSING', () => {
    expect(codeOfThrown(() => assertLotExpirySerial(expiryManaged, entry(), context()))).toBe(
      'EXPIRY_REQUIRED_MISSING',
    );
  });

  it('expiryDate = null 도 미지정으로 본다', () => {
    expect(
      codeOfThrown(() =>
        assertLotExpirySerial(expiryManaged, entry({ expiryDate: null }), context()),
      ),
    ).toBe('EXPIRY_REQUIRED_MISSING');
  });

  it('expiryManaged = false → expiryDate 가 없어도 통과한다', () => {
    expect(() => assertLotExpirySerial(tracking(), entry(), context())).not.toThrow();
  });

  /**
   * ⛔ `EXPIRY_NOT_ALLOWED` 규칙은 정본에 **없다.** LOT 만 명시적 거부 규칙을
   *    가지며, 유통기한·시리얼은 그렇지 않다.
   */
  it('★★ expiryManaged = false + expiryDate 있음 → 거부하지 않는다', () => {
    expect(() =>
      assertLotExpirySerial(
        tracking(),
        entry({ expiryDate: new Date('2020-01-01T00:00:00.000Z') }),
        context(),
      ),
    ).not.toThrow();
  });
});

describe('assertLotExpirySerial — 만료 입고', () => {
  const expiryManaged = tracking({ expiryManaged: true });
  const after = new Date(OCCURRED_AT.getTime() + 1);
  const same = new Date(OCCURRED_AT.getTime());
  const before = new Date(OCCURRED_AT.getTime() - 1);

  it('expiryDate > occurredAt → 통과', () => {
    expect(() =>
      assertLotExpirySerial(expiryManaged, entry({ expiryDate: after }), context()),
    ).not.toThrow();
  });

  it('★★ expiryDate == occurredAt → EXPIRED_INBOUND (경계는 차단이다)', () => {
    expect(
      codeOfThrown(() =>
        assertLotExpirySerial(expiryManaged, entry({ expiryDate: same }), context()),
      ),
    ).toBe('EXPIRED_INBOUND');
  });

  it('expiryDate < occurredAt → EXPIRED_INBOUND', () => {
    expect(
      codeOfThrown(() =>
        assertLotExpirySerial(expiryManaged, entry({ expiryDate: before }), context()),
      ),
    ).toBe('EXPIRED_INBOUND');
  });

  it('★★ 입고 7종 전수 — 만료 재고를 차단한다', () => {
    expect(INBOUND_TYPES).toHaveLength(7);
    for (const transactionType of INBOUND_TYPES) {
      expect(
        codeOfThrown(() =>
          assertLotExpirySerial(
            expiryManaged,
            entry({ expiryDate: before }),
            context({ transactionType }),
          ),
        ),
        transactionType,
      ).toBe('EXPIRED_INBOUND');
    }
  });

  it.each(['SALES_SHIPMENT', 'STATUS_CHANGE'] as const)(
    '★★ %s — 입고가 아니므로 만료 규칙을 적용하지 않는다',
    (transactionType) => {
      expect(() =>
        assertLotExpirySerial(
          expiryManaged,
          entry({ expiryDate: before }),
          context({ transactionType }),
        ),
      ).not.toThrow();
    },
  );

  it('expiryManaged = false 면 입고라도 만료 규칙을 적용하지 않는다', () => {
    expect(() =>
      assertLotExpirySerial(tracking(), entry({ expiryDate: before }), context()),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑦ 시리얼 — entry 단위
// ═══════════════════════════════════════════════════════════════

describe('assertLotExpirySerial — 시리얼 (entry 단위)', () => {
  const serialManaged = tracking({ serialManaged: true });
  const withSerial = (quantityDelta: string): LotExpirySerialEntry =>
    entry({ serialNo: 'SERIAL-001', quantityDelta });

  it('serialManaged = true + serialNo = "" → SERIAL_REQUIRED_MISSING', () => {
    expect(
      codeOfThrown(() =>
        assertLotExpirySerial(serialManaged, entry({ quantityDelta: '1' }), context()),
      ),
    ).toBe('SERIAL_REQUIRED_MISSING');
  });

  it.each(['1', '-1', '1.000000', '-1.000000'])('수량 %s → 통과', (quantityDelta) => {
    expect(() =>
      assertLotExpirySerial(serialManaged, withSerial(quantityDelta), context()),
    ).not.toThrow();
  });

  it.each(['2', '-2', '0.5', '-0.5', '10'])('수량 %s → SERIAL_QTY_INVALID', (quantityDelta) => {
    expect(
      codeOfThrown(() =>
        assertLotExpirySerial(serialManaged, withSerial(quantityDelta), context()),
      ),
    ).toBe('SERIAL_QTY_INVALID');
  });

  /**
   * ⛔ `SERIAL_NOT_ALLOWED` 규칙은 정본에 **없다** — `serialManaged = false` 인데
   *    `serialNo` 가 들어와도 그것만으로 거부하지 않는다. 수량 규칙도 적용되지
   *    않는다.
   */
  it('★★ serialManaged = false → serialNo·수량 규칙을 적용하지 않는다', () => {
    expect(() =>
      assertLotExpirySerial(
        tracking(),
        entry({ serialNo: 'SERIAL-001', quantityDelta: '7' }),
        context(),
      ),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// negative space — 세 flag 전부 false
// ═══════════════════════════════════════════════════════════════

describe('assertLotExpirySerial — 추적 미관리 SKU', () => {
  it('lot·expiry·serial 모두 false + 값 없음 → 어떤 규칙도 발동하지 않는다', () => {
    expect(() =>
      assertLotExpirySerial(tracking(), entry({ quantityDelta: '100' }), context()),
    ).not.toThrow();
  });

  /**
   * ★ "flag 가 false 면 어떤 값이든 통과" 는 **사실이 아니다** — `lotNo` 만은
   *   `LOT_NOT_ALLOWED` 로 걸린다. 그래서 negative space 를 LOT 과 나머지로
   *   나눠서 확인한다.
   */
  it('★★ 단, lotNo 만은 예외다 — 값이 있으면 차단된다', () => {
    expect(
      codeOfThrown(() =>
        assertLotExpirySerial(
          tracking(),
          entry({ lotNo: 'LOT-A', serialNo: 'SERIAL-001', quantityDelta: '7' }),
          context(),
        ),
      ),
    ).toBe('LOT_NOT_ALLOWED');
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑦' 시리얼 — 그룹 net 단위
// ═══════════════════════════════════════════════════════════════

describe('assertSerialNetQty — 그룹 net', () => {
  const CONTEXT = { defaultLocationId: DEFAULT_LOCATION };

  interface GroupInput {
    readonly skuId?: string;
    readonly serialNo?: string;
    readonly quantityDelta: string;
  }

  function groupsOf(inputs: readonly GroupInput[]): StockKeyGroup<unknown>[] {
    return groupByStockKey(
      normalizeEntries(
        inputs.map((input) => ({
          skuId: input.skuId ?? SKU_A,
          warehouseId: WAREHOUSE_A,
          locationId: LOCATION_A,
          inventoryStatus: 'AVAILABLE' as InventoryStatus,
          serialNo: input.serialNo ?? 'SERIAL-001',
          quantityDelta: input.quantityDelta,
        })),
        () => CONTEXT,
      ),
    );
  }

  const serialEverywhere = (): SkuTrackingFlags => tracking({ serialManaged: true });

  it.each(['1', '-1'])('net %s → 통과', (quantityDelta) => {
    expect(() => assertSerialNetQty(groupsOf([{ quantityDelta }]), serialEverywhere)).not.toThrow();
  });

  it.each(['2', '-2', '3'])('net %s → SERIAL_NET_QTY_INVALID', (quantityDelta) => {
    expect(
      codeOfThrown(() => assertSerialNetQty(groupsOf([{ quantityDelta }]), serialEverywhere)),
    ).toBe('SERIAL_NET_QTY_INVALID');
  });

  /**
   * ★★ 핵심 케이스 — 개별 entry 는 둘 다 `|1|` 이라 ⑦ 을 통과하지만, 같은
   *    시리얼이 두 번 들어와 net 이 `+2` 가 된다 (`CHANGELOG_v0.2.md:72`).
   */
  it('★★ 같은 시리얼 +1 / +1 → net +2 → 차단', () => {
    const groups = groupsOf([{ quantityDelta: '1' }, { quantityDelta: '1' }]);

    // 그룹은 하나로 합쳐졌고, entry 는 둘 다 살아 있다.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toHaveLength(2);

    expect(codeOfThrown(() => assertSerialNetQty(groups, serialEverywhere))).toBe(
      'SERIAL_NET_QTY_INVALID',
    );
  });

  it('★★ 같은 시리얼 +1 / −1 → net 0 → 통과 (|0| ≤ 1)', () => {
    const groups = groupsOf([{ quantityDelta: '1' }, { quantityDelta: '-1' }]);

    expect(groups).toHaveLength(1);
    expect(() => assertSerialNetQty(groups, serialEverywhere)).not.toThrow();
  });

  it('zero-net 그룹을 제거하지 않는다 (T2-6 계약)', () => {
    const groups = groupsOf([{ quantityDelta: '1' }, { quantityDelta: '-1' }]);
    const before = groups.length;

    assertSerialNetQty(groups, serialEverywhere);

    expect(groups).toHaveLength(before);
    expect(groups[0]?.entries).toHaveLength(2);
  });

  it('다른 시리얼은 별도 그룹이라 각각 판정한다', () => {
    const groups = groupsOf([
      { serialNo: 'SERIAL-001', quantityDelta: '1' },
      { serialNo: 'SERIAL-002', quantityDelta: '1' },
    ]);

    expect(groups).toHaveLength(2);
    expect(() => assertSerialNetQty(groups, serialEverywhere)).not.toThrow();
  });

  it('serialManaged = false 인 SKU 의 그룹은 검사하지 않는다', () => {
    const groups = groupsOf([{ quantityDelta: '5' }]);

    expect(() => assertSerialNetQty(groups, () => tracking())).not.toThrow();
  });

  it('★★ SKU 별로 다른 flag 를 본다 — 시리얼 SKU 만 걸린다', () => {
    const groups = groupsOf([
      { skuId: SKU_A, quantityDelta: '5' },
      { skuId: SKU_B, quantityDelta: '5' },
    ]);

    const onlyBIsSerial = (skuId: string): SkuTrackingFlags =>
      tracking({ serialManaged: skuId === SKU_B });

    expect(codeOfThrown(() => assertSerialNetQty(groups, onlyBIsSerial))).toBe(
      'SERIAL_NET_QTY_INVALID',
    );
    expect(() => assertSerialNetQty(groups, () => tracking())).not.toThrow();
  });

  it('빈 groups 는 통과한다', () => {
    expect(() => assertSerialNetQty([], serialEverywhere)).not.toThrow();
  });

  it('오류는 422 이고 publicDetails 를 추가하지 않는다', () => {
    try {
      assertSerialNetQty(groupsOf([{ quantityDelta: '2' }]), serialEverywhere);
      expect.unreachable('net 이 2 이므로 차단되어야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.httpStatus).toBe(422);
      expect(appError.publicDetails).toBeUndefined();
      expect(appError.message).toBe('동일 시리얼의 순수량은 -1부터 1 사이여야 합니다.');
    }
  });
});
