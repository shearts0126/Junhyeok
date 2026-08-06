import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthorizationError, ERROR_CODES, type AppError } from '@/shared/errors';

import {
  isPublicPath,
  listRoles,
  requiredPermissionFor,
  resolveActor,
  type ActorContext,
} from './application';
import type {
  RoleReader,
  UserAuthorization,
  UserAuthorizationReader,
} from './infrastructure/user-repository';
import type { ClaimsVerifier } from './infrastructure/verify';
import { blockWithError, createProxyRequestContext } from './presentation/proxy-guard';

/**
 * 인증 성공 연쇄 통합 테스트 (T0-6 보완).
 *
 * 실제 Supabase 없이 **전체 연쇄**를 검증한다.
 *
 * ```
 * 로그인 성공 → 세션 쿠키 설정 → 검증된 claims 의 sub 조회
 *   → 로컬 User 조회 → roles·permissions 구성
 *   → GET /api/me 200 → GET /api/roles 200 또는 403
 * ```
 *
 * 대역은 Supabase 의 **관찰 가능한 계약**만 흉내낸다.
 *   - `signInWithPassword` 가 성공하면 세션 쿠키를 심는다
 *   - 이후 `getClaims()` 가 그 쿠키를 근거로 서명 검증된 클레임을 돌려준다
 *   - 쿠키가 없거나 위조되면 `getClaims()` 가 실패한다
 *
 * ⚠️ 실제 Supabase 로그인은 자격증명이 없어 실측하지 못했다. 제한사항으로 유지한다.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_COOKIE = 'sb-access-token';

// ═══════════════════════════════════════════════════════════════
// Supabase 대역
// ═══════════════════════════════════════════════════════════════

interface SupabaseAccount {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

/** 세션 쿠키를 실제로 심고 읽는 Supabase 대역. */
class FakeSupabase {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly accounts: readonly SupabaseAccount[]) {}

  /** `POST /api/auth/login` 이 부르는 것. 성공하면 세션 쿠키를 심는다. */
  signInWithPassword(email: string, password: string): { userId: string } | null {
    const account = this.accounts.find(
      (candidate) => candidate.email === email && candidate.password === password,
    );
    if (account === undefined) return null;

    // 실제 Supabase 는 서명된 JWT 를 쿠키에 심는다.
    // 대역은 계정 식별자만 담되, 검증은 이 클래스만 할 수 있게 한다.
    this.cookies.set(SESSION_COOKIE, `signed:${account.userId}:${account.email}`);
    return { userId: account.userId };
  }

  signOut(): void {
    this.cookies.delete(SESSION_COOKIE);
  }

  hasSessionCookie(): boolean {
    return this.cookies.has(SESSION_COOKIE);
  }

  /** 쿠키를 위조한 상황. 서명이 맞지 않는다. */
  forgeCookie(value: string): void {
    this.cookies.set(SESSION_COOKIE, value);
  }

  /**
   * 서명을 검증하고 클레임을 돌려준다.
   *
   * ★ 쿠키 값을 그대로 신뢰하지 않고 형식을 확인한다는 점이
   *   `getSession()` 과 `getClaims()` 의 차이를 재현한다.
   */
  asClaimsVerifier(): ClaimsVerifier {
    return {
      getClaims: async () => {
        const raw = this.cookies.get(SESSION_COOKIE);
        if (raw === undefined) return { data: null, error: null };

        const match = /^signed:([^:]+):(.+)$/.exec(raw);
        if (match === null) {
          return { data: null, error: { message: '서명 검증 실패' } };
        }

        return {
          data: { claims: { sub: match[1], email: match[2], session_id: 'sess-fake' } },
          error: null,
        };
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 고정 데이터
// ═══════════════════════════════════════════════════════════════

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const GHOST_ID = '33333333-3333-4333-8333-333333333333';
const INACTIVE_ID = '44444444-4444-4444-8444-444444444444';

const ACCOUNTS: readonly SupabaseAccount[] = [
  { userId: ADMIN_ID, email: 'admin@deeppoint.test', password: 'correct-horse' },
  { userId: STAFF_ID, email: 'staff@deeppoint.test', password: 'staff-secret' },
  { userId: GHOST_ID, email: 'ghost@deeppoint.test', password: 'ghost-secret' },
  { userId: INACTIVE_ID, email: 'inactive@deeppoint.test', password: 'inactive-secret' },
];

/** 로컬 `user` 표. GHOST 는 일부러 없다(인증은 되지만 미등록). */
const LOCAL_USERS: ReadonlyMap<string, UserAuthorization> = new Map([
  [
    ADMIN_ID,
    {
      userId: ADMIN_ID,
      email: 'admin@deeppoint.test',
      name: '관리자',
      active: true,
      roles: ['ADMIN'],
      permissions: ['role.read'],
    },
  ],
  [
    STAFF_ID,
    {
      userId: STAFF_ID,
      email: 'staff@deeppoint.test',
      name: '담당자',
      active: true,
      roles: ['SCM_STAFF'],
      permissions: [],
    },
  ],
  [
    INACTIVE_ID,
    {
      userId: INACTIVE_ID,
      email: 'inactive@deeppoint.test',
      name: '퇴사자',
      active: false,
      roles: ['SCM_STAFF'],
      permissions: [],
    },
  ],
]);

function localUserReader(
  overrides: ReadonlyMap<string, UserAuthorization> = LOCAL_USERS,
): UserAuthorizationReader {
  return { findByUserId: async (userId) => overrides.get(userId) ?? null };
}

const ROLE_READER: RoleReader = {
  listRoles: async () => [
    { roleCode: 'ADMIN', roleName: '시스템 관리자', permissions: ['role.read'] },
    { roleCode: 'EXECUTIVE', roleName: '경영진', permissions: [] },
    { roleCode: 'FINANCE', roleName: '재무', permissions: [] },
    { roleCode: 'SCM_LEADER', roleName: 'SCM 리더', permissions: [] },
    { roleCode: 'SCM_STAFF', roleName: 'SCM 담당자', permissions: [] },
  ],
};

// ═══════════════════════════════════════════════════════════════
// 라우트 흉내 — 실제 핸들러와 같은 순서로 호출한다
// ═══════════════════════════════════════════════════════════════

interface RouteResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** `GET /api/me` 와 같은 순서. */
async function getMe(
  supabase: FakeSupabase,
  reader: UserAuthorizationReader,
  requestId = 'req-me',
): Promise<RouteResult> {
  try {
    const actor = await resolveActor(
      { verifier: supabase.asClaimsVerifier(), reader },
      { requestId },
    );
    return {
      status: 200,
      body: {
        user: { id: actor.userId, email: actor.email, name: actor.name },
        roles: actor.roles,
        permissions: actor.permissions,
        requestId: actor.requestId,
      },
    };
  } catch (error) {
    const appError = error as AppError;
    return { status: appError.httpStatus, body: { errorCode: appError.code } };
  }
}

/** `GET /api/roles` 와 같은 순서 (2차 가드 포함). */
async function getRoles(
  supabase: FakeSupabase,
  reader: UserAuthorizationReader,
  requestId = 'req-roles',
): Promise<RouteResult> {
  try {
    const actor = await resolveActor(
      { verifier: supabase.asClaimsVerifier(), reader },
      { requestId },
    );
    const roles = await listRoles(actor, { reader: ROLE_READER });
    return { status: 200, body: { roles } };
  } catch (error) {
    const appError = error as AppError;
    return { status: appError.httpStatus, body: { errorCode: appError.code } };
  }
}

/** Proxy 1차 가드 흉내. 통과하면 `null`, 차단하면 응답. */
async function proxyGuard(
  supabase: FakeSupabase,
  reader: UserAuthorizationReader,
  pathname: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (isPublicPath(pathname)) return null;

  const request = new NextRequest(`http://localhost${pathname}`);
  const { requestId } = createProxyRequestContext(request);

  try {
    const actor: ActorContext = await resolveActor(
      { verifier: supabase.asClaimsVerifier(), reader },
      { requestId },
    );
    const required = requiredPermissionFor(pathname);
    if (required !== undefined && !actor.permissions.includes(required)) {
      const { response } = blockWithError(
        new AuthorizationError(ERROR_CODES.FORBIDDEN, {
          message: `권한 '${required}' 가 없습니다.`,
        }),
        { request, requestId, route: pathname },
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }
    return null;
  } catch (error) {
    const { response } = blockWithError(error, { request, requestId, route: pathname });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════
// 성공 경로
// ═══════════════════════════════════════════════════════════════
describe('★ 인증 성공 연쇄 — ADMIN', () => {
  it('★ 로그인 → 쿠키 → claims → 로컬 User → /api/me 200', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    const reader = localUserReader();

    // 1. 로그인 성공
    const signIn = supabase.signInWithPassword('admin@deeppoint.test', 'correct-horse');
    expect(signIn).not.toBeNull();
    expect(signIn?.userId).toBe(ADMIN_ID);

    // 2. 세션 쿠키가 설정된다
    expect(supabase.hasSessionCookie()).toBe(true);

    // 3~5. claims 의 sub → 로컬 User → roles·permissions
    const me = await getMe(supabase, reader);

    expect(me.status).toBe(200);
    expect(me.body['user']).toEqual({
      id: ADMIN_ID,
      email: 'admin@deeppoint.test',
      name: '관리자',
    });
    expect(me.body['roles']).toEqual(['ADMIN']);
    expect(me.body['permissions']).toEqual(['role.read']);
    expect(me.body['requestId']).toBe('req-me');
  });

  it('★ role.read 가 있으면 /api/roles 200', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    supabase.signInWithPassword('admin@deeppoint.test', 'correct-horse');

    // 1차 가드 통과
    expect(await proxyGuard(supabase, localUserReader(), '/api/roles')).toBeNull();

    // 2차 가드 통과
    const roles = await getRoles(supabase, localUserReader());
    expect(roles.status).toBe(200);
    expect((roles.body['roles'] as unknown[]).length).toBe(5);
  });

  it('★ 로그인 요청 email 과 claims email 이 조작돼도 ActorContext 는 DB 값을 쓴다', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    supabase.signInWithPassword('admin@deeppoint.test', 'correct-horse');

    // 공격자가 쿠키의 email 부분만 바꾼 상황 (서명 형식은 유지)
    supabase.forgeCookie(`signed:${ADMIN_ID}:spoofed@evil.test`);

    const me = await getMe(supabase, localUserReader());

    expect(me.status).toBe(200);
    expect((me.body['user'] as Record<string, unknown>)['email']).toBe('admin@deeppoint.test');
    expect(JSON.stringify(me.body)).not.toContain('spoofed@evil.test');
  });

  it('★ ADMIN 이어도 RolePermission 데이터가 없으면 /api/roles 403', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    supabase.signInWithPassword('admin@deeppoint.test', 'correct-horse');

    // role_permission 행이 없는 ADMIN
    const strippedAdmin = new Map(LOCAL_USERS);
    strippedAdmin.set(ADMIN_ID, { ...LOCAL_USERS.get(ADMIN_ID)!, permissions: [] });
    const reader = localUserReader(strippedAdmin);

    // /api/me 는 통과 (역할 없음·권한 없음도 접근 가능)
    const me = await getMe(supabase, reader);
    expect(me.status).toBe(200);
    expect(me.body['roles']).toEqual(['ADMIN']);
    expect(me.body['permissions']).toEqual([]);

    // /api/roles 는 1차·2차 모두 막는다
    expect((await proxyGuard(supabase, reader, '/api/roles'))?.status).toBe(403);
    expect((await getRoles(supabase, reader)).status).toBe(403);
  });

  it('로그아웃하면 세션이 끊기고 다시 401 이 된다', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    supabase.signInWithPassword('admin@deeppoint.test', 'correct-horse');
    expect((await getMe(supabase, localUserReader())).status).toBe(200);

    supabase.signOut();
    expect(supabase.hasSessionCookie()).toBe(false);

    const me = await getMe(supabase, localUserReader());
    expect(me.status).toBe(401);
    expect(me.body['errorCode']).toBe(ERROR_CODES.UNAUTHORIZED);
  });
});

describe('★ 인증 성공 연쇄 — 권한 없는 일반 사용자', () => {
  it('/api/me 는 200, roles 는 있고 permissions 는 빈 배열', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    supabase.signInWithPassword('staff@deeppoint.test', 'staff-secret');

    const me = await getMe(supabase, localUserReader());

    expect(me.status).toBe(200);
    expect(me.body['roles']).toEqual(['SCM_STAFF']);
    expect(me.body['permissions']).toEqual([]);
  });

  it('★ /api/roles 는 Proxy 1차 가드에서 403', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    supabase.signInWithPassword('staff@deeppoint.test', 'staff-secret');

    const blocked = await proxyGuard(supabase, localUserReader(), '/api/roles');

    expect(blocked?.status).toBe(403);
    expect(blocked?.body['errorCode']).toBe(ERROR_CODES.FORBIDDEN);
    expect(blocked?.body['requestId']).toMatch(UUID_PATTERN);
  });

  it('★ Proxy 를 우회해 Application Service 를 직접 호출해도 403', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    supabase.signInWithPassword('staff@deeppoint.test', 'staff-secret');

    const actor = await resolveActor(
      { verifier: supabase.asClaimsVerifier(), reader: localUserReader() },
      { requestId: 'bypass' },
    );

    // Proxy 를 전혀 거치지 않은 직접 호출
    await expect(listRoles(actor, { reader: ROLE_READER })).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
      httpStatus: 403,
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 실패 경로
// ═══════════════════════════════════════════════════════════════
describe('★ 인증 실패 연쇄', () => {
  it('★ 로그인 실패 — 세션 쿠키가 설정되지 않는다', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);

    expect(supabase.signInWithPassword('admin@deeppoint.test', 'wrong-password')).toBeNull();
    expect(supabase.signInWithPassword('nobody@deeppoint.test', 'correct-horse')).toBeNull();
    expect(supabase.hasSessionCookie()).toBe(false);

    const me = await getMe(supabase, localUserReader());
    expect(me.status).toBe(401);
  });

  it('★ 세션 쿠키가 있어도 claims 검증에 실패하면 401', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    supabase.signInWithPassword('admin@deeppoint.test', 'correct-horse');

    // 쿠키는 있지만 서명 형식이 깨졌다 — getSession() 이었다면 통과했을 상황
    supabase.forgeCookie('forged-cookie-without-signature');
    expect(supabase.hasSessionCookie()).toBe(true);

    const me = await getMe(supabase, localUserReader());
    expect(me.status).toBe(401);
    expect(me.body['errorCode']).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it('★ claims 는 유효하지만 로컬 User 가 없으면 403', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    const signIn = supabase.signInWithPassword('ghost@deeppoint.test', 'ghost-secret');

    // Supabase 인증은 성공했다
    expect(signIn?.userId).toBe(GHOST_ID);
    expect(supabase.hasSessionCookie()).toBe(true);

    // 그러나 SCM 시스템에는 등록되지 않았다
    const me = await getMe(supabase, localUserReader());
    expect(me.status).toBe(403);
    expect(me.body['errorCode']).toBe(ERROR_CODES.FORBIDDEN);

    // ★ 자동 등록되지 않았다
    expect(await localUserReader().findByUserId(GHOST_ID)).toBeNull();
  });

  it('★ 로컬 User 가 비활성이면 403', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);
    supabase.signInWithPassword('inactive@deeppoint.test', 'inactive-secret');

    const me = await getMe(supabase, localUserReader());
    expect(me.status).toBe(403);
    expect(me.body['errorCode']).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ Proxy 도 같은 판정을 낸다 (401/403 구분 유지)', async () => {
    const cases: ReadonlyArray<[string, string | null, number]> = [
      ['세션 없음', null, 401],
      ['미등록 사용자', 'ghost@deeppoint.test', 403],
      ['비활성 사용자', 'inactive@deeppoint.test', 403],
    ];

    for (const [label, email, expected] of cases) {
      const supabase = new FakeSupabase(ACCOUNTS);
      if (email !== null) {
        const account = ACCOUNTS.find((candidate) => candidate.email === email)!;
        supabase.signInWithPassword(account.email, account.password);
      }

      const blocked = await proxyGuard(supabase, localUserReader(), '/api/me');
      expect(blocked?.status, label).toBe(expected);
    }
  });

  it('공개 경로는 세션 없이도 Proxy 를 통과한다', async () => {
    const supabase = new FakeSupabase(ACCOUNTS);

    for (const path of ['/api/health', '/api/auth/login', '/api/auth/logout', '/login']) {
      expect(await proxyGuard(supabase, localUserReader(), path), path).toBeNull();
    }
  });
});
