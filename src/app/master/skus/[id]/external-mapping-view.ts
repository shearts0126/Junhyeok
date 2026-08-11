/**
 * SKU 상세 외부시스템 매핑 탭 헬퍼 (T1-6B2) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ `@/modules/external-mapping/application` barrel 을 import 하지 않는다 (Prisma
 *    런타임을 끌고 온다). 대신 **unit 테스트가 backend contract 와의 정합을 고정**한다.
 *
 * ## 이 탭은 read-only summary 다 (`docs/16` §19~§21)
 *
 *   - 신규 API 0개 — `GET /api/external-mappings?skuId=…` 재사용
 *   - embedded CRUD 없음 — 모든 변경은 `EXT-MAP-001`(`/master/external-mappings`)
 *   - 창고 열 없음 — `Warehouse` 는 T08-1 이다 (placeholder 도 두지 않는다)
 *   - 관리 화면의 URL-state 아키텍처를 가져오지 않는다 — 탭 내부 local state 뿐
 */

/** V1 고정 페이지 크기. API 허용 범위(1..200) 안이며 UI 선택지를 만들지 않는다. */
export const MAPPING_TAB_PAGE_SIZE = 50;

/**
 * 이 탭이 API 에 보내는 파라미터 — **정확히 이 3개뿐**이다.
 *
 * ⛔ `q` · `externalSystemId` · `mappingStatus` · `sort` · `warehouseId` 없음.
 *    SKU 상세 탭은 page-level 관리 UI 가 아니다.
 */
export const MAPPING_TAB_QUERY_KEYS = ['skuId', 'page', 'pageSize'] as const;

/** 해당 SKU 의 매핑만 조회하는 쿼리. `page` 는 1-base. */
export function buildSkuMappingQuery(skuId: string, page: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set('skuId', skuId);
  params.set('page', String(page < 1 ? 1 : page));
  params.set('pageSize', String(MAPPING_TAB_PAGE_SIZE));
  return params;
}

/** `GET /api/external-mappings?…` 경로. */
export function skuMappingApiPath(skuId: string, page: number): string {
  return `/api/external-mappings?${buildSkuMappingQuery(skuId, page).toString()}`;
}

/**
 * 관리 화면 링크 — 해당 SKU 로 **필터된 상태**로 진입한다.
 *
 * T05-4A 의 URL-state 계약(`skuId` 는 관리 키다)을 그대로 쓴다.
 * ⛔ SKU 코드·상품명 등 다른 파라미터를 붙이지 않는다 — 관리 화면이 모르는 키는
 *    보존돼 API 400 이 되므로, 아는 키 하나만 넘긴다.
 */
export function externalMappingManagementHref(skuId: string): string {
  return `/master/external-mappings?skuId=${encodeURIComponent(skuId)}`;
}

/**
 * 외부 상품명의 의미를 화면에서 명시한다 (`05 §11.4 ④`).
 * 이 탭이 read-only 라는 성격도 함께 분명해진다.
 */
export const EXTERNAL_PRODUCT_NAME_NOTICE =
  '외부 상품명은 외부시스템 식별용 정보이며 SKU 표준 상품명을 변경하지 않습니다.';

/** 매핑이 0건일 때의 문구. */
export const MAPPING_TAB_EMPTY_MESSAGE = '등록된 외부시스템 매핑이 없습니다.';

// ═══════════════════════════════════════════════════════════════
// 행
// ═══════════════════════════════════════════════════════════════

/**
 * 탭이 **실제로 쓰는 필드만** 담은 projection.
 *
 * ⚠️ `GET /api/external-mappings` 응답의 부분집합이다 — `warehouseId` ·
 *    `externalBarcode` · `note` · `sku`(현재 SKU 라 반복 불필요) 는 쓰지 않는다.
 */
export interface MappingSummaryRow {
  readonly id: string;
  readonly skuId: string;
  readonly externalProductCode: string | null;
  readonly externalProductName: string | null;
  readonly mappingStatus: string;
  readonly isPrimary: boolean;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly externalSystem: {
    readonly systemCode: string;
    readonly systemName: string;
  };
}

/** `ZZX-ERP — 이카운트` 형태의 외부시스템 표시. */
export function externalSystemLabel(system: MappingSummaryRow['externalSystem']): string {
  return `${system.systemCode} — ${system.systemName}`;
}

/** 대표 여부 표시 — T05-4A 와 같은 표현(`대표` / 공란)을 쓴다. */
export function primaryLabel(isPrimary: boolean): string {
  return isPrimary ? '대표' : '';
}

/** null 을 빈 문자열로 — T05-4A 목록과 같은 표현이다. */
export function orBlank(value: string | null | undefined): string {
  return value ?? '';
}

/** 총 건수 → 페이지 수. API `totalPages` 가 있을 때는 그 값을 우선한다. */
export function mappingTabTotalPages(total: number): number {
  return Math.max(1, Math.ceil(total / MAPPING_TAB_PAGE_SIZE));
}
