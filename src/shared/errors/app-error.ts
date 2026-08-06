import { ERROR_CODES, httpStatusForCode, publicMessageForCode, type ErrorCode } from './codes';

/**
 * 공통 오류 체계.
 *
 * 설계 문서 `02_시스템_아키텍처와_모듈구조.md` §4.11 의 3계층 오류 체계를 구현한다.
 *
 * ┌──────────────────────┬─────────┬────────────────────────────────────────┐
 * │ 클래스               │ HTTP    │ 성격                                   │
 * ├──────────────────────┼─────────┼────────────────────────────────────────┤
 * │ ValidationError      │ 400     │ 요청 형식 위반                         │
 * │ AuthorizationError   │ 401/403 │ 인증·권한                              │
 * │ DomainError          │ 422     │ 업무규칙 위반 (예상 가능)              │
 * │ ConflictError        │ 409     │ 동시성·상태 충돌 (재시도 가능)         │
 * │ SystemError          │ 500     │ 예상하지 못한 오류                     │
 * └──────────────────────┴─────────┴────────────────────────────────────────┘
 *
 * 핵심 구분: **예상 가능한 오류(expected)** 와 **예상하지 못한 오류(unexpected)**.
 * 전자는 사용자에게 사유를 알려주고, 후자는 고정 문구 + 500 으로 처리한다.
 *
 * ## 부가정보 4종의 노출 범위
 *
 * ┌────────────────┬──────────────┬──────────────┐
 * │ 필드           │ 외부 응답    │ 서버 로그    │
 * ├────────────────┼──────────────┼──────────────┤
 * │ context        │ ❌           │ ✅           │
 * │ details        │ ❌           │ ✅           │
 * │ publicDetails  │ ✅ (expected)│ ✅           │
 * │ publicHint     │ ✅ (expected)│ ✅           │
 * └────────────────┴──────────────┴──────────────┘
 *
 * `details` 와 `publicDetails` 를 나눈 이유: 예상 가능한 오류라는 사실만으로는
 * 부가정보가 공개해도 되는 값임을 보장하지 못한다. 재고 부족(`DomainError`)
 * 하나만 봐도 "가용수량"은 공개해도 되지만 "내부 SKU UUID"는 아니다.
 * 기본값을 비공개로 두고, 공개는 호출부가 `publicDetails` 로 **명시**하게 한다.
 */

/** 서버 로그 전용 컨텍스트. 외부 응답에 나가지 않는다. */
export type ErrorContext = Record<string, unknown>;

/** 서버 로그 전용 상세. 외부 응답에 나가지 않는다. */
export type ErrorDetails = Record<string, unknown>;

/** 외부 응답에 담기는 상세. 비밀정보·내부 식별자를 넣지 않는다. */
export type PublicDetails = Record<string, unknown>;

export interface AppErrorOptions {
  /** 개발환경 응답(`debug`)과 서버 로그에 쓰이는 상세 메시지 */
  readonly message?: string;
  /** ⚠️ 서버 로그 전용 상세 — 외부 응답에 포함되지 않음 */
  readonly details?: ErrorDetails;
  /** ⚠️ 서버 로그 전용 컨텍스트 — 외부 응답에 포함되지 않음 */
  readonly context?: ErrorContext;
  /** 외부 응답에 포함할 상세 (운영환경에서도 노출됨) */
  readonly publicDetails?: PublicDetails;
  /** 외부 응답에 포함할 해결 안내 (운영환경에서도 노출됨) */
  readonly publicHint?: string;
  /** 원인 오류 */
  readonly cause?: unknown;
}

/**
 * 모든 애플리케이션 오류의 기반 클래스.
 *
 * 직접 사용하지 않고 아래 하위 클래스를 사용한다.
 */
