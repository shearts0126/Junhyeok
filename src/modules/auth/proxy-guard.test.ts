import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthorizationError, ERROR_CODES, REQUEST_ID_HEADER } from '@/shared/errors';

import { blockWithError, createProxyRequestContext } from './presentation/proxy-guard';

/**
 * Proxy 차단 로깅 테스트 (T0-6 보완).
 *
 * Proxy 가 401·403 을 반환하면 Route Handler 는 실행되지 않는다.
 * 따라서 `withErrorHandling` 이 대신 기록해 주지 않는다 — Proxy 가 직접 남겨야 한다.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/roles', { headers });
}

interface Captured {
  warn: string[];
  error: string[];
}

let captured: Captured;

beforeEach(() => {
  captured = { warn: [], error: [] };
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
    captured.warn.push(String(line));
  });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    captured.error.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function allLogs(): string[] {
  return [...captured.warn, ...captured.error];
}

function parsedLogs(): Array<Record<string, unknown>> {
  return allLogs().map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 차단 상황별 오류. resolveActor 가 실제로 던지는 것과 같은 모양이다. */
const BLOCK_CASES: ReadonlyArray<[string, AuthorizationError, number, string]> = [
  [
    '세션 없음',
    new AuthorizationError(ERROR_CODES.UNAUTHORIZED, { message: '유효한 세션이 없습니다.' }),
    401,
    ERROR_CODES.UNAUTHORIZED,
  ],
  [
    '잘못된 토큰',
    new AuthorizationError(ERROR_CODES.UNAUTHORIZED, { message: '토큰이 유효하지 않습니다.' }),
    401,
    ERROR_CODES.UNAUTHORIZED,
  ],
  [
    '로컬 사용자 없음',
    new AuthorizationError(ERROR_CODES.FORBIDDEN, {
      message: 'SCM 시스템에 등록되지 않은 사용자입니다.',
      context: { reason: 'LOCAL_USER_NOT_FOUND', supabaseUserId: 'uuid-x' },
    }),
    403,
    ERROR_CODES.FORBIDDEN,
  ],
  [
    '비활성 사용자',
    new AuthorizationError(ERROR_CODES.FORBIDDEN, {
      message: '비활성화된 사용자입니다.',
      context: { reason: 'USER_INACTIVE' },
    }),
    403,
    ERROR_CODES.FORBIDDEN,
  ],
  [
    '권한 없음',
    new AuthorizationError(ERROR_CODES.FORBIDDEN, {
      message: "권한 'role.read' 가 없습니다.",
      context: { reason: 'MISSING_PERMISSION', requiredPermission: 'role.read' },
    }),
    403,
    ERROR_CODES.FORBIDDEN,
  ],
];

describe('★ Proxy 차단 — 상태코드와 로그 1건', () => {
  it.each(BLOCK_CASES)('%s → HTTP %s / 로그 1건', async (_label, error, status, code) => {
    const request = makeRequest();
    const { requestId } = createProxyRequestContext(request);

    const { response } = blockWithError(error, { request, requestId, route: '/api/roles' });

    expect(response.status).toBe(status);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['errorCode']).toBe(code);

    // ★ 정확히 한 건. Proxy 가 남기고, Route Handler 는 실행되지 않는다.
    expect(allLogs()).toHaveLength(1);
  });
});

describe('★ Proxy 차단 — requestId 일관성', () => {
  it('★ 로그·응답 본문·x-request-id 헤더가 모두 같은 값이다', async () => {
    const request = makeRequest();
    const { requestId } = createProxyRequestContext(request);

    const { response } = blockWithError(BLOCK_CASES[2]![1], {
      request,
      requestId,
      route: '/api/roles',
    });

    const body = (await response.json()) as { requestId: string };
    const [log] = parsedLogs();

    expect(requestId).toMatch(UUID_PATTERN);
    expect(body.requestId).toBe(requestId);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(requestId);
    expect(log?.['requestId']).toBe(requestId);
  });

  it('★ 외부 x-request-id 를 서버 requestId 로 쓰지 않는다', () => {
    const request = makeRequest({ [REQUEST_ID_HEADER]: 'external-trace-1' });
    const context = createProxyRequestContext(request);

    expect(context.requestId).not.toBe('external-trace-1');
    expect(context.requestId).toMatch(UUID_PATTERN);
    expect(context.correlationId).toBe('external-trace-1');
  });

  it('★ 외부 값은 로그의 correlationId 에만 있고 응답에는 없다', async () => {
    const request = makeRequest({ [REQUEST_ID_HEADER]: 'external-trace-2' });
    const { requestId } = createProxyRequestContext(request);

    const { response } = blockWithError(BLOCK_CASES[0]![1], {
      request,
      requestId,
      route: '/api/roles',
    });

    const raw = JSON.stringify(await response.json());
    const [log] = parsedLogs();

    expect(log?.['correlationId']).toBe('external-trace-2');
    expect(raw).not.toContain('external-trace-2');
    expect(raw).not.toContain('correlationId');
  });

  it('외부 헤더가 없으면 correlationId 가 생략된다', () => {
    const [log] = (() => {
      const request = makeRequest();
      const { requestId } = createProxyRequestContext(request);
      blockWithError(BLOCK_CASES[0]![1], { request, requestId, route: '/api/roles' });
      return parsedLogs();
    })();

    expect(log?.['correlationId']).toBeUndefined();
  });

  it('★ 같은 요청을 반복해도 서버 requestId 는 매번 다르다', () => {
    const request = makeRequest({ [REQUEST_ID_HEADER]: 'same' });
    const ids = new Set(
      Array.from({ length: 10 }, () => createProxyRequestContext(request).requestId),
    );
    expect(ids.size).toBe(10);
  });
});

