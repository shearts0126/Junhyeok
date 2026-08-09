import { describe, expect, it } from 'vitest';

import { SKU_SORTS } from '@/modules/sku/application';
import { SKU_STATUSES } from '@/modules/sku/domain';

import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  SKU_LIST_MANAGED_KEYS,
  SKU_LIST_PAGE_SIZES,
  SKU_LIST_SORTS,
  SKU_LIST_STATUSES,
  buildSkuListParams,
  readSkuListState,
  skuListApiQuery,
} from './list-params';

/**
 * SKU 목록 URL 상태 헬퍼 테스트 (T1-5A).
 *
 * 화면 상수가 T1-3 API contract·T1-2 domain 과 어긋나지 않음을 고정한다 —
 * 클라이언트 번들이 Prisma 를 끌고 오지 않도록 상수를 복제했기 때문에,
 * 이 테스트가 복제본의 정합성을 지킨다.
 */

describe('★ API contract 정합', () => {
  it('정렬 목록이 API SKU_SORTS 와 정확히 일치한다 — 프론트 임의 정렬 없음', () => {
    expect([...SKU_LIST_SORTS]).toEqual([...SKU_SORTS]);
    expect(DEFAULT_SORT).toBe('updatedAt_desc');
  });

  it('상태 목록이 domain SKU_STATUSES 와 정확히 일치한다 — 상태 발명 없음', () => {
    expect([...SKU_LIST_STATUSES]).toEqual([...SKU_STATUSES]);
  });

  it('관리 키가 T1-3 지원 파라미터와 정확히 일치 — 미래 필터(hasBom 등) 없음', () => {
    expect([...SKU_LIST_MANAGED_KEYS]).toEqual([
      'q',
      'status',
      'itemType',
      'brandId',
      'majorCategoryId',
      'minorCategoryId',
      'page',
      'pageSize',
      'sort',
    ]);
    for (const forbidden of ['hasBom', 'mappingStatus', 'hasIssue', 'barcode']) {
      expect(SKU_LIST_MANAGED_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });

  it('pageSize 선택지는 API 허용 범위(1..200) 안이다', () => {
    for (const size of SKU_LIST_PAGE_SIZES) {
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(200);
    }
    expect(SKU_LIST_PAGE_SIZES).toContain(DEFAULT_PAGE_SIZE);
  });
});

describe('readSkuListState', () => {
  it('기본값: page=1, pageSize=50, sort=updatedAt_desc', () => {
    expect(readSkuListState(new URLSearchParams())).toEqual({
      q: '',
      status: '',
      itemType: '',
      brandId: '',
      majorCategoryId: '',
      minorCategoryId: '',
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      sort: DEFAULT_SORT,
    });
  });

  it('URL 복원 — 모든 관리 키를 읽는다', () => {
    const state = readSkuListState(
      new URLSearchParams(
        'q=샴푸&status=ACTIVE&itemType=FINISHED_GOOD&page=3&pageSize=20&sort=skuCode_asc',
      ),
    );
    expect(state).toMatchObject({
      q: '샴푸',
      status: 'ACTIVE',
      itemType: 'FINISHED_GOOD',
      page: 3,
      pageSize: 20,
      sort: 'skuCode_asc',
    });
  });

  it('형식이 어긋난 값은 표시용 기본값으로만 읽는다 (API 판정은 backend 몫)', () => {
    const state = readSkuListState(new URLSearchParams('page=abc&sort=name_asc'));
    expect(state.page).toBe(1);
    expect(state.sort).toBe(DEFAULT_SORT);
  });
});

describe('buildSkuListParams', () => {
  it('★ 검색조건 변경 시 page 를 1 로 초기화한다', () => {
    const current = new URLSearchParams('q=old&page=5');
    const next = buildSkuListParams(current, { q: '새검색' });
    expect(next.get('q')).toBe('새검색');
    expect(next.get('page')).toBeNull(); // page=1 은 URL 에서 생략
  });

  it('★ sort·pageSize 변경도 page 초기화, page 직접 지정은 유지', () => {
    expect(
      buildSkuListParams(new URLSearchParams('page=4'), { sort: 'skuCode_desc' }).get('page'),
    ).toBeNull();
    expect(
      buildSkuListParams(new URLSearchParams('page=4'), { pageSize: 100 }).get('page'),
    ).toBeNull();
    const paged = buildSkuListParams(new URLSearchParams('q=x'), { page: 3 });
    expect(paged.get('page')).toBe('3');
    expect(paged.get('q')).toBe('x');
  });

  it('빈 값·기본값은 URL 에서 제거된다', () => {
    const current = new URLSearchParams('status=ACTIVE&sort=skuCode_asc&pageSize=100');
    const next = buildSkuListParams(current, {
      status: '',
      sort: DEFAULT_SORT,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    expect(next.toString()).toBe('');
  });

  it('★ 관리 키 밖의 파라미터는 보존한다 — 조용한 제거 금지', () => {
    const current = new URLSearchParams('hasBom=true&q=x');
    const next = buildSkuListParams(current, { q: 'y' });
    expect(next.get('hasBom')).toBe('true'); // backend 400 이 보이도록 유지
    expect(next.get('q')).toBe('y');
  });
});

describe('skuListApiQuery', () => {
  it('★ URL 파라미터를 그대로 API 에 전달한다 (미지원 키 포함)', () => {
    expect(skuListApiQuery(new URLSearchParams())).toBe('');
    expect(skuListApiQuery(new URLSearchParams('q=x&hasBom=true'))).toBe('?q=x&hasBom=true');
  });
});
