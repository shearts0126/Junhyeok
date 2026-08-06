import { AppError, ValidationError, toAppError, type FieldError } from './app-error';
import { publicMessageForCode } from './codes';

/**
 * 오류 → 외부 응답 변환.
 *
 * 내부 로그와 외부 응답을 분리하는 지점이다.
 *
 * ┌────────────────┬────────────────────────┬──────────────────────────────┐
 * │                │ 운영 (production)      │ 개발 (development/test)      │
 * ├────────────────┼────────────────────────┼──────────────────────────────┤
 * │ message        │ 코드별 고정 공개 문구  │ 상세 메시지 허용             │
 * │ details        │ 포함 (비밀정보 금지)   │ 포함                         │
 * │ hint           │ 포함                   │ 포함                         │
 * │ fieldErrors    │ 포함                   │ 포함                         │
 * │ context        │ ❌ 미포함              │ ❌ 미포함 (로그 전용)        │
 * │ stack          │ ❌ 미포함              │ 포함                         │
 * │ cause          │ ❌ 미포함              │ 요약만 포함                  │
 * │ requestId      │ 포함                   │ 포함                         │
 * └────────────────┴────────────────────────┴──────────────────────────────┘
 *
 * 예상하지 못한 오류(`expected = false`)는 **환경과 무관하게** 운영 규칙을 적용한다.
 * 원인 메시지에 DB URL·호스트·포트·환경변수명·스택이 섞여 들어올 수 있기 때문이다.
 * 단 개발환경에서는 디버깅을 위해 `debug` 블록에 스택을 덧붙인다.
 */

/** 개발환경 전용 디버깅 정보. 운영 응답에는 절대 포함되지 않는다. */
export interface ErrorDebugInfo {
  readonly name: string;
  readonly internalMessage: string;
  readonly cause?: string;
  readonly stack?: string;
}

export interface ErrorResponseBody {
  readonly errorCode: string;
  readonly message: string;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;
  readonly hint?: string;
  readonly fieldErrors?: readonly FieldError[];
  readonly debug?: ErrorDebugInfo;
}

export interface BuildErrorResponseOptions {
  readonly requestId: string;
  /** 미지정 시 `process.env.NODE_ENV` 로 판단 */
  readonly isProduction?: boolean;
}

function resolveIsProduction(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env['NODE_ENV'] === 'production';
}

function summarizeCause(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/**
 * 오류를 외부 응답 본문으로 변환한다.
 *
 * ⚠️ 이 함수만이 오류를 외부로 내보내는 유일한 경로여야 한다.
 *    Route Handler 에서 오류 객체를 직접 직렬화하지 않는다.
 */
export function buildErrorResponse(
  error: unknown,
  options: BuildErrorResponseOptions,
): ErrorResponseBody {
  const appError: AppError = toAppError(error);
  const isProduction = resolveIsProduction(options.isProduction);

  // 예상하지 못한 오류는 환경과 무관하게 고정 문구.
  // 내부 message 에 연결 문자열·경로가 섞일 수 있다.
  const useDetailedMessage = appError.expected && !isProduction;

  const body: {
    errorCode: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
    hint?: string;
    fieldErrors?: readonly FieldError[];
    debug?: ErrorDebugInfo;
  } = {
    errorCode: appError.code,
    message: useDetailedMessage ? appError.message : publicMessageForCode(appError.code),
    requestId: options.requestId,
  };

  // details·hint 는 도메인이 의도적으로 공개한 값이므로 운영에서도 내보낸다.
  // 예상하지 못한 오류에는 details 가 없다(생성자에서 설정하지 않음).
  if (appError.expected) {
    if (appError.details !== undefined) body.details = appError.details;
    if (appError.hint !== undefined) body.hint = appError.hint;
    if (appError instanceof ValidationError && appError.fieldErrors.length > 0) {
      body.fieldErrors = appError.fieldErrors;
    }
  }

  if (!isProduction) {
    const debug: {
      name: string;
      internalMessage: string;
      cause?: string;
      stack?: string;
    } = {
      name: appError.name,
      internalMessage: appError.message,
    };
    const cause = summarizeCause(appError.cause);
    if (cause !== undefined) debug.cause = cause;
    if (appError.stack !== undefined) debug.stack = appError.stack;
    body.debug = debug;
  }

  // ★ context 는 어떤 환경에서도 응답에 포함하지 않는다 (서버 로그 전용).
  return body;
}
