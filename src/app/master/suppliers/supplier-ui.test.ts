import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import { SUPPLIER_PAGE_SIZE as API_SUPPLIER_PAGE_SIZE } from '@/modules/supplier/application/dto';
import {
  SUPPLY_TYPE_LABELS,
  SUPPLY_TYPE_VALUES,
  supplyTypeLabel,
} from '@/modules/supplier/presentation/supply-type';

import {
  buildSupplierDetailParams,
  DEFAULT_SUPPLIER_DETAIL_TAB,
  readSupplierDetailState,
  SUPPLIER_DETAIL_TABS,
} from './[id]/detail-params';
import {
  buildPriceApprovePayload,
  buildPriceCreatePayload,
  EMPTY_PRICE_CREATE_FORM,
  isPricePending,
  priceApprovalLabel,
} from './[id]/price-form';
import {
  buildTermClosePayload,
  buildTermCreatePayload,
  buildTermVersionPayload,
  canSubmitVersion,
  EMPTY_TERM_CREATE_FORM,
  toVersionForm,
  type SupplierSkuViewLike,
} from './[id]/terms-form';
import {
  buildSupplierListParams,
  formatLeadTimeDays,
  formatOptionalText,
  readSupplierListState,
  SUPPLIER_LIST_MANAGED_KEYS,
  SUPPLIER_PAGE_SIZE,
  supplierListApiQuery,
} from './list-params';
import {
  buildSupplierCreatePayload,
  buildSupplierUpdatePayload,
  EMPTY_SUPPLIER_CREATE_FORM,
  hasSupplierChanges,
  SUPPLIER_EDIT_FIELDS,
  toLeadTimeDaysPayload,
  toSupplierEditForm,
  type SupplierViewLike,
} from './supplier-form';

/**
 * 거래처 화면 단위 테스트 (T06-4) — 브라우저 없이 고정하는 계약.
 *
 * 근거: `docs/17_설계복구_거래처공급조건.md` §80~ (D-1 ~ D-38).
 *
 *   - URL 상태: 관리 키 4종 · 미지원 키 보존 · 상세 탭/선택 fallback
 *   - 폼 ↔ payload: server-owned/staged 필드 부재 · null vs 0 · Decimal 문자열
 *   - temporal: mode A 는 정확히 `{effectiveTo}` · mode B 는 실질 변경 필수
 *   - 가격: 승인 상태는 `approvedBy` 파생 · attachment/effectiveTo 부재
 *   - proxy first-match: `/master/suppliers` → `supplier.read`
 */

// ═══════════════════════════════════════════════════════════════
// 목록 URL 상태 (D-4)
// ═══════════════════════════════════════════════════════════════

describe('거래처 목록 URL 상태 (D-4)', () => {
  it('관리 키는 정확히 q·supplierType·status·page 4종이다', () => {
    expect([...SUPPLIER_LIST_MANAGED_KEYS]).toEqual(['q', 'supplierType', 'status', 'page']);
  });

  it('★ pageSize 는 서버 고정 50 — API 상수와 일치한다', () => {
    expect(SUPPLIER_PAGE_SIZE).toBe(50);
    expect(SUPPLIER_PAGE_SIZE).toBe(API_SUPPLIER_PAGE_SIZE);
  });

  it('URL → 상태. 없으면 빈 값·page 1 이다', () => {
    expect(readSupplierListState(new URLSearchParams(''))).toEqual({
      q: '',
      supplierType: '',
      status: '',
      page: 1,
    });
    expect(
      readSupplierListState(new URLSearchParams('q=포뷰&supplierType=VENDOR&status=ACTIVE&page=3')),
    ).toEqual({ q: '포뷰', supplierType: 'VENDOR', status: 'ACTIVE', page: 3 });
  });

  it('잘못된 page 는 표시용으로만 1 이 된다 — API 에는 원문이 그대로 간다', () => {
    const params = new URLSearchParams('page=0');
    expect(readSupplierListState(params).page).toBe(1);
    // ★ 조용히 고쳐 보내지 않는다 — backend 400 을 사용자가 봐야 한다.
    expect(supplierListApiQuery(params)).toBe('?page=0');
  });

  it('★ 미지원 파라미터(pageSize·sort)를 조용히 제거하지 않는다', () => {
    const params = new URLSearchParams('pageSize=10&sort=name&q=abc');
    const next = buildSupplierListParams(params, { q: 'xyz' });
    expect(next.get('pageSize')).toBe('10');
    expect(next.get('sort')).toBe('name');
    expect(next.get('q')).toBe('xyz');
    expect(supplierListApiQuery(next)).toContain('pageSize=10');
  });

  it('빈 값은 파라미터를 제거하고, 검색 변경 시 page 는 1 로 초기화된다', () => {
    const params = new URLSearchParams('q=abc&supplierType=VENDOR&page=5');
    const next = buildSupplierListParams(params, { supplierType: '' });
    expect(next.has('supplierType')).toBe(false);
    expect(next.has('page')).toBe(false);
    expect(next.get('q')).toBe('abc');
  });

  it('page=1 은 URL 에 쓰지 않는다', () => {
    expect(buildSupplierListParams(new URLSearchParams('page=3'), { page: 1 }).has('page')).toBe(
      false,
    );
    expect(buildSupplierListParams(new URLSearchParams(''), { page: 2 }).get('page')).toBe('2');
  });
});

