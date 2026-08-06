import { describe, expect, it } from 'vitest';

import { AppError, ERROR_CODES } from '@/shared/errors';

import {
  LIST_ROLES_PERMISSION,
  PUBLIC_PATHS,
  UnauthenticatedError,
  assertPermission,
  createActorContext,
  hasPermission,
  hasRole,
  isPublicPath,
  listRoles,
  normalizeCodes,
  requiredPermissionFor,
  resolveActor,
  type ActorContext,
} from './application';
import type {
  RoleReader,
  UserAuthorization,
  UserAuthorizationReader,
} from './infrastructure/user-repository';
import { verifyIdentity, type ClaimsVerifier } from './infrastructure/verify';

/**
 * 인증·권한 테스트 (T0-6).
 *
 * 실제 Supabase 없이 대역(`ClaimsVerifier`)으로 검증한다.
 * `resolveActor` 가 `getClaims()` 만 요구하도록 좁혀 놓았기 때문에 가능하다.
 */

// ── 대역 ────────────────────────────────────────────────────────

function verifierWithClaims(claims: Record<string, unknown>): ClaimsVerifier {
  return { getClaims: async () => ({ data: { claims }, error: null }) };
}

function verifierWithError(message = '토큰이 유효하지 않습니다.'): ClaimsVerifier {
  return { getClaims: async () => ({ data: null, error: { message } }) };
}

const NO_SESSION: ClaimsVerifier = {
  getClaims: async () => ({ data: null, error: null }),
};

function readerReturning(authorization: UserAuthorization | null): UserAuthorizationReader {
  return { findByUserId: async () => authorization };
}

const ACTIVE_ADMIN: UserAuthorization = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'admin@deeppoint.test',
  name: '관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: ['role.read'],
};

const ACTIVE_STAFF: UserAuthorization = {
  userId: '22222222-2222-4222-8222-222222222222',
  email: 'staff@deeppoint.test',
  name: '담당자',
  active: true,
  roles: ['SCM_STAFF'],
  permissions: [],
};

const VALID_CLAIMS = {
  sub: ACTIVE_ADMIN.userId,
  email: ACTIVE_ADMIN.email,
  session_id: 'sess-1',
};

async function actorFor(
  authorization: UserAuthorization,
  claims: Record<string, unknown> = VALID_CLAIMS,
): Promise<ActorContext> {
  return resolveActor(
    { verifier: verifierWithClaims(claims), reader: readerReturning(authorization) },
    { requestId: 'req-1' },
  );
}

