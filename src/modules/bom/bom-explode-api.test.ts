import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application';
import { explodeBomQuerySchema, parseExplodeBomQuery } from '@/modules/bom/application/dto';
import {
  computeRawRequiredQty,
  toRequiredQtyString,
  BOM_MAX_LEVEL,
  REQUIRED_QTY_SCALE,
} from '@/modules/bom/domain';
import { toDecimal, toDecimalString } from '@/shared/decimal';
import { ERROR_CODES, ValidationError, type DomainError } from '@/shared/errors';

/**
 * T07-6 explode — 단위 테스트 (대역 없이 판정 가능한 것만).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-18 · §D-19 · §D-15 ·
 *    `★ T07-6 explosion quantity gap closure`(E-1 ~ E-7).
 *
 * 실 DB 가 필요한 것(전개 순회·resolver·순환·깊이)은
 * `tests/db/bom-explode-api.test.ts` 가 본다.
 */

const q = (init: Record<string, string>): URLSearchParams => new URLSearchParams(init);
const BOM = '11111111-1111-4111-8111-111111111111';

// ═══════════════════════════════════════════════════════════════
// 1. query DTO — 정확히 3개
// ═══════════════════════════════════════════════════════════════

describe('★ explode query — qty · asOf · maxLevel 정확히 3개 (D-18)', () => {
  it('★ 키가 정확히 3개다 — 늘어나면 계약 변경이다', () => {
    expect(Object.keys(explodeBomQuerySchema.shape).sort()).toEqual(['asOf', 'maxLevel', 'qty']);
  });

  it('★★ 전부 생략 — qty="1" · maxLevel=BOM_MAX_LEVEL · asOf 는 undefined', () => {
    const parsed = parseExplodeBomQuery(q({}));
    expect(parsed.qty).toBe('1');
    expect(parsed.maxLevel).toBe(BOM_MAX_LEVEL);
    // ⛔ DTO 가 오늘 날짜를 채우지 않는다 — 업무일자 결정은 service 의 몫이다 (D-21).
    expect(parsed.asOf).toBeUndefined();
  });

  it('★ 값을 주면 그대로 통과한다', () => {
    const parsed = parseExplodeBomQuery(q({ qty: '2.5', asOf: '2026-08-16', maxLevel: '3' }));
    expect(parsed).toEqual({ qty: '2.5', asOf: '2026-08-16', maxLevel: 3 });
  });

  it('★★ 미지원 파라미터는 400 이다 — 조용히 무시하지 않는다', () => {
    expect(() => parseExplodeBomQuery(q({ level: '3' }))).toThrow(ValidationError);
    expect(() => parseExplodeBomQuery(q({ aggregate: 'true' }))).toThrow(ValidationError);
    expect(() => parseExplodeBomQuery(q({ qty: '1', page: '1' }))).toThrow(ValidationError);
  });

  it.each([['0'], ['0.0'], ['-1'], ['abc'], [''], ['1,000'], ['1.0000001']])(
    '★ qty %s 는 400 이다 (> 0 · 소수 6자리 이하)',
    (value) => {
      expect(() => parseExplodeBomQuery(q({ qty: value }))).toThrow(ValidationError);
    },
  );

  it('★ qty 는 문자열 그대로 통과한다 — Number 변환이 없다', () => {
    // 정수부 12자리(`Decimal(18,6)` 의 한계)까지 문자열 그대로 지나간다.
    expect(parseExplodeBomQuery(q({ qty: '999999999999' })).qty).toBe('999999999999');
    expect(parseExplodeBomQuery(q({ qty: '0.000001' })).qty).toBe('0.000001');
    // 정수부 13자리는 컬럼 용량을 넘으므로 400 이다.
    expect(() => parseExplodeBomQuery(q({ qty: '1000000000000' }))).toThrow(ValidationError);
  });

  it.each([['0'], ['11'], ['-1'], ['2.5'], ['abc']])(
    '★★ maxLevel %s 는 400 이다 — 범위는 1..BOM_MAX_LEVEL',
    (value) => {
      expect(() => parseExplodeBomQuery(q({ maxLevel: value }))).toThrow(ValidationError);
    },
  );

  it('★ maxLevel 경계 1 과 BOM_MAX_LEVEL 은 통과한다', () => {
    expect(parseExplodeBomQuery(q({ maxLevel: '1' })).maxLevel).toBe(1);
    expect(parseExplodeBomQuery(q({ maxLevel: String(BOM_MAX_LEVEL) })).maxLevel).toBe(
      BOM_MAX_LEVEL,
    );
  });

  it.each([['2026-8-16'], ['20260816'], ['2026-13-01'], ['오늘'], ['']])(
    '★ asOf %s 는 400 이다',
    (value) => {
      expect(() => parseExplodeBomQuery(q({ asOf: value }))).toThrow(ValidationError);
    },
  );

  it('⚠️ 일(day) 넘침은 공용 `dateString` 이 롤오버로 받는다 — T07-6 범위 밖', () => {
    // `new Date('2026-02-30T00:00:00.000Z')` 는 V8 에서 03-02 로 굴러가 NaN 이
    // 아니다. 프로젝트 전역 공용 파서의 기존 동작이므로 explode 만 다르게
    // 만들지 않는다 (보고서에 관찰 사실로 남긴다).
    expect(parseExplodeBomQuery(q({ asOf: '2026-02-30' })).asOf).toBe('2026-02-30');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. D-19 공식
// ═══════════════════════════════════════════════════════════════

/** 테스트 가독성용 — raw Decimal 을 문자열로 본다. */
const raw = (input: Parameters<typeof computeRawRequiredQty>[0]): string | null => {
  const value = computeRawRequiredQty(input);
  return value === null ? null : toDecimalString(value);
};

const base = {
  parentQty: toDecimal('1'),
  outputQty: '1',
  quantityPer: '1',
  lossRate: null,
  overallLossRate: null,
} as const;

describe('★★ D-19 수량 공식', () => {
  it('★ scale = Q / outputQty — outputQty 가 1 이 아니면 나눈다', () => {
    // (20 / 10) × 3 = 6
    expect(raw({ ...base, parentQty: toDecimal('20'), outputQty: '10', quantityPer: '3' })).toBe(
      '6',
    );
  });

  it('★★ 손실률은 **가산식**이다 — × (1 + rate)', () => {
    // 10 × 1.1 = 11 ⛔ 수율식 10 / (1 - 0.1) = 11.111… 이 아니다.
    expect(raw({ ...base, parentQty: toDecimal('10'), quantityPer: '1', lossRate: '0.1' })).toBe(
      '11',
    );
  });

  it('★★ 두 손실률은 **각각 곱한다** — (1+a+b) 로 합치지 않는다', () => {
    // 10 × 1.10 × 1.20 = 13.2   ⛔ 10 × 1.30 = 13 이 아니다.
    const value = raw({
      ...base,
      parentQty: toDecimal('10'),
      lossRate: '0.1',
      overallLossRate: '0.2',
    });
    expect(value).toBe('13.2');
    expect(value).not.toBe('13');
  });

  it('★ null 손실률은 0 이다 (× 1) — 추정하지 않는다', () => {
    expect(raw({ ...base, parentQty: toDecimal('7'), lossRate: null, overallLossRate: null })).toBe(
      '7',
    );
    expect(raw({ ...base, parentQty: toDecimal('7'), lossRate: '0', overallLossRate: '0' })).toBe(
      '7',
    );
  });

  it('★★ packQuantity 는 공식에 없다 — 0.033333 을 30 으로 되돌리지 않는다', () => {
    // 입력에 packQuantity 라는 자리가 아예 없다는 것이 계약이다.
    expect(Object.keys(base)).not.toContain('packQuantity');
    expect(raw({ ...base, quantityPer: '0.033333' })).toBe('0.033333');
  });

  it('★★ 0.033333 × 30 = 0.99999 를 1 로 재정규화하지 않는다', () => {
    expect(raw({ ...base, parentQty: toDecimal('30'), quantityPer: '0.033333' })).toBe('0.99999');
  });

  it('★★ outputQty <= 0 은 DB 손상이다 — BOM_QTY_INVALID (자동 1 대체 없음)', () => {
    for (const outputQty of ['0', '-1']) {
      let caught: unknown;
      try {
        computeRawRequiredQty({ ...base, outputQty });
      } catch (error) {
        caught = error;
      }
      expect((caught as DomainError | undefined)?.code, outputQty).toBe(
        ERROR_CODES.BOM_QTY_INVALID,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. E-1 · E-2 — null 수량
// ═══════════════════════════════════════════════════════════════

describe('★★ 미확정 수량 — requiredQty = null (E-1 · E-2)', () => {
  it('★★ E-1 — quantityPer 가 null 이면 null 이다 (0·1 fallback 없음)', () => {
    expect(raw({ ...base, quantityPer: null })).toBeNull();
  });

  it('★★ E-2 — 부모 Q 가 null 이면 라인이 CONFIRMED 여도 null 이다', () => {
    expect(raw({ ...base, parentQty: null, quantityPer: '2' })).toBeNull();
  });

  it('★ 둘 다 null 이어도 null 이다', () => {
    expect(raw({ ...base, parentQty: null, quantityPer: null })).toBeNull();
  });

  it('★★ 부모 Q 가 null 이면 outputQty 손상 검사보다 먼저 끝난다 — 던지지 않는다', () => {
    // 미상 subtree 를 훑다가 무관한 500 을 만들지 않는다.
    expect(raw({ ...base, parentQty: null, outputQty: '0' })).toBeNull();
  });

  it('★ 부모 Q 가 0 이면 0 이다 — null 이 아니다 (모르는 것과 없는 것은 다르다)', () => {
    expect(raw({ ...base, parentQty: toDecimal('0'), quantityPer: '5' })).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. E-6 — 직렬화
// ═══════════════════════════════════════════════════════════════

describe('★★ requiredQty 직렬화 — 6dp HALF_UP + minimal form (E-6)', () => {
  it('★ scale 상수는 6 이다 (Decimal(18,6) 과 일치)', () => {
    expect(REQUIRED_QTY_SCALE).toBe(6);
  });

  it('★★ trailing zero 를 채우지 않는다 — "6.000000" 이 아니라 "6"', () => {
    expect(toRequiredQtyString(toDecimal('6'))).toBe('6');
    expect(toRequiredQtyString(toDecimal('6.000000'))).toBe('6');
    expect(toRequiredQtyString(toDecimal('0.99999'))).toBe('0.99999');
    expect(toRequiredQtyString(toDecimal('0.999990'))).toBe('0.99999');
  });

  it('★★ 6자리 초과는 HALF_UP 으로 반올림한다', () => {
    expect(toRequiredQtyString(toDecimal('1.2345675'))).toBe('1.234568');
    expect(toRequiredQtyString(toDecimal('1.2345674'))).toBe('1.234567');
    expect(toRequiredQtyString(toDecimal('0.9999901'))).toBe('0.99999');
  });

  it('★ null 은 null 이다', () => {
    expect(toRequiredQtyString(null)).toBeNull();
  });

  it('★ 지수표기가 나오지 않는다', () => {
    expect(toRequiredQtyString(toDecimal('0.000001'))).toBe('0.000001');
    expect(toRequiredQtyString(toDecimal('123456789012'))).toBe('123456789012');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. E-7 — raw 전파 (중간 반올림 금지)
// ═══════════════════════════════════════════════════════════════

describe('★★ E-7 — 재귀에는 raw 를 넘긴다 (public 6dp 재사용 금지)', () => {
  /**
   * 부모 raw 와 부모 public(6dp)이 **다른** fixture 를 만들고, 자식 계산에
   * 어느 쪽을 썼는지가 결과로 구분되게 한다.
   */
  const parentRaw = computeRawRequiredQty({
    parentQty: toDecimal('1'),
    outputQty: '3', // 1/3 = 0.3333… 무한소수
    quantityPer: '1',
    lossRate: null,
    overallLossRate: null,
  });

  it('★ 전제 — 부모의 raw 와 public 6dp 가 실제로 다르다', () => {
    const publicValue = toRequiredQtyString(parentRaw);
    expect(publicValue).toBe('0.333333');
    expect(toDecimalString(parentRaw as never)).not.toBe(publicValue);
  });

  it('★★ raw 를 넘긴 자식과 public 을 넘긴 자식의 결과가 다르다', () => {
    const childOf = (parentQty: ReturnType<typeof toDecimal>): string | null =>
      toRequiredQtyString(
        computeRawRequiredQty({
          parentQty,
          outputQty: '1',
          quantityPer: '3000000',
          lossRate: null,
          overallLossRate: null,
        }),
      );

    // ✅ 계약대로 raw 를 넘긴 경우 — 1/3 × 3,000,000 = 1,000,000
    const correct = childOf(parentRaw as never);
    // ⛔ public 6dp 를 되읽어 넘긴 경우 — 0.333333 × 3,000,000 = 999,999
    const wrong = childOf(toDecimal(toRequiredQtyString(parentRaw) as string));

    expect(correct).toBe('1000000');
    expect(wrong).toBe('999999');
    // 이 두 값이 갈리는 것이 곧 "중간 반올림 금지"(D-19)의 관찰 가능한 증거다.
    expect(correct).not.toBe(wrong);
  });

  it('★★ null 은 그대로 전파되고 자식에서 되살아나지 않는다', () => {
    const parentNull = computeRawRequiredQty({ ...base, quantityPer: null });
    expect(parentNull).toBeNull();
    expect(raw({ ...base, parentQty: parentNull, quantityPer: '9' })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. route-policy — bom.read 이며 shadow 되지 않는다 (D-15)
// ═══════════════════════════════════════════════════════════════

describe('★★ explode route-policy (D-15)', () => {
  it('★★ GET explode 는 bom.read 다', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/explode`, method: 'GET' })).toBe(
      'bom.read',
    );
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/explode`, method: 'HEAD' })).toBe(
      'bom.read',
    );
  });

  it('★★ workflow POST 정책에 shadow 되지 않는다 — suffix 가 다르다', () => {
    // `/activate` 등은 POST 전용 suffix 규칙이라 GET explode 를 잡지 않는다.
    expect(
      resolveRoutePermission({ pathname: `/api/boms/${BOM}/explode`, method: 'POST' }),
    ).not.toBe('bom.read');
  });

  it('★ generic GET 규칙이 이미 덮으므로 route-policy 항목을 새로 만들지 않았다', () => {
    // 같은 규칙이 상세·목록도 잡는다 — explode 전용 entry 가 없다는 뜻이다.
    for (const pathname of ['/api/boms', `/api/boms/${BOM}`, `/api/boms/${BOM}/explode`]) {
      expect(resolveRoutePermission({ pathname, method: 'GET' }), pathname).toBe('bom.read');
    }
  });

  it('⛔ bom.explode 같은 새 permission 을 만들지 않았다', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    // ⚠️ 주석을 지우고 본다 — policy.ts 는 "⛔ `bom.cost` 를 만들지 않는다" 를
    //    주석으로 적어 두었으므로 원문 검색이면 스스로에게 걸린다.
    const policy = readFileSync(
      fileURLToPath(new URL('./application/policy.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(policy).not.toContain('bom.explode');
    expect(policy).not.toContain('bom.cost');
    // 기존 5종은 그대로다 — 늘지도 줄지도 않았다.
    expect([...policy.matchAll(/'bom\.\w+'/g)].map((m) => m[0]).sort()).toEqual([
      "'bom.approve'",
      "'bom.create'",
      "'bom.read'",
      "'bom.submit'",
      "'bom.update'",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. scope — T07-7 이후가 새어 들어오지 않았다
// ═══════════════════════════════════════════════════════════════

describe('⛔ T07-6 은 원가·재고를 만들지 않는다', () => {
  it('★★ explode 소스에 cost·supplier·inventory 어휘가 없다', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = ['application/explode-bom.ts', 'domain/explosion.ts']
      .map((path) => readFileSync(fileURLToPath(new URL(`./${path}`, import.meta.url)), 'utf8'))
      // 주석을 지운다 — 경계를 설명하는 문장이 어휘 검사에 걸리지 않게 한다.
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    for (const forbidden of [
      'supplierSku',
      'unitPrice',
      'lineCost',
      'currency',
      'vatIncluded',
      'isProvisional',
      'provisionalReason',
      'subtotal',
      'availableStock',
      'maxAssemblyQty',
      'onHand',
      'warehouse',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('★★ ExplodedNode 에 rawRequiredQty 를 노출하지 않는다 (E-7)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const views = readFileSync(
      fileURLToPath(new URL('./application/views.ts', import.meta.url)),
      'utf8',
    );
    const nodeShape = views.slice(
      views.indexOf('export interface ExplodedNodeView'),
      views.indexOf('EXPLODE_LINE_INCLUDE'),
    );
    expect(nodeShape).not.toContain('rawRequiredQty');
    expect(nodeShape).not.toContain('isProvisional');
    expect(nodeShape).not.toContain('isQuantityUnknown');
  });

  it('★★ ExplodedNodeView 는 정확히 12 필드다 (D-14 exact shape)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const views = readFileSync(
      fileURLToPath(new URL('./application/views.ts', import.meta.url)),
      'utf8',
    );
    const body = views.slice(
      views.indexOf('export interface ExplodedNodeView'),
      views.indexOf('EXPLODE_LINE_INCLUDE'),
    );
    const fields = [...body.matchAll(/^\s{2}readonly (\w+)[?]?:/gm)].map((match) => match[1]);
    expect(fields).toEqual([
      'level',
      'path',
      'bomHeaderId',
      'componentSkuId',
      'componentSku',
      'componentRole',
      'quantityPer',
      'lossRate',
      'requiredQty',
      'uom',
      'isLeaf',
      'quantityStatus',
    ]);
    expect(fields).toHaveLength(12);
  });

  it('⛔ max-assembly-qty · cost route 는 없다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../app/api/boms/[id]', import.meta.url));
    const entries = readdirSync(dir);
    expect(entries).toContain('explode');
    for (const forbidden of ['cost', 'max-assembly-qty', 'import']) {
      expect(entries, forbidden).not.toContain(forbidden);
    }
  });
});
