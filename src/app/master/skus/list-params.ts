/**
 * SKU 목록 URL 상태 헬퍼 (T1-5A) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ 이 파일은 `@/modules/sku/application` barrel 을 import 하지 않는다 —
 *    barrel 이 Prisma 런타임을 끌고 오기 때문이다. 목록 정렬·상태 목록은
 *    여기 상수로 두고, **unit 테스트가 API contract(SKU_SORTS 등)와의 일치를
 *    고정**한다.
 *
 * ## URL 이 단일 진실이다
 *
 * 검색조건·정렬·페이지는 전부 URL searchParams 와 동기화한다 — 뒤로가기/앞으로
 * 가기·새로고침·링크 공유가 상태를 복원한다.
 *
 * ⚠️ **관리 키 밖의 파라미터는 보존·전달한다.** URL 에 직접 들어온 미지원
 *    파라미터(`hasBom` 등)를 조용히 제거하고 재조회하지 않는다 — 그대로 API 에
 *    전달돼 backend 400 이 사용자에게 보인다 (T1-3 계약: 미지원 파라미터는
 *    무시가 아니라 400).
 */

/** T1-3 `GET /api/skus` 가 지원하는 정렬 — API `SKU_SORTS` 와 일치 (unit 고정). */
export const SKU_LIST_SORTS = [
  'updatedAt_desc',
  'updatedAt_asc',
  'skuCode_asc',
  'skuCode_desc',
] as const;

export type SkuListSort = (typeof SKU_LIST_SORTS)[number];

export const SKU_LIST_SORT_LABELS: Readonly<Record<SkuListSort, string>> = {
  updatedAt_desc: '최종수정 최신순',
  updatedAt_asc: '최종수정 오래된순',
  skuCode_asc: 'SKU 코드 오름차순',
  skuCode_desc: 'SKU 코드 내림차순',
};

/** SkuStatus 7종 — domain `SKU_STATUSES` 와 일치 (unit 고정). 추가 상태 발명 금지. */
export const SKU_LIST_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'REJECTED',
  'ACTIVE',
  'INACTIVE',
  'DISCONTINUED',
  'ARCHIVED',
] as const;

export type SkuListStatus = (typeof SKU_LIST_STATUSES)[number];

export const SKU_STATUS_LABELS: Readonly<Record<SkuListStatus, string>> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '승인대기',
  REJECTED: '반려',
  ACTIVE: '활성',
  INACTIVE: '중지',
  DISCONTINUED: '단종',
  ARCHIVED: '폐기',
};

/** API pageSize 허용 범위(1..200) 안의 UI 선택지. */
export const SKU_LIST_PAGE_SIZES = [20, 50, 100, 200] as const;

export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_SORT: SkuListSort = 'updatedAt_desc';

/** 이 화면이 관리하는 파라미터 — T1-3 API 지원 범위와 정확히 일치. */
export const SKU_LIST_MANAGED_KEYS = [
  'q',
  'status',
  'itemType',
  'brandId',
  'majorCategoryId',
  'minorCategoryId',
  'page',
  'pageSize',
  'sort',
] as const;

export type SkuListManagedKey = (typeof SKU_LIST_MANAGED_KEYS)[number];

/** 화면 폼 상태 — 전부 URL 에서 파생된다. */
export interface SkuListState {
  readonly q: string;
  readonly status: string;
  readonly itemType: string;
  readonly brandId: string;
  readonly majorCategoryId: string;
  readonly minorCategoryId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly sort: SkuListSort;
}

function positiveIntOr(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/**
 * URL → 화면 상태. 형식이 어긋난 page/pageSize/sort 는 **화면 표시용으로만**
 * 기본값으로 읽는다 — API 요청은 원본 파라미터를 그대로 보내므로 잘못된 값의
 * 400 판정은 backend 몫이다 (조용한 보정 없음).
 */
export function readSkuListState(params: URLSearchParams): SkuListState {
  const sortRaw = params.get('sort');
  const sort = (SKU_LIST_SORTS as readonly string[]).includes(sortRaw ?? '')
    ? (sortRaw as SkuListSort)
    : DEFAULT_SORT;
  return {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    itemType: params.get('itemType') ?? '',
    brandId: params.get('brandId') ?? '',
    majorCategoryId: params.get('majorCategoryId') ?? '',
    minorCategoryId: params.get('minorCategoryId') ?? '',
    page: positiveIntOr(params.get('page'), 1),
    pageSize: positiveIntOr(params.get('pageSize'), DEFAULT_PAGE_SIZE),
    sort,
  };
}

export interface SkuListPatch {
  readonly q?: string;
  readonly status?: string;
  readonly itemType?: string;
  readonly brandId?: string;
  readonly majorCategoryId?: string;
  readonly minorCategoryId?: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: string;
}

/**
 * 현재 URL 파라미터에 patch 를 적용한 새 URLSearchParams.
 *
 * - 빈 문자열 값은 파라미터 **제거** (기본값으로 복귀)
 * - 기본값(page=1, pageSize=50, sort=updatedAt_desc)은 URL 에 쓰지 않는다
 * - **검색조건·정렬 변경 시 page 는 1 로 초기화** (`page` 를 직접 지정한 patch 제외)
 * - 관리 키 밖의 기존 파라미터는 그대로 보존한다 (조용한 제거 금지)
 */
export function buildSkuListParams(current: URLSearchParams, patch: SkuListPatch): URLSearchParams {
  const next = new URLSearchParams(current);

  const setOrDelete = (key: SkuListManagedKey, value: string | undefined): void => {
    if (value === undefined) return;
    if (value === '') next.delete(key);
    else next.set(key, value);
  };

  setOrDelete('q', patch.q);
  setOrDelete('status', patch.status);
  setOrDelete('itemType', patch.itemType);
  setOrDelete('brandId', patch.brandId);
  setOrDelete('majorCategoryId', patch.majorCategoryId);
  setOrDelete('minorCategoryId', patch.minorCategoryId);

  if (patch.sort !== undefined) {
    if (patch.sort === '' || patch.sort === DEFAULT_SORT) next.delete('sort');
    else next.set('sort', patch.sort);
  }

  if (patch.pageSize !== undefined) {
    if (patch.pageSize === DEFAULT_PAGE_SIZE) next.delete('pageSize');
    else next.set('pageSize', String(patch.pageSize));
  }

  if (patch.page !== undefined) {
    if (patch.page <= 1) next.delete('page');
    else next.set('page', String(patch.page));
  } else {
    // ★ 검색조건·정렬·pageSize 가 바뀌면 page 1 로 초기화.
    next.delete('page');
  }

  return next;
}

/**
 * API 요청 쿼리 — **URL 파라미터를 그대로 전달한다.** 미지원 키를 걸러내지
 * 않는다 (backend 400 을 숨기지 않는 계약).
 */
export function skuListApiQuery(params: URLSearchParams): string {
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}
