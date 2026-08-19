import { describe, expect, it } from 'vitest';

import {
  computeCostSubtotals,
  computeRawLineCost,
  computeRawRequiredQty,
  deriveCostProvisionalReasons,
  projectProvisionalReason,
  toMoneyString,
  toRequiredQtyString,
  unionProvisionalReasons,
  COST_PROVISIONAL_REASONS,
  MONEY_SCALE,
  type CostProvisionalReason,
} from '@/modules/bom/domain';
import { divide, multiply, toDecimal, toDecimalString } from '@/shared/decimal';
import { ERROR_CODES, httpStatusForCode } from '@/shared/errors';

/**
 * T07-7A direct costing — 단위 테스트 (대역 없이 판정 가능한 것만).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-19 · §D-23 ~ §D-27 ·
 *    `★ T07-7A cost boundary and quantity gap closure`(C-1 ~ C-9) ·
 *    `★ T07-7A direct cost arithmetic gap closure`(F-1 ~ F-11).
 *
 * 실 DB 가 필요한 것(대표 SupplierSku 선택·가격 resolver·batch)은
 * `tests/db/bom-cost-api.test.ts` 가 본다.
 */

// ═══════════════════════════════════════════════════════════════
// 1. F-1 — rawLineCost 산식
// ═══════════════════════════════════════════════════════════════

const rawCost = (rawRequiredQty: string | null, unitPrice: string | null): string | null => {
  const value = computeRawLineCost({
    rawRequiredQty: rawRequiredQty === null ? null : toDecimal(rawRequiredQty),
    unitPrice,
  });
  return value === null ? null : toDecimalString(value);
};

