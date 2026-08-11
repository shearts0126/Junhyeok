import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import {
  MAPPING_STATUSES,
  createMappingSchema,
  parseListExternalSystemsQuery,
  parseListMappingsQuery,
  parseUpdateMappingInput,
  updateMappingSchema,
} from '@/modules/external-mapping/application';
import { businessDateOf } from '@/modules/external-mapping/application/effective-date';

import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from '../../../../prisma/seed/roles';

import {
  DEFAULT_PAGE_SIZE,
  MAPPING_LIST_MANAGED_KEYS,
  MAPPING_LIST_PAGE_SIZES,
  MAPPING_LIST_STATUSES,
  buildMappingListParams,
  formatEffectivePeriod,
  isEndedMapping,
  isInteractiveMapping,
  mappingListApiQuery,
  readMappingListState,
} from './list-params';
import {
  EMPTY_CREATE_FORM,
  buildCreatePayload,
  buildEndPayload,
  buildUpdatePayload,
  toEditForm,
  todayBusinessDate,
} from './mapping-form';

/**
 * 외부 매핑 관리 화면 helper 단위 테스트 (T05-4A).
 *
 * 계약 근거는 `docs/15_설계복구_ExternalMapping관리UI.md` 뿐이다.
 * 화면 동작 자체는 `tests/e2e/external-mappings.e2e.ts` 가 실 브라우저로 본다
 * (repo 의 unit 프로젝트는 node 환경이라 컴포넌트 렌더링 대역이 없다 —
 *  T1-5A/T1-6A 와 같은 분업이다).
 */

const SYSTEM_ID = '11111111-1111-4111-8111-111111111111';
const SKU_ID = '22222222-2222-4222-8222-222222222222';
const MAPPING_ID = '33333333-3333-4333-8333-333333333333';

// ═══════════════════════════════════════════════════════════════
// route policy · permission (§3·§4·§7)
// ═══════════════════════════════════════════════════════════════

describe('★ 화면·API route policy', () => {
  it('`/master/external-mappings` 진입은 external_mapping.read 를 요구한다', () => {
    expect(resolveRoutePermission({ pathname: '/master/external-mappings', method: 'GET' })).toBe(
      'external_mapping.read',
    );
    expect(resolveRoutePermission({ pathname: '/master/external-mappings', method: 'HEAD' })).toBe(
      'external_mapping.read',
    );
  });

  it('★ 화면 경로가 sku.* 로 매칭되지 않는다', () => {
    const permission = resolveRoutePermission({
      pathname: '/master/external-mappings',
      method: 'GET',
    });
    expect(permission).not.toBe('sku.read');
    expect(permission?.startsWith('external_mapping.')).toBe(true);
  });

  it('`GET /api/external-systems` 도 external_mapping.read 다 — 신규 permission 없음', () => {
    expect(resolveRoutePermission({ pathname: '/api/external-systems', method: 'GET' })).toBe(
      'external_mapping.read',
    );
    expect(resolveRoutePermission({ pathname: '/api/external-systems', method: 'HEAD' })).toBe(
      'external_mapping.read',
    );
  });

  it('★ 외부시스템 lookup 이 외부매핑 API 정책을 가로채지 않는다 (경로 분리)', () => {
    expect(resolveRoutePermission({ pathname: '/api/external-mappings', method: 'GET' })).toBe(
      'external_mapping.read',
    );
    expect(resolveRoutePermission({ pathname: '/api/external-mappings', method: 'POST' })).toBe(
      'external_mapping.create',
    );
    expect(
      resolveRoutePermission({ pathname: `/api/external-mappings/${MAPPING_ID}`, method: 'PATCH' }),
    ).toBe('external_mapping.update');
  });

  it('★ 기존 화면 정책은 그대로다 — 회귀 없음', () => {
    expect(resolveRoutePermission({ pathname: '/master/skus', method: 'GET' })).toBe('sku.read');
    expect(resolveRoutePermission({ pathname: '/master/skus/new', method: 'GET' })).toBe(
      'sku.create',
    );
    expect(resolveRoutePermission({ pathname: '/admin/codes', method: 'GET' })).toBe(
      'common_code.read',
    );
  });

  it('★ 신규 permission 을 만들지 않았다 — 시드는 external_mapping.* 3종 그대로', () => {
    const keys = PERMISSION_SEED.map((row) => row.permissionKey).filter((key) =>
      key.startsWith('external_mapping.'),
    );
    expect(keys.sort()).toEqual([
      'external_mapping.create',
      'external_mapping.read',
      'external_mapping.update',
    ]);

    const readRoles = ROLE_PERMISSION_SEED.filter(
      (row) => row.permissionKey === 'external_mapping.read',
    )
      .map((row) => row.roleCode)
      .sort();
    expect(readRoles).toEqual(['ADMIN', 'FINANCE', 'SCM_LEADER', 'SCM_STAFF']);
    expect(readRoles).not.toContain('EXECUTIVE');
  });
});

