import { AppError, toAppError } from './app-error';

/**
 * 오류 로깅.
 *
 * 외부 응답과 달리 **모든 상세를 기록한다.** 서버 로그는 신뢰 경계 안에 있다.
 * 다만 로그에도 비밀번호가 그대로 남는 것은 바람직하지 않으므로
 * 알려진 형태(연결 문자열)의 자격증명은 마스킹한다.
 *
 * T0-3 은 콘솔 출력만 한다. Sentry 등 외부 전송은 T0-9 에서 붙인다.
 */

export type LogLevel = 'error' | 'warn' | 'info';

export interface ErrorLogEntry {
  readonly level: LogLevel;
  readonly requestId: string;
  readonly errorCode: string;
  readonly errorName: string;
  readonly message: string;
  readonly expected: boolean;
  readonly httpStatus: number;
  readonly context?: Record<string, unknown>;
  readonly cause?: string;
  readonly stack?: string;
  readonly route?: string;
  readonly method?: string;
  readonly timestamp: string;
}

/**
 * 문자열에서 연결 문자열의 자격증명을 가린다.
 *
 * `postgresql://user:pw@host:5432/db` → `postgresql://***:***@host:5432/db`
 */
export function maskCredentials(value: string): string {
  return value.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/g, '$1***:***@');
}

export interface LogErrorOptions {
  readonly requestId: string;
  readonly route?: string;
  readonly method?: string;
}

/** 오류를 구조화된 로그 항목으로 만든다. */
export function buildErrorLogEntry(error: unknown, options: LogErrorOptions): ErrorLogEntry {
  const appError: AppError = toAppError(error);

  const entry: {
    level: LogLevel;
    requestId: string;
    errorCode: string;
    errorName: string;
    message: string;
    expected: boolean;
    httpStatus: number;
    timestamp: string;
    context?: Record<string, unknown>;
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
    message: maskCredentials(appError.message),
    expected: appError.expected,
    httpStatus: appError.httpStatus,
    timestamp: new Date().toISOString(),
  };

  if (appError.context !== undefined) entry.context = appError.context;
  if (appError.cause !== undefined) {
    entry.cause =
      appError.cause instanceof Error
        ? maskCredentials(`${appError.cause.name}: ${appError.cause.message}`)
        : maskCredentials(String(appError.cause));
  }
  // 예상하지 못한 오류만 스택을 남긴다. 예상 가능한 오류의 스택은 소음이다.
  if (!appError.expected && appError.stack !== undefined) {
    entry.stack = maskCredentials(appError.stack);
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
