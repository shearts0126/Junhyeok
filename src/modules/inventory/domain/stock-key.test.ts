import { describe, expect, it } from 'vitest';

import { isZero, toDecimalString } from '@/shared/decimal';

import {
  DEFAULT_OWNER_CODE,
  EMPTY_SENTINEL,
  expiryKeySentinel,
  groupByStockKey,
  hashStockKey,
  netQuantityDelta,
  normalizeEntries,
  normalizeStockKey,
  type NormalizedEntry,
  type StockKey,
  type StockKeyDraft,
} from './stock-key';

/**
 * 재고키 정규화 · 해시 · 그룹화 (T2-6).
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.1 · §8.5 · §8.12,
 *    `docs/07_개발백로그와_테스트전략_v0.2.md:154` — 테스트 유형은 **단위**이며
 *    완료조건은 *"그룹화 단위 테스트 전수"* 다.
 *
 * ⛔ 다음은 계약으로 고정하지 않는다 — 정본이 정하지 않았다.
 *    · **group 반환 순서** (`groups[0]` 이 무엇인지, hash 정렬 여부)
 *    · **구분자의 정확한 문자** — 직렬화 결과 문자열을 assert 하지 않는다.
 *      계약은 "재고키 값에 등장할 수 없는 문자" 라는 **성질**이다.
 *    · `trim` · 대소문자 정규화 (lotNo/serialNo/ownerCode/UUID 전부)
 *    · `ownerCode` 의 `''`·`'-'` 처리 — 정본은 null/undefined 2종만 규정한다
 *    · metadata 병합 규칙
 */

// ═══════════════════════════════════════════════════════════════
// fixture
// ═══════════════════════════════════════════════════════════════

const SKU_A = '11111111-1111-4111-8111-111111111111';
const SKU_B = '11111111-1111-4111-8111-111111111112';
const WAREHOUSE_A = '22222222-2222-4222-8222-222222222221';
const WAREHOUSE_B = '22222222-2222-4222-8222-222222222222';
const LOCATION_A = '33333333-3333-4333-8333-333333333331';
const LOCATION_B = '33333333-3333-4333-8333-333333333332';
const DEFAULT_LOCATION = '33333333-3333-4333-8333-33333333DEF0';

const CONTEXT = { defaultLocationId: DEFAULT_LOCATION };

/** 정규화 입력 — 재고키 후보 + 수량 + 비키 metadata. */
interface TestEntry extends StockKeyDraft {
  readonly quantityDelta: string;
  readonly note?: string;
  readonly channelId?: string;
  readonly manufacturedDate?: Date;
}

function draft(overrides: Partial<TestEntry> = {}): TestEntry {
  return {
    skuId: SKU_A,
    warehouseId: WAREHOUSE_A,
    locationId: LOCATION_A,
    inventoryStatus: 'AVAILABLE',
    quantityDelta: '10',
    ...overrides,
  };
}

/** 정규화된 재고키 하나 만들기 — grouping 테스트용. */
function normalized(overrides: Partial<TestEntry> = {}): NormalizedEntry<TestEntry> {
  return normalizeEntries([draft(overrides)], () => CONTEXT)[0]!;
}

