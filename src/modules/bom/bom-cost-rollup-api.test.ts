import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import { BOM_READ_PERMISSION, parseCostBomQuery } from '@/modules/bom/application';
import {
  compareCodePoint,
  compareCostComponents,
  computeCostSubtotals,
  deriveTerminalCostReasons,
  sumKnownDecimals,
  toRequiredQtyString,
  BOM_MAX_LEVEL,
} from '@/modules/bom/domain';
import { toDecimal, toDecimalString } from '@/shared/decimal';

/**
 * T07-7B multi-level cost roll-up — 단위 테스트 (대역 없이 판정 가능한 것만).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-14(`CostResult`) · §D-15 · §D-20 ·
 *    `★ T07-7B multi-level roll-up gap closure`(R-1 ~ R-23).
 *
 * 실 DB 가 필요한 것(traversal · terminal 판정 · resolver · 집계)은
 * `tests/db/bom-cost-rollup-api.test.ts` 가 본다.
 */

const BOM = '11111111-1111-4111-8111-111111111111';

// ═══════════════════════════════════════════════════════════════
// 1. query 계약 — 정확히 2개 (R-23 G12)
// ═══════════════════════════════════════════════════════════════

const q = (search: string) => parseCostBomQuery(new URLSearchParams(search));

describe('★★ GET /cost query — qty? · asOf? 정확히 2개', () => {
  it('★ 빈 쿼리는 qty="1" 이고 asOf 는 없다 (route 가 업무일자로 채운다)', () => {
    expect(q('')).toEqual({ qty: '1' });
  });

  it('★ 둘 다 주면 그대로 통과한다', () => {
    expect(q('qty=10&asOf=2026-06-01')).toEqual({ qty: '10', asOf: '2026-06-01' });
  });

  it('★★ maxLevel 은 public query 가 아니다 — 400 이다', () => {
    // ⛔ 깊이는 공유 상수 고정이며 client 가 정하지 않는다 (R-23 G12).
    expect(() => q('maxLevel=3')).toThrow();
  });

  it('★★ 공급처·가격 override 쿼리를 받지 않는다 — 전부 400', () => {
    // ⛔ D-23 선택을 client 가 뒤집을 수 없다.
    for (const bad of [
      'supplierId=x',
      'supplierSkuId=x',
      'priceId=x',
      'currency=USD',
      'vatIncluded=true',
      'level=2',
      'foo=1',
    ]) {
      expect(() => q(bad), bad).toThrow();
    }
  });

  it('★ qty 0 · 음수 · 7dp · 지수 · 콤마는 400 이다', () => {
    for (const bad of ['qty=0', 'qty=-1', 'qty=0.0000001', 'qty=1e3', 'qty=1,000', 'qty=']) {
      expect(() => q(bad), bad).toThrow();
    }
  });

  it('★ qty 6dp 는 통과한다 (T07-6 parser 재사용)', () => {
    expect(q('qty=0.000001').qty).toBe('0.000001');
  });

  it('★★ asOf 는 실존 달력 날짜여야 한다 — rollover 금지', () => {
    expect(q('asOf=2028-02-29').asOf).toBe('2028-02-29');
    expect(q('asOf=2026-02-28').asOf).toBe('2026-02-28');
    for (const bad of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01']) {
      expect(() => q(`asOf=${bad}`), bad).toThrow();
    }
  });

  it('★ asOf 형식 오류도 400 이다', () => {
    for (const bad of ['2026-6-1', '20260601', 'today', '2026-06-01T00:00:00Z']) {
      expect(() => q(`asOf=${bad}`), bad).toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. R-8·R-10 — known 값만 raw 로 합산
// ═══════════════════════════════════════════════════════════════

const sum = (...values: (string | null)[]) =>
  sumKnownDecimals(values.map((value) => (value === null ? null : toDecimal(value))));

describe('★★ R-8·R-10 — sumKnownDecimals 는 known partial sum 이다', () => {
  it('★ 전부 known 이면 단순 합이다', () => {
    expect(toDecimalString(sum('3', '4') as never)).toBe('7');
  });

  it('★★ known + null 혼합이면 known 만 더한다 — null 을 0 으로 보지 않는다', () => {
    // "3 + (모름)" 은 3 이 아니라 **"확정 가능한 부분이 3"** 이라는 뜻이다.
    expect(toDecimalString(sum('3', null) as never)).toBe('3');
    expect(toDecimalString(sum(null, '3', null, '4') as never)).toBe('7');
  });

  it('★★ 전부 null 이면 null 이다 — 0 이 아니다', () => {
    expect(sum(null, null)).toBeNull();
    expect(sum()).toBeNull();
  });

  it('★★ 0 은 known 이다 — null 과 섞이지 않는다', () => {
    expect(toDecimalString(sum('0', null) as never)).toBe('0');
  });

  it('★★ raw 로 먼저 더한다 — 6dp 로 자른 뒤 더한 것과 값이 갈린다', () => {
    // ★ 판별력 있는 fixture: 같은 세 occurrence 를 두 경로로 합산한다.
    const third = toDecimal('1').div(3);

    // ✅ raw 합 후 6dp — 0.9999…9(60 자리) 를 반올림하면 "1" 이다.
    const rawPath = toRequiredQtyString(sumKnownDecimals([third, third, third]));

    // ⛔ 각 occurrence 를 6dp 로 먼저 자른 뒤 합하면 0.999999 다.
    const roundedFirst = toRequiredQtyString(
      sumKnownDecimals(
        [third, third, third].map((value) => toDecimal(toRequiredQtyString(value) as string)),
      ),
    );

    expect(rawPath).toBe('1');
    expect(roundedFirst).toBe('0.999999');
    // 두 경로가 **실제로 다른 값**을 낸다 — 그래서 순서가 계약이다 (R-8).
    expect(rawPath).not.toBe(roundedFirst);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. R-12·R-13 — terminal 사유 (경로 상속)
// ═══════════════════════════════════════════════════════════════

describe('★★ R-12·R-13 — deriveTerminalCostReasons', () => {
  const reasons = (qtyUnconfirmed: boolean, primary: boolean, price: boolean) =>
    deriveTerminalCostReasons({
      qtyUnconfirmed,
      hasPrimarySupplierSku: primary,
      hasEffectivePrice: price,
    });

  it('★ 전부 정상이면 사유가 없다', () => {
    expect(reasons(false, true, true)).toEqual([]);
  });

  it('★★ 경로 미확정이면 QTY_UNCONFIRMED 다 — 자기 라인이 CONFIRMED 여도', () => {
    // 이 함수는 이미 OR 된 boolean 을 받는다. 그것이 R-12 의 핵심이다.
    expect(reasons(true, true, true)).toEqual(['QTY_UNCONFIRMED']);
  });

  it('★★ 대표가 없으면 NO_EFFECTIVE_PRICE 를 연쇄로 붙이지 않는다', () => {
    expect(reasons(false, false, false)).toEqual(['NO_PRIMARY_SUPPLIER']);
  });

  it('★ 대표는 있고 가격이 없으면 NO_EFFECTIVE_PRICE 다', () => {
    expect(reasons(false, true, false)).toEqual(['NO_EFFECTIVE_PRICE']);
  });

  it('★★ 복수 사유가 동시에 보존된다', () => {
    expect(reasons(true, false, false)).toEqual(['QTY_UNCONFIRMED', 'NO_PRIMARY_SUPPLIER']);
    expect(reasons(true, true, false)).toEqual(['QTY_UNCONFIRMED', 'NO_EFFECTIVE_PRICE']);
  });

  it('★★ F-6 우선순위 순서로 나온다', () => {
    expect(reasons(true, false, false)[0]).toBe('QTY_UNCONFIRMED');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. R-18·R-19 — 결정적 정렬
// ═══════════════════════════════════════════════════════════════

describe('★★ R-18·R-19 — code-point 비교 (locale 비의존)', () => {
  it('★ 기본 비교', () => {
    expect(compareCodePoint('A', 'B')).toBe(-1);
    expect(compareCodePoint('B', 'A')).toBe(1);
    expect(compareCodePoint('A', 'A')).toBe(0);
  });

  it('★★ 대문자가 소문자보다 앞선다 — localeCompare 와 갈리는 지점', () => {
    // 대부분 locale 의 collation 은 'a' < 'B' 로 보지만 code-point 는 'B' < 'a' 다.
    // ⛔ 환경별 collation 에 응답 순서를 맡기지 않는다.
    expect(compareCodePoint('B', 'a')).toBe(-1);
    expect('B'.localeCompare('a')).toBe(1);
  });

  it('★★ 하이픈·숫자가 섞여도 결정적이다', () => {
    const codes = ['SKU-10', 'SKU-2', 'SKU-1', 'sku-1'];
    expect([...codes].sort(compareCodePoint)).toEqual(['SKU-1', 'SKU-10', 'SKU-2', 'sku-1']);
  });
});

describe('★★ R-18 — components 정렬은 level → skuCode → skuId → uom', () => {
  const key = (level: number, skuCode: string, componentSkuId: string, uom = 'EA') => ({
    level,
    skuCode,
    componentSkuId,
    uom,
  });

  it('★ level 이 최우선이다', () => {
    expect(compareCostComponents(key(1, 'Z', 'z'), key(2, 'A', 'a'))).toBeLessThan(0);
  });

  it('★ 같은 level 이면 skuCode', () => {
    expect(compareCostComponents(key(2, 'A', 'z'), key(2, 'B', 'a'))).toBeLessThan(0);
  });

  it('★ skuCode 가 같으면 componentSkuId', () => {
    expect(compareCostComponents(key(2, 'A', 'a'), key(2, 'A', 'b'))).toBeLessThan(0);
  });

  it('★★ 그래도 같으면 uom — 집계 키 전체를 덮으므로 동률이 없다', () => {
    expect(compareCostComponents(key(2, 'A', 'a', 'BOX'), key(2, 'A', 'a', 'EA'))).toBeLessThan(0);
    expect(compareCostComponents(key(2, 'A', 'a', 'EA'), key(2, 'A', 'a', 'EA'))).toBe(0);
  });

  it('★★ 역순 입력이어도 같은 결과가 나온다', () => {
    const rows = [key(3, 'C', 'c'), key(1, 'B', 'b'), key(1, 'A', 'a'), key(2, 'A', 'z')];
    const forward = [...rows].sort(compareCostComponents).map((row) => row.skuCode + row.level);
    const backward = [...rows]
      .reverse()
      .sort(compareCostComponents)
      .map((row) => row.skuCode + row.level);
    expect(forward).toEqual(['A1', 'B1', 'A2', 'C3']);
    expect(backward).toEqual(forward);
  });
});

describe('★★ R-19 — subtotals 정렬도 code-point 다', () => {
  it('★ currency asc → vatIncluded false 먼저', () => {
    const rows = computeCostSubtotals([
      { currency: 'USD', vatIncluded: true, rawLineCost: toDecimal('1') },
      { currency: 'KRW', vatIncluded: true, rawLineCost: toDecimal('2') },
      { currency: 'USD', vatIncluded: false, rawLineCost: toDecimal('3') },
      { currency: 'KRW', vatIncluded: false, rawLineCost: toDecimal('4') },
    ]);
    expect(rows.map((row) => `${row.currency}/${String(row.vatIncluded)}`)).toEqual([
      'KRW/false',
      'KRW/true',
      'USD/false',
      'USD/true',
    ]);
  });

  it('⛔ localeCompare 를 쓰지 않는다 (source guard)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('./domain/cost.ts', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    // 주석에는 남아 있지만 실행 코드에는 없다.
    expect(source.replace(/\/\/.*$/gm, '')).not.toContain('localeCompare');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. 권한 · route-policy (D-15)
// ═══════════════════════════════════════════════════════════════

describe('★★ D-15 — /cost 는 bom.read 다', () => {
  it('★ generic GET /api/boms 정책이 /cost 를 덮는다 — 새 항목이 필요 없다', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/cost`, method: 'GET' })).toBe(
      'bom.read',
    );
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/cost`, method: 'HEAD' })).toBe(
      'bom.read',
    );
  });

  it('★★ workflow POST 정책에 shadow 되지 않는다', () => {
    // suffix 정책들은 POST 전용이라 GET /cost 를 가로채지 않는다.
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/approve`, method: 'POST' })).toBe(
      'bom.approve',
    );
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/cost`, method: 'GET' })).toBe(
      'bom.read',
    );
  });

  it('★★ bom.cost 라는 permission 을 만들지 않았다', () => {
    expect(BOM_READ_PERMISSION).toBe('bom.read');
    expect(BOM_READ_PERMISSION).not.toBe('bom.cost');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. 경계 guard — 구현이 계약을 벗어나지 않았다
// ═══════════════════════════════════════════════════════════════

async function sourceOf(relative: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('⛔ T07-7B 경계 — synthetic intermediate cost 가 없다 (R-20)', () => {
  it('★★ rolledUp* · synthetic 필드를 만들지 않는다', async () => {
    const source = await sourceOf('./application/cost-bom.ts');
    for (const forbidden of [
      'rolledUpUnitPrice',
      'rolledUpCurrency',
      'rolledUpVatIncluded',
      'syntheticSupplierSkuId',
      'intermediateLineCost',
      'totalCost',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('★★ 환율·VAT 가감·pack·UOM 환산이 없다', async () => {
    const source = await sourceOf('./application/cost-bom.ts');
    for (const forbidden of ['fxRate', 'exchangeRate', 'packQuantity', 'purchaseUom', 'vatRate']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('★★ write 계열 delegate 를 부르지 않는다 (read-only)', async () => {
    const source = await sourceOf('./application/cost-bom.ts');
    for (const forbidden of [
      '.create(',
      '.update(',
      '.delete(',
      '.upsert(',
      'createMany',
      'updateMany',
      'deleteMany',
      '$transaction',
      'FOR UPDATE',
      'advisory',
      'AuditLog',
      'auditLog',
      'idempotenc',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('★★ 단건 resolver 를 반복 호출하지 않는다 — batch 만 쓴다 (N+1 금지)', async () => {
    const source = await sourceOf('./application/cost-bom.ts');
    expect(source).toContain('resolvePrimarySupplierSkus');
    expect(source).toContain('resolveEffectiveSupplierPrices');
    expect(source).toContain('resolveEffectiveBoms');
    // 단수형 resolver 는 등장하지 않는다.
    expect(source).not.toContain('resolvePrimarySupplierSku(');
    expect(source).not.toContain('resolveEffectiveSupplierPrice(');
    expect(source).not.toContain('resolveEffectiveBom(');
  });

  it('★★ T07-7A 의 direct-line 엔진을 재귀 호출하지 않는다', async () => {
    const source = await sourceOf('./application/cost-bom.ts');
    // ⛔ costDirectBom 을 node 마다 부르면 그것이 곧 N+1 이다.
    expect(source).not.toContain('costDirectBom');
  });

  it('★★ public 6dp 문자열을 다음 level 입력으로 쓰지 않는다', async () => {
    const source = await sourceOf('./application/cost-bom.ts');
    // 다음 frontier 의 Q 는 raw Decimal 이다.
    expect(source).toContain('parentQty: item.raw');
    // `toRequiredQtyString` 결과를 다시 toDecimal 하는 경로가 없다.
    expect(source).not.toContain('toDecimal(toRequiredQtyString');
  });

  it('★★ maxLevel 을 query 에서 읽지 않는다 — 공유 상수 고정', async () => {
    const source = await sourceOf('./application/cost-bom.ts');
    expect(source).toContain('BOM_MAX_LEVEL');
    expect(source).not.toContain('query.maxLevel');
    expect(BOM_MAX_LEVEL).toBe(10);
  });

  it('★★ root 를 asOf 로 재선택하지 않는다', async () => {
    const source = await sourceOf('./application/cost-bom.ts');
    // root 는 findUnique(bomId) 하나뿐이다.
    expect(source).toContain('db.bomHeader.findUnique');
    expect(source).not.toContain('resolveEffectiveBoms(db, { parentSkuIds: [root');
  });

  it('★★ route 는 costBom 을 부르고 requestId 를 body 에 넣는다 (R-23 G10)', async () => {
    const route = await sourceOf('../../app/api/boms/[id]/cost/route.ts');
    expect(route).toContain('costBom');
    expect(route).toContain('parseCostBomQuery');
    expect(route).toContain('{ ...result, requestId }');
  });
});

describe('⛔ T07-8 UI · max-assembly 는 여전히 0 이다', () => {
  it('★ /master/boms 화면이 없다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../app/master', import.meta.url));
    expect(readdirSync(dir)).not.toContain('boms');
  });

  it('★ cost 서비스가 UI 어휘를 담지 않는다', async () => {
    const source = await sourceOf('./application/cost-bom.ts');
    for (const forbidden of ['잠정', 'badge', 'Badge', 'tsx']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
