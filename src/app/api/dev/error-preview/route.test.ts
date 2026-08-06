import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REQUEST_ID_HEADER } from '@/shared/errors';

import { GET } from './route';

/**
 * API 오류 응답 통합 테스트.
 *
 * Route Handler 를 직접 호출해 실제 `NextResponse` 를 검증한다.
 * 서버 기동 없이 응답 포맷·헤더·상태코드·비밀정보 미노출을 확인할 수 있다.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function request(kind?: string, headers: Record<string, string> = {}): Request {
  const url = kind
    ? `http://localhost/api/dev/error-preview?kind=${kind}`
    : 'http://localhost/api/dev/error-preview';
  return new Request(url, { headers });
}

/** NODE_ENV 는 읽기전용 타입이므로 테스트에서만 우회해 설정한다. */
function setNodeEnv(value: string): void {
  vi.stubEnv('NODE_ENV', value);
}

beforeEach(() => {
  // 로그 출력이 테스트 결과를 가리지 않도록 억제한다.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.stubEnv('NODE_ENV', ORIGINAL_NODE_ENV ?? 'test');
  vi.unstubAllEnvs();
});

describe('오류 응답 — HTTP 상태 매핑', () => {
  beforeEach(() => setNodeEnv('development'));

  it.each([
    ['validation', 400, 'VALIDATION_ERROR'],
    ['authorization', 403, 'FORBIDDEN'],
    ['conflict', 409, 'SERIALIZATION_FAILURE'],
    ['domain', 422, 'INSUFFICIENT_STOCK'],
    ['system', 500, 'INTERNAL_ERROR'],
    ['unknown', 500, 'INTERNAL_ERROR'],
  ])('kind=%s → HTTP %d / %s', async (kind, status, code) => {
    const response = await GET(request(kind));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.errorCode).toBe(code);
  });
});

describe('오류 응답 — 공통 포맷', () => {
  beforeEach(() => setNodeEnv('development'));

  it('errorCode·message·requestId 를 항상 포함한다', async () => {
    const body = await (await GET(request('domain'))).json();
    expect(typeof body.errorCode).toBe('string');
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it('★ x-request-id 응답 헤더를 내려준다', async () => {
    const response = await GET(request('domain'));
    const header = response.headers.get(REQUEST_ID_HEADER);
    expect(header).toBeTruthy();
    const body = await response.json();
    expect(header).toBe(body.requestId);
  });

  it('★ 요청의 x-request-id 를 그대로 전파한다', async () => {
    const response = await GET(request('domain', { [REQUEST_ID_HEADER]: 'trace-abc-123' }));
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('trace-abc-123');
    expect((await response.json()).requestId).toBe('trace-abc-123');
  });

  it('오류 응답은 캐시되지 않는다', async () => {
    const response = await GET(request('domain'));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('ValidationError 는 fieldErrors 를 포함한다', async () => {
    const body = await (await GET(request('validation'))).json();
    expect(body.fieldErrors).toHaveLength(2);
    expect(body.fieldErrors[0].path).toBe('skuCode');
  });

  it('DomainError 는 details·hint 를 포함한다', async () => {
    const body = await (await GET(request('domain'))).json();
    expect(body.details.available).toBe('10.000000');
    expect(body.hint).toContain('합산');
  });
});

describe('★ 오류 응답 — 운영환경 비밀정보 미노출', () => {
  beforeEach(() => setNodeEnv('production'));

  it('운영환경에서는 이 라우트가 404 를 반환한다', async () => {
    const response = await GET(request('system'));
    expect(response.status).toBe(404);
  });
});

describe('★ 오류 응답 — 운영 정책 (환경 강제)', () => {
  // 라우트가 운영에서 404 이므로, 운영 정책 자체는 buildErrorResponse 단위
  // 테스트(errors.test.ts)가 검증한다. 여기서는 개발환경 응답이
  // 예상하지 못한 오류에 대해서도 내부 상세를 message 로 내보내지 않는지 본다.
  beforeEach(() => setNodeEnv('development'));

  it('SystemError 의 연결 문자열이 message 에 노출되지 않는다', async () => {
    const body = await (await GET(request('system'))).json();
    expect(body.message).toBe('요청을 처리하지 못했습니다.');
    expect(body.details).toBeUndefined();
  });

  it('★ context(내부 호스트)는 어떤 환경에서도 응답에 없다', async () => {
    const raw = JSON.stringify(await (await GET(request('system'))).json());
    expect(raw).not.toContain('internalHost');
  });

  it('★ AuthorizationError 의 context(requiredPermission)도 노출되지 않는다', async () => {
    const raw = JSON.stringify(await (await GET(request('authorization'))).json());
    expect(raw).not.toContain('requiredPermission');
  });

  it('알 수 없는 오류(TypeError)는 고정 문구로 처리된다', async () => {
    const body = await (await GET(request('unknown'))).json();
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('요청을 처리하지 못했습니다.');
    expect(JSON.stringify(body.message)).not.toContain('Cannot read');
  });
});

describe('오류 로깅', () => {
  beforeEach(() => setNodeEnv('development'));

  it('예상 가능한 오류는 warn 으로 남는다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await GET(request('domain'));
    expect(warn).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(warn.mock.calls[0]?.[0] as string);
    expect(entry.level).toBe('warn');
    expect(entry.errorCode).toBe('INSUFFICIENT_STOCK');
    expect(entry.route).toBe('/api/dev/error-preview');
    expect(entry.method).toBe('GET');
  });

  it('★ 예상하지 못한 오류는 error 로 남고 context 를 포함한다', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await GET(request('system'));
    const entry = JSON.parse(errorLog.mock.calls[0]?.[0] as string);
    expect(entry.level).toBe('error');
    expect(entry.expected).toBe(false);
    expect(entry.context.internalHost).toBe('db.internal');
    expect(entry.stack).toBeDefined();
  });

  it('★ 로그의 requestId 로 응답과 연결된다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await GET(request('domain', { [REQUEST_ID_HEADER]: 'link-me' }));
    const entry = JSON.parse(warn.mock.calls[0]?.[0] as string);
    expect(entry.requestId).toBe('link-me');
    expect((await response.json()).requestId).toBe('link-me');
  });

  it('★ 로그에서도 비밀번호는 마스킹된다', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await GET(request('system'));
    const raw = errorLog.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain(':pw@');
    expect(raw).toContain('***:***@');
  });
});
