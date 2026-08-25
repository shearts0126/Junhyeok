import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  computeActualRequiredQty,
  computeCostSharePct,
  confirmProgress,
  resolveBomActions,
  suggestQuantityPer,
  ACTUAL_REQUIRED_QTY_SCALE,
  BOM_COMPONENT_ROLE_OPTIONS,
  BOM_QUANTITY_STATUS_OPTIONS,
  BOM_SUPPLY_TYPE_OPTIONS,
  BOM_LINE_GRID_COLUMNS,
  COST_SHARE_SCALE,
  EDITABLE_STATUSES,
  canEditLineByRowClick,
} from './bom-detail-view';
import {
  buildBomListParams,
  bomListApiQuery,
  formatKrwSubtotal,
  formatOptional,
  formatTimestamp,
  periodEndedLabel,
  readBomListState,
  referenceCostErrorLabel,
  toReferenceCostCell,
  BOM_LIST_QUERY_KEYS,
  BOM_STATUS_SUGGESTIONS,
  BOM_TYPE_SUGGESTIONS,
  REFERENCE_COST_ERROR_LABELS,
  type ReferenceCost,
} from './list-params';

/**
 * T07-8 BOM 관리 UI — 순수 helper 단위 테스트.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-6·§D-7·§D-19·§D-26·§D-27·§D-30·§D-31 ·
 *    `★ T07-8 BOM UI read-model gap closure` U8-10~U8-15 ·
 *    `★ T07-8 list reference-cost fault isolation remediation` R8-3·R8-6·R8-13.
 */

const ALL_PERMISSIONS = [
  'bom.read',
  'bom.create',
  'bom.update',
  'bom.submit',
  'bom.approve',
] as const;

