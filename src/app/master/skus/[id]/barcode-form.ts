/**
 * SKU 상세 바코드 탭 헬퍼 (T1-6B1) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ `@/modules/barcode/application` barrel 을 import 하지 않는다 (Prisma 런타임을
 *    끌고 온다). 대신 **unit 테스트가 backend contract 와의 정합을 고정**한다 —
 *    T1-6A `sku-form.ts` · T05-4A `mapping-form.ts` 와 같은 구조다.
 *
 * ## 계약 준수 (`docs/16_설계복구_SKU상세잔여탭.md`)
 *
 *   - `createBarcodeSchema`(Zod strict)가 단일 기준이다 —
 *     `{barcode, barcodeType, isPrimary?}` **뿐**. UI 가 필드를 늘리지 않는다.
 *   - 중복 예외 요청(`requestDuplicateCandidateSchema`)은 **같은 DTO** 다.
 *     그래서 409 를 받은 입력값을 그대로 재사용할 수 있다.
 *   - 정규화(공백·하이픈 제거, `-`·공란 → 204)는 **서버가 한다.** UI 는 입력값을
 *     그대로 보내고 서버 판정을 표시한다.
 *   - ⛔ `countryCode`·`channelCode`·`effectiveFrom`·`effectiveTo` 는 T04-3 V1 API
 *     가 입력을 받지 않는다(strict → 400). **조회 전용**이며 폼에 넣지 않는다.
 *   - ⛔ `duplicateException`·`exceptionReason`·`approvedBy` 는 승인 endpoint 전용.
 */

/** T04-1 `BarcodeType` enum 과 같은 5종. 새 타입을 발명하지 않는다. */
export const BARCODE_TYPE_OPTIONS = [
  { value: 'UNIT', label: '낱개 (UNIT)' },
  { value: 'INNER_BOX', label: '내박스 (INNER_BOX)' },
  { value: 'OUTER_BOX', label: '외박스 (OUTER_BOX)' },
  { value: 'CHANNEL', label: '채널 (CHANNEL)' },
  { value: 'LEGACY', label: '레거시 (LEGACY)' },
] as const;

export type BarcodeTypeOption = (typeof BARCODE_TYPE_OPTIONS)[number]['value'];

/** 저장될 수 있는 업무 status 3종 (T04-4A 로 `PENDING_DUPLICATE` 가 더해졌다). */
export const BARCODE_ROW_STATUSES = ['ACTIVE', 'INACTIVE', 'PENDING_DUPLICATE'] as const;
export type BarcodeRowStatus = (typeof BARCODE_ROW_STATUSES)[number];

export const BARCODE_STATUS_LABELS: Readonly<Record<BarcodeRowStatus, string>> = {
  ACTIVE: '활성',
  INACTIVE: '비활성',
  PENDING_DUPLICATE: '중복 예외 승인 대기',
};

/** 미입력 표시 — `0`·공란이 아니라 항상 `—` 다. */
export const DASH = '—';

// ═══════════════════════════════════════════════════════════════
// 목록 행
// ═══════════════════════════════════════════════════════════════

/** `GET /api/skus/{id}/barcodes` 가 주는 `SkuBarcodeView` 그대로. */
export interface BarcodeRow {
  readonly id: string;
  readonly skuId: string;
  readonly barcode: string;
  readonly barcodeType: string;
  readonly isPrimary: boolean;
  readonly countryCode: string | null;
  readonly channelCode: string | null;
  readonly status: string;
  readonly duplicateException: boolean;
  readonly exceptionReason: string | null;
  readonly approvedBy: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly createdAt: string;
}

export function isPendingDuplicate(row: Pick<BarcodeRow, 'status'>): boolean {
  return row.status === 'PENDING_DUPLICATE';
}

/** 승인된 중복 예외 — `중복 예외` 배지와 사유를 보여주는 기준. */
export function isApprovedDuplicate(
  row: Pick<BarcodeRow, 'status' | 'duplicateException'>,
): boolean {
  return row.status === 'ACTIVE' && row.duplicateException;
}

