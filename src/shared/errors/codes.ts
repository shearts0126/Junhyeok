/**
 * 오류코드 카탈로그.
 *
 * 오류코드는 API 소비자와의 계약이다. 한 번 공개된 코드는 의미를 바꾸지 않는다.
 * 새 오류는 코드를 추가하고, 기존 코드의 의미를 재정의하지 않는다.
 *
 * 명명 규칙: `<도메인>_<사유>` 대문자 스네이크. 도메인 접두사는 생략 가능하다.
 */

export const ERROR_CODES = {
  // ── 공통 ─────────────────────────────────────────────────
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // ── 설정·환경 (T0-2, T0-3) ───────────────────────────────
  ENVIRONMENT_ERROR: 'ENVIRONMENT_ERROR',
  SETTING_LOCKED: 'SETTING_LOCKED',

  // ── 동시성 (R1a-2) ───────────────────────────────────────
  SERIALIZATION_FAILURE: 'SERIALIZATION_FAILURE',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // ── 승인 (T0-7 이후) ─────────────────────────────────────
  SELF_APPROVAL_FORBIDDEN: 'SELF_APPROVAL_FORBIDDEN',

  // ── SKU 도메인 (T1-2) ────────────────────────────────────
  SKU_CODE_IMMUTABLE: 'SKU_CODE_IMMUTABLE',
  SKU_ARCHIVE_BLOCKED: 'SKU_ARCHIVE_BLOCKED',

  // ── SKU CRUD (T1-3) ──────────────────────────────────────
  SKU_CODE_DUPLICATE: 'SKU_CODE_DUPLICATE',
  SKU_ACTIVE_UPDATE_RESTRICTED: 'SKU_ACTIVE_UPDATE_RESTRICTED',

  // ── 재고 (R1a-2, 설계 05 v0.2 §10.18) ────────────────────
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  REVERSAL_OF_REVERSAL_NOT_ALLOWED: 'REVERSAL_OF_REVERSAL_NOT_ALLOWED',
  ALREADY_REVERSED: 'ALREADY_REVERSED',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  UNBALANCED_TRANSACTION: 'UNBALANCED_TRANSACTION',
  MISSING_SOURCE_DOCUMENT: 'MISSING_SOURCE_DOCUMENT',
  CLOSED_PERIOD_TRANSACTION: 'CLOSED_PERIOD_TRANSACTION',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * 오류코드 → HTTP 상태.
 *
 * 카탈로그에 없는 코드는 500 으로 처리한다(안전한 기본값).
 */
const HTTP_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  [ERROR_CODES.VALIDATION_ERROR]: 400,
  [ERROR_CODES.UNAUTHORIZED]: 401,
  [ERROR_CODES.REAUTH_REQUIRED]: 401,
  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.SELF_APPROVAL_FORBIDDEN]: 403,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.CONFLICT]: 409,
  [ERROR_CODES.SERIALIZATION_FAILURE]: 409,
  [ERROR_CODES.IDEMPOTENCY_KEY_REUSED]: 409,

  // 업무규칙 위반은 422. 요청 형식은 옳으나 도메인이 거부한 경우다.
  [ERROR_CODES.INSUFFICIENT_STOCK]: 422,
  [ERROR_CODES.REVERSAL_OF_REVERSAL_NOT_ALLOWED]: 422,
  [ERROR_CODES.ALREADY_REVERSED]: 422,
  [ERROR_CODES.INVALID_STATUS_TRANSITION]: 422,
  [ERROR_CODES.UNBALANCED_TRANSACTION]: 422,
  [ERROR_CODES.MISSING_SOURCE_DOCUMENT]: 422,
  [ERROR_CODES.CLOSED_PERIOD_TRANSACTION]: 422,
  [ERROR_CODES.SETTING_LOCKED]: 422,
  [ERROR_CODES.SKU_CODE_IMMUTABLE]: 422,
  [ERROR_CODES.SKU_ARCHIVE_BLOCKED]: 422,
  [ERROR_CODES.SKU_CODE_DUPLICATE]: 409,
  [ERROR_CODES.SKU_ACTIVE_UPDATE_RESTRICTED]: 422,

  [ERROR_CODES.ENVIRONMENT_ERROR]: 500,
  [ERROR_CODES.INTERNAL_ERROR]: 500,
};

