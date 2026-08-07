import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

import { E2E_USERS } from './fixtures';

/**
 * E2E 전용 Supabase Auth 스텁 (T0-8).
 *
 * 실제 Supabase 프로젝트 없이 E2E 를 돌리기 위한 **환경 대역**이다.
 * 앱은 `NEXT_PUBLIC_SUPABASE_URL` 이 이 서버를 가리키는 것 외에는
 * 운영과 완전히 같은 코드 경로(@supabase/ssr → 쿠키 → getClaims)를 탄다.
 *
 * ⚠️ **운영 인증 코드를 우회하지 않는다.** 앱 번들에는 테스트 분기가 없다 —
 *    이 파일은 Playwright 의 webServer 로만 뜨고 production bundle 에
 *    포함되지 않는다.
 *
 * 구현 범위 (supabase-js 2.x 가 실제로 부르는 것만):
 *   - POST /auth/v1/token?grant_type=password  → HS256 세션 발급
 *   - GET  /auth/v1/user                       → bearer 검증 (getClaims 의 HS256 폴백)
 *   - POST /auth/v1/logout                     → 204
 */

const PORT = Number(process.env['STUB_PORT'] ?? 54321);
const SECRET = 'e2e-stub-secret-not-a-real-key';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    if (typeof payload['exp'] === 'number' && payload['exp'] < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function userJson(user: (typeof E2E_USERS)[number]) {
  const now = new Date().toISOString();
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: now,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: now,
    updated_at: now,
  };
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    request.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    request.on('end', () => resolve(data));
  });
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    // 비밀번호 로그인
    if (request.method === 'POST' && url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') !== 'password') {
        json(400, { error: 'unsupported_grant_type' });
        return;
      }
      let body: { email?: string; password?: string } = {};
      try {
        body = JSON.parse(await readBody(request)) as typeof body;
      } catch {
        // 빈 본문이면 아래에서 실패한다.
      }
      const user = E2E_USERS.find(
        (candidate) => candidate.email === body.email && candidate.password === body.password,
      );
      if (user === undefined) {
        json(400, {
          error: 'invalid_grant',
          error_description: 'Invalid login credentials',
          error_code: 'invalid_credentials',
          code: 400,
          msg: 'Invalid login credentials',
        });
        return;
      }

      const expiresIn = 3600;
      const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
      const accessToken = signJwt({
        iss: `http://localhost:${PORT}/auth/v1`,
        sub: user.id,
        aud: 'authenticated',
        role: 'authenticated',
        email: user.email,
        session_id: `e2e-session-${user.id.slice(-4)}`,
        iat: Math.floor(Date.now() / 1000),
        exp: expiresAt,
      });

      json(200, {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: expiresIn,
        expires_at: expiresAt,
        refresh_token: `e2e-refresh-${user.id}`,
        user: userJson(user),
      });
      return;
    }

    // getClaims 의 HS256 폴백 — bearer 검증
    if (request.method === 'GET' && url.pathname === '/auth/v1/user') {
      const authorization = request.headers.authorization ?? '';
      const token = authorization.replace(/^Bearer\s+/i, '');
      const payload = verifyJwt(token);
      const user =
        payload === null
          ? undefined
          : E2E_USERS.find((candidate) => candidate.id === payload['sub']);
      if (user === undefined) {
        json(401, { code: 401, msg: 'invalid claim: missing sub claim' });
        return;
      }
      json(200, userJson(user));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/auth/v1/logout') {
      response.writeHead(204).end();
      return;
    }

    json(404, { error: 'not_found', path: url.pathname });
  })();
});

server.listen(PORT, () => {
  console.log(`[supabase-stub] listening on http://localhost:${PORT}`);
});
