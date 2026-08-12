import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import {
  parseCreateSupplierInput,
  parseCreateSupplierSkuInput,
  parseListSuppliersQuery,
  parseListSupplierSkusQuery,
  parseUpdateSupplierInput,
  parseUpdateSupplierSkuInput,
  SUPPLIER_PAGE_SIZE,
  translateSupplierSkuWriteError,
  translateSupplierWriteError,
  toSupplierSkuView,
} from '@/modules/supplier/application';
import { ERROR_CODES, httpStatusForCode } from '@/shared/errors';

/**
 * 거래처·공급조건 API 단위 테스트 (T06-2) — DB 없이 고정하는 계약.
 *
 * 근거: `docs/17_설계복구_거래처공급조건.md` §39~ (D-1 ~ D-30).
 *
 *   - DTO: unknown key 400 · server-owned 필드 거부 · Decimal 문자열 전용 ·
 *     leadTime 0 보존 · PATCH mode 판별
 *   - proxy 정책: `/api/suppliers`·`/api/supplier-skus` 의 method 별 권한
 *   - constraint 번역: **실측 Prisma error shape** 재현 —
 *     P2039/23P01(EXCLUDE) vs P2039/23514(CHECK), P2002 3종 구분
 *   - view: `effectiveLeadTimeDays` 는 `??` 폴백 — `0` 이 삼켜지지 않는다
 */

// ═══════════════════════════════════════════════════════════════
// Supplier 목록 쿼리
// ═══════════════════════════════════════════════════════════════