export abstract class AppError extends Error {
  readonly code: ErrorCode | string;
  readonly httpStatus: number;
  /** 예상 가능한 오류인가. false 면 500 + 고정 문구로 처리된다. */
  readonly expected: boolean;
  /** ⚠️ 서버 로그 전용. 직렬화해 외부로 내보내지 않는다. */
  readonly details: ErrorDetails | undefined;
  /** ⚠️ 서버 로그 전용. 직렬화해 외부로 내보내지 않는다. */
  readonly context: ErrorContext | undefined;
  /** 외부 응답 공개용. */
  readonly publicDetails: PublicDetails | undefined;
  /** 외부 응답 공개용. */
  readonly publicHint: string | undefined;

  protected constructor(
    code: ErrorCode | string,
    expected: boolean,
    options: AppErrorOptions = {},
  ) {
    super(options.message ?? publicMessageForCode(code), { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatusForCode(code);
    this.expected = expected;
    this.details = options.details;
    this.context = options.context;
    this.publicDetails = options.publicDetails;
    this.publicHint = options.publicHint;
  }

  /** 외부 응답용 공개 메시지. 운영환경에서는 항상 이 값이 나간다. */
  get publicMessage(): string {
    return publicMessageForCode(this.code);
  }
}

/**
 * 업무규칙 위반. 요청 형식은 옳으나 도메인이 거부한 경우.
 * 예: 재고 부족, 허용되지 않은 상태 전이, 마감월 거래.
 */
export class DomainError extends AppError {
  constructor(code: ErrorCode | string, options: AppErrorOptions = {}) {
    super(code, true, options);
  }
}

/** 인증·권한 오류. */
export class AuthorizationError extends AppError {
  constructor(code: ErrorCode | string = ERROR_CODES.FORBIDDEN, options: AppErrorOptions = {}) {
    super(code, true, options);
  }
}

/**
 * 동시성·상태 충돌. 재시도로 해소될 수 있다.
 * 예: 직렬화 실패(40001), 데드락(40P01), 멱등키 재사용.
 */
export class ConflictError extends AppError {
  /** 클라이언트가 재시도해도 되는가 */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode | string = ERROR_CODES.CONFLICT,
    options: AppErrorOptions & { retryable?: boolean } = {},
  ) {
    super(code, true, options);
    this.retryable = options.retryable ?? true;
  }
}

/** 요청 형식·스키마 위반. */
export class ValidationError extends AppError {
  /** 필드별 오류 목록. 외부 응답에 공개된다. */
  readonly fieldErrors: readonly FieldError[];

  constructor(fieldErrors: readonly FieldError[] = [], options: AppErrorOptions = {}) {
    super(ERROR_CODES.VALIDATION_ERROR, true, options);
    this.fieldErrors = fieldErrors;
  }
}

export interface FieldError {
  /** 점 표기 경로. 예: `entries.0.quantityDelta` */
  readonly path: string;
  readonly message: string;
}

/**
 * 예상하지 못한 시스템 오류.
 *
 * `expected = false` 이므로 외부에는 **항상 고정 문구 + HTTP 500** 으로 나간다.
 * `publicDetails` 를 넘겨도 응답에 실리지 않는다 — 예상하지 못한 오류의
 * 부가정보는 신뢰할 수 없기 때문이다. 원인은 서버 로그에만 기록된다.
 */
export class SystemError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(ERROR_CODES.INTERNAL_ERROR, false, options);
  }
}

/**
 * 환경변수·서버 설정 오류.
 *
 * T0-2 에서 독립 클래스로 만들었던 것을 공통 체계로 편입한다.
 * 변수명은 운영 환경에서 노출하지 않는다(내부 구조 힌트가 되므로).
 * 개발 환경에서는 원인 파악을 위해 `debug.internalMessage` 에 포함된다.
 */
export class EnvironmentError extends AppError {
  readonly variable: string;

  constructor(variable: string, detail: string, options: AppErrorOptions = {}) {
    super(ERROR_CODES.ENVIRONMENT_ERROR, false, {
      ...options,
      message: `[${variable}] ${detail}`,
      context: { ...options.context, variable },
    });
    this.variable = variable;
  }
}

/** 알 수 없는 값을 AppError 로 정규화한다. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof Error) {
    return new SystemError({ message: error.message, cause: error });
  }

  return new SystemError({ message: String(error), cause: error });
}
