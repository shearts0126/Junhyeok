/**
 * 거래처 목록 URL 상태 헬퍼 (T06-4, D-4) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ 이 파일은 `@/modules/supplier/application` barrel 을 import 하지 않는다 —
 *    barrel 이 Prisma 런타임을 끌고 오기 때문이다. 상수는 여기 두고 **unit
 *    테스트가 API contract 와의 일치를 고정**한다 (T1-5A·T05-4A 와 같은 구조).
 *
 * ## URL 이 단일 진실이다
 *
 * 검색조건·페이지는 URL searchParams 와 동기화한다 — 뒤로/앞으로·새로고침·
 * 링크 공유가 상태를 복원한다.
 *
 * ⚠️ **관리 키 밖의 파라미터는 보존·전달한다.** URL 에 직접 들어온 미지원
 *    파라미터(`pageSize`·`sort` 등)를 조용히 제거하지 않는다 — 그대로 API 에
 *    전달돼 backend 400 이 사용자에게 보인다.
 *
 * ⛔ **정렬 UI 가 없다** — `GET /api/suppliers` 에 `sort` 가 없고 정렬은
 *    `supplierCode ASC, id ASC` 고정이다.
 * ⛔ **페이지 크기 선택이 없다** — 서버 고정 50 이다.
 */

/** 이 화면이 관리하는 파라미터 — T06-2 `GET /api/suppliers` 지원 범위와 정확히 일치. */
export const SUPPLIER_LIST_MANAGED_KEYS = ['q', 'supplierType', 'status', 'page'] as const;

export type SupplierListManagedKey = (typeof SUPPLIER_LIST_MANAGED_KEYS)[number];

/**
 * `supplierType` **알려진 예시값** (`docs/03:185`·`03:1043` 주석).
 *
 * ⚠️ closed enum 이 **아니다** — API 는 trim·nonblank·≤30자 open string 을
 *    허용한다 (D-5). 그래서 select 가 아니라 **입력 + 제안(datalist)** 이다.
 *    여기 없는 값도 사용자가 직접 입력할 수 있어야 한다.
 */
export const SUPPLIER_TYPE_SUGGESTIONS = [
  'MANUFACTURER',
  'VENDOR',
  'THREE_PL',
  'FORWARDER',
] as const;

/**
 * `status` 알려진 예시값. 역시 open string 이다 — DB default 가 `ACTIVE` 일 뿐
 * API 는 enum 검증을 하지 않는다. closed select 를 만들지 않는다.
 */
export const SUPPLIER_STATUS_SUGGESTIONS = ['ACTIVE'] as const;

/** 서버 고정 페이지 크기 — API `SUPPLIER_PAGE_SIZE` 와 일치 (unit 고정). */
export const SUPPLIER_PAGE_SIZE = 50;

/** 화면 폼 상태 — 전부 URL 에서 파생된다. */
export interface SupplierListState {
  readonly q: string;
  readonly supplierType: string;
  readonly status: string;
  readonly page: number;
}

function positiveIntOr(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/**
 * URL → 화면 상태. 형식이 어긋난 `page` 는 **화면 표시용으로만** 기본값으로
 * 읽는다 — API 요청은 원본 파라미터를 그대로 보내므로 400 판정은 backend 몫이다.
 */
export function readSupplierListState(params: URLSearchParams): SupplierListState {
  return {
    q: params.get('q') ?? '',
    supplierType: params.get('supplierType') ?? '',
    status: params.get('status') ?? '',
    page: positiveIntOr(params.get('page'), 1),
  };
}

export interface SupplierListPatch {
  readonly q?: string;
  readonly supplierType?: string;
  readonly status?: string;
  readonly page?: number;
}

/**
 * 현재 URL 파라미터에 patch 를 적용한 새 URLSearchParams.
 *
 * - 빈 문자열 값은 파라미터 **제거**
 * - 기본값(`page=1`)은 URL 에 쓰지 않는다
 * - **검색조건 변경 시 page 는 1 로 초기화** (`page` 를 직접 지정한 patch 제외)
 * - 관리 키 밖의 기존 파라미터는 그대로 보존한다 (조용한 제거 금지)
 */
export function buildSupplierListParams(
  current: URLSearchParams,
  patch: SupplierListPatch,
): URLSearchParams {
  const next = new URLSearchParams(current);

  const setOrDelete = (key: SupplierListManagedKey, value: string | undefined): void => {
    if (value === undefined) return;
    if (value === '') next.delete(key);
    else next.set(key, value);
  };

  setOrDelete('q', patch.q);
  setOrDelete('supplierType', patch.supplierType);
  setOrDelete('status', patch.status);

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
export function supplierListApiQuery(params: URLSearchParams): string {
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * 리드타임 표시 — `null` 은 `—`, **`0` 은 `0`** 이다 (§00 G-03).
 *
 * ⛔ `value || '—'` 를 쓰지 않는다 — `0` 이 falsy 라 즉시납이 미입력으로 둔갑한다.
 */
export function formatLeadTimeDays(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** 값이 없을 때의 공통 표기. 빈 문자열도 `—` 로 본다. */
export function formatOptionalText(value: string | null): string {
  return value === null || value.trim() === '' ? '—' : value;
}
