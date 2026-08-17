import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import {
  assertBomEditable,
  assertNoQueryParams,
  assertPeriodOrder,
  bomListWhere,
  countsOf,
  isBomEditable,
  parseCreateBomInput,
  parseCreateLineInput,
  parseListBomsQuery,
  parseUpdateBomInput,
  parseUpdateLineInput,
  BOM_CREATE_ROUTE_SCOPE,
  BOM_EDITABLE_STATUSES,
  BOM_PAGE_SIZE,
  bomLineCreateRouteScope,
} from '@/modules/bom/application';
import { ERROR_CODES, httpStatusForCode } from '@/shared/errors';

/**
 * BOM CRUD API 단위 테스트 (T07-3) — DB 없이 고정하는 계약.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-6(편집 가능 상태) · §D-9 · §D-10 · §D-14
 *    (exact DTO) · §D-15(route-policy) · §D-17(멱등 scope) · §D-29(오류코드)
 *    · §D-31(목록 필터).
 *
 * 특히 §D-32 test matrix 가 T07-3 unit 에 요구한 것:
 *   - DTO strict
 *   - 편집 가능 상태
 *   - route-policy first-match
 *   - **`alternateGroup` trim → blank → null 정규화**
 */

const SKU = '11111111-1111-4111-8111-111111111111';
const SKU2 = '22222222-2222-4222-8222-222222222222';
const SUP = '33333333-3333-4333-8333-333333333333';
const WH = '44444444-4444-4444-8444-444444444444';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('예외가 발생하지 않았다');
}

// ═══════════════════════════════════════════════════════════════
// GET /api/boms 쿼리 (D-31 · D-14)
// ═══════════════════════════════════════════════════════════════

describe('BOM 목록 쿼리 — 정확히 7개 (D-31)', () => {
  it('빈 쿼리는 page=1 기본값만 갖는다', () => {
    expect(parseListBomsQuery(new URLSearchParams(''))).toEqual({ page: 1 });
  });

  it('7개 필터가 전부 통과한다', () => {
    const query = parseListBomsQuery(
      new URLSearchParams(
        `q=ZZ&status=ACTIVE&bomType=KIT&parentSkuId=${SKU}&effectiveOn=2026-08-16&hasUnknownQty=true&page=3`,
      ),
    );
    expect(query).toEqual({
      q: 'ZZ',
      status: 'ACTIVE',
      bomType: 'KIT',
      parentSkuId: SKU,
      effectiveOn: '2026-08-16',
      hasUnknownQty: 'true',
      page: 3,
    });
  });

  it('★ pageSize·sort·창고·거래처 필터는 400 이다 — 조용히 무시하지 않는다', () => {
    for (const bad of [
      'pageSize=10',
      'sort=version',
      'warehouseId=x',
      'supplierId=x',
      'asOf=2026-08-16',
      'foo=1',
    ]) {
      expect(() => parseListBomsQuery(new URLSearchParams(bad)), bad).toThrow();
    }
  });

  it('잘못된 enum·UUID·날짜는 400 이다', () => {
    for (const bad of [
      'status=WHATEVER',
      'bomType=ASSEMBLY',
      'parentSkuId=not-a-uuid',
      'effectiveOn=2026-8-1',
      'effectiveOn=2026-13-40',
      'hasUnknownQty=yes',
      'page=0',
    ]) {
      expect(() => parseListBomsQuery(new URLSearchParams(bad)), bad).toThrow();
    }
  });

  it('페이지 크기는 서버 고정 50 이다', () => {
    expect(BOM_PAGE_SIZE).toBe(50);
  });
});

describe('★ effectiveOn 은 반열림 기간 필터이며 status 를 함의하지 않는다', () => {
  it('effectiveFrom <= D AND (effectiveTo IS NULL OR effectiveTo > D)', () => {
    const where = bomListWhere({ page: 1, effectiveOn: '2026-08-16' });
    expect(where.effectiveFrom).toEqual({ lte: new Date('2026-08-16T00:00:00.000Z') });
    expect(where.OR).toEqual([
      { effectiveTo: null },
      { effectiveTo: { gt: new Date('2026-08-16T00:00:00.000Z') } },
    ]);
    // ★ status 를 끼워넣지 않는다 — 넣으면 status 필터와 서로를 무효화한다.
    expect(where.status).toBeUndefined();
  });

  it('status 와 함께 주면 두 조건이 모두 적용된다', () => {
    const where = bomListWhere({ page: 1, effectiveOn: '2026-08-16', status: 'DRAFT' });
    expect(where.status).toBe('DRAFT');
    expect(where.effectiveFrom).toBeDefined();
  });
});

