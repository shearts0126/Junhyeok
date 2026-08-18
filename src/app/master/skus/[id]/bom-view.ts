/**
 * SKU 상세 ⑦ BOM 탭 헬퍼 (T1-6B5) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ `@/modules/bom/application` barrel 을 import 하지 않는다 (Prisma 런타임을
 *    끌고 온다). 대신 **unit 테스트가 backend contract 와의 정합을 고정**한다 —
 *    T1-6B2 `external-mapping-view.ts` · T1-6B3 `history-view.ts` ·
 *    T1-6B4 `supplier-view.ts` 와 같은 구조다.
 *
 * ## 계약 (`docs/18_설계복구_BOM.md` §D-30)
 *
 * ⑦ 탭은 **read-only** 다. mutation owner 는 T07-8 `/master/boms` 화면이며,
 * 이 탭은 조회만 한다. 두 질문에 답한다:
 *
 * | 섹션 | 질문 | endpoint |
 * |---|---|---|
 * | A | 이 SKU 를 **상위(parent)로 갖는** BOM | `GET /api/boms?parentSkuId={id}` |
 * | B | 이 SKU 가 **구성품으로 쓰인** 곳 | `GET /api/skus/{id}/where-used` |
 *
 * ⛔ 두 API 를 섞거나 client 에서 join 하지 않는다 — 서로 다른 질문이다.
 * ⛔ BOM 을 SKU 상세 응답에 embed 하지 않는다.
 * ⛔ mutation·explode·cost 를 만들지 않는다 (T07-4~T07-8).
 */

/** 서버 고정 페이지 크기 — UI 선택지를 만들지 않는다 (`docs/18` §D-14). */
export const BOM_TAB_PAGE_SIZE = 50;

/** 섹션 A 가 API 에 보내는 파라미터 — `parentSkuId` 와 `page` 뿐이다. */
export const BOM_TAB_PARENT_QUERY_KEYS = ['parentSkuId', 'page'] as const;

/**
 * 섹션 A — 이 SKU 가 상위인 BOM.
 *
 * ⛔ `status`·`effectiveOn`·`hasUnknownQty` 를 붙이지 않는다. 이 탭은 **필터
 *    UI 가 없는 요약**이며, 임의 필터는 "이 SKU 의 BOM 전부"라는 의미를 바꾼다.
 */
export function skuParentBomsApiPath(skuId: string, page: number): string {
  const params = new URLSearchParams();
  params.set('parentSkuId', skuId);
  params.set('page', String(page < 1 ? 1 : page));
  return `/api/boms?${params.toString()}`;
}

/**
 * 섹션 B — 이 SKU 가 구성품으로 쓰인 곳.
 *
 * ⛔ 쿼리를 붙이지 않는다 — backend 가 **어떤 파라미터도 받지 않고 400** 이다.
 */
export function skuWhereUsedApiPath(skuId: string): string {
  return `/api/skus/${skuId}/where-used`;
}

// ═══════════════════════════════════════════════════════════════
// 응답 타입 — T07-3 actual response shape 그대로
// ═══════════════════════════════════════════════════════════════

export interface BomSkuRef {
  readonly id: string;
  readonly skuCode: string;
  readonly skuName: string;
}

/** `GET /api/boms` 의 item — 목록이라 `lines` 가 **없다** (D-14). */
export interface ParentBomRow {
  readonly id: string;
  readonly parentSkuId: string;
  readonly parentSku: BomSkuRef;
  readonly bomType: string;
  readonly version: string;
  readonly status: string;
  /** `YYYY-MM-DD` */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly lineCount: number;
  /** ★ `quantityStatus ≠ CONFIRMED` 인 라인 수 — `SUGGESTED` 도 포함한다. */
  readonly unconfirmedCount: number;
}

export interface ParentBomResponse {
  readonly items: readonly ParentBomRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

/** `GET /api/skus/{id}/where-used` 의 item — **한 행이 한 `BomLine`** 이다. */
export interface WhereUsedRow {
  readonly bomHeaderId: string;
  readonly parentSkuId: string;
  readonly parentSku: BomSkuRef;
  readonly bomType: string;
  readonly version: string;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly lineId: string;
  readonly lineNo: number;
  /** Decimal 문자열. ⛔ 숫자 변환 금지. `UNKNOWN` 이면 `null`. */
  readonly quantityPer: string | null;
  readonly quantityStatus: string;
  readonly uom: string;
  readonly componentRole: string;
  readonly isRequired: boolean;
  readonly alternateGroup: string | null;
}

/** where-used 응답 — **pagination 이 없다** (backend contract). */
export interface WhereUsedResponse {
  readonly items: readonly WhereUsedRow[];
}

// ═══════════════════════════════════════════════════════════════
// 표시 헬퍼
// ═══════════════════════════════════════════════════════════════

/** 값 없음 표기. 빈 문자열도 `—` 로 본다. */
export function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === '' ? '—' : value;
}

/**
 * `BomStatus` 7종 라벨 (`docs/18` §D-6).
 *
 * ⛔ 상태를 합치지 않는다 — 7개 값이 각각 다른 의미다.
 */
export const BOM_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '승인대기',
  APPROVED: '승인됨',
  ACTIVE: '활성',
  INACTIVE: '사용종료',
  ARCHIVED: '보관',
  REJECTED: '반려',
};

