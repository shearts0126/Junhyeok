/**
 * SKU 상세 변경이력 탭 헬퍼 (T1-6B3) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ `@/modules/sku/application` barrel 을 import 하지 않는다 (Prisma 런타임을
 *    끌고 온다). 대신 **unit 테스트가 backend contract 와의 정합을 고정**한다 —
 *    T1-6B1 `barcode-form.ts` · T1-6B2 `external-mapping-view.ts` 와 같은 구조다.
 *
 * ## 계약 (`docs/16_설계복구_SKU상세잔여탭.md` §27~§40)
 *
 *   - 쿼리는 **`page` 하나뿐**. `pageSize` 는 서버 고정(50)이라 보내지 않는다.
 *   - 표시는 **summary + `<details>` 확장**이고, diff 는 저장된 JSON 을 그대로
 *     pretty-print 한다. ⛔ field-label 매핑·action 별 렌더러를 만들지 않는다.
 *   - `approvedBy` · `requestId` · `sessionId` · `ipAddress` 는 응답에도 없고
 *     화면에도 없다.
 */

/** 서버 고정 페이지 크기 — UI 선택지를 만들지 않는다. */
export const HISTORY_PAGE_SIZE = 50;

/** 이 탭이 API 에 보내는 파라미터 — `page` **하나뿐**이다. */
export const HISTORY_QUERY_KEYS = ['page'] as const;

/** `page=1` 도 명시해 보낸다 — 서버 기본값과 같지만 계약이 선명하다. */
export function buildHistoryQuery(page: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set('page', String(page < 1 ? 1 : page));
  return params;
}

export function skuHistoryApiPath(skuId: string, page: number): string {
  return `/api/skus/${skuId}/history?${buildHistoryQuery(page).toString()}`;
}

// ═══════════════════════════════════════════════════════════════
// 행
// ═══════════════════════════════════════════════════════════════

/** `GET /api/skus/{id}/history` 의 item 그대로. */
export interface HistoryRow {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly reason: string | null;
}

/**
 * 대상 엔티티 라벨. 이 API 범위는 `Sku` · `SkuBarcode` 둘뿐이며
 * ⛔ entity registry 를 만들지 않는다 (`docs/16` §34).
 */
export const HISTORY_ENTITY_LABELS: Readonly<Record<string, string>> = {
  Sku: 'SKU',
  SkuBarcode: '바코드',
};

export function historyEntityLabel(entityType: string): string {
  return HISTORY_ENTITY_LABELS[entityType] ?? entityType;
}

/**
 * 현재 producer 가 실제로 쓰는 action 8종만 한글 라벨을 준다.
 *
 * ⚠️ `audit_log.action` 은 `text` 이고 enum·CHECK 이 없다 — 미래에 값이 늘 수
 *    있으므로 **모르는 값은 원문 그대로** 흘린다 (`docs/16` §33).
 * ⛔ DB enum·CHECK 을 추가하지 않는다.
 */
export const HISTORY_ACTION_LABELS: Readonly<Record<string, string>> = {
  CREATE: '등록',
  UPDATE: '수정',
  SUBMIT: '승인 요청',
  APPROVE: '승인',
  REJECT: '반려',
  DEACTIVATE: '비활성화',
  REQUEST_DUPLICATE: '중복 예외 요청',
  APPROVE_DUPLICATE: '중복 예외 승인',
};

export function historyActionLabel(action: string): string {
  return HISTORY_ACTION_LABELS[action] ?? action;
}

/**
 * 사유/메모 표시 여부.
 *
 * ★ SKU `SUBMIT`/`APPROVE` 의 **`note` 도 같은 `reason` 컬럼**에 저장되므로
 *   라벨을 `사유/메모` 로 둔다 — 저장 semantics 를 왜곡하지 않기 위함이다.
 * 값이 없으면 metadata line 자체를 생략한다(`—` placeholder 를 만들지 않는다).
 */
export function hasHistoryReason(reason: string | null): boolean {
  return reason !== null && reason.trim() !== '';
}

export const HISTORY_REASON_LABEL = '사유/메모';
export const HISTORY_ACTOR_LABEL = '변경자';

// ═══════════════════════════════════════════════════════════════
// diff
// ═══════════════════════════════════════════════════════════════

/**
 * 저장된 JSON 을 그대로 pretty-print 한다.
 *
 * ⛔ key 한글 라벨 매핑 없음 · nested 평탄화 없음 · 추가 마스킹 없음
 *    (`REDACTED` 는 저장 시점에 이미 적용돼 있다) · action 별 렌더러 없음.
 * ★ `null` 은 `'null'` 로 표시한다 — 저장된 JSON `null`(CREATE 계열)과 SQL NULL
 *   을 화면에서 구분하지 않는다는 결정이다 (`docs/16` §33).
 */
export function formatHistoryJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  return JSON.stringify(value, null, 2);
}

export const HISTORY_BEFORE_LABEL = '변경 전';
export const HISTORY_AFTER_LABEL = '변경 후';

// ═══════════════════════════════════════════════════════════════
// 상태 문구
// ═══════════════════════════════════════════════════════════════

export const HISTORY_EMPTY_MESSAGE = '변경이력이 없습니다.';

/** `totalPages` 는 0건일 때 **0** 이다 — 최소 1로 올리지 않는다. */
export function historyTotalPages(total: number): number {
  return Math.ceil(total / HISTORY_PAGE_SIZE);
}