describe('★ hasUnknownQty 는 quantityStatus 로 판정한다 (D-10)', () => {
  it('true 는 UNKNOWN 라인 보유, false 는 0건이다', () => {
    expect(bomListWhere({ page: 1, hasUnknownQty: 'true' }).lines).toEqual({
      some: { quantityStatus: 'UNKNOWN' },
    });
    expect(bomListWhere({ page: 1, hasUnknownQty: 'false' }).lines).toEqual({
      none: { quantityStatus: 'UNKNOWN' },
    });
  });

  it('⛔ quantityPer IS NULL 로 판정하지 않는다', () => {
    const where = bomListWhere({ page: 1, hasUnknownQty: 'true' });
    expect(JSON.stringify(where)).not.toContain('quantityPer');
  });

  it('생략하면 라인 조건 자체가 없다', () => {
    expect(bomListWhere({ page: 1 }).lines).toBeUndefined();
  });
});

describe('q 는 상위 SKU 코드·상품명만 본다', () => {
  it('parentSku 관계에 contains(insensitive) 두 개를 건다', () => {
    expect(bomListWhere({ page: 1, q: 'ZZ' }).parentSku).toEqual({
      OR: [
        { skuCode: { contains: 'ZZ', mode: 'insensitive' } },
        { skuName: { contains: 'ZZ', mode: 'insensitive' } },
      ],
    });
  });
});