/** `YYYY-MM-DD ~ YYYY-MM-DD`. 양쪽 다 없으면 `—` (0·빈칸이 아니다). */
export function formatBarcodePeriod(from: string | null, to: string | null): string {
  if (from === null && to === null) return DASH;
  return `${from ?? DASH} ~ ${to ?? DASH}`;
}

/** null·빈 문자열을 `—` 로. 조회 전용 메타(국가·채널)에 쓴다. */
export function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? DASH : value;
}

// ═══════════════════════════════════════════════════════════════
// 등록 폼 · payload
// ═══════════════════════════════════════════════════════════════

export interface BarcodeCreateForm {
  readonly barcode: string;
  readonly barcodeType: BarcodeTypeOption;
  readonly isPrimary: boolean;
}

export const EMPTY_BARCODE_CREATE_FORM: BarcodeCreateForm = {
  barcode: '',
  barcodeType: 'UNIT',
  isPrimary: false,
};

/**
 * POST body — `createBarcodeSchema` 와 **정확히 같은 필드 집합**.
 *
 * ⛔ `isPrimary` 는 false 일 때 키를 보내지 않는다(서버 기본값과 같다).
 * ⛔ trim 하지 않는다 — 정규화는 서버 권위다. `' 880 '` 같은 입력도 그대로 보내고
 *    서버의 판정(정규화 성공 / 422 / 204)을 표시한다.
 */
export interface BarcodeCreatePayload {
  barcode: string;
  barcodeType: BarcodeTypeOption;
  isPrimary?: boolean;
}

export function buildBarcodeCreatePayload(form: BarcodeCreateForm): BarcodeCreatePayload {
  const payload: BarcodeCreatePayload = { barcode: form.barcode, barcodeType: form.barcodeType };
  if (form.isPrimary) payload.isPrimary = true;
  return payload;
}

/**
 * 중복 예외 요청 body.
 *
 * ★ `requestDuplicateCandidateSchema === createBarcodeSchema` 이므로 **409 를 받은
 *   그 입력값을 그대로** 후보 endpoint 에 보낸다. UI 가 값을 바꾸지 않는다.
 */
export function buildDuplicateCandidatePayload(form: BarcodeCreateForm): BarcodeCreatePayload {
  return buildBarcodeCreatePayload(form);
}

// ═══════════════════════════════════════════════════════════════
// 중복 판정
// ═══════════════════════════════════════════════════════════════

/**
 * 사용자에게 보여줄 중복 안내.
 *
 * ⚠️ **다른 SKU 의 정보를 쓰지 않는다** — API 가 상대 SKU 를 알려주지 않으며,
 *    바코드 404 정책은 오히려 다른 SKU 의 행 존재를 숨긴다. 사전 lookup API 도
 *    만들지 않는다 (`docs/16` §10).
 */
export const DUPLICATE_WARNING =
  '동일한 활성 바코드가 다른 SKU 에서 사용 중입니다. 필요한 경우 중복 예외 요청을 등록할 수 있습니다.';

/** UI 오류 요약 — `sku-ui.tsx` `UiError` 의 필요한 부분만. */
export interface BarcodeApiFailure {
  readonly status: number;
  readonly code: string | null;
}

/**
 * "활성 중복" 409 인가?
 *
 * ★ **`BARCODE_DUPLICATE` 만** 해당한다. 같은 409 라도
 *   `BARCODE_PRIMARY_CONFLICT`(활성 대표 충돌) ·
 *   `BARCODE_DUPLICATE_CANDIDATE_EXISTS`(내용 다른 후보 존재) ·
 *   `IDEMPOTENCY_KEY_REUSED` 는 중복 예외 대상이 **아니다** — 이 경우 CTA 를
 *   띄우면 사용자를 잘못된 mutation 으로 유도한다.
 */
export function isDuplicateBarcodeConflict(error: BarcodeApiFailure | null): boolean {
  return error !== null && error.status === 409 && error.code === 'BARCODE_DUPLICATE';
}

