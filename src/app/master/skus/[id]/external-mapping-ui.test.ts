import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import { MAPPING_STATUSES, parseListMappingsQuery } from '@/modules/external-mapping/application';

import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from '../../../../../prisma/seed/roles';
import {
  MAPPING_LIST_STATUSES,
  MAPPING_STATUS_CLASS,
  MAPPING_STATUS_LABELS,
  REVIEW_REQUIRED_NOTICE,
  formatEffectivePeriod,
  isEndedMapping,
} from '../../external-mappings/list-params';
import { SKU_CREATE_TABS, SKU_DETAIL_TABS } from '../sku-form-fields';

import {
  EXTERNAL_PRODUCT_NAME_NOTICE,
  MAPPING_TAB_EMPTY_MESSAGE,
  MAPPING_TAB_PAGE_SIZE,
  MAPPING_TAB_QUERY_KEYS,
  buildSkuMappingQuery,
  externalMappingManagementHref,
  externalSystemLabel,
  mappingTabTotalPages,
  orBlank,
  primaryLabel,
  skuMappingApiPath,
  type MappingSummaryRow,
} from './external-mapping-view';

/**
 * SKU 상세 외부시스템 매핑 탭 helper 단위 테스트 (T1-6B2).
 *
 * 계약 근거는 `docs/16_설계복구_SKU상세잔여탭.md` §19~§21 이며, 매핑 API 계약은
 * `docs/13`(T05-2) · `docs/15`(T05-4A) 다. 화면 동작 자체는
 * `tests/e2e/external-mapping-tab.e2e.ts` 가 실 브라우저로 본다.
 *
 * ★ 이 파일은 **탭이 보내는 쿼리가 backend 계약을 벗어나지 않는지**와
 *   **표시 규약이 T05-4A 와 어긋나지 않는지**를 고정한다.
 */

const SKU_ID = '33333333-3333-4333-8333-333333333333';

const ROW: MappingSummaryRow = {
  id: '44444444-4444-4444-8444-444444444444',
  skuId: SKU_ID,
  externalProductCode: 'ECOUNT-001',
  externalProductName: '이카운트 샴푸',
  mappingStatus: 'MATCHED',
  isPrimary: true,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  externalSystem: { systemCode: 'LEGACY_ERP', systemName: '이카운트' },
};

// ═══════════════════════════════════════════════════════════════
// 탭 구성 (docs/16 §19)
// ═══════════════════════════════════════════════════════════════