export const DEFAULT_HTTP_STATUS = 500;

export function httpStatusForCode(code: string): number {
  return HTTP_STATUS_BY_CODE[code as ErrorCode] ?? DEFAULT_HTTP_STATUS;
}

export function isKnownErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(HTTP_STATUS_BY_CODE, code);
}

/**
 * 외부에 노출할 기본 메시지.
 *
 * 운영환경에서는 이 문장만 나간다. 내부 상세는 서버 로그에만 남는다.
 * 값·식별자·경로를 포함하지 않는다.
 */
const PUBLIC_MESSAGE_BY_CODE: Readonly<Record<ErrorCode, string>> = {
  [ERROR_CODES.VALIDATION_ERROR]: '요청 값이 올바르지 않습니다.',
  [ERROR_CODES.UNAUTHORIZED]: '로그인이 필요합니다.',
  [ERROR_CODES.REAUTH_REQUIRED]: '이 작업은 비밀번호 재확인이 필요합니다.',
  [ERROR_CODES.FORBIDDEN]: '이 작업을 수행할 권한이 없습니다.',
  [ERROR_CODES.SELF_APPROVAL_FORBIDDEN]: '작성자와 승인자는 달라야 합니다.',
  [ERROR_CODES.NOT_FOUND]: '요청한 대상을 찾을 수 없습니다.',
  [ERROR_CODES.CONFLICT]: '현재 상태에서는 처리할 수 없습니다.',
  [ERROR_CODES.SERIALIZATION_FAILURE]: '동시 요청이 충돌했습니다. 잠시 후 다시 시도하세요.',
  [ERROR_CODES.IDEMPOTENCY_KEY_REUSED]: '동일한 요청 키가 다른 내용으로 재사용되었습니다.',
  [ERROR_CODES.INSUFFICIENT_STOCK]: '재고가 부족합니다.',
  [ERROR_CODES.REVERSAL_OF_REVERSAL_NOT_ALLOWED]: '취소 거래는 다시 취소할 수 없습니다.',
  [ERROR_CODES.ALREADY_REVERSED]: '이미 취소된 거래입니다.',
  [ERROR_CODES.INVALID_STATUS_TRANSITION]: '허용되지 않은 상태 변경입니다.',
  // ⚠️ "증감 합계"라는 표현을 쓰지 않는다. 조립·분해(kit assemble/disassemble)는
  //    자재 감소와 완제품 증가의 수량이 BOM 소요량으로 환산되어 균형을 이루므로,
  //    단순 전체 증감 합계 0 검증이 아니다.
  [ERROR_CODES.UNBALANCED_TRANSACTION]: '거래의 수량 균형이 맞지 않습니다.',
  [ERROR_CODES.MISSING_SOURCE_DOCUMENT]: '원인문서가 필요합니다.',
  [ERROR_CODES.CLOSED_PERIOD_TRANSACTION]: '마감된 기간의 거래는 처리할 수 없습니다.',
  [ERROR_CODES.SETTING_LOCKED]: '잠긴 설정은 변경할 수 없습니다.',
  [ERROR_CODES.SKU_CODE_IMMUTABLE]: '거래가 발생한 SKU 의 코드는 변경할 수 없습니다.',
  [ERROR_CODES.SKU_ARCHIVE_BLOCKED]: '사용 이력이 있는 SKU 는 폐기할 수 없습니다.',
  [ERROR_CODES.SKU_CODE_DUPLICATE]: '이미 사용 중인 SKU 코드입니다.',
  [ERROR_CODES.SKU_ACTIVE_UPDATE_RESTRICTED]: '활성(ACTIVE) SKU 는 현재 일반 수정이 제한됩니다.',
  [ERROR_CODES.ENVIRONMENT_ERROR]: '서버 설정 오류가 발생했습니다.',
  [ERROR_CODES.INTERNAL_ERROR]: '요청을 처리하지 못했습니다.',
};

/** 코드에 대응하는 공개 메시지. 알 수 없는 코드는 일반 문구로 대체한다. */
export function publicMessageForCode(code: string): string {
  return PUBLIC_MESSAGE_BY_CODE[code as ErrorCode] ?? PUBLIC_MESSAGE_BY_CODE.INTERNAL_ERROR;
}