function sourceOf(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/**
 * 주석을 걷어낸 **코드만** 남긴다.
 *
 * ⚠️ 금지 어휘 검사는 "코드가 실제로 그렇게 하는가"를 보는 것이다. `⛔ 엑셀
 *    업로드 없음`·`⛔ parseFloat 금지` 같은 **금지 사실을 적어 둔 주석**까지
 *    걸면 그 설명을 지워야 통과하게 되어 의도가 정확히 뒤집힌다.
 *    (T1-6B5 `skus/[id]/bom-ui.test.ts` 의 같은 helper 와 동일한 선례다.)
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ═══════════════════════════════════════════════════════════════
// A. 목록 URL 상태 — 필터 정확히 7종
// ═══════════════════════════════════════════════════════════════

describe('A. 목록 URL 상태 (D-31 필터 7종)', () => {
  it('★ 필터 키는 정확히 7개다 — ⛔ 8번째 없음', () => {
    expect(BOM_LIST_QUERY_KEYS).toEqual([
      'q',
      'status',
      'bomType',
      'parentSkuId',
      'effectiveOn',
      'hasUnknownQty',
      'page',
    ]);
    expect(new Set(BOM_LIST_QUERY_KEYS).size).toBe(7);
  });

  it('★ status 후보는 BomStatus 7종, bomType 은 3종이다', () => {
    expect(BOM_STATUS_SUGGESTIONS).toHaveLength(7);
    expect(BOM_TYPE_SUGGESTIONS).toEqual(['MANUFACTURING', 'KIT', 'REPACK']);
  });

  it('빈 searchParams 는 전부 빈 문자열로 읽힌다', () => {
    expect(readBomListState(new URLSearchParams())).toEqual({
      q: '',
      status: '',
      bomType: '',
      parentSkuId: '',
      effectiveOn: '',
      hasUnknownQty: '',
      page: '',
    });
  });

  it('★ 필터가 바뀌면 page 를 1 로 되돌린다', () => {
    const current = new URLSearchParams('status=ACTIVE&page=5');
    expect(buildBomListParams(current, { status: 'DRAFT' }).toString()).toBe('status=DRAFT');
  });

  it('page 를 명시하면 그 값을 유지한다', () => {
    const current = new URLSearchParams('status=ACTIVE&page=2');
    expect(buildBomListParams(current, { page: '3' }).toString()).toBe('status=ACTIVE&page=3');
  });

  it('빈 문자열은 키를 지운다', () => {
    const current = new URLSearchParams('status=ACTIVE&q=abc');
    expect(buildBomListParams(current, { status: '' }).toString()).toBe('q=abc');
  });

  it('★★ 미지원 파라미터를 조용히 지우지 않는다 — API 400 이 사용자에게 보여야 한다', () => {
    // ⛔ 화면이 임의로 필터를 삼키면 400 계약이 사라진다.
    const current = new URLSearchParams('sort=version&pageSize=200');
    expect(bomListApiQuery(current)).toBe('?sort=version&pageSize=200');
    expect(buildBomListParams(current, { q: 'x' }).toString()).toContain('sort=version');
  });

  it('파라미터가 없으면 query string 도 비어 있다', () => {
    expect(bomListApiQuery(new URLSearchParams())).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// B. 기준원가 cell — R8-3 union · R8-13 `계산 불가`
// ═══════════════════════════════════════════════════════════════

const AVAILABLE_BASE = {
  status: 'AVAILABLE',
  asOf: '2026-08-21',
  krwSubtotals: [],
  hasOtherCurrency: false,
  isProvisional: false,
} as const satisfies ReferenceCost;

describe('B. 기준원가 cell (U8-10 · R8-3 · R8-13)', () => {
  it('★★ UNAVAILABLE label 은 정확히 7종이다 — ⛔ 새 오류코드 발명 금지', () => {
    expect(Object.keys(REFERENCE_COST_ERROR_LABELS).sort()).toEqual([
      'BOM_CYCLE_DETECTED',
      'BOM_EFFECTIVE_CONFLICT',
      'BOM_MAX_LEVEL_EXCEEDED',
      'BOM_QTY_INVALID',
      'BOM_QTY_STATUS_MISMATCH',
      'BOM_SUPPLIER_SELECTION_CONFLICT',
      'SUPPLIER_PRICE_CHAIN_CONFLICT',
    ]);
    expect(Object.keys(REFERENCE_COST_ERROR_LABELS)).toHaveLength(7);
  });

  it('7종 label 은 모두 한국어 사유이며 서로 다르다', () => {
    const labels = Object.values(REFERENCE_COST_ERROR_LABELS);
    expect(new Set(labels).size).toBe(7);
    for (const label of labels) expect(label).not.toBe('계산 불가');
  });

  it('알 수 없는 코드는 일반 label 로 떨어진다 — ⛔ 예외를 던지지 않는다', () => {
    expect(referenceCostErrorLabel('SOMETHING_NEW')).toBe('계산 불가');
  });

  it('★★ UNAVAILABLE 은 unavailable cell 이다 — ⛔ `—`·`0원`·`잠정` 위장 금지', () => {
    const cell = toReferenceCostCell({
      status: 'UNAVAILABLE',
      asOf: '2026-08-21',
      errorCode: 'BOM_CYCLE_DETECTED',
    });
    expect(cell).toEqual({
      kind: 'unavailable',
      label: '순환 구조',
      errorCode: 'BOM_CYCLE_DETECTED',
    });
    // ⛔ 잠정 badge 로 새어 나갈 경로가 없다.
    expect(cell).not.toHaveProperty('isProvisional');
  });

  it('★ KRW subtotal 은 vatIncluded 별로 **분리**된다 (D-27) — ⛔ 합산 금지', () => {
    const cell = toReferenceCostCell({
      ...AVAILABLE_BASE,
      krwSubtotals: [
        { vatIncluded: false, amount: '1000' },
        { vatIncluded: true, amount: '1100' },
      ],
    });
    expect(cell).toEqual({
      kind: 'amounts',
      amounts: ['₩1000 (VAT 별도)', '₩1100 (VAT 포함)'],
      hasOtherCurrency: false,
      isProvisional: false,
    });
  });

  it('★ 다른 통화가 있으면 marker 만 세운다 — ⛔ FX 환산 0 (D-26)', () => {
    const cell = toReferenceCostCell({
      ...AVAILABLE_BASE,
      krwSubtotals: [{ vatIncluded: false, amount: '500' }],
      hasOtherCurrency: true,
    });
    expect(cell.kind).toBe('amounts');
    if (cell.kind !== 'amounts') throw new Error('unreachable');
    expect(cell.hasOtherCurrency).toBe(true);
    // 금액은 KRW 한 줄뿐이다 — 다른 통화를 원화로 바꾸지 않았다.
    expect(cell.amounts).toEqual(['₩500 (VAT 별도)']);
  });

  it('KRW 가 없고 비KRW 만 있으면 amounts 는 비지만 marker 는 남는다', () => {
    const cell = toReferenceCostCell({ ...AVAILABLE_BASE, hasOtherCurrency: true });
    expect(cell).toEqual({
      kind: 'amounts',
      amounts: [],
      hasOtherCurrency: true,
      isProvisional: false,
    });
  });

  it('★ 잠정이면서 금액이 있는 부분 성공은 AVAILABLE 이다 (§19)', () => {
    const cell = toReferenceCostCell({
      ...AVAILABLE_BASE,
      krwSubtotals: [{ vatIncluded: false, amount: '300' }],
      isProvisional: true,
    });
    expect(cell.kind).toBe('amounts');
    if (cell.kind !== 'amounts') throw new Error('unreachable');
    expect(cell.isProvisional).toBe(true);
  });

  it('★ 금액 0 은 `empty` 가 아니라 실제 금액이다 (§20 — 0 과 null 을 구분한다)', () => {
    const cell = toReferenceCostCell({
      ...AVAILABLE_BASE,
      krwSubtotals: [{ vatIncluded: false, amount: '0' }],
    });
    expect(cell.kind).toBe('amounts');
    if (cell.kind !== 'amounts') throw new Error('unreachable');
    expect(cell.amounts).toEqual(['₩0 (VAT 별도)']);
  });

  it('계산 가능한 원가가 아예 없으면 empty 다', () => {
    expect(toReferenceCostCell(AVAILABLE_BASE)).toEqual({ kind: 'empty', isProvisional: false });
  });

  it('필드 자체가 없어도 예외 없이 empty 다', () => {
    expect(toReferenceCostCell(undefined)).toEqual({ kind: 'empty', isProvisional: false });
  });

  it('formatKrwSubtotal 은 VAT 구분을 문자열에 남긴다', () => {
    expect(formatKrwSubtotal({ vatIncluded: true, amount: '12.34' })).toBe('₩12.34 (VAT 포함)');
    expect(formatKrwSubtotal({ vatIncluded: false, amount: '12.34' })).toBe('₩12.34 (VAT 별도)');
  });
});

// ═══════════════════════════════════════════════════════════════
// C. status vs 적용기간 (D-7 · U8-15)
// ═══════════════════════════════════════════════════════════════

describe('C. status 와 적용기간 분리 (D-7 · U8-15)', () => {
  it('★ ACTIVE + 종료일 도달 → "적용기간 종료" 를 덧붙인다', () => {
    expect(periodEndedLabel({ status: 'ACTIVE', effectiveTo: '2026-08-21' }, '2026-08-21')).toBe(
      '적용기간 종료',
    );
    expect(periodEndedLabel({ status: 'ACTIVE', effectiveTo: '2026-08-01' }, '2026-08-21')).toBe(
      '적용기간 종료',
    );
  });

  it('종료일이 아직 남았으면 label 이 없다', () => {
    expect(
      periodEndedLabel({ status: 'ACTIVE', effectiveTo: '2026-12-31' }, '2026-08-21'),
    ).toBeNull();
  });

  it('종료일이 없으면 label 이 없다', () => {
    expect(periodEndedLabel({ status: 'ACTIVE', effectiveTo: null }, '2026-08-21')).toBeNull();
  });

  it('★ ACTIVE 가 아니면 기간과 무관하게 label 이 없다 — ⛔ status 를 바꾸지 않는다', () => {
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'APPROVED', 'INACTIVE']) {
      expect(periodEndedLabel({ status, effectiveTo: '2020-01-01' }, '2026-08-21')).toBeNull();
    }
  });

  it('★★ U8-15 — 미래 시작 ACTIVE 에 새 badge 를 만들지 않는다', () => {
    // `effectiveFrom` 이 미래여도 helper 는 아무 label 도 내지 않는다.
    expect(
      periodEndedLabel({ status: 'ACTIVE', effectiveTo: '2099-12-31' }, '2026-08-21'),
    ).toBeNull();
    // ⛔ `예정`·`대기` 같은 새 badge 어휘가 소스에 없다.
    const source = sourceOf('./list-params.ts');
    for (const forbidden of ['예정', '시작 전', 'upcoming', 'FUTURE_ACTIVE']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// D. 표시 helper
// ═══════════════════════════════════════════════════════════════

describe('D. 수정일·선택값 표시', () => {
  it('★ lastModifiedAt 은 분 단위까지 보여준다', () => {
    const iso = '2026-08-21T01:02:03.000Z';
    const at = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, '0');
    // 로컬 타임존 의존을 피하려고 같은 Date 로 기대값을 만든다.
    expect(formatTimestamp(iso)).toBe(
      `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`,
    );
  });

  it('null·빈 문자열·파싱 불가 값은 모두 `—` 다 — ⛔ 예외 금지', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp('')).toBe('—');
    expect(formatTimestamp('not-a-date')).toBe('—');
  });

  it('formatOptional 은 null·빈 문자열만 `—` 로 바꾼다', () => {
    expect(formatOptional(null)).toBe('—');
    expect(formatOptional('')).toBe('—');
    // ★ `0` 은 값이다 — 숨기지 않는다.
    expect(formatOptional('0')).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════════════
// E. 실제 필요량 — U8-12 (D-19 를 Q = outputQty 로 적용)
// ═══════════════════════════════════════════════════════════════

describe('E. 실제 필요량 (U8-12 · D-19)', () => {
  it('★★ CASE I — 0.2 × (1+0.05) × (1+0.1) = 0.231', () => {
    expect(
      computeActualRequiredQty({
        outputQty: '10',
        quantityPer: '0.2',
        lossRate: '0.05',
        overallLossRate: '0.1',
      }),
    ).toBe('0.231');
  });

  it('★ 결과는 outputQty 값과 무관하다 — scale = Q/outputQty = 1', () => {
    const base = { quantityPer: '0.2', lossRate: '0.05', overallLossRate: '0.1' } as const;
    for (const outputQty of ['1', '10', '1000', '0.5']) {
      expect(computeActualRequiredQty({ ...base, outputQty })).toBe('0.231');
    }
  });

  it('로스율이 없으면 소요량 그대로다', () => {
    expect(
      computeActualRequiredQty({
        outputQty: '1',
        quantityPer: '2.5',
        lossRate: null,
        overallLossRate: null,
      }),
    ).toBe('2.5');
  });

  it('라인 로스만 있는 경우', () => {
    expect(
      computeActualRequiredQty({
        outputQty: '1',
        quantityPer: '2',
        lossRate: '0.5',
        overallLossRate: null,
      }),
    ).toBe('3');
  });

  it('전체 로스만 있는 경우', () => {
    expect(
      computeActualRequiredQty({
        outputQty: '1',
        quantityPer: '2',
        lossRate: null,
        overallLossRate: '0.25',
      }),
    ).toBe('2.5');
  });

  it('★ 소요량이 없으면(UNKNOWN) null 이다 — ⛔ 0 이나 1 로 지어내지 않는다', () => {
    expect(
      computeActualRequiredQty({
        outputQty: '10',
        quantityPer: null,
        lossRate: '0.1',
        overallLossRate: null,
      }),
    ).toBeNull();
  });

  it('outputQty 가 0 이하이면 나누지 않고 null 이다', () => {
    for (const outputQty of ['0', '-1']) {
      expect(
        computeActualRequiredQty({
          outputQty,
          quantityPer: '1',
          lossRate: null,
          overallLossRate: null,
        }),
      ).toBeNull();
    }
  });

  it('★ 소요량 0 은 유효한 값이다 — null 이 아니라 "0" 이다', () => {
    expect(
      computeActualRequiredQty({
        outputQty: '10',
        quantityPer: '0',
        lossRate: '0.1',
        overallLossRate: null,
      }),
    ).toBe('0');
  });

  it('★ 6자리로 HALF_UP 반올림한다', () => {
    expect(ACTUAL_REQUIRED_QTY_SCALE).toBe(6);
    // 0.0333333333… → 6dp
    expect(
      computeActualRequiredQty({
        outputQty: '1',
        quantityPer: '0.033333',
        lossRate: null,
        overallLossRate: null,
      }),
    ).toBe('0.033333');
  });

  it('★★ ⛔ packQuantity 는 이 산식의 피연산자가 아니다 (TC-BOM-009 · F-13)', () => {
    const source = sourceOf('./bom-detail-view.ts');
    const body = source.slice(
      source.indexOf('export function computeActualRequiredQty'),
      source.indexOf('function lossFactor'),
    );
    expect(body).not.toContain('packQuantity');
  });
});

// ═══════════════════════════════════════════════════════════════
// F. 소요량 추천 — D-31 ②
// ═══════════════════════════════════════════════════════════════

describe('F. 소요량 추천 (D-31 ②)', () => {
  it('★ 입수량 20 → 0.05 (정확히 나누어떨어짐)', () => {
    expect(suggestQuantityPer('20')).toBe('0.05');
  });

  it('★★ 입수량 30 → 0.033333 — ⛔ 정확한 1/30 으로 재정규화하지 않는다', () => {
    expect(suggestQuantityPer('30')).toBe('0.033333');
  });

  it('입수량 1 → 1', () => {
    expect(suggestQuantityPer('1')).toBe('1');
  });

  it('입수량이 없거나 0 이하이면 추천하지 않는다', () => {
    expect(suggestQuantityPer(null)).toBeNull();
    expect(suggestQuantityPer('')).toBeNull();
    expect(suggestQuantityPer('0')).toBeNull();
    expect(suggestQuantityPer('-5')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// G. 비중 — U8-11 (분모 = 같은 (currency, vatIncluded) subtotal)
// ═══════════════════════════════════════════════════════════════

const KRW_EXCL = { currency: 'KRW', vatIncluded: false } as const;

describe('G. 원가 비중 (U8-11)', () => {
  it('★★ 25 / 100 = 25%, 75 / 100 = 75% — 합이 100% 다', () => {
    const subtotals = [{ ...KRW_EXCL, amount: '100' }];
    expect(computeCostSharePct({ lineCost: '25', ...KRW_EXCL }, subtotals)).toBe('25%');
    expect(computeCostSharePct({ lineCost: '75', ...KRW_EXCL }, subtotals)).toBe('75%');
  });

  it('★★ 분모는 **같은 통화** subtotal 이다 — ⛔ 전 통화 합계 금지 (FX 0)', () => {
    const subtotals = [
      { currency: 'KRW', vatIncluded: false, amount: '100' },
      { currency: 'USD', vatIncluded: false, amount: '900' },
    ];
    // USD 900 이 분모에 섞였다면 25/1000 = 2.5% 가 나왔을 것이다.
    expect(computeCostSharePct({ lineCost: '25', ...KRW_EXCL }, subtotals)).toBe('25%');
    expect(
      computeCostSharePct({ lineCost: '450', currency: 'USD', vatIncluded: false }, subtotals),
    ).toBe('50%');
  });

  it('★★ 분모는 **같은 VAT bucket** 이다 — ⛔ bucket 합산 금지 (D-27)', () => {
    const subtotals = [
      { currency: 'KRW', vatIncluded: false, amount: '100' },
      { currency: 'KRW', vatIncluded: true, amount: '400' },
    ];
    expect(computeCostSharePct({ lineCost: '50', ...KRW_EXCL }, subtotals)).toBe('50%');
    expect(
      computeCostSharePct({ lineCost: '50', currency: 'KRW', vatIncluded: true }, subtotals),
    ).toBe('12.5%');
  });

  it('★ 2자리 HALF_UP 이다', () => {
    expect(COST_SHARE_SCALE).toBe(2);
    // 1/3 × 100 = 33.333… → 33.33
    expect(
      computeCostSharePct({ lineCost: '1', ...KRW_EXCL }, [{ ...KRW_EXCL, amount: '3' }]),
    ).toBe('33.33%');
    // 2/3 × 100 = 66.666… → 66.67
    expect(
      computeCostSharePct({ lineCost: '2', ...KRW_EXCL }, [{ ...KRW_EXCL, amount: '3' }]),
    ).toBe('66.67%');
  });

  it('★ lineCost 가 null 이면 null 이다 — 0% 로 위장하지 않는다', () => {
    expect(
      computeCostSharePct({ lineCost: null, ...KRW_EXCL }, [{ ...KRW_EXCL, amount: '100' }]),
    ).toBeNull();
  });

  it('★ lineCost 0 은 "0%" 다 — null 과 구분된다', () => {
    expect(
      computeCostSharePct({ lineCost: '0', ...KRW_EXCL }, [{ ...KRW_EXCL, amount: '100' }]),
    ).toBe('0%');
  });

  it('통화·VAT 가 null 이면 대응 bucket 을 특정할 수 없어 null 이다', () => {
    const subtotals = [{ ...KRW_EXCL, amount: '100' }];
    expect(
      computeCostSharePct({ lineCost: '10', currency: null, vatIncluded: false }, subtotals),
    ).toBeNull();
    expect(
      computeCostSharePct({ lineCost: '10', currency: 'KRW', vatIncluded: null }, subtotals),
    ).toBeNull();
  });

  it('대응 subtotal 이 없으면 null 이다', () => {
    expect(
      computeCostSharePct({ lineCost: '10', currency: 'JPY', vatIncluded: false }, [
        { ...KRW_EXCL, amount: '100' },
      ]),
    ).toBeNull();
    expect(computeCostSharePct({ lineCost: '10', ...KRW_EXCL }, [])).toBeNull();
  });

  it('★ subtotal 이 0 이면 0 으로 나누지 않고 null 이다', () => {
    expect(
      computeCostSharePct({ lineCost: '0', ...KRW_EXCL }, [{ ...KRW_EXCL, amount: '0' }]),
    ).toBe(null);
  });

  it('★★ ⛔ CostResult 에 새 필드를 만들지 않는다 — 비중은 화면 계산이다', () => {
    const source = codeOnly(sourceOf('../../../modules/bom/application/views.ts'));
    for (const forbidden of ['sharePct', 'costShare', 'totalCost']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// H. 권한 × status 렌더 (D-6 · D-31)
// ═══════════════════════════════════════════════════════════════

describe('H. action 노출 (D-6 · D-31)', () => {
  it('★ 편집 가능 상태는 DRAFT·REJECTED 뿐이다', () => {
    expect(EDITABLE_STATUSES).toEqual(['DRAFT', 'REJECTED']);
  });

  it('★★ 권한이 하나도 없으면 clone 을 포함해 전부 false 다', () => {
    const actions = resolveBomActions('DRAFT', []);
    expect(Object.values(actions).every((value) => value === false)).toBe(true);
  });

  it('★ DRAFT + 전권 — 편집·제출·보관·복제가 열리고 승인계열은 닫힌다', () => {
    expect(resolveBomActions('DRAFT', ALL_PERMISSIONS)).toEqual({
      canEditHeader: true,
      canMutateLines: true,
      canBulkConfirm: true,
      canSubmit: true,
      canApprove: false,
      canReject: false,
      canActivate: false,
      canDeactivate: false,
      canArchive: true,
      canClone: true,
    });
  });

  it('★ REJECTED 는 DRAFT 와 같은 편집 권한을 갖는다', () => {
    expect(resolveBomActions('REJECTED', ALL_PERMISSIONS)).toEqual(
      resolveBomActions('DRAFT', ALL_PERMISSIONS),
    );
  });

  it('★ PENDING_APPROVAL — 승인·반려만 열린다. ⛔ 편집 불가', () => {
    const actions = resolveBomActions('PENDING_APPROVAL', ALL_PERMISSIONS);
    expect(actions.canApprove).toBe(true);
    expect(actions.canReject).toBe(true);
    expect(actions.canEditHeader).toBe(false);
    expect(actions.canMutateLines).toBe(false);
    expect(actions.canBulkConfirm).toBe(false);
    expect(actions.canSubmit).toBe(false);
  });

  it('★ APPROVED → activate 만 열린다', () => {
    const actions = resolveBomActions('APPROVED', ALL_PERMISSIONS);
    expect(actions.canActivate).toBe(true);
    expect(actions.canDeactivate).toBe(false);
    expect(actions.canMutateLines).toBe(false);
  });

  it('★★ ACTIVE 는 전체 읽기전용 + deactivate + 복제뿐이다', () => {
    const actions = resolveBomActions('ACTIVE', ALL_PERMISSIONS);
    expect(actions.canDeactivate).toBe(true);
    expect(actions.canClone).toBe(true);
    expect(actions.canEditHeader).toBe(false);
    expect(actions.canMutateLines).toBe(false);
    expect(actions.canBulkConfirm).toBe(false);
    expect(actions.canArchive).toBe(false);
    // ⛔ ACTIVE 재활성화 버튼 없음.
    expect(actions.canActivate).toBe(false);
  });

  it('★★ INACTIVE 는 activate 로 되돌릴 수 없다 (BOM_TRANSITIONS)', () => {
    const actions = resolveBomActions('INACTIVE', ALL_PERMISSIONS);
    expect(actions.canActivate).toBe(false);
    expect(actions.canDeactivate).toBe(false);
    expect(actions.canClone).toBe(true);
  });

  it('★★ ARCHIVED 는 mutation 이 전부 닫힌다 (복제 제외)', () => {
    const actions = resolveBomActions('ARCHIVED', ALL_PERMISSIONS);
    const { canClone, ...rest } = actions;
    expect(canClone).toBe(true);
    expect(Object.values(rest).every((value) => value === false)).toBe(true);
  });

  it('★ bom.update 만 있으면 제출·승인 버튼은 나오지 않는다', () => {
    const actions = resolveBomActions('DRAFT', ['bom.read', 'bom.update']);
    expect(actions.canMutateLines).toBe(true);
    expect(actions.canSubmit).toBe(false);
    expect(actions.canArchive).toBe(false);
    expect(actions.canClone).toBe(false);
  });

  it('★ bom.approve 만 있으면 편집은 닫힌 채 승인만 열린다', () => {
    const actions = resolveBomActions('PENDING_APPROVAL', ['bom.read', 'bom.approve']);
    expect(actions.canApprove).toBe(true);
    expect(actions.canMutateLines).toBe(false);
  });

  it('★★ ⛔ role 이름을 하드코딩하지 않는다 — permission 데이터만 본다', () => {
    const source = sourceOf('./bom-detail-view.ts');
    for (const role of ['ADMIN', 'SCM_LEADER', 'SCM_STAFF', 'FINANCE', 'EXECUTIVE']) {
      expect(source, role).not.toContain(role);
    }
  });

  it('★★★ D·E — DRAFT·REJECTED + bom.update 는 행 클릭으로 수정 dialog 를 연다', () => {
    for (const status of ['DRAFT', 'REJECTED']) {
      expect(canEditLineByRowClick(status, ALL_PERMISSIONS), status).toBe(true);
      expect(canEditLineByRowClick(status, ['bom.read', 'bom.update']), status).toBe(true);
    }
  });

  it('★★★ F — 읽기전용 status 는 행 클릭으로 mutation dialog 를 열지 않는다', () => {
    for (const status of ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'INACTIVE', 'ARCHIVED']) {
      expect(canEditLineByRowClick(status, ALL_PERMISSIONS), status).toBe(false);
    }
  });

  it('★★★ G — bom.update 가 없으면 편집 가능 status 라도 행 클릭이 열리지 않는다', () => {
    for (const status of ['DRAFT', 'REJECTED']) {
      expect(canEditLineByRowClick(status, ['bom.read']), status).toBe(false);
      // ⛔ 승인 권한이 편집 권한을 대신하지 않는다.
      expect(canEditLineByRowClick(status, ['bom.read', 'bom.approve']), status).toBe(false);
      expect(canEditLineByRowClick(status, []), status).toBe(false);
    }
  });

  it('★★★ H — dialog 삭제 버튼은 편집 가능 + 권한 + 기존 라인일 때만 렌더된다', () => {
    const code = codeOnly(sourceOf('./[id]/bom-detail-client.tsx'));
    // 그리드가 아니라 dialog 가 삭제를 갖는다.
    expect(code).toContain('canDelete={actions.canMutateLines}');
    expect(code).toContain("canDelete && form.mode === 'edit'");
    // ⛔ 권한이 없으면 disabled 가 아니라 렌더되지 않는다.
    expect(code).not.toContain('disabled={!canDelete}');
  });

  it('★★★ I — 삭제는 기존 DELETE 라인 API 를 그대로 호출한다', () => {
    const code = codeOnly(sourceOf('./[id]/bom-detail-client.tsx'));
    expect(code).toContain("send('DELETE', `/api/boms/${bomId}/lines/${lineForm.lineId}`)");
    // ⛔ 새 endpoint 를 만들지 않았다.
    expect(code).not.toContain('/lines/delete');
    expect(code).not.toContain('/lines/bulk-delete');
  });

  it('★ 진행률은 SUGGESTED 를 미확정으로 센다 (D-31 ⑤)', () => {
    expect(confirmProgress(10, 3)).toBe('확정 7 / 전체 10');
    expect(confirmProgress(0, 0)).toBe('확정 0 / 전체 0');
    expect(confirmProgress(4, 4)).toBe('확정 0 / 전체 4');
  });
});

// ═══════════════════════════════════════════════════════════════
// I. select 후보값 — 서버 enum 과 정확히 같다
// ═══════════════════════════════════════════════════════════════

describe('I. select 후보값', () => {
  it('★★ quantityStatus 는 정확히 3종이다 — BomStatus(7종) 와 다르다', () => {
    expect(BOM_QUANTITY_STATUS_OPTIONS).toEqual(['CONFIRMED', 'SUGGESTED', 'UNKNOWN']);
    expect(BOM_QUANTITY_STATUS_OPTIONS).toHaveLength(3);
  });

  it('componentRole 4종 · supplyType 2종', () => {
    expect(BOM_COMPONENT_ROLE_OPTIONS).toEqual(['PRODUCT', 'MATERIAL', 'PACKAGING', 'SERVICE']);
    expect(BOM_SUPPLY_TYPE_OPTIONS).toEqual(['SELF_SUPPLIED', 'TURNKEY']);
  });
});

// ═══════════════════════════════════════════════════════════════
// J. 화면 소스 계약 — 열 수 · 금지 어휘
// ═══════════════════════════════════════════════════════════════

describe('J. 화면 소스 계약 (D-30 · D-31)', () => {
  const listSource = sourceOf('./boms-client.tsx');
  const detailSource = sourceOf('./[id]/bom-detail-client.tsx');

  it('★★ 목록 열은 정확히 12개다', () => {
    const headers = [
      '상태',
      '상위 SKU',
      '상품명',
      'BOM 유형',
      '버전',
      '적용 시작일',
      '적용 종료일',
      '구성품 수',
      '기준원가',
      '미확정 항목 수',
      '승인자',
      '수정일',
    ];
    expect(headers).toHaveLength(12);
    for (const header of headers) {
      expect(listSource, header).toContain(`>${header}</th>`);
    }
  });

  it('★★★ 라인 그리드는 정확히 15열이다 — ⛔ 16번째 action 열 금지', () => {
    // 열 계약은 **데이터**다 — 마크업이 이 배열을 그대로 map 해서 그린다.
    expect(BOM_LINE_GRID_COLUMNS).toEqual([
      '순번',
      '구성품 SKU',
      '상품명',
      '소요량',
      '소요량 상태',
      '단위',
      '로스율',
      '실제 필요량',
      '구성품 유형',
      '공급유형',
      '대체그룹',
      '필수',
      '투입창고',
      '입수량',
      '상세사양',
    ]);
    expect(BOM_LINE_GRID_COLUMNS).toHaveLength(15);
  });

  it('★★★ 열 정의에 action 계열 label 이 하나도 없다', () => {
    for (const forbidden of ['작업', '관리', 'Action', '수정', '삭제', '비고']) {
      expect(BOM_LINE_GRID_COLUMNS as readonly string[], forbidden).not.toContain(forbidden);
    }
  });

  it('★★★ 그리드가 그 배열을 그대로 그린다 — 하드코딩 `<th>` 가 없다', () => {
    const code = codeOnly(detailSource);
    expect(code).toContain('BOM_LINE_GRID_COLUMNS.map(');
    // ⛔ 16번째 열을 마크업으로 몰래 덧붙이는 경로가 없다.
    expect(code).not.toContain('>작업</th>');
    expect(code).not.toContain('>관리</th>');
    expect(code).not.toContain('>비고</th>');
    // 그리드 머리글에 조건부 `<th>` 자체가 없다.
    expect(code).not.toMatch(/canMutate \? <th/);
  });

  it('★★★ 라인 CRUD 는 행 클릭 + dialog 다 — 셀 안의 수정/삭제 버튼 0', () => {
    const code = codeOnly(detailSource);
    // 행이 수정 dialog 를 연다.
    expect(code).toContain('onEditLine(line)');
    expect(code).toContain("role: 'button' as const");
    // 삭제는 dialog 안에서만 일어난다.
    expect(code).toContain('deleteLineFromDialog');
    // ⛔ 그리드 셀 안에 `수정`/`삭제` 버튼을 두지 않는다.
    expect(code).not.toContain('aria-label={`${line.lineNo} 수정`}');
    expect(code).not.toContain('aria-label={`${line.lineNo} 삭제`}');
  });

  it('★★ 일괄 확정은 top-level 배열을 보낸다 — ⛔ `{items: […]}` wrapper 금지', () => {
    expect(detailSource).toContain('bulk-confirm-qty');
    // 배열 그대로를 body 로 넘긴다.
    expect(detailSource).toContain('/lines/bulk-confirm-qty`, items)');
    expect(detailSource).not.toContain('{ items: items }');
    expect(detailSource).not.toContain('{ items }');
  });

  it('★★ Decimal 을 number 로 훼손하지 않는다', () => {
    for (const [name, source] of [
      ['list', codeOnly(listSource)],
      ['detail', codeOnly(detailSource)],
      ['view', codeOnly(sourceOf('./bom-detail-view.ts'))],
      ['params', codeOnly(sourceOf('./list-params.ts'))],
    ] as const) {
      for (const forbidden of ['parseFloat(', 'Math.round(', 'toFixed(', 'Number(']) {
        expect(source, `${name}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('★★ ⛔ 목록이 행마다 /cost 를 부르지 않는다 (N+1 금지 · U8-8)', () => {
    expect(listSource).not.toContain('/cost');
    expect(listSource).not.toContain('/explode');
  });

  it('★★ ⛔ `/master/boms/new` 라우트를 만들지 않는다 — 신규는 dialog 다', () => {
    expect(listSource).not.toContain('/master/boms/new');
  });

  it('★ 목록 버튼은 정확히 5개다 (신규·복사·승인 요청·승인·활성화)', () => {
    for (const label of ['신규', '복사', '승인 요청', '승인', '활성화']) {
      expect(listSource, label).toContain(label);
    }
    // ⛔ 없는 것 — 업로드·정렬·페이지 크기.
    const code = codeOnly(listSource);
    for (const forbidden of ['엑셀', '업로드', 'pageSize=', '정렬']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('★ 상세는 탭 4개다', () => {
    for (const label of ['구성품', '전개', '원가', '변경이력']) {
      expect(detailSource, label).toContain(`'${label}'`);
    }
  });

  it('★★ 권한 없는 control 은 렌더하지 않는다 — ⛔ disabled 로 남기지 않는다', () => {
    // 모든 mutation 버튼이 `actions.canXxx ? … : null` 형태로 감싸여 있다.
    for (const key of [
      'canEditHeader',
      'canSubmit',
      'canApprove',
      'canReject',
      'canActivate',
      'canDeactivate',
      'canArchive',
      'canClone',
    ]) {
      expect(detailSource, key).toContain(`actions.${key} ? (`);
    }
  });

  it('★★ 단건 원가는 strict 다 — 오류를 배너로 그대로 보여준다 (R8-2)', () => {
    // ⛔ 상세 원가 탭에서 `계산 불가` 로 삼키지 않는다.
    const costTab = detailSource.slice(detailSource.indexOf('function CostTab'));
    expect(costTab).toContain('setError(await readApiError(response))');
    expect(costTab).not.toContain('계산 불가');
  });

  it('★ 변경이력은 actorId UUID 원문을 보여준다 — ⛔ 사용자 조회 API 신설 금지', () => {
    expect(detailSource).toContain('{item.actorId}');
    expect(detailSource).not.toContain('/api/users');
  });
});
