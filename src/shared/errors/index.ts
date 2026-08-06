/**
 * 공통 오류 체계 (T0-3).
 *
 * 설계 문서 `02_시스템_아키텍처와_모듈구조.md` §4.11
 */

export {
  AppError,
  DomainError,
  AuthorizationError,
  ConflictError,
  ValidationError,
  SystemError,
  EnvironmentError,
  toAppError,
  type AppErrorOptions,
  type ErrorContext,
  type PublicDetails,
  type FieldError,
} from './app-error';

export {
  ERROR_CODES,
  DEFAULT_HTTP_STATUS,
  httpStatusForCode,
  isKnownErrorCode,
  publicMessageForCode,
  type ErrorCode,
} from './codes';

export { REQUEST_ID_HEADER, generateRequestId, resolveRequestId } from './request-id';

export {
  buildErrorResponse,
  type ErrorResponseBody,
  type ErrorDebugInfo,
  type BuildErrorResponseOptions,
} from './response';

export {
  buildErrorLogEntry,
  logError,
  maskCredentials,
  type ErrorLogEntry,
  type LogErrorOptions,
  type LogLevel,
} from './logger';

export { withErrorHandling, toErrorResponse, type ErrorHandlingOptions } from './handler';