// ═══════════════════════════════════════════════════════════════
// 목록 URL 상태 (§12·§13)
// ═══════════════════════════════════════════════════════════════

describe('★ 목록 URL 상태', () => {
  const read = (search: string) => readMappingListState(new URLSearchParams(search));
  const build = (search: string, patch: Parameters<typeof buildMappingListParams>[1]) =>
    buildMappingListParams(new URLSearchParams(search), patch).toString();

  it('★ 관리 키는 API 지원 범위와 정확히 일치한다 (sort·warehouse 없음)', () => {
    expect([...MAPPING_LIST_MANAGED_KEYS]).toEqual([
      'q',
      'externalSystemId',
      'skuId',
      'mappingStatus',
      'page',
      'pageSize',
    ]);
    expect(MAPPING_LIST_MANAGED_KEYS).not.toContain('sort');
    expect(MAPPING_LIST_MANAGED_KEYS).not.toContain('warehouseId');
    expect(MAPPING_LIST_MANAGED_KEYS).not.toContain('updatedAt');
  });

  it('★ 상태 목록이 API MappingStatus 3종과 일치한다', () => {
    expect([...MAPPING_LIST_STATUSES]).toEqual([...MAPPING_STATUSES]);
  });

  it('★ pageSize 선택지가 API 상한(200) 안에 있다', () => {
    for (const size of MAPPING_LIST_PAGE_SIZES) {
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(200);
    }
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });

  it('기본값을 읽는다', () => {
    expect(read('')).toEqual({
      q: '',
      externalSystemId: '',
      skuId: '',
      mappingStatus: '',
      page: 1,
      pageSize: 50,
    });
  });

  it('URL 에서 상태를 복원한다', () => {
    expect(read(`q=abc&externalSystemId=${SYSTEM_ID}&mappingStatus=MATCHED&page=3`)).toMatchObject({
      q: 'abc',
      externalSystemId: SYSTEM_ID,
      mappingStatus: 'MATCHED',
      page: 3,
    });
  });

  it('검색조건이 바뀌면 page 가 1 로 초기화된다', () => {
    expect(build('page=5', { q: 'x' })).toBe('q=x');
    expect(build('page=5&q=x', { mappingStatus: 'MATCHED' })).toBe('q=x&mappingStatus=MATCHED');
  });

  it('기본값은 URL 에 쓰지 않는다', () => {
    expect(build('', { page: 1, pageSize: 50 })).toBe('');
    expect(build('pageSize=20', { pageSize: 50 })).toBe('');
  });

  it('빈 값은 파라미터를 제거한다', () => {
    expect(build('q=x&mappingStatus=MATCHED', { mappingStatus: '' })).toBe('q=x');
  });

  it('★ 관리 키 밖 파라미터는 보존한다 — 조용히 지우지 않는다', () => {
    // `sort` 는 backend 가 400 으로 거부한다. UI 가 앞질러 제거하면 그 400 이 숨는다.
    const next = build('sort=createdAt_desc&warehouseId=w1', { q: 'x' });
    expect(next).toContain('sort=createdAt_desc');
    expect(next).toContain('warehouseId=w1');
  });

  it('★ API 쿼리는 URL 을 그대로 전달한다', () => {
    const params = new URLSearchParams('q=x&sort=nope');
    expect(mappingListApiQuery(params)).toBe('?q=x&sort=nope');
    expect(mappingListApiQuery(new URLSearchParams())).toBe('');
  });

  it('★ 실제로 미지원 파라미터는 backend 가 400 으로 판정한다', () => {
    expect(() => parseListMappingsQuery(new URLSearchParams('sort=createdAt_desc'))).toThrow();
    expect(() => parseListMappingsQuery(new URLSearchParams('warehouseId=w1'))).toThrow();
    // 화면이 관리하는 키는 전부 통과한다.
    expect(() =>
      parseListMappingsQuery(
        new URLSearchParams(
          `q=a&externalSystemId=${SYSTEM_ID}&skuId=${SKU_ID}&mappingStatus=MATCHED&page=2&pageSize=20`,
        ),
      ),
    ).not.toThrow();
  });
});

