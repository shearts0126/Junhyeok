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
 * `BomStatus` **7종** 라벨 (`docs/18` §D-6, `prisma/schema.prisma` `enum BomStatus`).
 *
 * authoritative key 는 정확히 이 7개다 — 축약형을 쓰지 않는다:
 *
 * ```
 *   DRAFT · PENDING_APPROVAL · REJECTED · APPROVED · ACTIVE · INACTIVE · ARCHIVED
 * ```
 *
 * ⛔ `PENDING` 은 **key 가 아니다** — 실제 enum key 는 `PENDING_APPROVAL` 이다.
 * ⛔ `APPROVED`(승인 완료, 아직 미발효)와 `ACTIVE`(발효 중)를 합치지 않는다.
 * ⛔ `INACTIVE`(사용종료)와 `ARCHIVED`(보관)를 합치지 않는다.
 * ⛔ 상태를 숨기지 않는다 — where-used 는 status 필터가 **없어서**
 *    `ARCHIVED` header 가 실제로 화면에 도달한다(`where-used.ts` 참조).
 */
export const BOM_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '승인대기',
  REJECTED: '반려',
  APPROVED: '승인됨',
  ACTIVE: '활성',
  INACTIVE: '사용종료',
  ARCHIVED: '보관',
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
 * ★ 표 머리글 — **표시하는 필드의 실제 이름으로만** 쓴다 (T1-6B5 remediation R2).
 *
 * ## `BomHeader` 에는 `bomCode` 가 없다
 *
 * T07-1 이 확정한 `BomHeader` scalar 19 개(`docs/18` §D-2)에 **BOM 코드 필드는
 * 없다**. BOM 의 identity 는 `id`(uuid) 와 `(parentSkuId, version)` UNIQUE 다.
 *
 * ⛔ 따라서 "BOM 코드" 라는 열을 만들지 않는다.
 * ⛔ `${skuCode}-${version}` 같은 **합성 식별자**를 만들지 않는다 — 저장된 값이
 *    아닌 것을 코드처럼 보여주면 사용자가 검색·대조할 수 있는 값으로 오인한다.
 * ⛔ `BomHeader.id`(uuid) 를 "코드" 로 표시하지 않는다.
 *
 * 섹션 A 는 **이미 그 SKU 의 상세 화면 안**이므로 상위 SKU 를 반복하지 않고
 * `version` 으로 각 BOM 을 구분한다. 섹션 B 는 상위가 매번 다르므로
 * `parentSku.skuCode` / `parentSku.skuName` 을 **"상위 SKU"** 로 표시한다.
 *
 * 컴포넌트가 이 배열을 그대로 렌더하므로, 이 상수가 곧 화면 머리글이다.
 */
export const BOM_TAB_PARENT_COLUMNS = [
  '버전',
  '유형',
  '상태',
  '적용기간',
  '구성품 수',
  '소요량 확정',
] as const;

export const BOM_TAB_WHERE_USED_COLUMNS = [
  '상위 SKU',
  '버전',
  '상태',
  '적용기간',
  '순번',
  '소요량',
  '소요량 상태',
  '구성품 유형',
  '필수',
  '대체그룹',
] as const;

/**
 * ★ D-30 항목 3 navigation 의 **deferred rendering 토글** (`docs/18` §D-30 부록).
 *
 * `docs/18` §D-30 ⑦탭 "최소" 항목 3 은 각 행에서 `/master/boms/{id}` 로 가는
 * 링크를 요구한다. 그 route 의 owner 는 **T07-8** 이었고, T1-6B5 시점에는 아직
 * 없었으므로 404 링크를 만들지 않기 위해 렌더를 연기해 두었다.
 *
 * ## ★ T07-8 이 착지하여 켰다
 *
 * `src/app/master/boms/[id]/page.tsx` 가 생겼으므로 예고한 대로 **이 한 줄만**
 * `true` 로 바꿨다 — `bom-tab.tsx` 의 두 조건 분기와 `bomManageLinkPath` 경로
 * 계약은 그대로다.
 *
 * ⛔ 이 토글을 지우지 않는다 — 두 표가 여전히 이 값을 조건으로 쓰며, 링크 열의
 *    존재 근거를 이 주석이 계속 들고 있다.
 */
export const BOM_TAB_MANAGE_LINK_ENABLED = true;

/** T07-8 standalone BOM 상세 경로 — 이제 실제로 존재한다. */
export function bomManageLinkPath(bomHeaderId: string): string {
  return `/master/boms/${bomHeaderId}`;
}

export const BOM_TAB_MANAGE_LINK_LABEL = 'BOM 관리에서 보기';