/** 8열 전부가 명시된 재고키. */
function key(overrides: Partial<StockKey> = {}): StockKey {
  return {
    skuId: SKU_A,
    warehouseId: WAREHOUSE_A,
    locationId: LOCATION_A,
    inventoryStatus: 'AVAILABLE',
    lotNo: EMPTY_SENTINEL,
    expiryKey: expiryKeySentinel(),
    serialNo: EMPTY_SENTINEL,
    ownerCode: DEFAULT_OWNER_CODE,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// 정규화 — docs/04 §8.5
// ═══════════════════════════════════════════════════════════════

describe('T2-6 정규화 — locationId', () => {
  it('1. ★★ 미지정(null)이면 창고 DEFAULT 로케이션이 된다', () => {
    expect(normalizeStockKey(draft({ locationId: null }), CONTEXT).locationId).toBe(
      DEFAULT_LOCATION,
    );
  });

  it('2. ★★ 미지정(undefined)도 같은 "미지정" 이다', () => {
    // 정본은 `null` 만 적었으나 실제 입력 타입이 `locationId?` 라 생략 시
    // `undefined` 가 온다. 같은 의도로 처리한다.
    expect(normalizeStockKey(draft({ locationId: undefined }), CONTEXT).locationId).toBe(
      DEFAULT_LOCATION,
    );
  });

  it('3. 지정하면 그대로 쓴다', () => {
    expect(normalizeStockKey(draft({ locationId: LOCATION_B }), CONTEXT).locationId).toBe(
      LOCATION_B,
    );
  });
});

describe('T2-6 정규화 — lotNo', () => {
  it('4. ★★ null · undefined · "" · "-" 4종이 전부 "" 가 된다', () => {
    for (const input of [null, undefined, '', '-'] as const) {
      expect(normalizeStockKey(draft({ lotNo: input }), CONTEXT).lotNo, String(input)).toBe(
        EMPTY_SENTINEL,
      );
    }
  });

  it('5. 그 외 문자열은 그대로다 — trim·대소문자 변환 없음', () => {
    // ⛔ 정본에 trim/case 규칙이 없다. 있는 그대로 보존한다.
    for (const input of ['LOT1', ' LOT1 ', 'lot1', '--']) {
      expect(normalizeStockKey(draft({ lotNo: input }), CONTEXT).lotNo, input).toBe(input);
    }
  });
});

describe('T2-6 정규화 — serialNo', () => {
  it('6. ★★ null · undefined · "" · "-" 4종이 전부 "" 가 된다', () => {
    for (const input of [null, undefined, '', '-'] as const) {
      expect(normalizeStockKey(draft({ serialNo: input }), CONTEXT).serialNo, String(input)).toBe(
        EMPTY_SENTINEL,
      );
    }
  });

  it('7. 그 외 문자열은 그대로다', () => {
    for (const input of ['SN-1', ' SN-1 ', 'sn-1']) {
      expect(normalizeStockKey(draft({ serialNo: input }), CONTEXT).serialNo, input).toBe(input);
    }
  });
});

describe('T2-6 정규화 — ownerCode', () => {
  it('8. ★★ null · undefined 2종만 DEEPPOINT 가 된다', () => {
    for (const input of [null, undefined] as const) {
      expect(normalizeStockKey(draft({ ownerCode: input }), CONTEXT).ownerCode, String(input)).toBe(
        DEFAULT_OWNER_CODE,
      );
    }
  });

  it('9. ★★ "" 와 "-" 는 default 되지 않는다 — lotNo 규칙을 확장하지 않는다', () => {
    // 정본(`docs/04 §8.5`)은 ownerCode 에 대해 null/undefined 만 규정한다.
    expect(normalizeStockKey(draft({ ownerCode: '' }), CONTEXT).ownerCode).toBe('');
    expect(normalizeStockKey(draft({ ownerCode: '-' }), CONTEXT).ownerCode).toBe('-');
  });

  it('10. 지정한 소유자는 그대로다', () => {
    expect(normalizeStockKey(draft({ ownerCode: 'OLIVE' }), CONTEXT).ownerCode).toBe('OLIVE');
  });
});

describe('T2-6 정규화 — expiryKey', () => {
  it('11. ★★ expiryDate 가 있으면 그 값이 expiryKey 다', () => {
    const expiryDate = new Date('2026-12-31T00:00:00.000Z');
    expect(normalizeStockKey(draft({ expiryDate }), CONTEXT).expiryKey.toISOString()).toBe(
      '2026-12-31T00:00:00.000Z',
    );
  });

  it('12. ★★ 없으면 센티넬 9999-12-31 이다', () => {
    for (const input of [null, undefined] as const) {
      expect(
        normalizeStockKey(draft({ expiryDate: input }), CONTEXT).expiryKey.toISOString(),
        String(input),
      ).toBe('9999-12-31T00:00:00.000Z');
    }
  });

  it('13. ★ 센티넬은 호출마다 새 인스턴스다 — 공유 가변 Date 를 돌려주지 않는다', () => {
    const first = expiryKeySentinel();
    const second = expiryKeySentinel();
    expect(first).not.toBe(second);
    expect(first.toISOString()).toBe(second.toISOString());

    first.setUTCFullYear(2000);
    expect(expiryKeySentinel().toISOString()).toBe('9999-12-31T00:00:00.000Z');
  });
});

describe('T2-6 정규화 — 경계', () => {
  it('14. ★★ 입력 객체를 변형하지 않는다 — 새 객체를 반환한다', () => {
    const input = draft({ lotNo: '-', ownerCode: null, locationId: null });
    const before = JSON.stringify(input);

    normalizeStockKey(input, CONTEXT);
    normalizeEntries([input], () => CONTEXT);

    expect(JSON.stringify(input)).toBe(before);
  });

  it('15. ★ 비키 metadata 는 재고키에 들어가지 않는다', () => {
    const result = normalizeStockKey(
      draft({
        note: 'memo',
        channelId: '44444444-4444-4444-8444-444444444441',
        manufacturedDate: new Date('2026-01-01T00:00:00.000Z'),
      }),
      CONTEXT,
    );

    // StockKey 는 정확히 8열이다.
    expect(Object.keys(result).sort()).toEqual([
      'expiryKey',
      'inventoryStatus',
      'locationId',
      'lotNo',
      'ownerCode',
      'serialNo',
      'skuId',
      'warehouseId',
    ]);
  });

  it('16. ★ 정규화된 entry 는 원본 metadata 를 보존한다', () => {
    const manufacturedDate = new Date('2026-01-01T00:00:00.000Z');
    const entry = normalized({ note: 'memo', manufacturedDate, expiryDate: null });

    expect(entry.note).toBe('memo');
    expect(entry.manufacturedDate).toBe(manufacturedDate);
    expect(entry.quantityDelta).toBe('10');
    // 표시용 원본 expiryDate 도 남는다 — expiryKey 와 별개다.
    expect(entry.expiryDate).toBeNull();
    expect(entry.expiryKey.toISOString()).toBe('9999-12-31T00:00:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════════════
// lineNo
// ═══════════════════════════════════════════════════════════════

describe('T2-6 lineNo', () => {
  it('17. ★★ 1-based 원본 순서다 — index 0 → 1', () => {
    const entries = normalizeEntries(
      [draft({ lotNo: 'A' }), draft({ lotNo: 'B' }), draft({ lotNo: 'C' })],
      () => CONTEXT,
    );

    expect(entries.map((entry) => entry.lineNo)).toEqual([1, 2, 3]);
    // 원본 순서가 보존된다.
    expect(entries.map((entry) => entry.lotNo)).toEqual(['A', 'B', 'C']);
  });

  it('18. ★★ lineNo 는 재고키가 아니다 — 같은 재고키의 다른 lineNo 는 한 그룹이다', () => {
    const entries = normalizeEntries([draft(), draft()], () => CONTEXT);

    expect(entries.map((entry) => entry.lineNo)).toEqual([1, 2]);
    expect(hashStockKey(entries[0]!)).toBe(hashStockKey(entries[1]!));
    expect(groupByStockKey(entries)).toHaveLength(1);
  });

  it('19. ★ 창고마다 다른 기본 로케이션이 적용된다', () => {
    const entries = normalizeEntries(
      [
        draft({ warehouseId: WAREHOUSE_A, locationId: null }),
        draft({ warehouseId: WAREHOUSE_B, locationId: null }),
      ],
      (entry) => ({
        defaultLocationId: entry.warehouseId === WAREHOUSE_A ? LOCATION_A : LOCATION_B,
      }),
    );

    expect(entries[0]!.locationId).toBe(LOCATION_A);
    expect(entries[1]!.locationId).toBe(LOCATION_B);
  });
});

// ═══════════════════════════════════════════════════════════════
// 해시
// ═══════════════════════════════════════════════════════════════

describe('T2-6 hashStockKey', () => {
  it('20. ★★ 같은 재고키는 같은 해시다 (결정적)', () => {
    expect(hashStockKey(key())).toBe(hashStockKey(key()));
    // 속성 삽입 순서가 달라도 같다 — 필드 배열이 코드로 고정되어 있다.
    const reordered: StockKey = {
      ownerCode: DEFAULT_OWNER_CODE,
      serialNo: EMPTY_SENTINEL,
      expiryKey: expiryKeySentinel(),
      lotNo: EMPTY_SENTINEL,
      inventoryStatus: 'AVAILABLE',
      locationId: LOCATION_A,
      warehouseId: WAREHOUSE_A,
      skuId: SKU_A,
    };
    expect(hashStockKey(reordered)).toBe(hashStockKey(key()));
  });

  it('21. ★★ 8열 각각이 하나만 달라도 해시가 달라진다', () => {
    const base = hashStockKey(key());
    const variants: Partial<StockKey>[] = [
      { skuId: SKU_B },
      { warehouseId: WAREHOUSE_B },
      { locationId: LOCATION_B },
      { inventoryStatus: 'HOLD' },
      { lotNo: 'LOT1' },
      { expiryKey: new Date('2026-12-31T00:00:00.000Z') },
      { serialNo: 'SN-1' },
      { ownerCode: 'OLIVE' },
    ];

    expect(variants).toHaveLength(8);
    for (const variant of variants) {
      expect(hashStockKey(key(variant)), Object.keys(variant)[0]).not.toBe(base);
    }
  });

  it('22. ★★ 문서 사례 — "AB"+"C" 와 "A"+"BC" 가 충돌하지 않는다', () => {
    // docs/04 §8.12: 단순 문자열 결합은 lotNo='AB'+serialNo='C' 와
    // lotNo='A'+serialNo='BC' 가 같은 문자열이 되어 서로 다른 재고키가 합쳐진다.
    const left = hashStockKey(key({ lotNo: 'AB', serialNo: 'C' }));
    const right = hashStockKey(key({ lotNo: 'A', serialNo: 'BC' }));

    expect(left).not.toBe(right);
    // 실제로 다른 그룹이 된다.
    expect(
      groupByStockKey([
        normalized({ lotNo: 'AB', serialNo: 'C' }),
        normalized({ lotNo: 'A', serialNo: 'BC' }),
      ]),
    ).toHaveLength(2);
  });

  it('23. ★★ expiryKey 는 date-only 로 직렬화된다 — 같은 날의 다른 시각은 같은 그룹', () => {
    // `@db.Date` identity 와 맞춘다. 시각 성분이 섞이면 같은 날짜가 갈라진다.
    const midnight = hashStockKey(key({ expiryKey: new Date('2026-12-31T00:00:00.000Z') }));
    const noon = hashStockKey(key({ expiryKey: new Date('2026-12-31T12:34:56.789Z') }));

    expect(midnight).toBe(noon);
  });

  it('24. ★ 반환은 문자열이며 8개 값을 모두 담는다', () => {
    // ⛔ 정확한 구분자·직렬화 결과를 assert 하지 않는다 — internal detail 이다.
    const hash = hashStockKey(key({ lotNo: 'LOT1', serialNo: 'SN-1', ownerCode: 'OLIVE' }));

    expect(typeof hash).toBe('string');
    for (const part of [SKU_A, WAREHOUSE_A, LOCATION_A, 'AVAILABLE', 'LOT1', 'SN-1', 'OLIVE']) {
      expect(hash, part).toContain(part);
    }
    expect(hash).toContain('9999-12-31');
  });
});

// ═══════════════════════════════════════════════════════════════
// netQuantityDelta
// ═══════════════════════════════════════════════════════════════

describe('T2-6 netQuantityDelta', () => {
  it('25. ★★ 같은 재고키 수량을 합산한다 — −6 / +3 → −3', () => {
    expect(
      toDecimalString(netQuantityDelta([{ quantityDelta: '-6' }, { quantityDelta: '3' }])),
    ).toBe('-3');
  });

  it('26. ★★ −50 / +50 → 0', () => {
    expect(isZero(netQuantityDelta([{ quantityDelta: '-50' }, { quantityDelta: '50' }]))).toBe(
      true,
    );
  });

  it('27. ★★ Decimal 정밀도가 유지된다 — Number 변환이 없다', () => {
    // 1/30 계열: 0.033333 을 3번 더하면 0.099999 다. float 이면 0.09999900000000001.
    expect(
      toDecimalString(
        netQuantityDelta([
          { quantityDelta: '0.033333' },
          { quantityDelta: '0.033333' },
          { quantityDelta: '0.033333' },
        ]),
      ),
    ).toBe('0.099999');
  });

  it('28. 빈 목록은 0 이다', () => {
    expect(isZero(netQuantityDelta([]))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// groupByStockKey
// ═══════════════════════════════════════════════════════════════

describe('T2-6 groupByStockKey', () => {
  it('29. ★★ 같은 재고키는 한 그룹이다 — 중복은 오류가 아니다 (C-13)', () => {
    const groups = groupByStockKey([
      normalized({ quantityDelta: '-6' }),
      normalized({ quantityDelta: '-6' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(2);
    expect(toDecimalString(groups[0]!.netQuantityDelta)).toBe('-12');
  });

  it('30. ★★ 8열 각각이 다르면 별도 그룹이다', () => {
    const variants: Partial<TestEntry>[] = [
      { skuId: SKU_B },
      { warehouseId: WAREHOUSE_B },
      { locationId: LOCATION_B },
      { inventoryStatus: 'HOLD' },
      { lotNo: 'LOT1' },
      { expiryDate: new Date('2026-12-31T00:00:00.000Z') },
      { serialNo: 'SN-1' },
      { ownerCode: 'OLIVE' },
    ];

    expect(variants).toHaveLength(8);
    for (const variant of variants) {
      const groups = groupByStockKey([normalized(), normalized(variant)]);
      expect(groups, Object.keys(variant)[0]).toHaveLength(2);
    }
  });

  it('31. ★★ 정규화 동치 — lotNo null 과 "" 는 같은 그룹이다', () => {
    // 정규화가 그룹화보다 먼저 실행되지 않으면 여기서 2개로 갈라진다.
    const groups = groupByStockKey([
      normalized({ lotNo: null }),
      normalized({ lotNo: '' }),
      normalized({ lotNo: '-' }),
      normalized({ lotNo: undefined }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(4);
  });

  it('32. ★★ 지정 locationId 와 기본 로케이션 치환 결과가 같으면 한 그룹이다', () => {
    const groups = groupByStockKey([
      normalizeEntries([draft({ locationId: null })], () => ({
        defaultLocationId: LOCATION_A,
      }))[0]!,
      normalized({ locationId: LOCATION_A }),
    ]);

    expect(groups).toHaveLength(1);
  });

  it('33. ★★ 비키 metadata 가 달라도 같은 그룹이고, entry 는 각각 남는다', () => {
    const groups = groupByStockKey([normalized({ note: 'A' }), normalized({ note: 'B' })]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(2);
    // ★ 원본 사실 단위가 보존된다 — 합쳐지지 않는다.
    expect(groups[0]!.entries.map((entry) => entry.note)).toEqual(['A', 'B']);
  });

  it('34. ★★ net = 0 그룹도 제거하지 않는다', () => {
    // docs/04:753 — "netQuantityDelta 가 0인 그룹도 제거하지 않는다."
    // ⛔ PENDING_v0.3 §4(net=0 시 balance 미갱신)는 T2-9 의 정책이며 별개다.
    const groups = groupByStockKey([
      normalized({ quantityDelta: '-50' }),
      normalized({ quantityDelta: '50' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(2);
    expect(isZero(groups[0]!.netQuantityDelta)).toBe(true);
  });

  it('35. ★ 그룹은 정확히 4필드다 — 후속 task 값이 미리 들어 있지 않다', () => {
    const [group] = groupByStockKey([normalized()]);

    expect(Object.keys(group!).sort()).toEqual(['entries', 'hash', 'key', 'netQuantityDelta']);
    for (const future of [
      'currentBalance',
      'balanceAfter',
      'lockVersion',
      'lastTransactionId',
      'transition',
      'exception',
    ]) {
      expect(group!, future).not.toHaveProperty(future);
    }
  });

  it('36. ★ group.key 와 group.hash 가 서로 일치한다', () => {
    const groups = groupByStockKey([normalized({ lotNo: 'LOT1' }), normalized({ lotNo: 'LOT2' })]);

    for (const group of groups) {
      expect(hashStockKey(group.key)).toBe(group.hash);
    }
  });

  it('37. ★ 여러 재고키가 섞여도 각자 합산된다', () => {
    // docs/04 §8.6 검증 사례: 「10 | K −5, L −5 → K 는 통과, L 은 L 잔량으로 별도 판정」
    const groups = groupByStockKey([
      normalized({ lotNo: 'K', quantityDelta: '-5' }),
      normalized({ lotNo: 'L', quantityDelta: '-5' }),
      normalized({ lotNo: 'K', quantityDelta: '-2' }),
    ]);

    expect(groups).toHaveLength(2);
    const byLot = new Map(groups.map((group) => [group.key.lotNo, group]));
    expect(toDecimalString(byLot.get('K')!.netQuantityDelta)).toBe('-7');
    expect(toDecimalString(byLot.get('L')!.netQuantityDelta)).toBe('-5');
  });

  it('38. 빈 입력은 빈 그룹이다', () => {
    expect(groupByStockKey([])).toEqual([]);
  });

  // ⛔ 반환 순서를 계약으로 고정하지 않는다 (`groups[0]` 이 무엇인지 · hash 정렬 ·
  //    재고키 정렬). 정본이 순서를 규정하지 않았고, 잠금 순서 정렬은 T2-9 소유다.
  //    위 테스트들은 전부 길이·해시·key 로 찾아서 검증한다.
});