describe('★ 행 표시 헬퍼', () => {
  it('적용기간을 표시한다', () => {
    expect(formatEffectivePeriod(null, null)).toBe('');
    expect(formatEffectivePeriod('2026-01-01', null)).toBe('2026-01-01 ~ ');
    expect(formatEffectivePeriod(null, '2026-08-10')).toBe(' ~ 2026-08-10');
  });

  it('★ 종료된 행은 수정·해제 대상이 아니다', () => {
    expect(isEndedMapping('2026-08-10')).toBe(true);
    expect(isEndedMapping(null)).toBe(false);
    expect(isInteractiveMapping('MATCHED', '2026-08-10')).toBe(false);
  });

  it('★ UNMATCHED 행도 수정 대상이 아니다 (서버가 422)', () => {
    expect(isInteractiveMapping('UNMATCHED', null)).toBe(false);
    expect(isInteractiveMapping('MATCHED', null)).toBe(true);
    expect(isInteractiveMapping('REVIEW_REQUIRED', null)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// create payload (§16)
// ═══════════════════════════════════════════════════════════════

describe('★ 신규 매핑 payload — POST DTO 와 정확히 일치', () => {
  const form = { ...EMPTY_CREATE_FORM, externalSystemId: SYSTEM_ID, skuId: SKU_ID };

  it('필수 2개만 채우면 그 2개만 보낸다', () => {
    expect(buildCreatePayload(form)).toEqual({ skuId: SKU_ID, externalSystemId: SYSTEM_ID });
  });

  it('입력한 선택 필드만 담는다', () => {
    const payload = buildCreatePayload({
      ...form,
      externalProductCode: 'P001',
      externalProductName: '외부명',
      externalBarcode: '8809619961373',
      isPrimary: true,
      note: '메모',
    });
    expect(payload).toEqual({
      skuId: SKU_ID,
      externalSystemId: SYSTEM_ID,
      externalProductCode: 'P001',
      externalProductName: '외부명',
      externalBarcode: '8809619961373',
      isPrimary: true,
      note: '메모',
    });
  });

  it('★ 생성한 payload 가 backend strict DTO 를 통과한다', () => {
    expect(
      createMappingSchema.safeParse(buildCreatePayload({ ...form, externalProductCode: 'P001' }))
        .success,
    ).toBe(true);
  });

  it('★ server-managed 필드를 payload 에 넣지 않는다', () => {
    const payload = buildCreatePayload({
      ...form,
      externalProductCode: 'P001',
    }) as unknown as Record<string, unknown>;
    for (const key of [
      'id',
      'mappingStatus',
      'effectiveFrom',
      'effectiveTo',
      'createdAt',
      'warehouseId',
    ]) {
      expect(payload[key], key).toBeUndefined();
    }
  });

  it('★ 식별자를 하나도 안 채워도 UI 가 막지 않는다 — 서버 422 를 보여준다', () => {
    const payload = buildCreatePayload(form);
    expect(createMappingSchema.safeParse(payload).success).toBe(true);
  });

  it('★ trim 하지 않는다 — canonicalization 은 서버 몫', () => {
    expect(buildCreatePayload({ ...form, externalProductCode: '  P001  ' })).toMatchObject({
      externalProductCode: '  P001  ',
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// update payload (§18)
// ═══════════════════════════════════════════════════════════════

describe('★ 수정 payload — 변경분만', () => {
  const row = {
    externalProductCode: null,
    externalProductName: '이름',
    externalBarcode: null,
    isPrimary: false,
    note: null,
  };

  it('현재 행에서 폼 초기값을 만든다', () => {
    expect(toEditForm(row)).toEqual({
      externalProductCode: '',
      externalProductName: '이름',
      externalBarcode: '',
      isPrimary: false,
      note: '',
    });
  });

  it('★ 변경이 없으면 null — PATCH 를 호출하지 않는다', () => {
    expect(buildUpdatePayload(row, toEditForm(row))).toBeNull();
  });

  it('★ REVIEW_REQUIRED 해소 — 외부코드만 추가하면 그 필드만 보낸다', () => {
    const payload = buildUpdatePayload(row, { ...toEditForm(row), externalProductCode: 'P001' });
    expect(payload).toEqual({ externalProductCode: 'P001' });
    expect(updateMappingSchema.safeParse(payload).success).toBe(true);
  });

  it('빈 문자열은 null 로 지운다', () => {
    const filled = { ...row, externalProductCode: 'P001' };
    expect(buildUpdatePayload(filled, { ...toEditForm(filled), externalProductCode: '' })).toEqual({
      externalProductCode: null,
    });
  });

  it('대표 토글도 변경분에 담긴다', () => {
    expect(buildUpdatePayload(row, { ...toEditForm(row), isPrimary: true })).toEqual({
      isPrimary: true,
    });
  });

  it('★ identity·상태 필드를 payload 에 넣지 않는다', () => {
    const payload = buildUpdatePayload(row, {
      ...toEditForm(row),
      externalProductCode: 'P001',
    }) as unknown as Record<string, unknown>;
    for (const key of [
      'skuId',
      'externalSystemId',
      'mappingStatus',
      'effectiveFrom',
      'warehouseId',
    ]) {
      expect(payload[key], key).toBeUndefined();
    }
    // backend DTO 도 그 키들을 거부한다.
    expect(() => parseUpdateMappingInput({ skuId: SKU_ID })).toThrow();
    expect(() => parseUpdateMappingInput({ externalSystemId: SYSTEM_ID })).toThrow();
    expect(() => parseUpdateMappingInput({ mappingStatus: 'MATCHED' })).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 매핑 해제 (§19)
// ═══════════════════════════════════════════════════════════════

describe('★ 매핑 해제 payload', () => {
  it('일반 행은 effectiveTo 만 보낸다', () => {
    expect(buildEndPayload({ isPrimary: false }, '2026-08-10')).toEqual({
      effectiveTo: '2026-08-10',
    });
  });

  it('★ 대표 행은 같은 요청에서 isPrimary=false 를 함께 보낸다', () => {
    expect(buildEndPayload({ isPrimary: true }, '2026-08-10')).toEqual({
      isPrimary: false,
      effectiveTo: '2026-08-10',
    });
  });

  it('두 payload 모두 backend PATCH DTO 를 통과한다', () => {
    for (const isPrimary of [true, false]) {
      const payload = buildEndPayload({ isPrimary }, '2026-08-10');
      expect(updateMappingSchema.safeParse(payload).success, String(isPrimary)).toBe(true);
    }
  });

  it('★ 업무일자가 backend businessDateOf 와 같은 규칙이다 (새 유틸 아님)', () => {
    for (const iso of [
      '2026-08-09T16:30:00.000Z',
      '2026-08-09T14:30:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]) {
      const now = new Date(iso);
      expect(todayBusinessDate(now), iso).toBe(businessDateOf(now));
    }
    expect(todayBusinessDate()).toBe(businessDateOf(new Date()));
  });
});

// ═══════════════════════════════════════════════════════════════
// 외부시스템 lookup 쿼리 (§6)
// ═══════════════════════════════════════════════════════════════

describe('★ GET /api/external-systems 쿼리 계약', () => {
  it('파라미터가 없으면 통과한다', () => {
    expect(() => parseListExternalSystemsQuery(new URLSearchParams())).not.toThrow();
  });

  it('★ 어떤 파라미터도 받지 않는다 — 400', () => {
    for (const search of ['page=1', 'active=true', 'q=abc', 'pageSize=20']) {
      expect(() => parseListExternalSystemsQuery(new URLSearchParams(search)), search).toThrow();
    }
  });
});