describe('Supplier 목록 쿼리 — q·supplierType·status·page 만', () => {
  it('4개 파라미터만 통과하고 page 는 기본 1 이다', () => {
    const query = parseListSuppliersQuery(
      new URLSearchParams('q=포뷰&supplierType=MANUFACTURER&status=ACTIVE'),
    );
    expect(query).toEqual({
      q: '포뷰',
      supplierType: 'MANUFACTURER',
      status: 'ACTIVE',
      page: 1,
    });
  });

  it('★ pageSize·sort·unknown 키는 400 이다 (서버 고정 50)', () => {
    for (const bad of ['pageSize=10', 'sort=name', 'foo=1']) {
      expect(() => parseListSuppliersQuery(new URLSearchParams(bad)), bad).toThrow();
    }
    expect(SUPPLIER_PAGE_SIZE).toBe(50);
  });

  it('page 는 양의 정수만 — 0·음수·문자는 400', () => {
    for (const bad of ['page=0', 'page=-1', 'page=abc']) {
      expect(() => parseListSuppliersQuery(new URLSearchParams(bad)), bad).toThrow();
    }
    expect(parseListSuppliersQuery(new URLSearchParams('page=3')).page).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// CreateSupplierDto
// ═══════════════════════════════════════════════════════════════

describe('CreateSupplierDto (D-4)', () => {
  const base = {
    supplierCode: 'SUP-001',
    supplierName: '포뷰트 제조',
    supplierType: 'MANUFACTURER',
  };

  it('required 3종 + nullable 6종이 계약 전부다', () => {
    const input = parseCreateSupplierInput({
      ...base,
      businessRegistrationNo: null,
      contactName: '홍길동',
      contactPhone: null,
      contactEmail: null,
      defaultLeadTimeDays: 14,
      note: null,
    });
    expect(input.supplierCode).toBe('SUP-001');
    expect(input.defaultLeadTimeDays).toBe(14);
  });

  it('★ server-owned·staged 필드는 400 이다', () => {
    for (const forbidden of [
      { status: 'ACTIVE' },
      { defaultWarehouseId: '11111111-1111-4111-8111-111111111111' },
      { id: '11111111-1111-4111-8111-111111111111' },
      { createdAt: '2026-01-01' },
      { updatedAt: '2026-01-01' },
      { createdBy: 'x' },
      { approvedBy: 'x' },
      { deletedAt: null },
    ]) {
      expect(() => parseCreateSupplierInput({ ...base, ...forbidden })).toThrow();
    }
  });

  it('required 문자열은 blank 를 거부하고 trim 한다', () => {
    expect(() => parseCreateSupplierInput({ ...base, supplierCode: '   ' })).toThrow();
    expect(() => parseCreateSupplierInput({ ...base, supplierName: '' })).toThrow();
    expect(parseCreateSupplierInput({ ...base, supplierType: ' VENDOR ' }).supplierType).toBe(
      'VENDOR',
    );
  });

  it('★ supplierType 은 open string — 예시 4종 밖 값도 통과한다 (D-5)', () => {
    expect(parseCreateSupplierInput({ ...base, supplierType: 'CUSTOM_KIND' }).supplierType).toBe(
      'CUSTOM_KIND',
    );
  });

  it('★ defaultLeadTimeDays — null·0 유효, 음수·소수 400 (G-03)', () => {
    expect(
      parseCreateSupplierInput({ ...base, defaultLeadTimeDays: null }).defaultLeadTimeDays,
    ).toBeNull();
    expect(parseCreateSupplierInput({ ...base, defaultLeadTimeDays: 0 }).defaultLeadTimeDays).toBe(
      0,
    );
    expect(() => parseCreateSupplierInput({ ...base, defaultLeadTimeDays: -1 })).toThrow();
    expect(() => parseCreateSupplierInput({ ...base, defaultLeadTimeDays: 1.5 })).toThrow();
  });
});

describe('Supplier PATCH DTO (D-7·D-8)', () => {
  it('{} 는 400 — 변경 필드 최소 하나', () => {
    expect(() => parseUpdateSupplierInput({})).toThrow();
  });

  it('★ supplierCode·status·defaultWarehouseId 는 400 이다', () => {
    expect(() => parseUpdateSupplierInput({ supplierCode: 'NEW' })).toThrow();
    expect(() => parseUpdateSupplierInput({ status: 'INACTIVE' })).toThrow();
    expect(() =>
      parseUpdateSupplierInput({ defaultWarehouseId: '11111111-1111-4111-8111-111111111111' }),
    ).toThrow();
  });

  it('nullable 은 null 로 비울 수 있고, supplierName·Type 은 null 불가', () => {
    const patch = parseUpdateSupplierInput({ businessRegistrationNo: null, note: null });
    expect(patch.businessRegistrationNo).toBeNull();
    expect(() => parseUpdateSupplierInput({ supplierName: null })).toThrow();
    expect(() => parseUpdateSupplierInput({ supplierType: null })).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// SupplierSku DTO
// ═══════════════════════════════════════════════════════════════

const SKU_ID = '22222222-2222-4222-8222-222222222222';

describe('CreateSupplierSkuDto (D-12~D-14)', () => {
  const base = { skuId: SKU_ID, supplyType: 'SELF_SUPPLIED', effectiveFrom: '2026-01-01' };

  it('★ skuId·supplyType·effectiveFrom 이 required 다 — DB default 와 무관하다 (D-13)', () => {
    expect(() =>
      parseCreateSupplierSkuInput({ supplyType: 'TURNKEY', effectiveFrom: '2026-01-01' }),
    ).toThrow();
    expect(() =>
      parseCreateSupplierSkuInput({ skuId: SKU_ID, effectiveFrom: '2026-01-01' }),
    ).toThrow();
    expect(() => parseCreateSupplierSkuInput({ skuId: SKU_ID, supplyType: 'TURNKEY' })).toThrow();
  });

  it('supplyType 은 정확히 2값이다', () => {
    expect(parseCreateSupplierSkuInput({ ...base, supplyType: 'TURNKEY' }).supplyType).toBe(
      'TURNKEY',
    );
    expect(() => parseCreateSupplierSkuInput({ ...base, supplyType: 'CONSIGNMENT' })).toThrow();
  });

  it('★ moq/orderMultiple 은 십진 문자열 전용 — JSON number 는 400 (§19)', () => {
    const ok = parseCreateSupplierSkuInput({ ...base, moq: '12.500000', orderMultiple: '5' });
    expect(ok.moq).toBe('12.500000');
    expect(ok.orderMultiple).toBe('5');

    expect(() => parseCreateSupplierSkuInput({ ...base, moq: 100 }), 'number').toThrow();
    for (const bad of ['0', '0.000000', '-1', '1.2345678', 'abc', '1e3']) {
      expect(() => parseCreateSupplierSkuInput({ ...base, moq: bad }), bad).toThrow();
    }
    expect(parseCreateSupplierSkuInput({ ...base, moq: null }).moq).toBeNull();
  });

  it('★ leadTimeDays — 0 이 삭제·변환되지 않고 그대로 0 이다', () => {
    expect(parseCreateSupplierSkuInput({ ...base, leadTimeDays: 0 }).leadTimeDays).toBe(0);
    expect(parseCreateSupplierSkuInput({ ...base, leadTimeDays: null }).leadTimeDays).toBeNull();
    expect(() => parseCreateSupplierSkuInput({ ...base, leadTimeDays: -1 })).toThrow();
  });

  it('★ supplierId·destinationWarehouseId·price 계열은 400 이다', () => {
    for (const forbidden of [
      { supplierId: SKU_ID },
      { destinationWarehouseId: SKU_ID },
      { price: '1000' },
      { approvedBy: SKU_ID },
      { createdAt: '2026-01-01' },
    ]) {
      expect(() => parseCreateSupplierSkuInput({ ...base, ...forbidden })).toThrow();
    }
  });

  it('effectiveTo — 생략/null = open-ended, 날짜 문법 오류는 400', () => {
    expect(parseCreateSupplierSkuInput(base).effectiveTo).toBeUndefined();
    expect(parseCreateSupplierSkuInput({ ...base, effectiveTo: null }).effectiveTo).toBeNull();
    expect(parseCreateSupplierSkuInput({ ...base, effectiveTo: '2027-01-01' }).effectiveTo).toBe(
      '2027-01-01',
    );
    expect(() => parseCreateSupplierSkuInput({ ...base, effectiveTo: '2026/01/01' })).toThrow();
    expect(() => parseCreateSupplierSkuInput({ ...base, effectiveFrom: '2026-13-99' })).toThrow();
  });
});

describe('★ SupplierSku PATCH — mode 판별 (D-15)', () => {
  it('정확히 {effectiveTo} 면 mode A(종료)다', () => {
    const parsed = parseUpdateSupplierSkuInput({ effectiveTo: '2026-06-01' });
    expect(parsed.mode).toBe('close');
  });

  it('★ effectiveTo: null 은 reopen — 400 이다', () => {
    expect(() => parseUpdateSupplierSkuInput({ effectiveTo: null })).toThrow();
  });

  it('effectiveFrom 이 있으면 mode B(새 버전)다', () => {
    const parsed = parseUpdateSupplierSkuInput({ effectiveFrom: '2026-06-01', moq: '20' });
    expect(parsed.mode).toBe('version');
  });

  it('★ effectiveFrom 만 있고 실질 변경이 없으면 400 — 단 effectiveTo 는 실질 변경이다', () => {
    expect(() => parseUpdateSupplierSkuInput({ effectiveFrom: '2026-06-01' })).toThrow();
    const withTo = parseUpdateSupplierSkuInput({
      effectiveFrom: '2026-06-01',
      effectiveTo: '2026-12-01',
    });
    expect(withTo.mode).toBe('version');
  });

  it('★ business field 만 보내면(제자리 수정) 400 이다 — 과거·현재·미래 공통 (D-16)', () => {
    for (const inPlace of [
      { moq: '10' },
      { supplyType: 'TURNKEY' },
      { leadTimeDays: 7 },
      { isPrimary: true },
      {},
    ]) {
      expect(() => parseUpdateSupplierSkuInput(inPlace), JSON.stringify(inPlace)).toThrow();
    }
  });

  it('★ identity(supplierId·skuId)는 어느 mode 에서도 400 이다', () => {
    expect(() =>
      parseUpdateSupplierSkuInput({ effectiveFrom: '2026-06-01', supplierId: SKU_ID }),
    ).toThrow();
    expect(() =>
      parseUpdateSupplierSkuInput({ effectiveTo: '2026-06-01', skuId: SKU_ID }),
    ).toThrow();
  });
});

describe('SupplierSku 목록 쿼리 — page 만', () => {
  it('page 만 받고 그 밖의 키는 400 이다', () => {
    expect(parseListSupplierSkusQuery(new URLSearchParams('page=2')).page).toBe(2);
    for (const bad of ['pageSize=10', 'skuId=x', 'current=true']) {
      expect(() => parseListSupplierSkusQuery(new URLSearchParams(bad)), bad).toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// proxy 정책 (D-23) — 96~99·first-match
// ═══════════════════════════════════════════════════════════════

describe('★ proxy 정책 — supplier 계열', () => {
  it('/api/suppliers — GET read / POST create / PATCH·PUT·DELETE update', () => {
    expect(resolveRoutePermission({ pathname: '/api/suppliers', method: 'GET' })).toBe(
      'supplier.read',
    );
    expect(resolveRoutePermission({ pathname: '/api/suppliers', method: 'POST' })).toBe(
      'supplier.create',
    );
    expect(resolveRoutePermission({ pathname: '/api/suppliers/abc', method: 'PATCH' })).toBe(
      'supplier.update',
    );
    expect(resolveRoutePermission({ pathname: '/api/suppliers/abc', method: 'DELETE' })).toBe(
      'supplier.update',
    );
  });

  it('★ nested /api/suppliers/{id}/skus 도 같은 family 로 잡힌다', () => {
    expect(resolveRoutePermission({ pathname: '/api/suppliers/uuid-1/skus', method: 'GET' })).toBe(
      'supplier.read',
    );
    expect(resolveRoutePermission({ pathname: '/api/suppliers/uuid-1/skus', method: 'POST' })).toBe(
      'supplier.create',
    );
  });

  it('★ /api/supplier-skus 는 독립 경로다 — suppliers 정책에 걸리지 않고 update 다', () => {
    expect(resolveRoutePermission({ pathname: '/api/supplier-skus/uuid-1', method: 'PATCH' })).toBe(
      'supplier.update',
    );
    // GET 은 정책이 없다 — supplier-skus 컬렉션 GET 라우트 자체가 없다 (D-1).
    expect(
      resolveRoutePermission({ pathname: '/api/supplier-skus/uuid-1', method: 'GET' }),
    ).toBeUndefined();
  });

  it('기존 /api/skus 정책이 흔들리지 않는다 (first-match regression)', () => {
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'GET' })).toBe('sku.read');
    expect(resolveRoutePermission({ pathname: '/api/skus/uuid-1/barcodes', method: 'POST' })).toBe(
      'barcode.create',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// constraint 번역 (D-20) — 104~108, 실측 shape 재현
// ═══════════════════════════════════════════════════════════════

function prismaError(
  code: string,
  cause: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('synthetic', {
    code,
    clientVersion: '7.9.1',
    meta: { modelName: 'SupplierSku', driverAdapterError: { name: 'DriverAdapterError', cause } },
  });
}

describe('★ constraint 번역 — P2039·P2002 를 정확히 가른다', () => {
  it('104. P2039 + SQLSTATE 23P01(EXCLUDE) → 409 SUPPLIER_SKU_PERIOD_OVERLAP', () => {
    const error = prismaError('P2039', {
      kind: 'postgres',
      code: '23P01',
      originalCode: '23P01',
      originalMessage:
        'conflicting key value violates exclusion constraint "supplier_sku_effective_period_excl"',
    });
    expect(() => translateSupplierSkuWriteError(error)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SUPPLIER_SKU_PERIOD_OVERLAP }),
    );
    expect(httpStatusForCode(ERROR_CODES.SUPPLIER_SKU_PERIOD_OVERLAP)).toBe(409);
  });

  it('105. ★ P2039 + SQLSTATE 23514(CHECK) 는 overlap 이 아니다 — 원본 그대로 던진다', () => {
    const error = prismaError('P2039', {
      kind: 'postgres',
      code: '23514',
      originalCode: '23514',
      originalMessage:
        'new row for relation "supplier_sku" violates check constraint "supplier_sku_moq_positive_check"',
    });
    let thrown: unknown;
    try {
      translateSupplierSkuWriteError(error);
    } catch (caught) {
      thrown = caught;
    }
    // 번역되지 않은 원본 Prisma 오류여야 한다 — 계약 버그를 409 로 숨기지 않는다.
    expect(thrown).toBe(error);
  });

  it('106. P2002 supplier_code → 409 SUPPLIER_CODE_DUPLICATE', () => {
    const error = new Prisma.PrismaClientKnownRequestError('synthetic', {
      code: 'P2002',
      clientVersion: '7.9.1',
      meta: {
        modelName: 'Supplier',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['supplier_code'] } },
        },
      },
    });
    expect(() => translateSupplierWriteError(error, 'SUP-001')).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SUPPLIER_CODE_DUPLICATE }),
    );
  });

  it('107. P2002 [supplier_id, sku_id, effective_from] → 409 EFFECTIVE_FROM_DUPLICATE', () => {
    const error = prismaError('P2002', {
      kind: 'UniqueConstraintViolation',
      constraint: { fields: ['supplier_id', 'sku_id', 'effective_from'] },
    });
    expect(() => translateSupplierSkuWriteError(error)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SUPPLIER_SKU_EFFECTIVE_FROM_DUPLICATE }),
    );
  });

  it('108. P2002 [sku_id](현행 대표 partial UNIQUE) → 409 PRIMARY_CONFLICT', () => {
    const error = prismaError('P2002', {
      kind: 'UniqueConstraintViolation',
      constraint: { fields: ['sku_id'] },
      originalMessage:
        'duplicate key value violates unique constraint "ux_supplier_sku_primary_current"',
    });
    expect(() => translateSupplierSkuWriteError(error)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SUPPLIER_SKU_PRIMARY_CONFLICT }),
    );
  });

  it('422 계열 — 기간·버전 날짜 오류의 HTTP status', () => {
    expect(httpStatusForCode(ERROR_CODES.SUPPLIER_SKU_EFFECTIVE_PERIOD_INVALID)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.SUPPLIER_SKU_VERSION_DATE_INVALID)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.SUPPLIER_SKU_EFFECTIVE_FROM_DUPLICATE)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.SUPPLIER_CODE_DUPLICATE)).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════
// view — lead time 폴백 (D-18)
// ═══════════════════════════════════════════════════════════════

function skuRow(leadTimeDays: number | null, supplierDefault: number | null) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    supplierId: '44444444-4444-4444-8444-444444444444',
    skuId: SKU_ID,
    supplierSkuCode: null,
    supplierSkuName: null,
    supplyType: 'SELF_SUPPLIED',
    moq: new Prisma.Decimal('12.5'),
    orderMultiple: null,
    leadTimeDays,
    purchaseUom: null,
    destinationWarehouseId: null,
    currency: 'KRW',
    isPrimary: false,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    createdAt: new Date('2026-08-12T01:00:00.000Z'),
    sku: { id: SKU_ID, skuCode: 'FB-SP-001', skuName: '샴푸', status: 'ACTIVE' },
    supplier: { defaultLeadTimeDays: supplierDefault },
  };
}

describe('★ SupplierSkuView — stored/derived 분리 (D-18)', () => {
  it('저장값이 있으면 effective 는 저장값이다', () => {
    const view = toSupplierSkuView(skuRow(7, 30) as never);
    expect(view.leadTimeDays).toBe(7);
    expect(view.effectiveLeadTimeDays).toBe(7);
  });

  it('★ 저장값 0 은 falsy 지만 폴백되지 않는다 — || 가 아니라 ?? 다', () => {
    const view = toSupplierSkuView(skuRow(0, 30) as never);
    expect(view.leadTimeDays).toBe(0);
    expect(view.effectiveLeadTimeDays).toBe(0);
  });

  it('null 이면 supplier 기본값으로 폴백하고, 둘 다 null 이면 null 이다 — 0 대체 금지', () => {
    const fallback = toSupplierSkuView(skuRow(null, 30) as never);
    expect(fallback.leadTimeDays).toBeNull();
    expect(fallback.effectiveLeadTimeDays).toBe(30);

    const bothNull = toSupplierSkuView(skuRow(null, null) as never);
    expect(bothNull.effectiveLeadTimeDays).toBeNull();
    expect(bothNull.effectiveLeadTimeDays).not.toBe(0);
  });

  it('Decimal 은 문자열, 날짜는 date-only 로 직렬화된다', () => {
    const view = toSupplierSkuView(skuRow(null, null) as never);
    expect(view.moq).toBe('12.5');
    expect(typeof view.moq).toBe('string');
    expect(view.effectiveFrom).toBe('2026-01-01');
    expect(view.effectiveTo).toBeNull();
    // ⛔ 노출 금지 필드 (D-9·D-30)
    const keys = Object.keys(view);
    expect(keys).not.toContain('destinationWarehouseId');
    expect(keys).not.toContain('price');
    expect(keys).not.toContain('recentPrice');
  });
});