// ═══════════════════════════════════════════════════════════════
// 인증 검증
// ═══════════════════════════════════════════════════════════════
describe('verifyIdentity — 인증 검증', () => {
  it('서명 검증된 클레임에서 사용자 정보를 얻는다', async () => {
    const identity = await verifyIdentity(verifierWithClaims(VALID_CLAIMS));
    expect(identity).toEqual({
      userId: ACTIVE_ADMIN.userId,
      email: ACTIVE_ADMIN.email,
      sessionId: 'sess-1',
    });
  });

  it('세션이 없으면 null', async () => {
    expect(await verifyIdentity(NO_SESSION)).toBeNull();
  });

  it('토큰이 무효하면 null', async () => {
    expect(await verifyIdentity(verifierWithError())).toBeNull();
  });

  it('sub·email 이 없으면 null', async () => {
    expect(await verifyIdentity(verifierWithClaims({ email: 'a@b.c' }))).toBeNull();
    expect(await verifyIdentity(verifierWithClaims({ sub: 'uuid' }))).toBeNull();
    expect(await verifyIdentity(verifierWithClaims({ sub: '', email: '' }))).toBeNull();
  });

  it('session_id 가 없으면 생략한다', async () => {
    const identity = await verifyIdentity(verifierWithClaims({ sub: 'u1', email: 'a@b.c' }));
    expect(identity?.sessionId).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 401 / 403 분기
// ═══════════════════════════════════════════════════════════════
describe('★ resolveActor — 401 / 403', () => {
  async function expectError(promise: Promise<unknown>): Promise<{ code: string; status: number }> {
    try {
      await promise;
      throw new Error('오류가 발생하지 않았습니다.');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      return { code: String(appError.code), status: appError.httpStatus };
    }
  }

  it('★ 세션 없음 → UNAUTHORIZED 401', async () => {
    const result = await expectError(
      resolveActor(
        { verifier: NO_SESSION, reader: readerReturning(ACTIVE_ADMIN) },
        { requestId: 'r' },
      ),
    );
    expect(result).toEqual({ code: ERROR_CODES.UNAUTHORIZED, status: 401 });
  });

  it('★ 잘못된 토큰 → UNAUTHORIZED 401', async () => {
    const result = await expectError(
      resolveActor(
        { verifier: verifierWithError(), reader: readerReturning(ACTIVE_ADMIN) },
        { requestId: 'r' },
      ),
    );
    expect(result).toEqual({ code: ERROR_CODES.UNAUTHORIZED, status: 401 });
  });

  it('★ 로컬 사용자 없음 → FORBIDDEN 403 (401 아님)', async () => {
    const result = await expectError(
      resolveActor(
        { verifier: verifierWithClaims(VALID_CLAIMS), reader: readerReturning(null) },
        { requestId: 'r' },
      ),
    );
    expect(result).toEqual({ code: ERROR_CODES.FORBIDDEN, status: 403 });
  });

  it('★ 비활성 사용자 → FORBIDDEN 403', async () => {
    const result = await expectError(
      resolveActor(
        {
          verifier: verifierWithClaims(VALID_CLAIMS),
          reader: readerReturning({ ...ACTIVE_ADMIN, active: false }),
        },
        { requestId: 'r' },
      ),
    );
    expect(result).toEqual({ code: ERROR_CODES.FORBIDDEN, status: 403 });
  });

  it('★ REAUTH_REQUIRED 를 쓰지 않는다', async () => {
    for (const verifier of [NO_SESSION, verifierWithError()]) {
      const result = await expectError(
        resolveActor({ verifier, reader: readerReturning(ACTIVE_ADMIN) }, { requestId: 'r' }),
      );
      expect(result.code).not.toBe(ERROR_CODES.REAUTH_REQUIRED);
    }
  });

  it('★ 403 사유는 로그 전용 context 에만 담긴다', async () => {
    try {
      await resolveActor(
        { verifier: verifierWithClaims(VALID_CLAIMS), reader: readerReturning(null) },
        { requestId: 'r' },
      );
      throw new Error('오류가 발생하지 않았습니다.');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.context?.['reason']).toBe('LOCAL_USER_NOT_FOUND');
      // 외부 공개 필드에는 내부 사유가 없다
      expect(JSON.stringify(appError.publicDetails ?? {})).not.toContain('LOCAL_USER_NOT_FOUND');
    }
  });

  it('UnauthenticatedError 는 401 이다', () => {
    const error = new UnauthenticatedError('세션 없음');
    expect(error.code).toBe(ERROR_CODES.UNAUTHORIZED);
    expect(error.httpStatus).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════
// ActorContext
// ═══════════════════════════════════════════════════════════════
describe('★ ActorContext', () => {
  it('활성 사용자의 컨텍스트를 만든다', async () => {
    const actor = await actorFor(ACTIVE_ADMIN);
    expect(actor.userId).toBe(ACTIVE_ADMIN.userId);
    expect(actor.email).toBe(ACTIVE_ADMIN.email);
    expect(actor.name).toBe('관리자');
    expect(actor.requestId).toBe('req-1');
    expect(actor.sessionId).toBe('sess-1');
  });

  it('역할이 없으면 roles·permissions 가 빈 배열이다', async () => {
    const actor = await actorFor({ ...ACTIVE_STAFF, roles: [], permissions: [] });
    expect(actor.roles).toEqual([]);
    expect(actor.permissions).toEqual([]);
  });

  it('★ 비활성 사용자로는 ActorContext 를 만들 수 없다', () => {
    expect(() =>
      createActorContext({
        userId: 'u',
        email: 'a@b.c',
        name: 'x',
        active: false,
        roles: [],
        permissions: [],
        requestId: 'r',
      }),
    ).toThrow(/비활성/);
  });

  it('★ 역할·권한 중복을 제거한다', () => {
    const actor = createActorContext({
      userId: 'u',
      email: 'a@b.c',
      name: 'x',
      active: true,
      roles: ['ADMIN', 'ADMIN', 'FINANCE'],
      permissions: ['role.read', 'role.read'],
      requestId: 'r',
    });
    expect(actor.roles).toEqual(['ADMIN', 'FINANCE']);
    expect(actor.permissions).toEqual(['role.read']);
  });

  it('★ 여러 역할에서 온 동일 permission 을 중복 제거한다', async () => {
    // ADMIN 과 SCM_LEADER 가 모두 role.read 를 가진 상황
    const actor = await actorFor({
      ...ACTIVE_ADMIN,
      roles: ['ADMIN', 'SCM_LEADER'],
      permissions: ['role.read', 'role.read'],
    });
    expect(actor.permissions).toEqual(['role.read']);
    expect(actor.roles).toEqual(['ADMIN', 'SCM_LEADER']);
  });

  it('★ roles·permissions 순서가 고정된다', () => {
    const first = normalizeCodes(['FINANCE', 'ADMIN', 'EXECUTIVE']);
    const second = normalizeCodes(['EXECUTIVE', 'ADMIN', 'FINANCE']);
    expect(first).toEqual(['ADMIN', 'EXECUTIVE', 'FINANCE']);
    expect(second).toEqual(first);
  });

  it('빈 문자열 코드를 걸러낸다', () => {
    expect(normalizeCodes(['ADMIN', '', '  '])).toEqual(['ADMIN']);
  });

  it('★ 요청 본문의 위조된 userId·roles·permissions 를 무시한다', async () => {
    // 공격자가 본문에 넣었을 법한 값들. resolveActor 는 이런 입력을 받지 않는다.
    const forged = {
      userId: '99999999-9999-4999-8999-999999999999',
      roles: ['ADMIN'],
      permissions: ['role.read', 'inventory.adjust.approve'],
    };

    const actor = await resolveActor(
      {
        verifier: verifierWithClaims(VALID_CLAIMS),
        reader: readerReturning(ACTIVE_STAFF),
      },
      // ★ requestId 와 ipAddress 만 받는다 — 위조 필드가 들어갈 자리가 없다
      { requestId: 'req-forge', ipAddress: '10.0.0.1' },
    );

    expect(actor.userId).toBe(ACTIVE_STAFF.userId);
    expect(actor.userId).not.toBe(forged.userId);
    expect(actor.roles).toEqual(['SCM_STAFF']);
    expect(actor.permissions).toEqual([]);
    expect(actor.ipAddress).toBe('10.0.0.1');
  });

  it('★ 클레임의 email 이 아니라 DB 의 email 을 쓴다', async () => {
    const actor = await actorFor(ACTIVE_STAFF, {
      sub: ACTIVE_STAFF.userId,
      email: 'spoofed@evil.test',
    });
    expect(actor.email).toBe(ACTIVE_STAFF.email);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2차 권한 가드
// ═══════════════════════════════════════════════════════════════
describe('★ 2차 권한 가드 — Application Service', () => {
  const roleReader: RoleReader = {
    listRoles: async () => [
      { roleCode: 'ADMIN', roleName: '시스템 관리자', permissions: ['role.read'] },
      { roleCode: 'SCM_STAFF', roleName: 'SCM 담당자', permissions: [] },
    ],
  };

  it('권한이 있으면 통과한다', async () => {
    const actor = await actorFor(ACTIVE_ADMIN);
    const roles = await listRoles(actor, { reader: roleReader });
    expect(roles).toHaveLength(2);
  });

  it('★ Proxy 를 우회해 직접 호출해도 권한이 없으면 403', async () => {
    // Proxy 를 전혀 거치지 않은 호출 — 서비스가 스스로 막아야 한다
    const actor = await actorFor(ACTIVE_STAFF);

    await expect(listRoles(actor, { reader: roleReader })).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
      httpStatus: 403,
    });
  });

  it('★ ADMIN 이어도 명시적 RolePermission 이 없으면 권한이 없다', async () => {
    // 역할 코드는 ADMIN 이지만 permissions 가 비어 있다
    const actor = await actorFor({ ...ACTIVE_ADMIN, permissions: [] });

    expect(hasRole(actor, 'ADMIN')).toBe(true);
    expect(hasPermission(actor, LIST_ROLES_PERMISSION)).toBe(false);
    await expect(listRoles(actor, { reader: roleReader })).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('assertPermission 은 필요한 권한을 로그 context 에만 담는다', async () => {
    const actor = await actorFor(ACTIVE_STAFF);
    try {
      assertPermission(actor, 'role.read');
      throw new Error('오류가 발생하지 않았습니다.');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.context?.['requiredPermission']).toBe('role.read');
      expect(appError.publicDetails).toBeUndefined();
      expect(appError.publicHint).toBeDefined();
    }
  });

  it('권한 판정에 역할 이름을 쓰지 않는다', async () => {
    // FINANCE 역할이 role.read 를 가지면 통과해야 한다 — 역할 이름은 무관
    const actor = await actorFor({
      ...ACTIVE_STAFF,
      roles: ['FINANCE'],
      permissions: ['role.read'],
    });
    await expect(listRoles(actor, { reader: roleReader })).resolves.toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 1차 권한 가드 — route policy
// ═══════════════════════════════════════════════════════════════
describe('★ 1차 권한 가드 — route policy', () => {
  it('로그인·헬스체크는 인증 예외다', () => {
    expect(isPublicPath('/api/health')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/logout')).toBe(true);
    expect(isPublicPath('/login')).toBe(true);
  });

  it('★ 표에 없는 경로는 기본이 보호다', () => {
    expect(isPublicPath('/api/me')).toBe(false);
    expect(isPublicPath('/api/roles')).toBe(false);
    expect(isPublicPath('/api/future-endpoint')).toBe(false);
    expect(isPublicPath('/admin')).toBe(false);
  });

  it('관리자 전용 경로에 필요한 권한이 명시된다', () => {
    expect(requiredPermissionFor('/api/roles')).toBe('role.read');
    expect(requiredPermissionFor('/api/me')).toBeUndefined();
  });

  it('공개 경로 목록에 보호 경로가 섞이지 않았다', () => {
    expect(PUBLIC_PATHS).not.toContain('/api/me');
    expect(PUBLIC_PATHS).not.toContain('/api/roles');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2겹 구조 자체
// ═══════════════════════════════════════════════════════════════
describe('★ 2겹 가드가 독립적이다', () => {
  const roleReader: RoleReader = { listRoles: async () => [] };

  it('★ 1차 가드가 통과시킨 뒤에도 2차가 다시 검사한다', async () => {
    const actor = await actorFor(ACTIVE_STAFF);

    // 1차 가드 판정: /api/roles 는 role.read 를 요구한다
    const required = requiredPermissionFor('/api/roles');
    expect(required).toBe(LIST_ROLES_PERMISSION);

    // 1차 가드를 통과했다고 가정하고 서비스를 직접 호출해도 막힌다
    await expect(listRoles(actor, { reader: roleReader })).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('두 가드가 같은 권한 키를 본다', () => {
    expect(requiredPermissionFor('/api/roles')).toBe(LIST_ROLES_PERMISSION);
  });
});
