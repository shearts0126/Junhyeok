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
 * │ message        │ 코드별 고정 공개 문구  │ 상세 메시지 (expected 한정)  │
 * │ publicDetails  │ 포함 (expected 한정)   │ 포함 (expected 한정)         │
 * │ publicHint     │ 포함 (expected 한정)   │ 포함 (expected 한정)         │
 * │ fieldErrors    │ 포함                   │ 포함                         │
 * │ details        │ ❌ 미포함              │ ❌ 미포함 (로그 전용)        │
 * │ context        │ ❌ 미포함              │ ❌ 미포함 (로그 전용)        │
 * │ stack          │ ❌ 미포함              │ debug.stack                  │
 * │ cause          │ ❌ 미포함              │ debug.cause (요약만)         │
 * │ requestId      │ 포함                   │ 포함                         │
 * └────────────────┴────────────────────────┴──────────────────────────────┘
 *
 * 두 가지 안전장치가 겹쳐 있다.
 *
 *   1. **필드 분리** — `details`·`context` 는 어떤 환경에서도 응답에 실리지 않는다.
 *      공개는 `publicDetails`·`publicHint` 로 호출부가 명시해야 한다.
 *   2. **expected 분기** — 예상하지 못한 오류(`expected = false`)는 환경과 무관하게
 *      운영 규칙을 적용한다. 원인 메시지에 DB URL·호스트·포트·환경변수명·스택이
 *      섞여 들어올 수 있기 때문이다. 단 개발환경에서는 디버깅을 위해 `debug`
 *      블록에 내부 메시지와 스택을 덧붙인다.
 *
 * `requestId` 는 서버가 생성한 값이다. 외부에서 받은 `x-request-id` 는
 * `correlationId` 로 서버 로그에만 남는다 (`request-id.ts` 참조).
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
  /** 서버가 생성한 요청 식별자. 문의 시 이 값으로 서버 로그를 찾는다. */
  readonly requestId: string;
  readonly publicDetails?: Record<string, unknown>;
  readonly publicHint?: string;
  readonly fieldErrors?: readonly FieldError[];
  readonly debug?: ErrorDebugInfo;
}

export interface BuildErrorResponseOptions {
  /** 서버가 생성한 requestId. 외부 헤더 값을 넣지 않는다. */
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
  const useDetailedMessage = appError.expected && !isProduction;

  const body: {
    errorCode: string;
    message: string;
    requestId: string;
    publicDetails?: Record<string, unknown>;
    publicHint?: string;
    fieldErrors?: readonly FieldError[];
    debug?: ErrorDebugInfo;
  } = {
    errorCode: appError.code,
    message: useDetailedMessage ? appError.message : publicMessageForCode(appError.code),
    requestId: options.requestId,
  };

  // 공개 부가정보는 도메인이 `publicDetails`/`publicHint` 로 명시한 값만 내보낸다.
  // 예상하지 못한 오류는 명시가 있어도 신뢰하지 않는다.
  if (appError.expected) {
    if (appError.publicDetails !== undefined) body.publicDetails = appError.publicDetails;
    if (appError.publicHint !== undefined) body.publicHint = appError.publicHint;
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

  // ★ details·context 는 어떤 환경에서도 응답에 포함하지 않는다 (서버 로그 전용).
  return body;
}
