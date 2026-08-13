/**
 * SKU 상세 ⑥ 공급조건 탭 헬퍼 (T1-6B4) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ `@/modules/supplier/application` barrel 을 import 하지 않는다 (Prisma
 *    런타임을 끌고 온다). 대신 **unit 테스트가 backend contract 와의 정합을
 *    고정**한다 — T1-6B1 `barcode-form.ts` · T1-6B2 `external-mapping-view.ts` ·
 *    T1-6B3 `history-view.ts` 와 같은 구조다.
 *
 * ## 계약 (`docs/16_설계복구_SKU상세잔여탭.md` §41~)
 *
 *   - **read-only summary** 다. mutation control 을 만들지 않는다 — 공급조건·
 *     가격의 owner 는 T06-4 `/master/suppliers` 화면이다 (docs/17 §95 D-34·D-35).
 *   - **현재 유효 공급조건만** 보여준다 (D-5) — 과거/미래 이력은 관리화면의 몫.
 *   - 리드타임은 **적용값(`effectiveLeadTimeDays`)** 이다 (D-9). `null → —`,
 *     **`0 → 0`** (§00 G-03).
 *   - `최근 단가` 는 asOf 유효 **승인** 가격이다 — 없으면 `—`, 0원이면 `0`.
 *   - 쿼리는 `page` 하나뿐. `asOf` 는 서버 업무일자라 보내지 않는다.
 */

/** 서버 고정 페이지 크기 — UI 선택지를 만들지 않는다 (D-21). */
export const SUPPLIER_TAB_PAGE_SIZE = 50;

/** 이 탭이 API 에 보내는 파라미터 — `page` **하나뿐**이다. */
export const SUPPLIER_TAB_QUERY_KEYS = ['page'] as const;

export function skuSupplierApiPath(skuId: string, page: number): string {
  const params = new URLSearchParams();
  params.set('page', String(page < 1 ? 1 : page));
  return `/api/skus/${skuId}/supplier-skus?${params.toString()}`;
}

// ═══════════════════════════════════════════════════════════════
// 행 — `GET /api/skus/{id}/supplier-skus` 의 item 그대로 (D-7)
// ═══════════════════════════════════════════════════════════════

export interface SupplierSummaryRow {
  readonly id: string;
  readonly supplierId: string;
  readonly supplier: {
    readonly id: string;
    readonly supplierCode: string;
    readonly supplierName: string;
  };
  readonly supplierSkuCode: string | null;
  readonly supplierSkuName: string | null;
  /** Decimal 문자열. ⛔ 숫자 변환 금지. */
  readonly moq: string | null;
  /** 적용 리드타임(파생). `0` 은 즉시납이다. */
  readonly effectiveLeadTimeDays: number | null;
  readonly supplyType: string;
  readonly isPrimary: boolean;
  readonly recentPrice: { readonly unitPrice: string; readonly currency: string } | null;
}

export interface SupplierSummaryResponse {
  readonly items: readonly SupplierSummaryRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly asOf: string;
}

// ═══════════════════════════════════════════════════════════════
// 표시 헬퍼
// ═══════════════════════════════════════════════════════════════

/**
 * `SupplyType` 라벨 — T06-4 가 확정한 매핑과 **같은 값**이다 (D-11).
 *
 * ⚠️ T06-4 의 helper 는 관리화면 전용 위치(`master/suppliers/[id]/terms-form.ts`)
 *    에 있어 SKU 상세가 직접 import 하면 화면 간 결합이 생긴다. 값을 여기
 *    상수로 두고 **unit 테스트가 두 매핑의 일치를 고정**한다 (T1-6B2 가
 *    `MAPPING_STATUS_LABELS` 를 다룬 방식과 같은 원칙).
 */
export const SUPPLY_TYPE_TAB_LABELS: Readonly<Record<string, string>> = {
  SELF_SUPPLIED: '사급',
  TURNKEY: '턴키',
};

/** 알 수 없는 값은 원문 그대로 — 임의 라벨을 만들지 않는다. */
export function supplyTypeTabLabel(value: string): string {
  return SUPPLY_TYPE_TAB_LABELS[value] ?? value;
}

/** 값 없음 표기. 빈 문자열도 `—` 로 본다. */
export function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === '' ? '—' : value;
}

/**
 * 리드타임 — `null → —`, **`0 → 0`** (G-03).
 *
 * ⛔ `value || '—'` 를 쓰지 않는다 — `0` 이 falsy 라 즉시납이 미입력으로 둔갑한다.
 */
export function formatEffectiveLeadTime(value: number | null): string {
  return value === null ? '—' : String(value);
}

/**
 * 최근 단가 — 없으면 `—`, 있으면 `{unitPrice} {currency}`.
 *
 * ★ `"0"` 은 실재하는 0원 단가라 `0 KRW` 로 보인다 — "가격 없음"(`—`)과
 *   절대 혼동하지 않는다 (D-17). ⛔ 숫자 변환·VAT 계산 금지.
 */
export function formatRecentPrice(
  price: { readonly unitPrice: string; readonly currency: string } | null,
): string {
  return price === null ? '—' : `${price.unitPrice} ${price.currency}`;
}

/** 우선공급업체 — T06-4 와 같은 표현이다 (D-12). */
export function primaryTabLabel(isPrimary: boolean): string {
  return isPrimary ? '예' : '—';
}

/**
 * 공급업체 SKU 표시 — 코드·명 중 있는 것만, 둘 다 없으면 `—` (§25).
 *
 * ⛔ SKU 자체의 `skuCode`/`skuName` 을 반복하지 않는다 — 화면 상단에 이미 있다.
 */
export function supplierSkuLabel(row: SupplierSummaryRow): string {
  const parts = [row.supplierSkuCode, row.supplierSkuName]
    .map((value) => (value === null || value.trim() === '' ? null : value))
    .filter((value): value is string => value !== null);
  return parts.length === 0 ? '—' : parts.join(' · ');
}

/**
 * 관리 링크 — **공급조건 탭**으로 보낸다 (D-22).
 *
 * ⛔ `?tab=prices` 나 `supplierSkuId` 를 붙이지 않는다 — 이 탭의 관리 대상은
 *    공급조건 요약이고, 그 authoritative target 은 T06-4 공급조건 탭이다.
 */
export function supplierManagementHref(supplierId: string): string {
  return `/master/suppliers/${supplierId}?tab=terms`;
}

export const SUPPLIER_TAB_EMPTY_MESSAGE = '등록된 공급조건이 없습니다.';
export const SUPPLIER_TAB_LOADING_MESSAGE = '공급조건을 불러오는 중…';

export function supplierTabTotalPages(response: SupplierSummaryResponse | null): number {
  return response === null ? 1 : Math.max(response.totalPages, 1);
}