describe('★ Proxy 차단 — 응답에 내부 정보 미노출', () => {
  it('★ 내부 사유·권한 목록·스택이 응답에 없다', async () => {
    const request = makeRequest();
    const { requestId } = createProxyRequestContext(request);

    const { response } = blockWithError(BLOCK_CASES[4]![1], {
      request,
      requestId,
      route: '/api/roles',
    });

    const raw = JSON.stringify(await response.json());

    expect(raw).not.toContain('MISSING_PERMISSION');
    expect(raw).not.toContain('role.read');
    expect(raw).not.toContain('requiredPermission');
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('at ');
  });

  it('공개 고정 문구를 쓴다', async () => {
    const request = makeRequest();
    const { requestId } = createProxyRequestContext(request);

    const forbidden = blockWithError(BLOCK_CASES[2]![1], {
      request,
      requestId,
      route: '/api/roles',
    });
    const body = (await forbidden.response.json()) as { message: string };

    expect(body.message).toBe('이 작업을 수행할 권한이 없습니다.');
    expect(body.message).not.toContain('등록되지 않은');
  });

  it('Cache-Control: no-store 를 설정한다', () => {
    const request = makeRequest();
    const { requestId } = createProxyRequestContext(request);
    const { response } = blockWithError(BLOCK_CASES[0]![1], {
      request,
      requestId,
      route: '/api/roles',
    });

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('응답 본문의 키가 세 개뿐이다', async () => {
    const request = makeRequest();
    const { requestId } = createProxyRequestContext(request);
    const { response } = blockWithError(BLOCK_CASES[0]![1], {
      request,
      requestId,
      route: '/api/roles',
    });

    expect(Object.keys((await response.json()) as object).sort()).toEqual([
      'errorCode',
      'message',
      'requestId',
    ]);
  });
});

describe('★ Proxy 차단 — 로그 내용과 마스킹', () => {
  it('로그에는 내부 사유가 남는다', () => {
    const request = makeRequest();
    const { requestId } = createProxyRequestContext(request);
    blockWithError(BLOCK_CASES[2]![1], { request, requestId, route: '/api/roles' });

    const [log] = parsedLogs();
    expect((log?.['context'] as Record<string, unknown>)['reason']).toBe('LOCAL_USER_NOT_FOUND');
    expect(log?.['route']).toBe('/api/roles');
    expect(log?.['method']).toBe('GET');
    expect(log?.['errorCode']).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ 로그의 토큰·쿠키가 마스킹된다', () => {
    const request = makeRequest();
    const { requestId } = createProxyRequestContext(request);

    blockWithError(
      new AuthorizationError(ERROR_CODES.UNAUTHORIZED, {
        message: '토큰 검증 실패',
        context: {
          authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
          cookie: 'sb-access-token=eyJhbGciOi...; sb-refresh-token=abc',
          databaseUrl: 'postgresql://scm:pw123@db.internal/prod',
        },
      }),
      { request, requestId, route: '/api/roles' },
    );

    const raw = allLogs()[0] ?? '';
    expect(raw).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(raw).not.toContain('sb-access-token=');
    expect(raw).not.toContain('pw123');
    expect(raw).toContain('***');
  });

  it('401 은 warn, 403 도 warn (예상 가능한 오류)', () => {
    const request = makeRequest();
    for (const [, error] of BLOCK_CASES) {
      const { requestId } = createProxyRequestContext(request);
      blockWithError(error, { request, requestId, route: '/api/roles' });
    }

    expect(captured.error).toHaveLength(0);
    expect(captured.warn).toHaveLength(BLOCK_CASES.length);
  });
});
