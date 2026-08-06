import { NextResponse } from 'next/server';

import { toAppError } from './app-error';
import { logError } from './logger';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id';
import { buildErrorResponse } from './response';

/**
 * Route Handler 오류 처리.
 *
 * 모든 API 라우트는 이 헬퍼를 통해 오류를 응답한다.
 * 오류 객체를 직접 직렬화하는 코드가 있으면 안 된다.
 *
 * ```ts
 * export async function GET(request: Request) {
 *   return withErrorHandling(request, async () => {
 *     const data = await service.doSomething();
 *     return NextResponse.json(data);
 *   });
 * }
 * ```
 */

export interface ErrorHandlingOptions {
  readonly route?: string;
}

/** 오류를 로그에 남기고 표준 오류 응답을 만든다. */
export function toErrorResponse(
  error: unknown,
  requestId: string,
  options: ErrorHandlingOptions & { method?: string } = {},
): NextResponse {
  // 1. 서버 로그: 전체 상세 (context, stack 포함)
  logError(error, {
    requestId,
    ...(options.route !== undefined ? { route: options.route } : {}),
    ...(options.method !== undefined ? { method: options.method } : {}),
  });

  // 2. 외부 응답: 환경별 정책 적용
  const body = buildErrorResponse(error, { requestId });
  const appError = toAppError(error);

  return NextResponse.json(body, {
    status: appError.httpStatus,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 핸들러를 감싸 오류를 표준 응답으로 변환한다.
 * 성공 응답에도 `x-request-id` 헤더를 붙인다.
 */
export async function withErrorHandling(
  request: Request,
  handler: (requestId: string) => Promise<NextResponse>,
  options: ErrorHandlingOptions = {},
): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers);

  try {
    const response = await handler(requestId);
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  } catch (error) {
    return toErrorResponse(error, requestId, { ...options, method: request.method });
  }
}