describe('★ 표시 헬퍼 — 0 을 — 로 삼키지 않는다 (G-03)', () => {
  it('리드타임 null 은 —, 0 은 "0" 이다', () => {
    expect(formatLeadTimeDays(null)).toBe('—');
    expect(formatLeadTimeDays(0)).toBe('0');
    expect(formatLeadTimeDays(14)).toBe('14');
  });

  it('빈 문자열·null 텍스트는 — 다', () => {
    expect(formatOptionalText(null)).toBe('—');
    expect(formatOptionalText('  ')).toBe('—');
    expect(formatOptionalText('홍길동')).toBe('홍길동');
  });
});

// ═══════════════════════════════════════════════════════════════
// 거래처 폼 (D-6·D-7·D-8·D-20)
// ═══════════════════════════════════════════════════════════════

const SUPPLIER: SupplierViewLike = {
  supplierName: '포뷰트 제조',
  supplierType: 'MANUFACTURER',
  businessRegistrationNo: '123-45-67890',
  contactName: '홍길동',
  contactPhone: null,
  contactEmail: null,
  defaultLeadTimeDays: 0,
  note: null,
};

describe('거래처 create payload (D-6)', () => {
  it('★ status·warehouse·server 필드를 만들지 않는다', () => {
    const payload = buildSupplierCreatePayload({
      ...EMPTY_SUPPLIER_CREATE_FORM,
      supplierCode: ' SUP-001 ',
      supplierName: '포뷰트',
      supplierType: ' VENDOR ',
    });
    expect(Object.keys(payload).sort()).toEqual(
      [
        'supplierCode',
        'supplierName',
        'supplierType',
        'businessRegistrationNo',
        'contactName',
        'contactPhone',
        'contactEmail',
        'defaultLeadTimeDays',
        'note',
      ].sort(),
    );
    for (const forbidden of ['status', 'defaultWarehouseId', 'createdBy', 'deletedAt']) {
      expect(forbidden in payload).toBe(false);
    }
    expect(payload['supplierCode']).toBe('SUP-001');
    expect(payload['supplierType']).toBe('VENDOR');
  });

  it('★ 리드타임 — 빈 값은 null(미입력), "0" 은 숫자 0(즉시납)이다', () => {
    expect(toLeadTimeDaysPayload('')).toBeNull();
    expect(toLeadTimeDaysPayload('   ')).toBeNull();
    expect(toLeadTimeDaysPayload('0')).toBe(0);
    expect(toLeadTimeDaysPayload('14')).toBe(14);
    // 숫자가 아니면 원문을 그대로 보내 backend 400 을 보이게 한다.
    expect(toLeadTimeDaysPayload('abc')).toBe('abc');
    expect(toLeadTimeDaysPayload('-1')).toBe('-1');
  });

  it('선택 필드는 빈 값이면 null 로 보낸다', () => {
    const payload = buildSupplierCreatePayload(EMPTY_SUPPLIER_CREATE_FORM);
    expect(payload['contactName']).toBeNull();
    expect(payload['note']).toBeNull();
  });
});

