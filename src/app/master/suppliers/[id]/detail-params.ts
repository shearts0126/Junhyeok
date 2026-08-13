/**
 * 거래처 상세 URL 상태 헬퍼 (T06-4, §19) — 순수 함수만.
 *
 * ⚠️ 이 화면 query 는 **UI route state** 다 — backend API query 와 다르다.
 *    `tab`·`termsPage`·`supplierSkuId` 를 API 로 전달하지 않는다 (전달하면
 *    미지원 파라미터 400 이다).
 *
 * 새로고침·뒤로가기·링크 공유가 탭과 선택 상태를 복원한다.
 */

export const SUPPLIER_DETAIL_TABS = ['basic', 'terms', 'prices'] as const;

export type SupplierDetailTab = (typeof SUPPLIER_DETAIL_TABS)[number];

/** 탭 순서·라벨은 `docs/02:148`(거래처·공급조건·가격이력) 순서 그대로다 (D-10). */
export const SUPPLIER_DETAIL_TAB_LABELS: Readonly<Record<SupplierDetailTab, string>> = {
  basic: '기본정보',
  terms: '공급조건',
  prices: '가격이력',
};

export const DEFAULT_SUPPLIER_DETAIL_TAB: SupplierDetailTab = 'basic';

export interface SupplierDetailState {
  readonly tab: SupplierDetailTab;
  readonly termsPage: number;
  /** 가격이력 탭에서 선택된 공급조건. 없으면 선택 안내 상태다. */
  readonly supplierSkuId: string;
}

function positiveIntOr(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/** 알 수 없는 `tab` 은 `basic` 으로 fallback 한다 (§19). */
export function readSupplierDetailState(params: URLSearchParams): SupplierDetailState {
  const raw = params.get('tab');
  const tab = (SUPPLIER_DETAIL_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as SupplierDetailTab)
    : DEFAULT_SUPPLIER_DETAIL_TAB;
  return {
    tab,
    termsPage: positiveIntOr(params.get('termsPage'), 1),
    supplierSkuId: params.get('supplierSkuId') ?? '',
  };
}

export interface SupplierDetailPatch {
  readonly tab?: SupplierDetailTab;
  readonly termsPage?: number;
  readonly supplierSkuId?: string;
}

/** 기본값(`tab=basic`·`termsPage=1`·빈 선택)은 URL 에 쓰지 않는다. */
export function buildSupplierDetailParams(
  current: URLSearchParams,
  patch: SupplierDetailPatch,
): URLSearchParams {
  const next = new URLSearchParams(current);

  if (patch.tab !== undefined) {
    if (patch.tab === DEFAULT_SUPPLIER_DETAIL_TAB) next.delete('tab');
    else next.set('tab', patch.tab);
  }

  if (patch.termsPage !== undefined) {
    if (patch.termsPage <= 1) next.delete('termsPage');
    else next.set('termsPage', String(patch.termsPage));
  }

  if (patch.supplierSkuId !== undefined) {
    if (patch.supplierSkuId === '') next.delete('supplierSkuId');
    else next.set('supplierSkuId', patch.supplierSkuId);
  }

  return next;
}