describe('read endpoint 는 파라미터를 받지 않는다', () => {
  it('빈 쿼리는 통과, 어떤 키든 400 이다', () => {
    expect(() => assertNoQueryParams(new URLSearchParams(''), 'x')).not.toThrow();
    expect(() => assertNoQueryParams(new URLSearchParams('page=1'), 'x')).toThrow();
    expect(() => assertNoQueryParams(new URLSearchParams('asOf=2026-08-16'), 'x')).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// CreateBomDto (D-14)
// ═══════════════════════════════════════════════════════════════

describe('CreateBomDto (D-14)', () => {
  const base = {
    parentSkuId: SKU,
    bomType: 'MANUFACTURING' as const,
    version: '1.0',
    effectiveFrom: '2026-08-16',
  };

  it('필수 4필드만으로 통과한다 — outputQty·outputUom 은 선택이다', () => {
    expect(parseCreateBomInput(base)).toEqual(base);
  });

  it('선택 필드가 전부 통과한다', () => {
    const input = parseCreateBomInput({
      ...base,
      outputQty: '10',
      outputUom: 'EA',
      effectiveTo: '2027-01-01',
      productionPartnerId: SUP,
      destinationWarehouseId: WH,
      overallLossRate: '0.05',
      description: '설명',
      changeReason: '사유',
    });
    expect(input.outputQty).toBe('10');
    expect(input.destinationWarehouseId).toBe(WH);
  });

  it('★ server-managed 필드는 400 이다 (strictObject)', () => {
    for (const forbidden of [
      { id: SKU },
      { status: 'ACTIVE' },
      { createdBy: SKU },
      { createdAt: '2026-08-16' },
      { approvedBy: SKU },
      { approvedAt: '2026-08-16' },
      { activatedAt: '2026-08-16' },
      { lines: [] },
      { legacyBomCode: 'X' },
      { legacyCommonBomCode: 'X' },
      { foo: 1 },
    ]) {
      expect(
        () => parseCreateBomInput({ ...base, ...forbidden }),
        JSON.stringify(forbidden),
      ).toThrow();
    }
  });

  it('★ Decimal 은 문자열 전용 — JSON number 는 400 이다', () => {
    expect(() => parseCreateBomInput({ ...base, outputQty: 10 })).toThrow();
    expect(() => parseCreateBomInput({ ...base, overallLossRate: 0.05 })).toThrow();
  });

  it('outputQty 는 0·음수·지수표기를 거부한다', () => {
    for (const bad of ['0', '0.000000', '-1', '1e3', '', 'abc']) {
      expect(() => parseCreateBomInput({ ...base, outputQty: bad }), bad).toThrow();
    }
  });

  it('★ overallLossRate 는 0 이상 1 미만이다 (D-9)', () => {
    expect(parseCreateBomInput({ ...base, overallLossRate: '0' }).overallLossRate).toBe('0');
    expect(parseCreateBomInput({ ...base, overallLossRate: '0.999999' }).overallLossRate).toBe(
      '0.999999',
    );
    for (const bad of ['1', '1.5', '-0.1']) {
      expect(() => parseCreateBomInput({ ...base, overallLossRate: bad }), bad).toThrow();
    }
  });

  it('★ effectiveFrom 은 required — 서버가 오늘로 채우지 않는다 (D-5)', () => {
    const { effectiveFrom: _omitted, ...withoutFrom } = base;
    expect(() => parseCreateBomInput(withoutFrom)).toThrow();
  });

  it('★ effectiveTo 는 effectiveFrom 보다 뒤여야 한다 (D-5 CHECK 선검증)', () => {
    expect(() => parseCreateBomInput({ ...base, effectiveTo: '2026-08-16' })).toThrow();
    expect(() => parseCreateBomInput({ ...base, effectiveTo: '2026-08-15' })).toThrow();
    expect(() => parseCreateBomInput({ ...base, effectiveTo: '2026-08-17' })).not.toThrow();
    expect(() => parseCreateBomInput({ ...base, effectiveTo: null })).not.toThrow();
  });

  it('version 은 1~20자다', () => {
    expect(() => parseCreateBomInput({ ...base, version: '' })).toThrow();
    expect(() => parseCreateBomInput({ ...base, version: 'v'.repeat(21) })).toThrow();
  });
});

describe('assertPeriodOrder (D-5)', () => {
  it('null 은 열린 구간이라 항상 통과한다', () => {
    expect(() => assertPeriodOrder('2026-08-16', null)).not.toThrow();
  });
  it('같은 날은 거부한다 — half-open 이라 빈 구간이 된다', () => {
    expect(() => assertPeriodOrder('2026-08-16', '2026-08-16')).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// UpdateBomDto (D-14)
// ═══════════════════════════════════════════════════════════════

describe('UpdateBomDto — parentSkuId·version 을 뺀 부분집합 (D-14)', () => {
  it('★ parentSkuId·version 변경은 400 이다 — 다른 BOM 이 된다', () => {
    expect(() => parseUpdateBomInput({ parentSkuId: SKU })).toThrow();
    expect(() => parseUpdateBomInput({ version: '2.0' })).toThrow();
  });

  it('★ generic status PATCH 는 400 이다 (D-6)', () => {
    expect(() => parseUpdateBomInput({ status: 'ACTIVE' })).toThrow();
  });

  it('빈 body 는 400 이다', () => {
    expect(() => parseUpdateBomInput({})).toThrow();
  });

  it('한 필드만 있어도 통과한다', () => {
    expect(parseUpdateBomInput({ description: '변경' })).toEqual({ description: '변경' });
  });

  it('effectiveFrom 단독 변경이 허용된다 — cycle 재검사 대상이다', () => {
    expect(parseUpdateBomInput({ effectiveFrom: '2027-01-01' })).toEqual({
      effectiveFrom: '2027-01-01',
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// CreateLineDto / UpdateLineDto (D-14 · D-9)
// ═══════════════════════════════════════════════════════════════

describe('CreateLineDto (D-14)', () => {
  const base = { componentSkuId: SKU2, componentRole: 'MATERIAL' as const };

  it('필수는 componentSkuId·componentRole 둘뿐이다', () => {
    expect(parseCreateLineInput(base)).toEqual(base);
  });

  it('★ lineNo·uom·quantityStatus 는 선택이다 — 서버가 채운다', () => {
    const input = parseCreateLineInput({ ...base, lineNo: null });
    expect(input.lineNo).toBeNull();
    expect(input.uom).toBeUndefined();
    expect(input.quantityStatus).toBeUndefined();
  });

  it('★ server-owned·이동 필드는 400 이다', () => {
    for (const forbidden of [
      { id: SKU },
      { bomHeaderId: SKU },
      { legacyBomCode: 'X' },
      { legacyCommonBomCode: 'X' },
      { foo: 1 },
    ]) {
      expect(
        () => parseCreateLineInput({ ...base, ...forbidden }),
        JSON.stringify(forbidden),
      ).toThrow();
    }
  });

  it('★ Decimal 3종은 문자열 전용이다', () => {
    for (const key of ['quantityPer', 'lossRate', 'packQuantity']) {
      expect(() => parseCreateLineInput({ ...base, [key]: 1 }), key).toThrow();
    }
  });

  it('componentRole 4종·supplyType 2종만 허용한다', () => {
    for (const role of ['PRODUCT', 'MATERIAL', 'PACKAGING', 'SERVICE'] as const) {
      expect(() => parseCreateLineInput({ ...base, componentRole: role })).not.toThrow();
    }
    expect(() => parseCreateLineInput({ ...base, componentRole: 'SUBASSEMBLY' })).toThrow();
    for (const supply of ['SELF_SUPPLIED', 'TURNKEY'] as const) {
      expect(() => parseCreateLineInput({ ...base, supplyType: supply })).not.toThrow();
    }
    expect(() => parseCreateLineInput({ ...base, supplyType: 'OEM' })).toThrow();
  });

  it('packQuantity 는 > 0 이고 lossRate 는 0 이상 1 미만이다 (D-9)', () => {
    expect(() => parseCreateLineInput({ ...base, packQuantity: '0' })).toThrow();
    expect(() => parseCreateLineInput({ ...base, packQuantity: '30' })).not.toThrow();
    expect(() => parseCreateLineInput({ ...base, lossRate: '1' })).toThrow();
    expect(() => parseCreateLineInput({ ...base, lossRate: '0' })).not.toThrow();
  });

  it('★ quantityPer 는 DTO 에서 형식만 본다 — 0 정합은 도메인이 422 로 판정한다', () => {
    // 형식 위반은 400.
    expect(() => parseCreateLineInput({ ...base, quantityPer: 'abc' })).toThrow();
    expect(() => parseCreateLineInput({ ...base, quantityPer: '-1' })).toThrow();
    // "0" 은 형식상 유효 — 422 판정은 assertQuantityConsistency 의 몫이다.
    expect(parseCreateLineInput({ ...base, quantityPer: '0' }).quantityPer).toBe('0');
  });
});

describe('★ alternateGroup — trim → blank → null 정규화 (D-3 · §D-32 unit 필수)', () => {
  const base = { componentSkuId: SKU2, componentRole: 'MATERIAL' as const };

  it("공백만 있는 값은 null 이 된다 — `''` 저장 경로가 없다", () => {
    for (const blank of ['', ' ', '   ', '\t', '\n  ']) {
      expect(parseCreateLineInput({ ...base, alternateGroup: blank }).alternateGroup).toBeNull();
    }
  });

  it('앞뒤 공백은 잘린다', () => {
    expect(parseCreateLineInput({ ...base, alternateGroup: '  ALT-A  ' }).alternateGroup).toBe(
      'ALT-A',
    );
  });

  it('명시적 null 도 null 이다', () => {
    expect(parseCreateLineInput({ ...base, alternateGroup: null }).alternateGroup).toBeNull();
  });

  it('50자 초과는 400 이다', () => {
    expect(() => parseCreateLineInput({ ...base, alternateGroup: 'A'.repeat(51) })).toThrow();
    expect(() => parseCreateLineInput({ ...base, alternateGroup: 'A'.repeat(50) })).not.toThrow();
  });

  it('PATCH 에서도 같은 정규화가 적용된다', () => {
    expect(parseUpdateLineInput({ alternateGroup: '   ' }).alternateGroup).toBeNull();
    expect(parseUpdateLineInput({ alternateGroup: ' G1 ' }).alternateGroup).toBe('G1');
  });
});

describe('UpdateLineDto — lineNo 를 뺀 부분집합 (D-14)', () => {
  it('★ lineNo·bomHeaderId 변경은 400 이다 — 라인 이동 없음', () => {
    expect(() => parseUpdateLineInput({ lineNo: 2 })).toThrow();
    expect(() => parseUpdateLineInput({ bomHeaderId: SKU })).toThrow();
  });

  it('★ componentSkuId 는 변경 가능하다 — topology 가 바뀌므로 cycle 재검사 대상', () => {
    expect(parseUpdateLineInput({ componentSkuId: SKU2 })).toEqual({ componentSkuId: SKU2 });
  });

  it('빈 body 는 400 이다', () => {
    expect(() => parseUpdateLineInput({})).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 편집 가능 상태 (D-6)
// ═══════════════════════════════════════════════════════════════

describe('★ 편집 가능 상태 (D-6)', () => {
  it('DRAFT·REJECTED 만 편집 가능하다', () => {
    expect([...BOM_EDITABLE_STATUSES]).toEqual(['DRAFT', 'REJECTED']);
    expect(isBomEditable('DRAFT')).toBe(true);
    expect(isBomEditable('REJECTED')).toBe(true);
    for (const status of ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'INACTIVE', 'ARCHIVED']) {
      expect(isBomEditable(status), status).toBe(false);
    }
  });

  it('★ ACTIVE 만 BOM_ACTIVE_IMMUTABLE 이다 (원문 코드)', () => {
    expect(codeOf(() => assertBomEditable('b', 'ACTIVE'))).toBe(ERROR_CODES.BOM_ACTIVE_IMMUTABLE);
  });

  it('★ 나머지 편집 불가 상태는 BOM_NOT_EDITABLE 이다 — 두 오류를 합치지 않는다', () => {
    for (const status of ['PENDING_APPROVAL', 'APPROVED', 'INACTIVE', 'ARCHIVED']) {
      expect(
        codeOf(() => assertBomEditable('b', status)),
        status,
      ).toBe(ERROR_CODES.BOM_NOT_EDITABLE);
    }
  });

  it('편집 가능 상태는 통과한다', () => {
    expect(() => assertBomEditable('b', 'DRAFT')).not.toThrow();
    expect(() => assertBomEditable('b', 'REJECTED')).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 오류코드 HTTP 상태 (D-29)
// ═══════════════════════════════════════════════════════════════

describe('T07-3 신규 오류코드 5종의 HTTP 상태 (D-29)', () => {
  it('422 3종 · 409 3종', () => {
    expect(httpStatusForCode(ERROR_CODES.BOM_ACTIVE_IMMUTABLE)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.BOM_NOT_EDITABLE)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.BOM_VERSION_DUPLICATE)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.BOM_PERIOD_OVERLAP)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.BOM_LINE_DUPLICATE)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.BOM_NOT_FOUND)).toBe(404);
  });

  it('⛔ workflow·cost 전용 코드는 아직 없다 — 후속 Task 가 추가한다', () => {
    expect(ERROR_CODES).not.toHaveProperty('BOM_INVALID_TRANSITION');
    expect(ERROR_CODES).not.toHaveProperty('BOM_SUPPLIER_SELECTION_CONFLICT');
  });
});

// ═══════════════════════════════════════════════════════════════
// 멱등 scope (D-17)
// ═══════════════════════════════════════════════════════════════

describe('★ 멱등 routeScope 는 docs/18 D-17 표 그대로다', () => {
  it('BOM 생성은 bom:create', () => {
    expect(BOM_CREATE_ROUTE_SCOPE).toBe('bom:create');
  });

  it('★ 라인 생성 scope 는 실제 bomId 를 포함한다 — BOM 별로 독립이다', () => {
    expect(bomLineCreateRouteScope('abc')).toBe('bom:abc:line:create');
    expect(bomLineCreateRouteScope('abc')).not.toBe(bomLineCreateRouteScope('xyz'));
  });
});

// ═══════════════════════════════════════════════════════════════
// counts (D-14 · D-31 진행률 바)
// ═══════════════════════════════════════════════════════════════

describe('unconfirmedCount 는 CONFIRMED 가 아닌 라인 수다', () => {
  it('SUGGESTED 도 미확정이다 (D-10)', () => {
    expect(
      countsOf([
        { quantityStatus: 'CONFIRMED' },
        { quantityStatus: 'SUGGESTED' },
        { quantityStatus: 'UNKNOWN' },
      ]),
    ).toEqual({ lineCount: 3, unconfirmedCount: 2 });
  });

  it('라인이 없으면 0/0 이다', () => {
    expect(countsOf([])).toEqual({ lineCount: 0, unconfirmedCount: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════
// route-policy first-match (D-15)
// ═══════════════════════════════════════════════════════════════

describe('★ route-policy — BOM 경로 (D-15)', () => {
  const BOM = '55555555-5555-4555-8555-555555555555';
  const LINE = '66666666-6666-4666-8666-666666666666';

  it('목록·상세 GET 은 bom.read 다', () => {
    expect(resolveRoutePermission({ pathname: '/api/boms', method: 'GET' })).toBe('bom.read');
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}`, method: 'GET' })).toBe(
      'bom.read',
    );
    expect(resolveRoutePermission({ pathname: '/api/boms', method: 'HEAD' })).toBe('bom.read');
  });

  it('POST /api/boms 는 bom.create 다', () => {
    expect(resolveRoutePermission({ pathname: '/api/boms', method: 'POST' })).toBe('bom.create');
  });

  it('PATCH /api/boms/{id} 는 bom.update 다', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}`, method: 'PATCH' })).toBe(
      'bom.update',
    );
  });

  it('★ 라인 POST 는 bom.create 가 아니라 bom.update 다', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/lines`, method: 'POST' })).toBe(
      'bom.update',
    );
  });

  it('라인 단건 PATCH·DELETE 도 bom.update 다', () => {
    for (const method of ['PATCH', 'DELETE'] as const) {
      expect(
        resolveRoutePermission({ pathname: `/api/boms/${BOM}/lines/${LINE}`, method }),
        method,
      ).toBe('bom.update');
    }
  });

  it('★ workflow suffix 는 일반 POST 정책보다 앞에 있다 — bom.create 로 새지 않는다', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/submit`, method: 'POST' })).toBe(
      'bom.submit',
    );
    for (const action of ['approve', 'reject', 'activate', 'deactivate', 'archive']) {
      expect(
        resolveRoutePermission({ pathname: `/api/boms/${BOM}/${action}`, method: 'POST' }),
        action,
      ).toBe('bom.approve');
    }
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/clone`, method: 'POST' })).toBe(
      'bom.create',
    );
  });

  it('★★ RESERVED POLICY — 예약 정책 8개가 D-15 matrix 와 1:1 일치한다', () => {
    // ⛔ 아래 경로들은 **route handler 가 없다**(404). 정책만 예약돼 있다.
    const reserved: readonly [string, string][] = [
      [`/api/boms/${BOM}/submit`, 'bom.submit'],
      [`/api/boms/${BOM}/approve`, 'bom.approve'],
      [`/api/boms/${BOM}/reject`, 'bom.approve'],
      [`/api/boms/${BOM}/activate`, 'bom.approve'],
      [`/api/boms/${BOM}/deactivate`, 'bom.approve'],
      [`/api/boms/${BOM}/archive`, 'bom.approve'],
      [`/api/boms/${BOM}/clone`, 'bom.create'],
    ];
    for (const [pathname, permission] of reserved) {
      expect(resolveRoutePermission({ pathname, method: 'POST' }), pathname).toBe(permission);
    }
    // 화면 예약 — T07-8 이 만들 `/master/boms` 가 인증-only 로 열리지 않게 한다.
    expect(resolveRoutePermission({ pathname: '/master/boms', method: 'GET' })).toBe('bom.read');
    expect(resolveRoutePermission({ pathname: `/master/boms/${BOM}`, method: 'GET' })).toBe(
      'bom.read',
    );
  });

  it('★ 예약은 정책일 뿐 endpoint 가 아니다 — workflow route handler 가 0개다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const bomsDir = fileURLToPath(new URL('../../app/api/boms', import.meta.url));
    expect(readdirSync(bomsDir).sort()).toEqual(['[id]', 'route.ts']);
    // 상세 하위에는 `lines` 와 route.ts 뿐 — submit/approve/clone 등이 없다.
    expect(readdirSync(`${bomsDir}/[id]`).sort()).toEqual(['lines', 'route.ts']);
    expect(readdirSync(`${bomsDir}/[id]/lines`).sort()).toEqual(['[lineId]', 'route.ts']);
  });

  it('★ T07-4 의 bulk-confirm-qty 는 contains:/lines 로 bom.update 에 잡힌다', () => {
    expect(
      resolveRoutePermission({
        pathname: `/api/boms/${BOM}/lines/bulk-confirm-qty`,
        method: 'POST',
      }),
    ).toBe('bom.update');
  });
});

describe('★★ where-used 가 sku.read 로 shadow 되지 않는다 (D-15)', () => {
  const SKU_ID = '77777777-7777-4777-8777-777777777777';

  it('where-used 는 bom.read 다', () => {
    expect(
      resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/where-used`, method: 'GET' }),
    ).toBe('bom.read');
    expect(
      resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/where-used`, method: 'HEAD' }),
    ).toBe('bom.read');
  });

  it('★ 기존 /api/skus 정책은 그대로다 — 회귀 없음', () => {
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'GET' })).toBe('sku.read');
    expect(resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}`, method: 'GET' })).toBe(
      'sku.read',
    );
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'POST' })).toBe('sku.create');
    expect(resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}`, method: 'PATCH' })).toBe(
      'sku.update',
    );
    expect(
      resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/barcodes`, method: 'GET' }),
    ).toBe('barcode.read');
    expect(
      resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/supplier-skus`, method: 'GET' }),
    ).toBe('supplier.read');
    expect(resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/submit`, method: 'POST' })).toBe(
      'sku.submit',
    );
  });
});