describe('거래처 edit 폼 (D-7)', () => {
  it('★ editable 은 정확히 8필드 — supplierCode·status 가 없다', () => {
    expect([...SUPPLIER_EDIT_FIELDS]).toEqual([
      'supplierName',
      'supplierType',
      'businessRegistrationNo',
      'contactName',
      'contactPhone',
      'contactEmail',
      'defaultLeadTimeDays',
      'note',
    ]);
    const form = toSupplierEditForm(SUPPLIER);
    expect('supplierCode' in form).toBe(false);
    expect('status' in form).toBe(false);
  });

  it('★ 서버 0 은 "0" 으로 prefill 된다 — 빈 값(미입력)과 구분', () => {
    expect(toSupplierEditForm(SUPPLIER).defaultLeadTimeDays).toBe('0');
    expect(toSupplierEditForm({ ...SUPPLIER, defaultLeadTimeDays: null }).defaultLeadTimeDays).toBe(
      '',
    );
  });

  it('변경된 필드만 payload 에 담는다', () => {
    const form = { ...toSupplierEditForm(SUPPLIER), contactName: '김철수' };
    expect(buildSupplierUpdatePayload(form, SUPPLIER)).toEqual({ contactName: '김철수' });
  });

  it('★ 값 제거는 null 로 간다 (빈 문자열이 아니다)', () => {
    const form = { ...toSupplierEditForm(SUPPLIER), businessRegistrationNo: '' };
    expect(buildSupplierUpdatePayload(form, SUPPLIER)).toEqual({ businessRegistrationNo: null });
  });

  it('변경이 없으면 payload 는 비고 Save 는 비활성이다', () => {
    const form = toSupplierEditForm(SUPPLIER);
    expect(buildSupplierUpdatePayload(form, SUPPLIER)).toEqual({});
    expect(hasSupplierChanges(form, SUPPLIER)).toBe(false);
    expect(hasSupplierChanges({ ...form, note: '메모' }, SUPPLIER)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 상세 탭 URL 상태 (§19)
// ═══════════════════════════════════════════════════════════════

describe('상세 탭 URL 상태 (§19)', () => {
  it('탭은 정확히 3개이고 기본은 basic 이다', () => {
    expect([...SUPPLIER_DETAIL_TABS]).toEqual(['basic', 'terms', 'prices']);
    expect(DEFAULT_SUPPLIER_DETAIL_TAB).toBe('basic');
  });

  it('★ 알 수 없는 tab 은 basic 으로 fallback 한다', () => {
    expect(readSupplierDetailState(new URLSearchParams('tab=unknown')).tab).toBe('basic');
    expect(readSupplierDetailState(new URLSearchParams('tab=prices')).tab).toBe('prices');
  });

  it('termsPage·supplierSkuId 를 읽고 기본값은 URL 에 쓰지 않는다', () => {
    const state = readSupplierDetailState(
      new URLSearchParams('tab=prices&termsPage=2&supplierSkuId=abc'),
    );
    expect(state).toEqual({ tab: 'prices', termsPage: 2, supplierSkuId: 'abc' });

    const cleared = buildSupplierDetailParams(new URLSearchParams('tab=terms&termsPage=3'), {
      tab: 'basic',
      termsPage: 1,
    });
    expect(cleared.has('tab')).toBe(false);
    expect(cleared.has('termsPage')).toBe(false);
  });

  it('선택 해제는 supplierSkuId 파라미터를 지운다', () => {
    const next = buildSupplierDetailParams(new URLSearchParams('supplierSkuId=abc'), {
      supplierSkuId: '',
    });
    expect(next.has('supplierSkuId')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 공급조건 temporal (D-14 ~ D-19)
// ═══════════════════════════════════════════════════════════════

const TERM: SupplierSkuViewLike = {
  supplierSkuCode: 'SC-1',
  supplierSkuName: '공급처명',
  supplyType: 'SELF_SUPPLIED',
  moq: '100',
  orderMultiple: null,
  leadTimeDays: 0,
  purchaseUom: 'BOX',
  currency: 'KRW',
  isPrimary: false,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
};

describe('SupplyType 라벨 (D-14)', () => {
  it('SELF_SUPPLIED → 사급 / TURNKEY → 턴키. 값은 2종뿐이다', () => {
    expect([...SUPPLY_TYPE_VALUES]).toEqual(['SELF_SUPPLIED', 'TURNKEY']);
    expect(SUPPLY_TYPE_LABELS.SELF_SUPPLIED).toBe('사급');
    expect(SUPPLY_TYPE_LABELS.TURNKEY).toBe('턴키');
  });

  it('알 수 없는 값은 원문을 그대로 보여준다 — 임의 라벨을 만들지 않는다', () => {
    expect(supplyTypeLabel('SELF_SUPPLIED')).toBe('사급');
    expect(supplyTypeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('공급조건 create payload (D-31)', () => {
  it('★ destinationWarehouseId 가 없다 (D-20)', () => {
    const payload = buildTermCreatePayload({
      ...EMPTY_TERM_CREATE_FORM,
      skuId: '11111111-1111-4111-8111-111111111111',
      effectiveFrom: '2026-01-01',
    });
    expect('destinationWarehouseId' in payload).toBe(false);
    expect('skuLabel' in payload).toBe(false);
    expect(payload['supplyType']).toBe('SELF_SUPPLIED');
  });

  it('★ Decimal 은 문자열 그대로 — 숫자 변환이 없다 (D-15)', () => {
    const payload = buildTermCreatePayload({
      ...EMPTY_TERM_CREATE_FORM,
      skuId: 'x',
      effectiveFrom: '2026-01-01',
      moq: '12.5',
      orderMultiple: '0.000001',
    });
    expect(payload['moq']).toBe('12.5');
    expect(payload['orderMultiple']).toBe('0.000001');
  });

  it('빈 currency·effectiveTo 는 아예 보내지 않는다 (DB default·open-ended)', () => {
    const payload = buildTermCreatePayload({
      ...EMPTY_TERM_CREATE_FORM,
      skuId: 'x',
      effectiveFrom: '2026-01-01',
    });
    expect('currency' in payload).toBe(false);
    expect('effectiveTo' in payload).toBe(false);
  });
});

describe('★ mode A — 기간 종료/단축 (D-17)', () => {
  it('body 는 정확히 {effectiveTo} 다 — business field 를 함께 보내지 않는다', () => {
    const payload = buildTermClosePayload(' 2026-06-01 ');
    expect(payload).toEqual({ effectiveTo: '2026-06-01' });
    expect(Object.keys(payload)).toEqual(['effectiveTo']);
  });
});

describe('★ mode B — 새 버전 생성 (D-18·§28)', () => {
  it('prefill 은 기존 값을 담되 effectiveFrom 은 비운다', () => {
    const form = toVersionForm(TERM);
    expect(form.effectiveFrom).toBe('');
    expect(form.moq).toBe('100');
    expect(form.leadTimeDays).toBe('0');
    expect(form.supplyType).toBe('SELF_SUPPLIED');
  });

  it('payload 는 effectiveFrom + 변경 필드만 담는다', () => {
    const form = { ...toVersionForm(TERM), effectiveFrom: '2026-06-01', moq: '200' };
    expect(buildTermVersionPayload(form, TERM)).toEqual({
      effectiveFrom: '2026-06-01',
      moq: '200',
    });
  });

  it('★ 실질 변경이 없으면 submit 할 수 없다 — backend 400 을 만들지 않는다', () => {
    const noChange = { ...toVersionForm(TERM), effectiveFrom: '2026-06-01' };
    expect(canSubmitVersion(noChange, TERM)).toBe(false);
    expect(canSubmitVersion({ ...noChange, isPrimary: true }, TERM)).toBe(true);
    // 종료일 변경도 실질 변경이다.
    expect(canSubmitVersion({ ...noChange, effectiveTo: '2026-12-01' }, TERM)).toBe(true);
  });

  it('새 시작일이 없으면 submit 할 수 없다', () => {
    expect(canSubmitVersion({ ...toVersionForm(TERM), moq: '200' }, TERM)).toBe(false);
  });

  it('★ identity(supplierId·skuId)는 payload 에 없다 — immutable 이다', () => {
    const payload = buildTermVersionPayload(
      { ...toVersionForm(TERM), effectiveFrom: '2026-06-01', moq: '200' },
      TERM,
    );
    expect('skuId' in payload).toBe(false);
    expect('supplierId' in payload).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 가격 (D-23 ~ D-25)
// ═══════════════════════════════════════════════════════════════

describe('가격 create payload (D-23)', () => {
  it('★ 정확히 5필드 — attachmentId·effectiveTo 가 없다 (D-26)', () => {
    const payload = buildPriceCreatePayload({
      ...EMPTY_PRICE_CREATE_FORM,
      unitPrice: '1234.5678',
      effectiveFrom: '2026-01-01',
    });
    expect(Object.keys(payload).sort()).toEqual(
      ['unitPrice', 'currency', 'vatIncluded', 'effectiveFrom', 'sourceDocument'].sort(),
    );
    expect('attachmentId' in payload).toBe(false);
    expect('effectiveTo' in payload).toBe(false);
    expect('approvedBy' in payload).toBe(false);
  });

  it('★ unitPrice 는 문자열 그대로 — "0" 도 유효한 0원 단가다', () => {
    expect(
      buildPriceCreatePayload({ ...EMPTY_PRICE_CREATE_FORM, unitPrice: ' 0 ' })['unitPrice'],
    ).toBe('0');
    expect(
      buildPriceCreatePayload({ ...EMPTY_PRICE_CREATE_FORM, unitPrice: '1234.5678' })['unitPrice'],
    ).toBe('1234.5678');
  });

  it('sourceDocument 는 trim·blank→null 이다', () => {
    expect(
      buildPriceCreatePayload({ ...EMPTY_PRICE_CREATE_FORM, sourceDocument: '  ' })[
        'sourceDocument'
      ],
    ).toBeNull();
    expect(
      buildPriceCreatePayload({ ...EMPTY_PRICE_CREATE_FORM, sourceDocument: ' 계약서 ' })[
        'sourceDocument'
      ],
    ).toBe('계약서');
  });
});

describe('가격 승인 (D-24·D-25)', () => {
  it('note 는 blank 면 아예 보내지 않는다', () => {
    expect(buildPriceApprovePayload('   ')).toEqual({});
    expect(buildPriceApprovePayload(' 합의 ')).toEqual({ note: '합의' });
  });

  it('★ 승인 상태는 approvedBy 로만 파생한다 — approvalStatus enum 이 없다', () => {
    expect(priceApprovalLabel(null)).toBe('미승인');
    expect(priceApprovalLabel('7f000000-0000-4000-8000-000000000001')).toBe('승인');
    expect(isPricePending(null)).toBe(true);
    expect(isPricePending('7f000000-0000-4000-8000-000000000001')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// proxy first-match (§66)
// ═══════════════════════════════════════════════════════════════

describe('★ proxy 정책 — 화면 route (§66)', () => {
  it('/master/suppliers 목록·상세 GET 은 supplier.read 다', () => {
    expect(resolveRoutePermission({ pathname: '/master/suppliers', method: 'GET' })).toBe(
      'supplier.read',
    );
    expect(
      resolveRoutePermission({
        pathname: '/master/suppliers/33333333-3333-4333-8333-333333333333',
        method: 'GET',
      }),
    ).toBe('supplier.read');
  });

  it('supporting API GET /api/suppliers/{id} 도 supplier.read 다', () => {
    expect(
      resolveRoutePermission({
        pathname: '/api/suppliers/33333333-3333-4333-8333-333333333333',
        method: 'GET',
      }),
    ).toBe('supplier.read');
  });

  it('기존 화면·API 정책은 그대로다 — regression', () => {
    expect(resolveRoutePermission({ pathname: '/master/skus', method: 'GET' })).toBe('sku.read');
    expect(resolveRoutePermission({ pathname: '/master/external-mappings', method: 'GET' })).toBe(
      'external_mapping.read',
    );
    expect(resolveRoutePermission({ pathname: '/api/suppliers', method: 'POST' })).toBe(
      'supplier.create',
    );
    expect(
      resolveRoutePermission({
        pathname: '/api/supplier-skus/33333333-3333-4333-8333-333333333333/prices',
        method: 'POST',
      }),
    ).toBe('supplier_price.create');
  });
});
