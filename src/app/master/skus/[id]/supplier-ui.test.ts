import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import { SUPPLIER_PAGE_SIZE as API_PAGE_SIZE } from '@/modules/supplier/application/dto';

import { SUPPLY_TYPE_LABELS } from '../../suppliers/[id]/terms-form';

import {
  formatEffectiveLeadTime,
  formatRecentPrice,
  orDash,
  primaryTabLabel,
  skuSupplierApiPath,
  supplierManagementHref,
  supplierSkuLabel,
  SUPPLIER_TAB_EMPTY_MESSAGE,
  SUPPLIER_TAB_PAGE_SIZE,
  SUPPLIER_TAB_QUERY_KEYS,
  SUPPLY_TYPE_TAB_LABELS,
  supplyTypeTabLabel,
  supplierTabTotalPages,
  type SupplierSummaryRow,
} from './supplier-view';

/**
 * SKU 상세 ⑥ 공급조건 탭 단위 테스트 (T1-6B4) — 브라우저 없이 고정하는 계약.
 *
 * 근거: `docs/16_설계복구_SKU상세잔여탭.md` §41~ (D-1 ~ D-30).
 *
 *   - 쿼리는 `page` 하나뿐 — `asOf` 를 보내지 않는다 (D-6)
 *   - 리드타임 `null → —` / **`0 → 0`** (D-9, G-03)
 *   - MOQ Decimal 문자열 그대로 (D-10)
 *   - 사급/턴키 라벨이 **T06-4 매핑과 같은 값** (D-11)
 *   - 최근 단가 없음 `—` / 0원 `0 KRW` (D-17)
 *   - 관리 링크는 `?tab=terms` 하나 (D-22)
 *   - proxy first-match: `/api/skus/{id}/supplier-skus` → `supplier.read`
 */

const SKU_ID = '11111111-1111-4111-8111-111111111111';
const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<SupplierSummaryRow> = {}): SupplierSummaryRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    supplierId: SUPPLIER_ID,
    supplier: { id: SUPPLIER_ID, supplierCode: 'SUP-001', supplierName: '포뷰트 제조' },
    supplierSkuCode: 'SC-1',
    supplierSkuName: '공급처 상품명',
    moq: '100',
    effectiveLeadTimeDays: 0,
    supplyType: 'SELF_SUPPLIED',
    isPrimary: false,
    recentPrice: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// 쿼리 계약 (D-19·D-21)
// ═══════════════════════════════════════════════════════════════

