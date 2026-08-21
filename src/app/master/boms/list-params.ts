/**
 * `/master/boms` 목록 URL 상태 · 표시 helper (T07-8).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-31(목록 12열 · 필터 7종 · 버튼 5종) ·
 *    `★ T07-8 BOM UI read-model gap closure`(U8-10) ·
 *    `★ T07-8 list reference-cost fault isolation remediation`(R8-13).
 *
 * ⛔ 이 파일은 **순수 함수만** 둔다 — Prisma·서버 모듈을 import 하지 않는다.
 */

/** ★ D-31 exact 7 filters. ⛔ 8번째를 추가하지 않는다. */
export const BOM_LIST_QUERY_KEYS = [
  'q',
  'status',
  'bomType',
  'parentSkuId',
  'effectiveOn',
  'hasUnknownQty',
  'page',
] as const;

export type BomListQueryKey = (typeof BOM_LIST_QUERY_KEYS)[number];

export interface BomListState {
  readonly q: string;
  readonly status: string;
  readonly bomType: string;
  readonly parentSkuId: string;
  readonly effectiveOn: string;
  readonly hasUnknownQty: string;
  readonly page: string;
}

export const BOM_STATUS_SUGGESTIONS = [
  'DRAFT',
  'PENDING_APPROVAL',
  'REJECTED',
  'APPROVED',
  'ACTIVE',
  'INACTIVE',
  'ARCHIVED',
] as const;

export const BOM_TYPE_SUGGESTIONS = ['MANUFACTURING', 'KIT', 'REPACK'] as const;

export function readBomListState(searchParams: URLSearchParams): BomListState {
  return {
    q: searchParams.get('q') ?? '',
    status: searchParams.get('status') ?? '',
    bomType: searchParams.get('bomType') ?? '',
    parentSkuId: searchParams.get('parentSkuId') ?? '',
    effectiveOn: searchParams.get('effectiveOn') ?? '',
    hasUnknownQty: searchParams.get('hasUnknownQty') ?? '',
    page: searchParams.get('page') ?? '',
  };
}

export type BomListPatch = Partial<Record<BomListQueryKey, string>>;

/**
 * URL 파라미터를 만든다.
 *
 * ★ **미지원 파라미터를 조용히 지우지 않는다** — 그대로 두어 API 400 이 사용자에게
 *   보이게 한다 (T06-4 와 같은 원칙).
 */
export function buildBomListParams(current: URLSearchParams, patch: BomListPatch): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === '') next.delete(key);
    else next.set(key, value);
  }
  // 필터가 바뀌면 페이지를 1로 되돌린다 — patch 가 page 를 직접 준 경우는 예외.
  if (patch.page === undefined && Object.keys(patch).length > 0) next.delete('page');
  return next;
}

/** API 로 보낼 query string. ⛔ 알 수 없는 키도 그대로 전달한다(400 을 보여준다). */
export function bomListApiQuery(searchParams: URLSearchParams): string {
  const text = searchParams.toString();
  return text === '' ? '' : `?${text}`;
}

// ═══════════════════════════════════════════════════════════════
// 기준원가 cell (U8-10 · R8-13)
// ═══════════════════════════════════════════════════════════════

export interface ReferenceCostAvailable {
  readonly status: 'AVAILABLE';
  readonly asOf: string;
  readonly krwSubtotals: readonly { readonly vatIncluded: boolean; readonly amount: string }[];
  readonly hasOtherCurrency: boolean;
  readonly isProvisional: boolean;
}

export interface ReferenceCostUnavailable {
  readonly status: 'UNAVAILABLE';
  readonly asOf: string;
  readonly errorCode: string;
}

export type ReferenceCost = ReferenceCostAvailable | ReferenceCostUnavailable;

/**
 * ★ **R8-13 — `UNAVAILABLE` 사유 label (exact 7종).**
 *
 * ⛔ 목록에서 `—`·`0원`·`잠정` 으로 표시하지 않는다 — 무결성 오류를 숨기게 된다.
 */