/** 미지의 status 는 원문 그대로 보여준다 — 조용히 숨기지 않는다. */
export function bomStatusLabel(status: string): string {
  return BOM_STATUS_LABELS[status] ?? status;
}

/** `BomType` 3종 (`docs/18` §D-2). */
export const BOM_TYPE_LABELS: Readonly<Record<string, string>> = {
  MANUFACTURING: '제조',
  KIT: '키트',
  REPACK: '재포장',
};

export function bomTypeLabel(bomType: string): string {
  return BOM_TYPE_LABELS[bomType] ?? bomType;
}

/** `ComponentRole` 4종 (`docs/18` §D-9). */
export const COMPONENT_ROLE_LABELS: Readonly<Record<string, string>> = {
  PRODUCT: '제품',
  MATERIAL: '자재',
  PACKAGING: '포장',
  SERVICE: '임가공',
};

export function componentRoleLabel(role: string): string {
  return COMPONENT_ROLE_LABELS[role] ?? role;
}

/** `QuantityStatus` 3종 (`docs/18` §D-10). */
export const QUANTITY_STATUS_LABELS: Readonly<Record<string, string>> = {
  CONFIRMED: '확정',
  SUGGESTED: '추천',
  UNKNOWN: '미입력',
};

export function quantityStatusLabel(status: string): string {
  return QUANTITY_STATUS_LABELS[status] ?? status;
}

/**
 * 적용기간 — 반열림 `[from, to)` 를 훼손하지 않는다 (`docs/18` §D-5).
 *
 * `effectiveTo = null` 은 **무기한**이다. ⛔ 오늘 날짜를 채워 넣지 않는다.
 * ⛔ 문자열을 `Date` 로 파싱했다가 다시 포맷하지 않는다 — timezone 에 따라
 *    하루가 밀린다. API 가 이미 `YYYY-MM-DD` 로 주므로 **그대로** 쓴다.
 */
export function formatEffectivePeriod(from: string, to: string | null): string {
  return `${from} ~ ${to ?? '무기한'}`;
}

/**
 * ★ 확정 진행률 — `확정 N / 전체 M`.
 *
 * `unconfirmedCount` 는 **`CONFIRMED` 가 아닌 라인 수**이므로 `SUGGESTED` 도
 * 포함한다(T07-3 확정 계약). 따라서:
 *
 * ```
 *   confirmed = lineCount - unconfirmedCount
 * ```
 *
 * ⛔ 이 값을 "UNKNOWN 개수"로 표시하지 않는다 — 그러면 `SUGGESTED` 라인이
 *    미입력으로 둔갑한다.
 * ⛔ 라인 상세를 다시 부르지 않는다 — 목록 응답의 두 수만 쓴다(N+1 없음).
 */
export function formatQuantityProgress(lineCount: number, unconfirmedCount: number): string {
  const confirmed = lineCount - unconfirmedCount;
  return `확정 ${confirmed} / 전체 ${lineCount}`;
}

/** 미확정이 하나라도 있으면 강조 대상이다 (`docs/18` §D-31 진행률 UX). */
export function hasUnconfirmedQuantity(row: ParentBomRow): boolean {
  return row.unconfirmedCount > 0;
}

/**
 * 소요량 표시 — `UNKNOWN` 이면 `quantityPer` 이 `null` 이다 (D-10).
 *
 * ⛔ `0` 으로 표시하지 않는다 — "미입력"과 "0개"는 다른 사실이다.
 * ⛔ Decimal 문자열을 `Number()` 로 바꾸지 않는다 — 정밀도가 깨진다.
 */
export function formatQuantityPer(quantityPer: string | null, uom: string): string {
  return quantityPer === null ? '—' : `${quantityPer} ${uom}`;
}

/** 필수 여부 — `isRequired = false` 는 선택 구성품이다. */
export function requiredLabel(isRequired: boolean): string {
  return isRequired ? '필수' : '선택';
}

export const BOM_TAB_PARENT_EMPTY_MESSAGE = '이 SKU 를 상위 품목으로 하는 BOM 이 없습니다.';
export const BOM_TAB_WHERE_USED_EMPTY_MESSAGE = '이 SKU 를 구성품으로 사용하는 BOM 이 없습니다.';
export const BOM_TAB_PARENT_LOADING_MESSAGE = 'BOM 을 불러오는 중…';
export const BOM_TAB_WHERE_USED_LOADING_MESSAGE = '사용처를 불러오는 중…';

export const BOM_TAB_PARENT_SECTION_LABEL = '이 SKU 의 BOM';
export const BOM_TAB_WHERE_USED_SECTION_LABEL = '구성품으로 사용된 BOM';

/**
 * ⚠️ **T07-8 미착수로 인한 계약 미충족 — 완료 보고 deviation 참조.**
 *
 * `docs/18` §D-30 ⑦탭 "최소" 항목 3 은 각 행에서 `/master/boms/{id}` 로 가는
 * 링크를 요구하지만, 그 route 는 **T07-8 이 만들며 아직 존재하지 않는다**
 * (§D-31 · §5 구현 순서에서 T1-6B5 는 T07-8 보다 6단계 앞이다).
 *
 * 존재하지 않는 화면으로 보내는 활성 링크를 만들면 사용자가 404 를 받으므로
 * **링크를 렌더하지 않는다.** T07-8 이 route 를 만들 때 함께 활성화한다.
 */
export const BOM_TAB_MANAGE_LINK_ENABLED = false;