describe('공급조건 탭 쿼리 (D-19·D-21)', () => {
  it('★ 보내는 파라미터는 page 하나뿐 — asOf 를 보내지 않는다', () => {
    expect([...SUPPLIER_TAB_QUERY_KEYS]).toEqual(['page']);
    const path = skuSupplierApiPath(SKU_ID, 2);
    expect(path).toBe(`/api/skus/${SKU_ID}/supplier-skus?page=2`);
    expect(path).not.toContain('asOf');
    expect(path).not.toContain('pageSize');
  });

  it('page 는 1 미만이면 1 로 보정해 보낸다', () => {
    expect(skuSupplierApiPath(SKU_ID, 0)).toContain('page=1');
    expect(skuSupplierApiPath(SKU_ID, -3)).toContain('page=1');
  });

  it('★ pageSize 는 서버 고정 50 — API 상수와 일치한다', () => {
    expect(SUPPLIER_TAB_PAGE_SIZE).toBe(50);
    expect(SUPPLIER_TAB_PAGE_SIZE).toBe(API_PAGE_SIZE);
  });

  it('totalPages 는 최소 1 이다 (0건이어도 페이지 계산이 깨지지 않는다)', () => {
    expect(supplierTabTotalPages(null)).toBe(1);
    expect(
      supplierTabTotalPages({
        items: [],
        page: 1,
        pageSize: 50,
        total: 0,
        totalPages: 0,
        asOf: '2026-08-13',
      }),
    ).toBe(1);
    expect(
      supplierTabTotalPages({
        items: [],
        page: 1,
        pageSize: 50,
        total: 60,
        totalPages: 2,
        asOf: '2026-08-13',
      }),
    ).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 표시 헬퍼
// ═══════════════════════════════════════════════════════════════

describe('★ 리드타임 — 적용값이고 0 을 삼키지 않는다 (D-9·G-03)', () => {
  it('null 은 —, 0 은 "0", 양수는 숫자다', () => {
    expect(formatEffectiveLeadTime(null)).toBe('—');
    expect(formatEffectiveLeadTime(0)).toBe('0');
    expect(formatEffectiveLeadTime(14)).toBe('14');
  });
});

describe('MOQ (D-10)', () => {
  it('★ Decimal 문자열을 그대로 보여준다 — 숫자 변환·포맷 없음', () => {
    expect(orDash('100')).toBe('100');
    expect(orDash('12.500000')).toBe('12.500000');
    expect(orDash(null)).toBe('—');
    expect(orDash('  ')).toBe('—');
  });
});

describe('SupplyType 라벨 (D-11)', () => {
  it('★ T06-4 관리화면 매핑과 같은 값이다 — 두 화면이 갈리지 않는다', () => {
    expect(SUPPLY_TYPE_TAB_LABELS).toEqual(SUPPLY_TYPE_LABELS);
    expect(supplyTypeTabLabel('SELF_SUPPLIED')).toBe('사급');
    expect(supplyTypeTabLabel('TURNKEY')).toBe('턴키');
  });

  it('알 수 없는 값은 원문 그대로 — 임의 라벨을 만들지 않는다', () => {
    expect(supplyTypeTabLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('우선공급업체 (D-12)', () => {
  it('true 는 예, false 는 — 다 (T06-4 와 같은 표현)', () => {
    expect(primaryTabLabel(true)).toBe('예');
    expect(primaryTabLabel(false)).toBe('—');
  });
});

describe('★ 최근 단가 — 가격 없음과 0원을 구분한다 (D-16·D-17)', () => {
  it('null 은 — 다', () => {
    expect(formatRecentPrice(null)).toBe('—');
  });

  it('★ 0원은 "0 KRW" 다 — — 로 표시하지 않는다', () => {
    expect(formatRecentPrice({ unitPrice: '0', currency: 'KRW' })).toBe('0 KRW');
    expect(formatRecentPrice({ unitPrice: '0.0000', currency: 'KRW' })).toBe('0.0000 KRW');
  });

  it('일반 단가는 문자열 그대로 + 통화다 — 숫자 변환 없음', () => {
    expect(formatRecentPrice({ unitPrice: '1234.5678', currency: 'KRW' })).toBe('1234.5678 KRW');
    expect(formatRecentPrice({ unitPrice: '9.99', currency: 'USD' })).toBe('9.99 USD');
  });
});

describe('공급업체 SKU 표시 (§25)', () => {
  it('코드·명이 모두 있으면 함께, 하나만 있으면 그것만, 둘 다 없으면 — 다', () => {
    expect(supplierSkuLabel(row())).toBe('SC-1 · 공급처 상품명');
    expect(supplierSkuLabel(row({ supplierSkuName: null }))).toBe('SC-1');
    expect(supplierSkuLabel(row({ supplierSkuCode: null }))).toBe('공급처 상품명');
    expect(supplierSkuLabel(row({ supplierSkuCode: null, supplierSkuName: null }))).toBe('—');
    expect(supplierSkuLabel(row({ supplierSkuCode: '  ', supplierSkuName: '  ' }))).toBe('—');
  });
});

// ═══════════════════════════════════════════════════════════════
// 관리 링크 (D-22)
// ═══════════════════════════════════════════════════════════════

describe('★ 관리 링크 (D-22)', () => {
  it('공급조건 탭으로 보낸다 — prices·supplierSkuId 를 붙이지 않는다', () => {
    const href = supplierManagementHref(SUPPLIER_ID);
    expect(href).toBe(`/master/suppliers/${SUPPLIER_ID}?tab=terms`);
    expect(href).not.toContain('tab=prices');
    expect(href).not.toContain('supplierSkuId');
  });
});

describe('빈 상태 문구 (D-23)', () => {
  it('T06-4 와 같은 문구를 쓴다', () => {
    expect(SUPPLIER_TAB_EMPTY_MESSAGE).toBe('등록된 공급조건이 없습니다.');
  });
});

// ═══════════════════════════════════════════════════════════════
// 행 모델 — 요약에 없는 필드가 새지 않는다 (D-7)
// ═══════════════════════════════════════════════════════════════

describe('★ 요약 행 모델 (D-7)', () => {
  it('관리화면 전용 필드가 타입/헬퍼 경로에 없다', () => {
    const value = row();
    for (const forbidden of [
      'orderMultiple',
      'leadTimeDays',
      'purchaseUom',
      'currency',
      'effectiveFrom',
      'effectiveTo',
      'createdAt',
      'destinationWarehouseId',
    ]) {
      expect(forbidden in value, forbidden).toBe(false);
    }
    // Supplier 도 3필드뿐이다.
    expect(Object.keys(value.supplier).sort()).toEqual(['id', 'supplierCode', 'supplierName']);
  });

  it('recentPrice 는 unitPrice·currency 두 필드뿐이다', () => {
    const priced = row({ recentPrice: { unitPrice: '100', currency: 'KRW' } });
    expect(Object.keys(priced.recentPrice ?? {}).sort()).toEqual(['currency', 'unitPrice']);
  });
});

// ═══════════════════════════════════════════════════════════════
// proxy first-match (§48)
// ═══════════════════════════════════════════════════════════════

describe('★ proxy 정책 — supporting API (§48)', () => {
  const path = `/api/skus/${SKU_ID}/supplier-skus`;

  it('GET/HEAD 는 supplier.read 다 — sku.read 로 잡히지 않는다', () => {
    expect(resolveRoutePermission({ pathname: path, method: 'GET' })).toBe('supplier.read');
    expect(resolveRoutePermission({ pathname: path, method: 'HEAD' })).toBe('supplier.read');
    expect(resolveRoutePermission({ pathname: path, method: 'GET' })).not.toBe('sku.read');
  });

  it('기존 SKU 정책은 그대로다 — first-match regression', () => {
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'GET' })).toBe('sku.read');
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'POST' })).toBe('sku.create');
    expect(resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}`, method: 'PATCH' })).toBe(
      'sku.update',
    );
    expect(resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/history`, method: 'GET' })).toBe(
      'sku.read',
    );
    expect(
      resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/barcodes`, method: 'GET' }),
    ).toBe('barcode.read');
    expect(
      resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/approve`, method: 'POST' }),
    ).toBe('sku.approve');
    // 화면 정책도 그대로다.
    expect(resolveRoutePermission({ pathname: '/master/skus', method: 'GET' })).toBe('sku.read');
    expect(resolveRoutePermission({ pathname: '/master/suppliers', method: 'GET' })).toBe(
      'supplier.read',
    );
  });
});