export const REFERENCE_COST_ERROR_LABELS: Readonly<Record<string, string>> = {
  BOM_CYCLE_DETECTED: '순환 구조',
  BOM_MAX_LEVEL_EXCEEDED: '전개 깊이 초과',
  BOM_EFFECTIVE_CONFLICT: '유효 BOM 충돌',
  BOM_SUPPLIER_SELECTION_CONFLICT: '대표 공급조건 충돌',
  SUPPLIER_PRICE_CHAIN_CONFLICT: '가격이력 충돌',
  BOM_QTY_STATUS_MISMATCH: '소요량 상태 불일치',
  BOM_QTY_INVALID: '소요량 값 오류',
};

export function referenceCostErrorLabel(errorCode: string): string {
  return REFERENCE_COST_ERROR_LABELS[errorCode] ?? '계산 불가';
}

/** `vatIncluded` 별 KRW 금액 한 줄. ⛔ 두 bucket 을 합치지 않는다 (D-27). */
export function formatKrwSubtotal(row: {
  readonly vatIncluded: boolean;
  readonly amount: string;
}): string {
  return `₩${row.amount} (${row.vatIncluded ? 'VAT 포함' : 'VAT 별도'})`;
}

/**
 * 기준원가 cell 의 표시 모델.
 *
 * | 상황 | `kind` |
 * |---|---|
 * | 무결성 오류 | `unavailable` — **`계산 불가`** + 사유 |
 * | KRW subtotal 있음 | `amounts` |
 * | KRW 없고 비KRW 있음 | `amounts`(빈 금액) — `— +` 로 표시된다 |
 * | 계산 가능한 원가가 아예 없음 | `empty` |
 */
export type ReferenceCostCell =
  | { readonly kind: 'unavailable'; readonly label: string; readonly errorCode: string }
  | {
      readonly kind: 'amounts';
      readonly amounts: readonly string[];
      readonly hasOtherCurrency: boolean;
      readonly isProvisional: boolean;
    }
  | { readonly kind: 'empty'; readonly isProvisional: boolean };

export function toReferenceCostCell(cost: ReferenceCost | undefined): ReferenceCostCell {
  if (cost === undefined) return { kind: 'empty', isProvisional: false };
  if (cost.status === 'UNAVAILABLE') {
    return {
      kind: 'unavailable',
      label: referenceCostErrorLabel(cost.errorCode),
      errorCode: cost.errorCode,
    };
  }
  if (cost.krwSubtotals.length === 0 && !cost.hasOtherCurrency) {
    return { kind: 'empty', isProvisional: cost.isProvisional };
  }
  return {
    kind: 'amounts',
    amounts: cost.krwSubtotals.map(formatKrwSubtotal),
    hasOtherCurrency: cost.hasOtherCurrency,
    isProvisional: cost.isProvisional,
  };
}

// ═══════════════════════════════════════════════════════════════
// status vs 적용기간 (D-7 · D-31 · U8-15)
// ═══════════════════════════════════════════════════════════════

/**
 * ★ **status 와 적용기간을 분리 표시**한다 (D-7).
 *
 * `ACTIVE` 이면서 `businessDate >= effectiveTo` 면 **"적용기간 종료"** 를 덧붙여
 * 현행 버전과 구분한다. ⛔ status 자체를 `INACTIVE` 로 바꾸지 않는다.
 *
 * ⛔ **U8-15 — 미래 `ACTIVE` 에 새 badge 를 만들지 않는다.** `effectiveFrom` 이
 *    미래여도 `status = ACTIVE` 를 그대로 보여주고 날짜만 별도로 표시한다.
 */
export function periodEndedLabel(
  row: { readonly status: string; readonly effectiveTo: string | null },
  businessDate: string,
): string | null {
  if (row.status !== 'ACTIVE') return null;
  if (row.effectiveTo === null) return null;
  return businessDate >= row.effectiveTo ? '적용기간 종료' : null;
}

/** `2026-08-21T01:02:03.000Z` → `2026-08-21 01:02`. 빈 값은 `—`. */
export function formatTimestamp(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function formatOptional(value: string | null): string {
  return value === null || value === '' ? '—' : value;
}
