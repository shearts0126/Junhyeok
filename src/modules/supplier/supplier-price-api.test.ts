import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import {
  parseApprovePriceInput,
  parseCreatePriceInput,
  parseListPricesQuery,
  toSupplierSkuPriceView,
  translateSupplierPriceWriteError,
} from '@/modules/supplier/application';
import { ERROR_CODES, httpStatusForCode } from '@/shared/errors';

/**
 * 가격이력 API 단위 테스트 (T06-3) — DB 없이 고정하는 계약.
 *
 * 근거: `docs/17_설계복구_거래처공급조건.md` §58~ (D-1 ~ D-37).
 *
 *   - GET 쿼리: `asOf?` 하나뿐 — page/pageSize/sort 는 400 (D-5)
 *   - CreatePriceDto: 정확히 5필드 · unitPrice 십진 문자열 · 0 허용 ·
 *     음수 422 (형식 400 과 구분) · server-owned/staged 필드 400 (D-6·D-7)
 *   - approve body: `{note?}` — trim·blank→null (D-17)
 *   - 오류코드 3종의 HTTP 상태 (D-35)
 *   - constraint 번역: P2002 `(supplier_sku_id, effective_from)` → 409,
 *     P2039 는 번역하지 않는다 (§46)
 *   - PriceView: 정확히 10필드 — attachmentId 미노출 (D-4·D-26)
 *   - proxy first-match: price 경로가 `supplier.*` 로 잘못 잡히지 않는다 (D-29)
 */

const SS = '33333333-3333-4333-8333-333333333333';

// ═══════════════════════════════════════════════════════════════
// GET 쿼리 — asOf 하나뿐 (D-5)
// ═══════════════════════════════════════════════════════════════

