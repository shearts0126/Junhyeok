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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** 라우트는 개발환경 + 명시적 활성화 플래그를 모두 요구한다. */
function enablePreview(): void {
  setNodeEnv('development');
  vi.stubEnv('ENABLE_ERROR_PREVIEW', 'true');
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
  beforeEach(enablePreview);

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

describe('★ 라우트 활성화 조건', () => {
  it('운영환경에서는 플래그가 켜져 있어도 404 를 반환한다', async () => {
    setNodeEnv('production');
    vi.stubEnv('ENABLE_ERROR_PREVIEW', 'true');
    const response = await GET(request('system'));
    expect(response.status).toBe(404);
  });

  it('★ 개발환경이어도 플래그가 없으면 404 를 반환한다 (기본 비활성화)', async () => {
    setNodeEnv('development');
    vi.stubEnv('ENABLE_ERROR_PREVIEW', '');
    const response = await GET(request('system'));
    expect(response.status).toBe(404);
  });

  it("플래그가 'true' 가 아닌 값이면 404 를 반환한다", async () => {
    setNodeEnv('development');
    for (const value of ['1', 'yes', 'TRUE', 'false']) {
      vi.stubEnv('ENABLE_ERROR_PREVIEW', value);
      expect((await GET(request('system'))).status, value).toBe(404);
    }
  });

  it('★ 비활성 상태에서도 JSON 404 를 반환한다 (HTML 아님)', async () => {
    setNodeEnv('production');
    const response = await GET(request('system'));
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await response.json();
    expect(body.errorCode).toBe('NOT_FOUND');
    expect(body.message).toBe('요청한 대상을 찾을 수 없습니다.');
  });

  it('두 조건을 모두 만족하면 동작한다', async () => {
    enablePreview();
    expect((await GET(request('domain'))).status).toBe(422);
  });
});

describe('오류 응답 — 공통 포맷', () => {
  beforeEach(enablePreview);

  it('errorCode·message·requestId 를 항상 포함한다', async () => {
    const body = await (await GET(request('domain'))).json();
    expect(typeof body.errorCode).toBe('string');
    expect(typeof body.message).toBe('string');
    expect(body.requestId).toMatch(UUID_PATTERN);
  });

  it('★ x-request-id 응답 헤더를 내려준다', async () => {
    const response = await GET(request('domain'));
    const header = response.headers.get(REQUEST_ID_HEADER);
    expect(header).toBeTruthy();
    const body = await response.json();
    expect(header).toBe(body.requestId);
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

  it('DomainError 는 publicDetails·publicHint 를 포함한다', async () => {
    const body = await (await GET(request('domain'))).json();
    expect(body.publicDetails.available).toBe('10.000000');
    expect(body.publicHint).toContain('합산');
  });
});

describe('★ 서버 requestId ↔ 외부 correlationId 분리', () => {
  beforeEach(enablePreview);

  it('★ 요청의 x-request-id 를 응답에 되돌려주지 않는다', async () => {
    const response = await GET(request('domain', { [REQUEST_ID_HEADER]: 'trace-abc-123' }));
    const body = await response.json();

    expect(body.requestId).not.toBe('trace-abc-123');
    expect(body.requestId).toMatch(UUID_PATTERN);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(body.requestId);
  });

  it('★ 동일한 외부 x-request-id 를 반복 전송해도 서버 requestId 는 매번 다르다', async () => {
    const ids = new Set<string>();

    for (let i = 0; i < 5; i += 1) {
      const response = await GET(request('domain', { [REQUEST_ID_HEADER]: 'same-id' }));
      ids.add((await response.json()).requestId);
    }

    expect(ids.size).toBe(5);
  });

  it('★ correlationId 는 로그에만 남고 응답에는 없다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await GET(request('domain', { [REQUEST_ID_HEADER]: 'client-trace-9' }));
    const body = await response.json();
    const entry = JSON.parse(warn.mock.calls[0]?.[0] as string);

    expect(entry.correlationId).toBe('client-trace-9');
    expect(entry.requestId).toBe(body.requestId);
    expect(JSON.stringify(body)).not.toContain('client-trace-9');
    expect(JSON.stringify(body)).not.toContain('correlationId');
  });

  it('외부 헤더가 없으면 로그의 correlationId 도 생략된다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await GET(request('domain'));
    const entry = JSON.parse(warn.mock.calls[0]?.[0] as string);
    expect(entry.correlationId).toBeUndefined();
  });
});

describe('★ 오류 응답 — 내부 정보 미노출', () => {
  beforeEach(enablePreview);

  it('SystemError 의 연결 문자열이 message 에 노출되지 않는다', async () => {
    const body = await (await GET(request('system'))).json();
    expect(body.message).toBe('요청을 처리하지 못했습니다.');
  });

  it('★ 예상하지 못한 오류의 publicDetails 는 응답에 실리지 않는다', async () => {
    const raw = JSON.stringify(await (await GET(request('system'))).json());
    expect(raw).not.toContain('shouldNotAppear');
    expect(raw).not.toContain('leaked');
  });

  it('★ details(내부 전용)는 어떤 환경에서도 응답에 없다', async () => {
    const raw = JSON.stringify(await (await GET(request('domain'))).json());
    expect(raw).not.toContain('internalSkuId');
    expect(raw).not.toContain('postgresql://');
    expect(raw).not.toContain('databaseUrl');
  });

  it('★ context 는 어떤 환경에서도 응답에 없다', async () => {
    const raw = JSON.stringify(await (await GET(request('system'))).json());
    expect(raw).not.toContain('internalHost');
    expect(raw).not.toContain('context');
    // context 안의 Bearer 토큰도 응답에 없다
    expect(raw).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    // ※ `db.internal` 은 debug.internalMessage 에 남는다. 개발환경 한정이며
    //    운영 응답에 debug 블록이 없다는 것은 errors.test.ts 가 검증한다.
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
  beforeEach(enablePreview);

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

  it('★ 로그에는 details 가 남되 자격증명은 마스킹된다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await GET(request('domain'));
    const raw = warn.mock.calls[0]?.[0] as string;
    const entry = JSON.parse(raw);

    expect(entry.details.internalSkuId).toBe('uuid-sku-1');
    // 키 이름이 databaseUrl 이므로 값 전체가 치환된다
    expect(entry.details.databaseUrl).toBe('***');
    expect(raw).not.toContain(':pw@');
  });

  it('★ 로그의 context 안 Bearer 토큰도 마스킹된다', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await GET(request('system'));
    const raw = errorLog.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(raw).toContain('***');
  });

  it('★ 로그의 message 에서도 비밀번호는 마스킹된다', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await GET(request('system'));
    const raw = errorLog.mock.calls[0]?.[0] as string;
    expect(raw).not.toContain(':pw@');
    expect(raw).toContain('***:***@');
  });
});