// ═══════════════════════════════════════════════════════════════
// 행 액션 매트릭스
// ═══════════════════════════════════════════════════════════════

export type BarcodeRowAction =
  /** 대표 지정/해제 — `PATCH {isPrimary}` */
  | 'togglePrimary'
  /** 비활성 — `DELETE` */
  | 'deactivate'
  /** 재활성 — `PATCH {status:'ACTIVE'}` */
  | 'reactivate'
  /** 중복 예외 승인 — `POST .../approve-duplicate` */
  | 'approveDuplicate'
  /** 중복 예외 요청 취소 — `DELETE` (물리삭제 아님) */
  | 'cancelCandidate';

/** 각 액션이 요구하는 permission. UI 는 이 값만 보고 판단한다(역할 이름 금지). */
export const BARCODE_ACTION_PERMISSIONS: Readonly<Record<BarcodeRowAction, string>> = {
  togglePrimary: 'barcode.update',
  deactivate: 'barcode.deactivate',
  reactivate: 'barcode.update',
  approveDuplicate: 'barcode.approve_duplicate',
  cancelCandidate: 'barcode.deactivate',
};

/**
 * status 별로 **가능한** 액션. 권한은 아직 보지 않는다.
 *
 *   ACTIVE            → 대표 지정/해제 · 비활성
 *   INACTIVE          → 재활성
 *   PENDING_DUPLICATE → 중복 예외 승인 · 요청 취소   ← 일반 수정 액션 없음
 *
 * ⛔ `PENDING_DUPLICATE` 에 일반 PATCH 액션을 노출하지 않는다 — 서버가 422
 *    `BARCODE_DUPLICATE_APPROVAL_PENDING` 로 막는 경로다 (`docs/11` §23).
 * ⛔ 승인 취소(revoke) 액션은 어떤 status 에도 없다 — 계약 자체가 없다.
 */
export function barcodeActionsForStatus(status: string): readonly BarcodeRowAction[] {
  if (status === 'ACTIVE') return ['togglePrimary', 'deactivate'];
  if (status === 'INACTIVE') return ['reactivate'];
  if (status === 'PENDING_DUPLICATE') return ['approveDuplicate', 'cancelCandidate'];
  return [];
}

/** 권한까지 적용한 최종 노출 액션. */
export function visibleBarcodeActions(
  status: string,
  permissions: readonly string[] | null,
): readonly BarcodeRowAction[] {
  if (permissions === null) return [];
  return barcodeActionsForStatus(status).filter((action) =>
    permissions.includes(BARCODE_ACTION_PERMISSIONS[action]),
  );
}

// ═══════════════════════════════════════════════════════════════
// mutation payload
// ═══════════════════════════════════════════════════════════════

/** `PATCH {isPrimary}` — 대표 지정/해제. ⛔ 다른 행의 대표를 자동 해제하지 않는다. */
export function buildTogglePrimaryPayload(row: Pick<BarcodeRow, 'isPrimary'>): {
  isPrimary: boolean;
} {
  return { isPrimary: !row.isPrimary };
}

/** `PATCH {status:'ACTIVE'}` — 재활성. 충돌은 서버 409 를 그대로 보여준다. */
export function buildReactivatePayload(): { status: 'ACTIVE' } {
  return { status: 'ACTIVE' };
}

/** 승인 body — `{reason}` **만**. ⛔ 최대 길이를 새로 만들지 않는다. */
export interface ApproveDuplicatePayload {
  reason: string;
}

/** 서버와 같은 판정: trim 후 비어 있으면 보내지 않는다(서버도 400 이다). */
export function isApprovalReasonValid(reason: string): boolean {
  return reason.trim().length > 0;
}

/**
 * ⚠️ 서버가 저장하는 값은 **trim 된 문자열**이다(`approveDuplicateSchema` 의
 *    `.transform(trim)`). UI 도 같은 값을 보내 요청/저장이 어긋나지 않게 한다.
 */
export function buildApproveDuplicatePayload(reason: string): ApproveDuplicatePayload {
  return { reason: reason.trim() };
}