describe('가격 조회 쿼리 — asOf 만 (D-5)', () => {
  it('asOf 없으면 빈 쿼리, 있으면 YYYY-MM-DD 로 통과한다', () => {
    expect(parseListPricesQuery(new URLSearchParams(''))).toEqual({});
    expect(parseListPricesQuery(new URLSearchParams('asOf=2026-08-12'))).toEqual({
      asOf: '2026-08-12',
    });
  });

  it('★ page·pageSize·sort·unknown 키는 400 이다 — pagination 없음', () => {
    for (const bad of ['page=1', 'pageSize=10', 'sort=effectiveFrom', 'foo=1']) {
      expect(() => parseListPricesQuery(new URLSearchParams(bad)), bad).toThrow();
    }
  });

  it('asOf 형식·존재하지 않는 날짜는 400 이다 (§55-9)', () => {
    for (const bad of ['asOf=2026-8-1', 'asOf=20260801', 'asOf=abc', 'asOf=2026-13-40']) {
      expect(() => parseListPricesQuery(new URLSearchParams(bad)), bad).toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// CreatePriceDto (D-6·D-7·D-8·D-9·D-10·§47)
// ═══════════════════════════════════════════════════════════════

describe('CreatePriceDto (D-6)', () => {
  const base = {
    unitPrice: '1234.5678',
    currency: 'KRW',
    vatIncluded: false,
    effectiveFrom: '2026-08-01',
  };

  it('정확히 5필드 계약 — sourceDocument 는 선택이다 (§55-20)', () => {
    const input = parseCreatePriceInput({ ...base, sourceDocument: '단가계약서-2026-08' });
    expect(input).toEqual({
      unitPrice: '1234.5678',
      currency: 'KRW',
      vatIncluded: false,
      effectiveFrom: '2026-08-01',
      sourceDocument: '단가계약서-2026-08',
    });
  });

  it('★ server-owned·staged 필드는 400 이다 (§55-32·33)', () => {
    for (const forbidden of [
      { effectiveTo: '2026-12-01' },
      { effectiveTo: null },
      { attachmentId: '11111111-1111-4111-8111-111111111111' },
      { supplierSkuId: SS },
      { createdBy: SS },
      { approvedBy: SS },
      { approvedAt: '2026-08-01' },
      { approvalStatus: 'APPROVED' },
      { createdAt: '2026-08-01' },
      { updatedAt: '2026-08-01' },
      { deletedAt: null },
      { id: SS },
    ]) {
      expect(() => parseCreatePriceInput({ ...base, ...forbidden })).toThrow();
    }
  });

  it('required 4종은 생략하면 400 이다 (§55-26·27·28)', () => {
    for (const key of ['unitPrice', 'currency', 'vatIncluded', 'effectiveFrom'] as const) {
      const body: Record<string, unknown> = { ...base };
      delete body[key];
      expect(() => parseCreatePriceInput(body), key).toThrow();
    }
  });

  it('★ unitPrice — JSON number 는 400 이다. 문자열 전용 (§55-22)', () => {
    expect(() => parseCreatePriceInput({ ...base, unitPrice: 1234.5678 })).toThrow();
    expect(() => parseCreatePriceInput({ ...base, unitPrice: 0 })).toThrow();
  });

  it('★ unitPrice — "0"·"0.0000" 은 유효한 0원 가격이다 (§55-23)', () => {
    expect(parseCreatePriceInput({ ...base, unitPrice: '0' }).unitPrice).toBe('0');
    expect(parseCreatePriceInput({ ...base, unitPrice: '0.0000' }).unitPrice).toBe('0.0000');
  });

  it('★ unitPrice — 음수는 400 이 아니라 422 UNIT_PRICE_INVALID 다 (§55-24)', () => {
    for (const negative of ['-1', '-0.0001', '-0']) {
      expect(() => parseCreatePriceInput({ ...base, unitPrice: negative }), negative).toThrow(
        expect.objectContaining({ code: ERROR_CODES.SUPPLIER_PRICE_UNIT_PRICE_INVALID }),
      );
    }
  });

  it('unitPrice — scale 5자리·지수·malformed 는 400 이다 (§55-25)', () => {
    for (const bad of ['1.23456', '1e3', '1.', '.5', '12,000', ' 100', '100 ', 'abc', '']) {
      expect(() => parseCreatePriceInput({ ...base, unitPrice: bad }), bad).toThrow();
    }
  });

  it('currency — trim 후 정확히 3글자. allow-list 없음 (D-8, §55-26)', () => {
    expect(parseCreatePriceInput({ ...base, currency: ' USD ' }).currency).toBe('USD');
    // uppercase 강제·ISO enum 없음 — 소문자·비표준 코드도 3글자면 통과한다.
    expect(parseCreatePriceInput({ ...base, currency: 'krw' }).currency).toBe('krw');
    for (const bad of ['KR', 'KRWX', '', '  ', 1234]) {
      expect(() => parseCreatePriceInput({ ...base, currency: bad }), String(bad)).toThrow();
    }
  });

  it('vatIncluded — boolean 만. 문자열 "true" 는 400 (D-9, §55-27)', () => {
    expect(parseCreatePriceInput({ ...base, vatIncluded: true }).vatIncluded).toBe(true);
    for (const bad of ['true', 1, null]) {
      expect(() => parseCreatePriceInput({ ...base, vatIncluded: bad }), String(bad)).toThrow();
    }
  });

  it('effectiveFrom — YYYY-MM-DD. 과거·미래 제한 없음 (D-10, §55-29·30)', () => {
    expect(parseCreatePriceInput({ ...base, effectiveFrom: '2000-01-01' }).effectiveFrom).toBe(
      '2000-01-01',
    );
    expect(parseCreatePriceInput({ ...base, effectiveFrom: '2099-12-31' }).effectiveFrom).toBe(
      '2099-12-31',
    );
    for (const bad of ['2026-8-1', '20260801', '2026-02-30T00:00:00Z']) {
      expect(() => parseCreatePriceInput({ ...base, effectiveFrom: bad }), bad).toThrow();
    }
  });

  it('★ sourceDocument normalize — 생략/null/blank 전부 null, trim 보존 (§47·§55-31)', () => {
    expect(parseCreatePriceInput(base).sourceDocument).toBeNull();
    expect(parseCreatePriceInput({ ...base, sourceDocument: null }).sourceDocument).toBeNull();
    expect(parseCreatePriceInput({ ...base, sourceDocument: '   ' }).sourceDocument).toBeNull();
    expect(parseCreatePriceInput({ ...base, sourceDocument: ' 계약서 ' }).sourceDocument).toBe(
      '계약서',
    );
    expect(() => parseCreatePriceInput({ ...base, sourceDocument: 'x'.repeat(256) })).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// approve body (D-17)
// ═══════════════════════════════════════════════════════════════

describe('approve body — {note?} 뿐 (D-17)', () => {
  it('본문 없음·{}·blank note 전부 note null 로 정규화된다', () => {
    expect(parseApprovePriceInput(undefined)).toEqual({ note: null });
    expect(parseApprovePriceInput({})).toEqual({ note: null });
    expect(parseApprovePriceInput({ note: '   ' })).toEqual({ note: null });
  });

  it('note 는 trim 되어 AuditLog.reason 으로 간다 (§55-47)', () => {
    expect(parseApprovePriceInput({ note: ' 8월 단가 합의 ' })).toEqual({
      note: '8월 단가 합의',
    });
  });

  it('unknown key·비문자열 note 는 400 이다', () => {
    expect(() => parseApprovePriceInput({ reason: 'x' })).toThrow();
    expect(() => parseApprovePriceInput({ note: 'ok', force: true })).toThrow();
    expect(() => parseApprovePriceInput({ note: 123 })).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 오류코드 3종 (D-35)
// ═══════════════════════════════════════════════════════════════

describe('오류코드 — 신규 3종의 HTTP 상태 (D-35)', () => {
  it('EFFECTIVE_FROM_DUPLICATE 409 / UNIT_PRICE_INVALID 422 / CHAIN_CONFLICT 409', () => {
    expect(httpStatusForCode(ERROR_CODES.SUPPLIER_PRICE_EFFECTIVE_FROM_DUPLICATE)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.SUPPLIER_PRICE_UNIT_PRICE_INVALID)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.SUPPLIER_PRICE_CHAIN_CONFLICT)).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════
// constraint 번역 (§46) — 실측 shape 재현
// ═══════════════════════════════════════════════════════════════

function prismaError(
  code: string,
  cause: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('synthetic', {
    code,
    clientVersion: '7.9.1',
    meta: {
      modelName: 'SupplierSkuPrice',
      driverAdapterError: { name: 'DriverAdapterError', cause },
    },
  });
}

describe('★ price constraint 번역 — price 전용 mapper (§46)', () => {
  it('P2002 [supplier_sku_id, effective_from] → 409 PRICE_EFFECTIVE_FROM_DUPLICATE', () => {
    const error = prismaError('P2002', {
      kind: 'UniqueConstraintViolation',
      constraint: { fields: ['supplier_sku_id', 'effective_from'] },
    });
    expect(() => translateSupplierPriceWriteError(error)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SUPPLIER_PRICE_EFFECTIVE_FROM_DUPLICATE }),
    );
  });

  it('구조화 정보가 없으면 constraint 이름 fallback 으로 판정한다', () => {
    const error = prismaError('P2002', {
      kind: 'UniqueConstraintViolation',
      originalMessage:
        'duplicate key value violates unique constraint ' +
        '"supplier_sku_price_supplier_sku_id_effective_from_key"',
    });
    expect(() => translateSupplierPriceWriteError(error)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SUPPLIER_PRICE_EFFECTIVE_FROM_DUPLICATE }),
    );
  });

  it('★ P2039(CHECK 등)는 번역하지 않고 원본 그대로 던진다 — 숨기지 않는다', () => {
    const error = prismaError('P2039', {
      kind: 'postgres',
      code: '23514',
      originalCode: '23514',
      originalMessage: 'check constraint violated',
    });
    let thrown: unknown;
    try {
      translateSupplierPriceWriteError(error);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
  });

  it('P2002 이지만 effective_from 무관이면 원본 그대로 던진다', () => {
    const error = prismaError('P2002', {
      kind: 'UniqueConstraintViolation',
      constraint: { fields: ['id'] },
    });
    let thrown: unknown;
    try {
      translateSupplierPriceWriteError(error);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
  });
});

// ═══════════════════════════════════════════════════════════════
// PriceView (D-4·D-26)
// ═══════════════════════════════════════════════════════════════

describe('PriceView — 정확히 10필드 (D-4)', () => {
  const row = {
    id: '44444444-4444-4444-8444-444444444444',
    supplierSkuId: SS,
    unitPrice: new Prisma.Decimal('1234.5678'),
    currency: 'KRW',
    vatIncluded: true,
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    effectiveTo: null,
    sourceDocument: null,
    attachmentId: '55555555-5555-4555-8555-555555555555',
    createdBy: '66666666-6666-4666-8666-666666666666',
    approvedBy: null,
    createdAt: new Date('2026-08-12T09:30:00.000Z'),
  };

  it('Decimal 은 문자열·날짜는 date-only 로 직렬화된다 (§55-5·7·8)', () => {
    const view = toSupplierSkuPriceView(row);
    expect(view).toEqual({
      id: row.id,
      supplierSkuId: SS,
      unitPrice: '1234.5678',
      currency: 'KRW',
      vatIncluded: true,
      effectiveFrom: '2026-08-01',
      effectiveTo: null,
      sourceDocument: null,
      createdBy: '66666666-6666-4666-8666-666666666666',
      approvedBy: null,
      createdAt: '2026-08-12T09:30:00.000Z',
    });
  });

  it('★ attachmentId 는 row 에 있어도 view 에 없다 (D-26, §55-6)', () => {
    const view = toSupplierSkuPriceView(row);
    expect('attachmentId' in view).toBe(false);
    expect(Object.keys(view).sort()).toEqual(
      [
        'id',
        'supplierSkuId',
        'unitPrice',
        'currency',
        'vatIncluded',
        'effectiveFrom',
        'effectiveTo',
        'sourceDocument',
        'createdBy',
        'approvedBy',
        'createdAt',
      ].sort(),
    );
  });

  it('effectiveTo 가 있으면 date-only, 0원 가격도 문자열 그대로다 (§55-18)', () => {
    const view = toSupplierSkuPriceView({
      ...row,
      unitPrice: new Prisma.Decimal('0'),
      effectiveTo: new Date('2026-12-01T00:00:00.000Z'),
      approvedBy: '77777777-7777-4777-8777-777777777777',
    });
    expect(view.unitPrice).toBe('0');
    expect(view.effectiveTo).toBe('2026-12-01');
    expect(view.approvedBy).toBe('77777777-7777-4777-8777-777777777777');
  });
});

// ═══════════════════════════════════════════════════════════════
// proxy first-match (D-29) — §55-71~74
// ═══════════════════════════════════════════════════════════════

describe('★ proxy 정책 — price 경로 first-match (D-29)', () => {
  const pricesPath = `/api/supplier-skus/${SS}/prices`;
  const approvePath = `/api/supplier-sku-prices/${SS}/approve`;

  it('71. GET/HEAD prices → supplier_price.read', () => {
    expect(resolveRoutePermission({ pathname: pricesPath, method: 'GET' })).toBe(
      'supplier_price.read',
    );
    expect(resolveRoutePermission({ pathname: pricesPath, method: 'HEAD' })).toBe(
      'supplier_price.read',
    );
  });

  it('72. POST prices → supplier_price.create', () => {
    expect(resolveRoutePermission({ pathname: pricesPath, method: 'POST' })).toBe(
      'supplier_price.create',
    );
  });

  it('73. POST approve → supplier_price.approve', () => {
    expect(resolveRoutePermission({ pathname: approvePath, method: 'POST' })).toBe(
      'supplier_price.approve',
    );
  });

  it('★ 74. price 경로가 기존 supplier.update 로 잘못 잡히지 않는다', () => {
    // GET/POST 는 price 정책이 먼저 잡는다 — 인증-only gap 이 닫혔다.
    expect(resolveRoutePermission({ pathname: pricesPath, method: 'GET' })).not.toBe(
      'supplier.read',
    );
    expect(resolveRoutePermission({ pathname: pricesPath, method: 'POST' })).not.toBe(
      'supplier.update',
    );
    // 존재하지 않는 변경성 메서드(405)는 여전히 supplier.update 1차 가드에 잡힌다.
    expect(resolveRoutePermission({ pathname: pricesPath, method: 'PATCH' })).toBe(
      'supplier.update',
    );
  });

  it('기존 T06-2 정책은 그대로다 — regression (§55-80)', () => {
    expect(resolveRoutePermission({ pathname: '/api/suppliers', method: 'GET' })).toBe(
      'supplier.read',
    );
    expect(resolveRoutePermission({ pathname: '/api/suppliers', method: 'POST' })).toBe(
      'supplier.create',
    );
    expect(resolveRoutePermission({ pathname: `/api/supplier-skus/${SS}`, method: 'PATCH' })).toBe(
      'supplier.update',
    );
    expect(resolveRoutePermission({ pathname: `/api/suppliers/${SS}/skus`, method: 'POST' })).toBe(
      'supplier.create',
    );
  });
});
