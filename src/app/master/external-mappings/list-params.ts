/**
 * 외부 상품 매핑 목록 URL 상태 헬퍼 (T05-4A) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ 이 파일은 `@/modules/external-mapping/application` barrel 을 import 하지
 *    않는다 — barrel 이 Prisma 런타임을 끌고 오기 때문이다. 상태 목록은 여기
 *    상수로 두고, **unit 테스트가 API contract(`MAPPING_STATUSES`)와의 일치를
 *    고정**한다. (T1-5A `list-params.ts` 와 같은 구조)
 *
 * ## URL 이 단일 진실이다
 *
 * 검색조건·페이지는 URL searchParams 와 동기화한다 — 뒤로/앞으로·새로고침·링크
 * 공유가 상태를 복원한다.
 *
 * ⚠️ **관리 키 밖의 파라미터는 보존·전달한다.** URL 에 직접 들어온 미지원
 *    파라미터(`sort`·`warehouseId` 등)를 조용히 제거하고 재조회하지 않는다 —
 *    그대로 API 에 전달돼 backend 400 이 사용자에게 보인다.
 *
 * ⛔ **정렬 UI 가 없다.** `GET /api/external-mappings` 에 `sort` 가 없고 정렬은
 *    `createdAt DESC, id DESC` 로 고정이다 (docs/13 §12).
 * ⛔ **창고 필터가 없다.** `warehouseId` 는 T08-1 이후다.
 * ⛔ **"미매칭만 보기" 버튼이 없다** — 그 문구의 의미가 미정이라 T05-4B 다.
 */

/** T05-1 `MappingStatus` 3종 — API `MAPPING_STATUSES` 와 일치 (unit 고정). */
export const MAPPING_LIST_STATUSES = ['MATCHED', 'UNMATCHED', 'REVIEW_REQUIRED'] as const;

export type MappingListStatus = (typeof MAPPING_LIST_STATUSES)[number];

export const MAPPING_STATUS_LABELS: Readonly<Record<MappingListStatus, string>> = {
  MATCHED: '매칭됨',
  UNMATCHED: '미매칭',
  REVIEW_REQUIRED: '확인 필요',
};

/**
 * 상태 배지 색. 관리 화면(T05-4A)과 SKU 상세 외부매핑 탭(T1-6B2)이 **같은 표현**을
 * 쓰도록 여기로 끌어올렸다 (display helper 최소 공유 — 동작 변경 없음).
 */
export const MAPPING_STATUS_CLASS: Readonly<Record<string, string>> = {
  MATCHED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  REVIEW_REQUIRED: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  UNMATCHED: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};

/** T05-2/T05-3 계약을 그대로 보여주는 문구 — 승인 버튼도, review API 도 없다. */
export const REVIEW_REQUIRED_NOTICE =
  '상품명 기반 매핑입니다. 자동 원장 반영 대상이 아닙니다. 외부코드 또는 바코드를 추가하면 MATCHED 로 전환할 수 있습니다.';

/** API pageSize 허용 범위(1..200) 안의 UI 선택지. */
export const MAPPING_LIST_PAGE_SIZES = [20, 50, 100, 200] as const;

export const DEFAULT_PAGE_SIZE = 50;

/** 이 화면이 관리하는 파라미터 — T05-2 API 지원 범위와 정확히 일치. */
export const MAPPING_LIST_MANAGED_KEYS = [
  'q',
  'externalSystemId',
  'skuId',
  'mappingStatus',
  'page',
  'pageSize',
] as const;

export type MappingListManagedKey = (typeof MAPPING_LIST_MANAGED_KEYS)[number];

export interface MappingListState {
  readonly q: string;
  readonly externalSystemId: string;
  readonly skuId: string;
  readonly mappingStatus: string;
  readonly page: number;
  readonly pageSize: number;
}

function positiveIntOr(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/**
 * URL → 화면 상태. 형식이 어긋난 page/pageSize 는 **화면 표시용으로만** 기본값으로
 * 읽는다 — API 요청은 원본 파라미터를 그대로 보내므로 400 판정은 backend 몫이다.
 */
export function readMappingListState(params: URLSearchParams): MappingListState {
  return {
    q: params.get('q') ?? '',
    externalSystemId: params.get('externalSystemId') ?? '',
    skuId: params.get('skuId') ?? '',
    mappingStatus: params.get('mappingStatus') ?? '',
    page: positiveIntOr(params.get('page'), 1),
    pageSize: positiveIntOr(params.get('pageSize'), DEFAULT_PAGE_SIZE),
  };
}

export interface MappingListPatch {
  readonly q?: string;
  readonly externalSystemId?: string;
  readonly skuId?: string;
  readonly mappingStatus?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * 현재 URL 파라미터에 patch 를 적용한 새 URLSearchParams.
 *
 * - 빈 문자열 값은 파라미터 **제거** (기본값 복귀)
 * - 기본값(page=1, pageSize=50)은 URL 에 쓰지 않는다
 * - **검색조건 변경 시 page 는 1 로 초기화** (`page` 를 직접 지정한 patch 제외)
 * - 관리 키 밖의 기존 파라미터는 그대로 보존한다 (조용한 제거 금지)
 */
export function buildMappingListParams(
  current: URLSearchParams,
  patch: MappingListPatch,
): URLSearchParams {
  const next = new URLSearchParams(current);

  const setOrDelete = (key: MappingListManagedKey, value: string | undefined): void => {
    if (value === undefined) return;
    if (value === '') next.delete(key);
    else next.set(key, value);
  };

  setOrDelete('q', patch.q);
  setOrDelete('externalSystemId', patch.externalSystemId);
  setOrDelete('skuId', patch.skuId);
  setOrDelete('mappingStatus', patch.mappingStatus);

  if (patch.pageSize !== undefined) {
    if (patch.pageSize === DEFAULT_PAGE_SIZE) next.delete('pageSize');
    else next.set('pageSize', String(patch.pageSize));
  }

  if (patch.page !== undefined) {
    if (patch.page <= 1) next.delete('page');
    else next.set('page', String(patch.page));
  } else {
    next.delete('page');
  }

  return next;
}

/**
 * API 요청 쿼리 — **URL 파라미터를 그대로 전달한다.** 미지원 키를 걸러내지
 * 않는다 (backend 400 을 숨기지 않는 계약).
 */
export function mappingListApiQuery(params: URLSearchParams): string {
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** `YYYY-MM-DD` ~ `YYYY-MM-DD` (열려 있으면 `~` 만). 값이 없으면 빈 문자열. */
export function formatEffectivePeriod(from: string | null, to: string | null): string {
  if (from === null && to === null) return '';
  return `${from ?? ''} ~ ${to ?? ''}`;
}

/** 종료된 매핑은 이력이라 수정·해제할 수 없다 (T05-2 `EXTERNAL_MAPPING_ENDED`). */
export function isEndedMapping(effectiveTo: string | null): boolean {
  return effectiveTo !== null;
}

/**
 * `UNMATCHED` 행은 interactive API 가 만들지도, 고치지도 못한다
 * (T05-2 `EXTERNAL_MAPPING_UNMATCHED_NOT_INTERACTIVE`). 조회만 가능하다.
 */
export function isInteractiveMapping(mappingStatus: string, effectiveTo: string | null): boolean {
  return mappingStatus !== 'UNMATCHED' && !isEndedMapping(effectiveTo);
}
