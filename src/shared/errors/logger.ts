import { AppError, toAppError } from './app-error';
import { maskSecretsInString, redactRecord } from './redact';

/**
 * 오류 로깅.
 *
 * 외부 응답과 달리 **모든 상세를 기록한다.** 서버 로그는 신뢰 경계 안에 있다.
 * 다만 로그도 수집기·백업·화면 캡처로 새어 나갈 수 있으므로
 * 자격증명은 키 기반·패턴 기반으로 마스킹한다 (`redact.ts`).
 *
 * T0-3 은 콘솔 출력만 한다. Sentry 등 외부 전송은 T0-9 에서 붙인다.
 */

export type LogLevel = 'error' | 'warn' | 'info';

export interface ErrorLogEntry {
  readonly level: LogLevel;
  /** 서버가 생성한 요청 식별자. 응답의 `requestId` 와 같은 값이다. */
  readonly requestId: string;
  /** 외부에서 받은 추적 식별자. 응답에는 나가지 않는다. */
  readonly correlationId?: string;
  readonly errorCode: string;
  /**
   * 오류 타입명. 최소화 빌드에서도 값이 고정된다(`ERROR_TYPE`).
   * ⚠️ 로그 검색의 **1차 판별 키는 `errorCode`** 이며, 이 값은 보조 정보다.
   */
  readonly errorName: string;
  readonly message: string;
  readonly expected: boolean;
  readonly httpStatus: number;
  /** 서버 로그 전용 상세 */
  readonly details?: Record<string, unknown>;
  /** 서버 로그 전용 컨텍스트 */
  readonly context?: Record<string, unknown>;
  /** 외부 응답에도 나간 공개 상세 (대조용) */
  readonly publicDetails?: Record<string, unknown>;
  readonly cause?: string;
  readonly stack?: string;
  readonly route?: string;
  readonly method?: string;
  readonly timestamp: string;
}

export interface LogErrorOptions {
  /** 서버가 생성한 requestId */
  readonly requestId: string;
  /** 외부 헤더에서 온 추적 ID. 없으면 생략한다. */
  readonly correlationId?: string;
  readonly route?: string;
  readonly method?: string;
}

/** 오류를 구조화된 로그 항목으로 만든다. */
export function buildErrorLogEntry(error: unknown, options: LogErrorOptions): ErrorLogEntry {
  const appError: AppError = toAppError(error);

  const entry: {
    level: LogLevel;
    requestId: string;
    correlationId?: string;
    errorCode: string;
    errorName: string;
    message: string;
    expected: boolean;
    httpStatus: number;
    timestamp: string;
    details?: Record<string, unknown>;
    context?: Record<string, unknown>;
    publicDetails?: Record<string, unknown>;
    cause?: string;
    stack?: string;
    route?: string;
    method?: string;
  } = {
    // 예상 가능한 오류는 warn, 예상하지 못한 오류는 error.
    // 알림·에스컬레이션은 error 만 대상으로 한다.
    level: appError.expected ? 'warn' : 'error',
    requestId: options.requestId,
    errorCode: appError.code,
    errorName: appError.name,
    message: maskSecretsInString(appError.message),
    expected: appError.expected,
    httpStatus: appError.httpStatus,
    timestamp: new Date().toISOString(),
  };

  if (options.correlationId !== undefined) entry.correlationId = options.correlationId;
  if (appError.details !== undefined) entry.details = redactRecord(appError.details);
  if (appError.context !== undefined) entry.context = redactRecord(appError.context);
  if (appError.publicDetails !== undefined) {
    entry.publicDetails = redactRecord(appError.publicDetails);
  }
  if (appError.cause !== undefined) {
    entry.cause =
      appError.cause instanceof Error
        ? maskSecretsInString(`${appError.cause.name}: ${appError.cause.message}`)
        : maskSecretsInString(String(appError.cause));
  }
  // 예상하지 못한 오류만 스택을 남긴다. 예상 가능한 오류의 스택은 소음이다.
  if (!appError.expected && appError.stack !== undefined) {
    entry.stack = maskSecretsInString(appError.stack);
  }
  if (options.route !== undefined) entry.route = options.route;
  if (options.method !== undefined) entry.method = options.method;

  return entry;
}

/** 오류를 서버 로그에 기록한다. */
export function logError(error: unknown, options: LogErrorOptions): ErrorLogEntry {
  const entry = buildErrorLogEntry(error, options);
  const serialized = JSON.stringify(entry);

  if (entry.level === 'error') {
    console.error(serialized);
  } else {
    console.warn(serialized);
  }

  return entry;
}
