import { NextResponse, type NextRequest } from 'next/server';

import {
  ERROR_CODES,
  REQUEST_ID_HEADER,
  generateRequestId,
  logError,
  publicMessageForCode,
  resolveCorrelationId,
  toAppError,
  type AppError,
} from '@/shared/errors';

/**
 * Proxy 차단 응답과 로깅 (T0-6 보완).
 *
 * ## 왜 Proxy 전용 처리기가 필요한가
 *
 * Proxy 가 401·403 을 반환하면 **Route Handler 는 아예 실행되지 않는다.**
 * 따라서 `withErrorHandling` 이 다시 판정하고 기록해 줄 것이라 기대할 수 없다.
 * 그렇게 두면 차단된 요청이 서버 로그에 한 줄도 남지 않는다 —
 * 권한 거부야말로 가장 남아야 할 기록이다.
 *
 * ## 중복 로깅을 피하는 방식
 *
 * Proxy 가 **차단한 요청만** 기록한다. 통과시킨 요청은 로그를 남기지 않고
 * Route Handler 로 넘긴다. 그쪽에서 오류가 나면 `withErrorHandling` 이 기록한다.
 * 한 요청이 두 곳에서 기록되는 경로가 없다.
 */

/** Proxy 가 차단할 때 만드는 결과. */
export interface ProxyBlockResult {
  readonly response: NextResponse;
  readonly requestId: string;
}

export interface ProxyBlockOptions {
  readonly request: NextRequest;
  /** 서버가 생성한 requestId. 응답·헤더·로그에 같은 값을 쓴다. */
  readonly requestId: string;
  readonly route: string;
}

/** 요청 1건의 식별자. Proxy 진입 시 한 번 만든다. */
export function createProxyRequestContext(request: NextRequest): {
  requestId: string;
  correlationId?: string;
} {
  const correlationId = resolveCorrelationId(request.headers);
  return {
    requestId: generateRequestId(),
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
}

function statusFor(code: string): number {
  return code === ERROR_CODES.UNAUTHORIZED ? 401 : 403;
}

/**
 * Proxy 차단 응답을 만들고 **서버 로그에 기록한다.**
 *
 * - 응답 본문·`x-request-id` 헤더·로그에 **같은 서버 생성 requestId**
 * - 외부 `x-request-id` 는 로그의 `correlationId` 에만
 * - 운영 응답에 내부 사유·스택·권한 목록 없음 (`publicMessageForCode` 고정 문구)
 * - 로그의 자격증명은 `logError` 가 재사용하는 redaction 으로 마스킹
 */
export function blockWithError(error: unknown, options: ProxyBlockOptions): ProxyBlockResult {
  const appError: AppError = toAppError(error);
  const code = String(appError.code);
  const status = statusFor(code);
  const correlationId = resolveCorrelationId(options.request.headers);

  // ★ 서버 로그 — 상세는 여기에만 남는다.
  //   context 에 담긴 내부 사유(LOCAL_USER_NOT_FOUND 등)와 쿠키·토큰은
  //   logError 의 redaction 을 그대로 거친다.
  logError(appError, {
    requestId: options.requestId,
    ...(correlationId !== undefined ? { correlationId } : {}),
    route: options.route,
    method: options.request.method,
  });

  const response = NextResponse.json(
    {
      errorCode: code,
      message: publicMessageForCode(code),
      requestId: options.requestId,
    },
    {
      status,
      headers: {
        [REQUEST_ID_HEADER]: options.requestId,
        'Cache-Control': 'no-store',
      },
    },
  );

  return { response, requestId: options.requestId };
}