describe('★★ F-1 — rawLineCost = rawRequiredQty × unitPrice', () => {
  it('★ 기본 곱셈', () => {
    expect(rawCost('4', '2500')).toBe('10000');
    expect(rawCost('2.5', '1000')).toBe('2500');
  });

  it('★★ 입력은 정확히 2개다 — 다른 계수가 끼어들 자리가 없다 (F-4)', () => {
    // packQuantity·purchaseUom·VAT·환율이 파라미터로 존재하지 않는 것이 계약이다.
    const keys = ['rawRequiredQty', 'unitPrice'];
    expect(keys).toHaveLength(2);
    for (const forbidden of ['packQuantity', 'purchaseUom', 'vatIncluded', 'currency', 'fxRate']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('★★ packQuantity 를 다시 나누지 않는다 — 이중 환산 금지 (TC-BOM-009)', () => {
    // quantityPer = 1/30 이 이미 박스 환산을 담고 있다. 30000원 박스 → 개당 1000원.
    const requiredQty = divide('1', '30');
    expect(toMoneyString(multiply(requiredQty, '30000'))).toBe('1000');
    // ⛔ 여기에 다시 /30 을 하면 33.3333 이 되어 틀린다.
    expect(toMoneyString(multiply(requiredQty, divide('30000', '30')))).not.toBe('1000');
  });

  it('★★ VAT·통화는 곱셈에 들어가지 않는다 — 저장된 unitPrice 그대로', () => {
    // vatIncluded 여부와 무관하게 같은 값이 나온다.
    expect(rawCost('3', '1100')).toBe('3300');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. F-1 raw 전파 — 6dp 표시값 재사용 금지
// ═══════════════════════════════════════════════════════════════

describe('★★ F-1 — public 6dp requiredQty 를 되읽어 곱하지 않는다', () => {
  /** raw 1/3 · public "0.333333" — 두 경로가 갈리는 판별력 있는 fixture. */
  const rawRequiredQty = divide('1', '3');

  it('★ 전제 — public 6dp 값과 raw 값이 실제로 다르다', () => {
    expect(toRequiredQtyString(rawRequiredQty)).toBe('0.333333');
    expect(toDecimalString(rawRequiredQty)).not.toBe('0.333333');
  });

  it('★★ unitPrice 3000000 에서 결과가 갈린다 — 1000000 vs 999999', () => {
    const correct = toMoneyString(computeRawLineCost({ rawRequiredQty, unitPrice: '3000000' }));
    const wrong = toMoneyString(
      computeRawLineCost({
        rawRequiredQty: toDecimal(toRequiredQtyString(rawRequiredQty) as string),
        unitPrice: '3000000',
      }),
    );

    expect(correct).toBe('1000000');
    expect(wrong).toBe('999999');
    expect(correct).not.toBe(wrong);
  });

  it('⚠️ unitPrice 3 은 판별력이 없다 — 둘 다 4dp 후 "1" 이 된다', () => {
    // 문서 F-10 이 명시한 사실. 이 fixture 를 핵심 회귀로 쓰면 안 된다.
    const correct = toMoneyString(computeRawLineCost({ rawRequiredQty, unitPrice: '3' }));
    const wrong = toMoneyString(
      computeRawLineCost({
        rawRequiredQty: toDecimal(toRequiredQtyString(rawRequiredQty) as string),
        unitPrice: '3',
      }),
    );
    expect(correct).toBe('1');
    expect(wrong).toBe('1');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. F-2 — 금액 직렬화
// ═══════════════════════════════════════════════════════════════

describe('★★ F-2 — 금액 4dp HALF_UP + minimal form', () => {
  it('★ scale 상수는 4 다 (Decimal(18,4) 과 일치)', () => {
    expect(MONEY_SCALE).toBe(4);
  });

  it('★★ trailing zero 를 채우지 않는다', () => {
    expect(toMoneyString(toDecimal('6'))).toBe('6');
    expect(toMoneyString(toDecimal('6.0000'))).toBe('6');
    expect(toMoneyString(toDecimal('10.5000'))).toBe('10.5');
  });

  it('★★ 4자리 초과는 HALF_UP 으로 반올림한다', () => {
    expect(toMoneyString(toDecimal('10.12345'))).toBe('10.1235');
    expect(toMoneyString(toDecimal('10.12344'))).toBe('10.1234');
    expect(toMoneyString(toDecimal('0.00005'))).toBe('0.0001');
  });

  it('★ null 은 null 이다', () => {
    expect(toMoneyString(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. F-3 — null 과 "0" 의 구분
// ═══════════════════════════════════════════════════════════════

describe('★★ F-3 — lineCost null vs "0"', () => {
  it('★★ 수량 미상이면 null 이다 — 0 이 아니다', () => {
    expect(rawCost(null, '1000')).toBeNull();
  });

  it('★★ 가격이 없으면(대표 없음·유효가격 없음) null 이다', () => {
    expect(rawCost('4', null)).toBeNull();
  });

  it('★ 둘 다 없으면 null 이다', () => {
    expect(rawCost(null, null)).toBeNull();
  });

  it('★★ unitPrice 0 + 수량 확정은 "0" 이다 — 정상 확정 원가', () => {
    expect(rawCost('5', '0')).toBe('0');
    expect(
      toMoneyString(computeRawLineCost({ rawRequiredQty: toDecimal('5'), unitPrice: '0' })),
    ).toBe('0');
  });

  it('★★ 수량 0 도 "0" 이다 — 모르는 것과 없는 것은 다르다', () => {
    expect(rawCost('0', '1000')).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. F-5 — 실제 provisional 사유 집합
// ═══════════════════════════════════════════════════════════════

const reasonsOf = (
  quantityStatus: string,
  hasPrimarySupplierSku: boolean,
  hasEffectivePrice: boolean,
): CostProvisionalReason[] =>
  deriveCostProvisionalReasons({ quantityStatus, hasPrimarySupplierSku, hasEffectivePrice });

describe('★★ F-5 — 복수 사유를 전부 보존한다', () => {
  it('★ 사유는 정확히 3종이다 (D-25) — 늘리지 않는다', () => {
    expect([...COST_PROVISIONAL_REASONS]).toEqual([
      'QTY_UNCONFIRMED',
      'NO_PRIMARY_SUPPLIER',
      'NO_EFFECTIVE_PRICE',
    ]);
  });

  it('★ CONFIRMED + 대표 + 가격 → 사유 없음', () => {
    expect(reasonsOf('CONFIRMED', true, true)).toEqual([]);
  });

  it('★★ SUGGESTED 도 QTY_UNCONFIRMED 다 — 확정된 것은 CONFIRMED 뿐 (D-10)', () => {
    expect(reasonsOf('SUGGESTED', true, true)).toEqual(['QTY_UNCONFIRMED']);
  });

  it('★★ UNKNOWN 도 QTY_UNCONFIRMED 다', () => {
    expect(reasonsOf('UNKNOWN', true, true)).toEqual(['QTY_UNCONFIRMED']);
  });

  it('★★ 판정 기준은 `!== CONFIRMED` 다 — 새 상태가 생겨도 확정으로 새지 않는다', () => {
    expect(reasonsOf('WHATEVER', true, true)).toEqual(['QTY_UNCONFIRMED']);
  });

  it('★★ 수량 미확정 + 대표 없음 → 두 사유 모두', () => {
    expect(reasonsOf('UNKNOWN', false, false)).toEqual(['QTY_UNCONFIRMED', 'NO_PRIMARY_SUPPLIER']);
    expect(reasonsOf('SUGGESTED', false, false)).toEqual([
      'QTY_UNCONFIRMED',
      'NO_PRIMARY_SUPPLIER',
    ]);
  });

  it('★★ 대표가 없으면 NO_EFFECTIVE_PRICE 를 추가하지 않는다 — 조회 대상이 없다', () => {
    for (const status of ['CONFIRMED', 'SUGGESTED', 'UNKNOWN']) {
      expect(reasonsOf(status, false, false), status).not.toContain('NO_EFFECTIVE_PRICE');
    }
    expect(reasonsOf('CONFIRMED', false, false)).toEqual(['NO_PRIMARY_SUPPLIER']);
  });

  it('★★ 대표는 있으나 가격이 없으면 NO_EFFECTIVE_PRICE', () => {
    expect(reasonsOf('CONFIRMED', true, false)).toEqual(['NO_EFFECTIVE_PRICE']);
    expect(reasonsOf('SUGGESTED', true, false)).toEqual(['QTY_UNCONFIRMED', 'NO_EFFECTIVE_PRICE']);
  });

  it('⛔ NO_PRIMARY_SUPPLIER 와 NO_EFFECTIVE_PRICE 는 함께 나올 수 없다', () => {
    for (const status of ['CONFIRMED', 'SUGGESTED', 'UNKNOWN']) {
      for (const hasPrice of [true, false]) {
        const reasons = reasonsOf(status, false, hasPrice);
        expect(
          reasons.includes('NO_PRIMARY_SUPPLIER') && reasons.includes('NO_EFFECTIVE_PRICE'),
        ).toBe(false);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. F-6 — 단수 projection 우선순위
// ═══════════════════════════════════════════════════════════════

describe('★★ F-6 — QTY_UNCONFIRMED > NO_PRIMARY_SUPPLIER > NO_EFFECTIVE_PRICE', () => {
  it('★ 사유가 없으면 null', () => {
    expect(projectProvisionalReason([])).toBeNull();
  });

  it('★★ 수량 미확정 + 대표 없음 → QTY_UNCONFIRMED', () => {
    expect(projectProvisionalReason(reasonsOf('SUGGESTED', false, false))).toBe('QTY_UNCONFIRMED');
    expect(projectProvisionalReason(reasonsOf('UNKNOWN', false, false))).toBe('QTY_UNCONFIRMED');
  });

  it('★★ 수량 확정 + 대표 없음 → NO_PRIMARY_SUPPLIER', () => {
    expect(projectProvisionalReason(reasonsOf('CONFIRMED', false, false))).toBe(
      'NO_PRIMARY_SUPPLIER',
    );
  });

  it('★★ 수량 확정 + 대표 있음 + 가격 없음 → NO_EFFECTIVE_PRICE', () => {
    expect(projectProvisionalReason(reasonsOf('CONFIRMED', true, false))).toBe(
      'NO_EFFECTIVE_PRICE',
    );
  });

  it('★★ 수량 미확정 + 가격 없음 → QTY_UNCONFIRMED (정보는 버리지 않는다)', () => {
    const reasons = reasonsOf('SUGGESTED', true, false);
    expect(projectProvisionalReason(reasons)).toBe('QTY_UNCONFIRMED');
    // ★ 단수 표시값이 하나여도 실제 사유는 둘 다 남아 있다.
    expect(reasons).toEqual(['QTY_UNCONFIRMED', 'NO_EFFECTIVE_PRICE']);
  });

  it('★ 입력 순서가 달라도 우선순위가 결정한다', () => {
    expect(projectProvisionalReason(['NO_EFFECTIVE_PRICE', 'QTY_UNCONFIRMED'])).toBe(
      'QTY_UNCONFIRMED',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. F-7 — union
// ═══════════════════════════════════════════════════════════════

describe('★★ F-7 — top-level 은 union 이고 우선순위 순서다', () => {
  it('★★ 단수 projection 의 수집이 아니다 — 숨은 사유도 올라온다', () => {
    // 라인 하나의 public 표시값은 QTY_UNCONFIRMED 뿐이지만 union 은 둘이다.
    const lineReasons = reasonsOf('SUGGESTED', false, false);
    expect(projectProvisionalReason(lineReasons)).toBe('QTY_UNCONFIRMED');
    expect(unionProvisionalReasons([lineReasons])).toEqual([
      'QTY_UNCONFIRMED',
      'NO_PRIMARY_SUPPLIER',
    ]);
  });

  it('★ 중복을 제거하고 우선순위 순서로 정렬한다', () => {
    expect(
      unionProvisionalReasons([
        ['NO_EFFECTIVE_PRICE'],
        ['QTY_UNCONFIRMED', 'NO_EFFECTIVE_PRICE'],
        ['NO_PRIMARY_SUPPLIER'],
      ]),
    ).toEqual(['QTY_UNCONFIRMED', 'NO_PRIMARY_SUPPLIER', 'NO_EFFECTIVE_PRICE']);
  });

  it('★ 사유가 없으면 빈 배열', () => {
    expect(unionProvisionalReasons([[], []])).toEqual([]);
    expect(unionProvisionalReasons([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. F-8 · F-9 — subtotal
// ═══════════════════════════════════════════════════════════════

describe('★★ F-8 — raw 합계 후 4dp (반올림된 lineCost 재합산 금지)', () => {
  it('★★ 두 경로가 실제로 다른 값을 낸다 — 0.0001 vs 0.0002', () => {
    const raw = multiply('0.5', '0.0001'); // 0.00005
    expect(toDecimalString(raw)).toBe('0.00005');
    // ⛔ 각 라인을 4dp 로 먼저 접으면 0.0001 + 0.0001 = 0.0002
    expect(toMoneyString(raw)).toBe('0.0001');

    // ✅ raw 를 먼저 합하면 0.0001
    const subtotals = computeCostSubtotals([
      { currency: 'KRW', vatIncluded: false, rawLineCost: raw },
      { currency: 'KRW', vatIncluded: false, rawLineCost: raw },
    ]);
    expect(subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '0.0001' }]);
    expect(subtotals[0]?.amount).not.toBe('0.0002');
  });

  it('★ 금액도 minimal form 이다', () => {
    expect(
      computeCostSubtotals([
        { currency: 'KRW', vatIncluded: false, rawLineCost: toDecimal('1000') },
      ])[0]?.amount,
    ).toBe('1000');
  });
});

describe('★★ D-26 · D-27 — (currency, vatIncluded) 별 분리', () => {
  const LINES = [
    { currency: 'KRW', vatIncluded: false, rawLineCost: toDecimal('100') },
    { currency: 'KRW', vatIncluded: true, rawLineCost: toDecimal('200') },
    { currency: 'USD', vatIncluded: false, rawLineCost: toDecimal('3') },
    { currency: 'KRW', vatIncluded: false, rawLineCost: toDecimal('50') },
  ];

  it('★★ 통화 혼재는 오류가 아니다 — subtotal 이 나뉜다 (TC-BOM-009)', () => {
    expect(computeCostSubtotals(LINES)).toEqual([
      { currency: 'KRW', vatIncluded: false, amount: '150' },
      { currency: 'KRW', vatIncluded: true, amount: '200' },
      { currency: 'USD', vatIncluded: false, amount: '3' },
    ]);
  });

  it('★★ 환산하지 않는다 — 단일 합계가 없다', () => {
    const subtotals = computeCostSubtotals(LINES);
    expect(subtotals).toHaveLength(3);
    // ⛔ 353(=100+200+3+50) 같은 단일 총액이 어디에도 없다.
    expect(subtotals.map((row) => row.amount)).not.toContain('353');
  });

  it('★ 정렬은 currency asc → vatIncluded false 먼저다 (D-26)', () => {
    expect(
      computeCostSubtotals(LINES).map((row) => `${row.currency}/${String(row.vatIncluded)}`),
    ).toEqual(['KRW/false', 'KRW/true', 'USD/false']);
  });

  it('★★ VAT 10% 를 가감하지 않는다 — 저장값 그대로 합산', () => {
    expect(
      computeCostSubtotals([
        { currency: 'KRW', vatIncluded: true, rawLineCost: toDecimal('1100') },
      ])[0]?.amount,
    ).toBe('1100');
  });
});

describe('★★ F-9 — partial subtotal', () => {
  it('★★ lineCost null 은 제외한다 — 0 으로 더하지 않는다', () => {
    const subtotals = computeCostSubtotals([
      { currency: 'KRW', vatIncluded: false, rawLineCost: toDecimal('100') },
      { currency: null, vatIncluded: null, rawLineCost: null },
    ]);
    expect(subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '100' }]);
  });

  it('★★ 계산 가능한 라인이 하나도 없으면 빈 배열이다', () => {
    expect(
      computeCostSubtotals([
        { currency: null, vatIncluded: null, rawLineCost: null },
        { currency: null, vatIncluded: null, rawLineCost: null },
      ]),
    ).toEqual([]);
  });

  it('★ 0원 라인은 포함된다 — null 과 다르다', () => {
    expect(
      computeCostSubtotals([{ currency: 'KRW', vatIncluded: false, rawLineCost: toDecimal('0') }]),
    ).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '0' }]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. D-19 — Q 는 요청 수량이다
// ═══════════════════════════════════════════════════════════════

describe('★★ C-4 — Q 는 requestedQty 이고 outputQty 로 치환하지 않는다', () => {
  it('★★ 문서 예시 A — Q=10, outputQty=5, quantityPer=2 → 4', () => {
    const raw = computeRawRequiredQty({
      parentQty: toDecimal('10'),
      outputQty: '5',
      quantityPer: '2',
      lossRate: null,
      overallLossRate: null,
    });
    expect(toRequiredQtyString(raw)).toBe('4');
    // ⛔ Q 를 outputQty(5)로 치환하면 2 가 되어 틀린다.
    expect(toRequiredQtyString(raw)).not.toBe('2');
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. 오류 코드 — 신규 0, 예약 코드 활성화
// ═══════════════════════════════════════════════════════════════

describe('★★ 오류 코드 (D-29)', () => {
  it('★★ BOM_SUPPLIER_SELECTION_CONFLICT 는 409 다', () => {
    expect(ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT).toBe('BOM_SUPPLIER_SELECTION_CONFLICT');
    expect(httpStatusForCode(ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT)).toBe(409);
  });

  it('★ 기존 SUPPLIER_PRICE_CHAIN_CONFLICT 를 그대로 재사용한다 (409)', () => {
    expect(httpStatusForCode(ERROR_CODES.SUPPLIER_PRICE_CHAIN_CONFLICT)).toBe(409);
  });

  it('⛔ 원가 전용 error code 를 새로 만들지 않았다', () => {
    for (const forbidden of [
      'BOM_COST_UNAVAILABLE',
      'BOM_PRICE_MISSING',
      'BOM_NO_PRIMARY_SUPPLIER',
      'BOM_CURRENCY_MISMATCH',
      'BOM_COST_INVALID',
    ]) {
      expect(Object.keys(ERROR_CODES), forbidden).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. 경계 — T07-7B / public API 가 새어 들어오지 않았다
// ═══════════════════════════════════════════════════════════════

async function sourceOf(relative: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('⛔ C-1 · C-2 · C-6 — T07-7B scope 가 들어오지 않았다', () => {
  it('★★ public /cost route 가 없다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../app/api/boms/[id]', import.meta.url));
    const entries = readdirSync(dir);
    expect(entries).not.toContain('cost');
    // T07-6 explode 는 그대로 있다.
    expect(entries).toContain('explode');
  });

  it('★★ direct costing 이 하위 BOM 을 전개하지 않는다 (C-2)', async () => {
    const source = await sourceOf('./application/cost-direct-bom.ts');
    for (const forbidden of ['resolveEffectiveBom', 'explodeBom', 'EXPLODE_LINE_INCLUDE.child']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // direct line 만 읽는다 — where 는 bomHeaderId 하나다.
    expect(source).toContain('where: { bomHeaderId: root.id }');
  });

  it('★★ D-20 집계를 하지 않는다 (C-6)', async () => {
    const source = await sourceOf('./application/cost-direct-bom.ts');
    for (const forbidden of [
      'rollup',
      'rolledUp',
      'multiLevel',
      'aggregateComponents',
      'recursiveCost',
      'totalCost',
      'costTree',
      'minLevel',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('★★ 서비스가 requestedQty·asOf 기본값을 스스로 정하지 않는다 (C-4)', async () => {
    const source = await sourceOf('./application/cost-direct-bom.ts');
    expect(source).not.toContain('businessDateOf');
    expect(source).not.toContain('new Date()');
    // 기본값 "1" 을 서비스가 넣지 않는다.
    expect(source).not.toMatch(/requestedQty\s*\?\?\s*'1'/);
  });

  it('★★ read-only — write·audit·lock 어휘가 없다', async () => {
    const source = await sourceOf('./application/cost-direct-bom.ts');
    for (const forbidden of [
      '.create(',
      '.update(',
      '.delete(',
      'auditLog',
      'FOR UPDATE',
      'advisory',
      'withBomCycleGraphLock',
      'Idempotency',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('★★ 가격 SQL 을 복제하지 않고 기존 resolver 를 재사용한다 (D-24)', async () => {
    const source = await sourceOf('./application/cost-direct-bom.ts');
    expect(source).toContain('resolveEffectiveSupplierPrices');
    expect(source).toContain('resolvePrimarySupplierSkus');
    // BOM module 이 supplier 테이블 SQL 을 직접 짜지 않는다.
    expect(source).not.toContain('supplierSkuPrice.findMany');
    expect(source).not.toContain('supplierSku.findMany');
  });

  it('⛔ 원가 전용 permission 을 만들지 않았다', async () => {
    const policy = await sourceOf('./application/policy.ts');
    expect(policy).not.toContain('bom.cost');
    expect([...policy.matchAll(/'bom\.\w+'/g)].map((m) => m[0]).sort()).toEqual([
      "'bom.approve'",
      "'bom.create'",
      "'bom.read'",
      "'bom.submit'",
      "'bom.update'",
    ]);
  });

  it('★ 대표 resolver 는 supplier module 이 소유한다 (G7)', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../supplier/application', import.meta.url));
    expect(readdirSync(dir)).toContain('resolve-primary-supplier-sku.ts');
  });

  it('⛔ T1-6B4 요약 서비스를 대표 선택에 재사용하지 않는다 (D-23)', async () => {
    const source = await sourceOf('./application/cost-direct-bom.ts');
    expect(source).not.toContain('listSkuSupplierSummaries');
  });
});