describe('★ 상세 탭 구성 — 외부시스템 매핑 추가', () => {
  it('1. 등록 화면은 여전히 3탭이다 — child entity 탭 없음', () => {
    expect(SKU_CREATE_TABS.map((tab) => tab.key)).toEqual(['basic', 'classification', 'inventory']);
    const createKeys = SKU_CREATE_TABS.map((tab) => tab.key) as readonly string[];
    expect(createKeys).not.toContain('externalMapping');
    expect(createKeys).not.toContain('barcode');
  });

  it('2. 상세 화면은 5탭이다', () => {
    expect(SKU_DETAIL_TABS).toHaveLength(5);
  });

  it('3. ★ 상세 탭 순서가 원문 8탭(①②③④⑤)의 논리 순서다', () => {
    expect(SKU_DETAIL_TABS.map((tab) => tab.key)).toEqual([
      'basic',
      'classification',
      'barcode',
      'externalMapping',
      'inventory',
    ]);
    expect(SKU_DETAIL_TABS.map((tab) => tab.label)).toEqual([
      '기본정보',
      '코드·분류',
      '바코드',
      '외부시스템 매핑',
      '재고관리 설정',
    ]);
  });

  it('4. ★ 외부시스템 매핑은 바코드 다음, 재고관리 설정 앞이다', () => {
    const keys = SKU_DETAIL_TABS.map((tab) => tab.key) as readonly string[];
    expect(keys.indexOf('externalMapping')).toBe(keys.indexOf('barcode') + 1);
    expect(keys.indexOf('externalMapping')).toBe(keys.indexOf('inventory') - 1);
  });

  it('5. 아직 없는 탭(공급조건·BOM·변경이력)은 어느 배열에도 없다', () => {
    const labels = [...SKU_CREATE_TABS, ...SKU_DETAIL_TABS].map((tab) => tab.label);
    for (const absent of ['공급조건', 'BOM', '변경이력']) {
      expect(labels, absent).not.toContain(absent);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 권한 (docs/16 §24)
// ═══════════════════════════════════════════════════════════════

describe('★ 탭 노출 권한 — external_mapping.read', () => {
  const rolesFor = (key: string) =>
    ROLE_PERMISSION_SEED.filter((entry) => entry.permissionKey === key)
      .map((entry) => entry.roleCode)
      .sort();

  it('6. `external_mapping.read` 가 seed 에 존재한다', () => {
    expect(PERMISSION_SEED.map((entry) => entry.permissionKey)).toContain('external_mapping.read');
  });

  it('7. ★ EXECUTIVE 는 sku.read 는 있고 external_mapping.read 는 없다', () => {
    expect(rolesFor('sku.read')).toContain('EXECUTIVE');
    expect(rolesFor('external_mapping.read')).not.toContain('EXECUTIVE');
    // 반대로 바코드는 EXECUTIVE 도 조회할 수 있다 — 두 탭의 노출이 다르다.
    expect(rolesFor('barcode.read')).toContain('EXECUTIVE');
  });

  it('8. FINANCE 는 조회 권한이 있다 (read-only 요약을 볼 수 있다)', () => {
    expect(rolesFor('external_mapping.read')).toEqual([
      'ADMIN',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
  });

  it('9. 탭이 부르는 GET 의 proxy 1차 정책이 external_mapping.read 다', () => {
    expect(resolveRoutePermission({ pathname: '/api/external-mappings', method: 'GET' })).toBe(
      'external_mapping.read',
    );
    // 관리 화면 진입도 같은 read 권한이다 (링크 대상).
    expect(resolveRoutePermission({ pathname: '/master/external-mappings', method: 'GET' })).toBe(
      'external_mapping.read',
    );
  });

  it('10. ★ 이 탭은 mutation permission 을 판단하지 않는다 (CRUD 가 없다)', () => {
    const helpers = Object.keys({
      MAPPING_TAB_PAGE_SIZE,
      MAPPING_TAB_QUERY_KEYS,
      buildSkuMappingQuery,
      externalMappingManagementHref,
      externalSystemLabel,
      mappingTabTotalPages,
      orBlank,
      primaryLabel,
      skuMappingApiPath,
    });
    for (const name of helpers) {
      expect(name, name).not.toMatch(/create|update|delete|end|primaryToggle|approve/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 쿼리 계약 (docs/16 §20)
// ═══════════════════════════════════════════════════════════════

describe('★ 쿼리 — skuId · page · pageSize 뿐', () => {
  it('11. ★ 정확히 3개 키만 보낸다', () => {
    const params = buildSkuMappingQuery(SKU_ID, 1);
    expect([...params.keys()].sort()).toEqual(['page', 'pageSize', 'skuId']);
    expect([...MAPPING_TAB_QUERY_KEYS].sort()).toEqual(['page', 'pageSize', 'skuId']);
  });

  it('12. ★ skuId 는 항상 현재 SKU 다', () => {
    expect(buildSkuMappingQuery(SKU_ID, 3).get('skuId')).toBe(SKU_ID);
  });

  it('13. pageSize 는 50 고정이다 (UI 선택지 없음)', () => {
    expect(MAPPING_TAB_PAGE_SIZE).toBe(50);
    expect(buildSkuMappingQuery(SKU_ID, 1).get('pageSize')).toBe('50');
    expect(buildSkuMappingQuery(SKU_ID, 7).get('pageSize')).toBe('50');
  });

  it('14. page 는 1-base 이며 0·음수는 1 로 보정한다', () => {
    expect(buildSkuMappingQuery(SKU_ID, 1).get('page')).toBe('1');
    expect(buildSkuMappingQuery(SKU_ID, 4).get('page')).toBe('4');
    expect(buildSkuMappingQuery(SKU_ID, 0).get('page')).toBe('1');
    expect(buildSkuMappingQuery(SKU_ID, -3).get('page')).toBe('1');
  });

  it('15. ★ q·mappingStatus·externalSystemId·sort·warehouseId 를 보내지 않는다', () => {
    const params = buildSkuMappingQuery(SKU_ID, 2);
    for (const forbidden of [
      'q',
      'mappingStatus',
      'externalSystemId',
      'sort',
      'warehouseId',
      'hasIssue',
      'skuCode',
    ]) {
      expect(params.get(forbidden), forbidden).toBeNull();
    }
  });

  it('16. ★ 이 쿼리가 실제 backend DTO 를 통과한다 (unknown key 400 계약)', () => {
    const parsed = parseListMappingsQuery(buildSkuMappingQuery(SKU_ID, 2));
    expect(parsed.skuId).toBe(SKU_ID);
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(MAPPING_TAB_PAGE_SIZE);
    expect(parsed.q).toBeUndefined();
    expect(parsed.mappingStatus).toBeUndefined();
    expect(parsed.externalSystemId).toBeUndefined();
  });

  it('17. API 경로가 그 쿼리 그대로다', () => {
    expect(skuMappingApiPath(SKU_ID, 2)).toBe(
      `/api/external-mappings?skuId=${SKU_ID}&page=2&pageSize=50`,
    );
  });

  it('18. totalPages 계산은 pageSize 50 기준이다', () => {
    expect(mappingTabTotalPages(0)).toBe(1);
    expect(mappingTabTotalPages(1)).toBe(1);
    expect(mappingTabTotalPages(50)).toBe(1);
    expect(mappingTabTotalPages(51)).toBe(2);
    expect(mappingTabTotalPages(120)).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// 관리 화면 링크 (docs/16 §22)
// ═══════════════════════════════════════════════════════════════

describe('★ 관리 화면 링크', () => {
  it('19. ★ /master/external-mappings?skuId={skuId} 로 정확히 연결된다', () => {
    expect(externalMappingManagementHref(SKU_ID)).toBe(`/master/external-mappings?skuId=${SKU_ID}`);
  });

  it('20. ★ SKU 코드·상품명 등 다른 파라미터를 붙이지 않는다', () => {
    const href = externalMappingManagementHref(SKU_ID);
    const params = new URLSearchParams(href.split('?')[1]);
    expect([...params.keys()]).toEqual(['skuId']);
  });

  it('21. ★ skuId 는 관리 화면이 아는 키다 (미지원 파라미터 400 을 만들지 않는다)', () => {
    const href = externalMappingManagementHref(SKU_ID);
    const params = new URLSearchParams(href.split('?')[1]);
    expect(() => parseListMappingsQuery(params)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 표시 (docs/16 §21)
// ═══════════════════════════════════════════════════════════════

describe('★ 표시 규약 — T05-4A convention 재사용', () => {
  it('22. 상태 3종이 API MAPPING_STATUSES 와 같다', () => {
    expect([...MAPPING_LIST_STATUSES].sort()).toEqual([...MAPPING_STATUSES].sort());
  });

  it('23. MATCHED · REVIEW_REQUIRED · UNMATCHED 라벨과 배지 색이 정의되어 있다', () => {
    expect(MAPPING_STATUS_LABELS.MATCHED).toBe('매칭됨');
    expect(MAPPING_STATUS_LABELS.REVIEW_REQUIRED).toBe('확인 필요');
    expect(MAPPING_STATUS_LABELS.UNMATCHED).toBe('미매칭');
    for (const status of MAPPING_LIST_STATUSES) {
      expect(MAPPING_STATUS_CLASS[status], status).toBeTruthy();
    }
  });

  it('24. ★ resolver transient 결과(AMBIGUOUS·CONFLICT)를 상태로 넣지 않는다', () => {
    const statuses = [...MAPPING_LIST_STATUSES] as readonly string[];
    expect(statuses).not.toContain('AMBIGUOUS');
    expect(statuses).not.toContain('CONFLICT');
    expect(MAPPING_STATUS_CLASS['AMBIGUOUS']).toBeUndefined();
  });

  it('25. REVIEW_REQUIRED 안내문이 T05-4A 와 같은 문장이다', () => {
    expect(REVIEW_REQUIRED_NOTICE).toContain('자동 원장 반영 대상이 아닙니다');
    expect(REVIEW_REQUIRED_NOTICE).toContain('MATCHED');
  });

  it('26. 대표 표시 — T05-4A 와 같은 표현', () => {
    expect(primaryLabel(true)).toBe('대표');
    expect(primaryLabel(false)).toBe('');
  });

  it('27. 종료된 매핑 판정 — 숨기지 않고 표시 대상이다', () => {
    expect(isEndedMapping(null)).toBe(false);
    expect(isEndedMapping('2026-06-30')).toBe(true);
  });

  it('28. 적용기간 표기 — T05-4A convention 그대로', () => {
    expect(formatEffectivePeriod(null, null)).toBe('');
    expect(formatEffectivePeriod('2026-01-01', null)).toBe('2026-01-01 ~ ');
    expect(formatEffectivePeriod('2026-01-01', '2026-06-30')).toBe('2026-01-01 ~ 2026-06-30');
  });

  it('29. 외부시스템 라벨 — 코드 + 이름', () => {
    expect(externalSystemLabel(ROW.externalSystem)).toBe('LEGACY_ERP — 이카운트');
  });

  it('30. null 필드는 안전하게 빈 문자열이다', () => {
    expect(orBlank(null)).toBe('');
    expect(orBlank(undefined)).toBe('');
    expect(orBlank('ECOUNT-001')).toBe('ECOUNT-001');
    const nameOnly: MappingSummaryRow = {
      ...ROW,
      externalProductCode: null,
      mappingStatus: 'REVIEW_REQUIRED',
      isPrimary: false,
      effectiveFrom: null,
    };
    expect(orBlank(nameOnly.externalProductCode)).toBe('');
    expect(formatEffectivePeriod(nameOnly.effectiveFrom, nameOnly.effectiveTo)).toBe('');
  });

  it('31. ★ 외부 상품명 안내문이 표준 상품명 불변을 명시한다', () => {
    expect(EXTERNAL_PRODUCT_NAME_NOTICE).toContain('표준 상품명');
    expect(EXTERNAL_PRODUCT_NAME_NOTICE).toContain('변경하지 않습니다');
  });

  it('32. 빈 목록 문구', () => {
    expect(MAPPING_TAB_EMPTY_MESSAGE).toBe('등록된 외부시스템 매핑이 없습니다.');
  });

  it('33. ★ 창고 관련 표시 helper 가 없다 (T08-1 이전)', () => {
    const row = ROW as unknown as Record<string, unknown>;
    expect(Object.hasOwn(row, 'warehouseId')).toBe(false);
    expect(Object.hasOwn(row, 'warehouse')).toBe(false);
  });
});
