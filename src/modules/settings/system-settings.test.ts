import { describe, expect, it } from 'vitest';

import type { AuditLogger, AuditWriteInput } from '@/modules/audit/application/audit-logger';
import {
  createActorContext,
  resolveRoutePermission,
  type ActorContext,
} from '@/modules/auth/application';
import type { TransactionClient } from '@/shared/db';
import { ERROR_CODES, ValidationError, type AppError } from '@/shared/errors';

import {
  SETTING_READ_PERMISSION,
  SETTING_UPDATE_PERMISSION,
  SYSTEM_SETTING_ID,
  UPDATABLE_FIELDS,
  getSystemSettings,
  parseSettingPatch,
  updateSystemSettings,
  type SystemSettingReader,
  type SystemSettingView,
} from './application';

/**
 * 시스템 설정 테스트 (T0-7).
 *
 * DB 없이 대역으로 검증한다. 실제 DB 제약·트리거는 `system-settings-db.test.ts`.
 */

function actorWith(
  permissions: readonly string[],
  roles: readonly string[] = ['ADMIN'],
): ActorContext {
  return createActorContext({
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'admin@deeppoint.test',
    name: '관리자',
    active: true,
    roles,
    permissions,
    requestId: 'req-setting',
    sessionId: 'sess-1',
    ipAddress: '10.0.0.9',
  });
}

const ADMIN = actorWith([SETTING_READ_PERMISSION, SETTING_UPDATE_PERMISSION]);
const READER_ONLY = actorWith([SETTING_READ_PERMISSION]);
const NO_PERMISSION = actorWith([]);

const INITIAL: SystemSettingView = {
  allowSelfApprovalSku: false,
  allowSelfApprovalBom: false,
  cutoverDate: null,
  postingFrozen: false,
  version: 1,
};

const settingReader: SystemSettingReader = { read: async () => INITIAL };

// ── 트랜잭션 대역 ───────────────────────────────────────────────

interface FakeRow {
  id: number;
  allowSelfApprovalSku: boolean;
  allowSelfApprovalBom: boolean;
  cutoverDate: Date | null;
  postingFrozen: boolean;
  version: number;
  updatedBy: string | null;
}

interface FakeTxOptions {
  /** update 직후 감사로그를 실패시킨다 */
  readonly failAudit?: boolean;
  /** update 자체를 실패시킨다 */
  readonly failUpdate?: boolean;
}

function createFakeTransaction(initial: Partial<FakeRow> = {}, options: FakeTxOptions = {}) {
  const committed: FakeRow = {
    id: SYSTEM_SETTING_ID,
    allowSelfApprovalSku: false,
    allowSelfApprovalBom: false,
    cutoverDate: null,
    postingFrozen: false,
    version: 1,
    updatedBy: null,
    ...initial,
  };

  const auditWrites: AuditWriteInput[] = [];
  let staged: FakeRow = { ...committed };
  let commits = 0;
  let rollbacks = 0;

  const tx = {
    systemSetting: {
      findUniqueOrThrow: async () => ({ ...staged }),
      // ★ 실제 구현과 같은 의미론: WHERE 에 version 이 맞아야만 1건이 바뀐다.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: number; version: number };
        data: Record<string, unknown>;
      }) => {
        if (options.failUpdate === true) throw new Error('update 실패');
        if (staged.id !== where.id || staged.version !== where.version) {
          return { count: 0 };
        }

        const next: FakeRow = { ...staged };
        for (const [key, value] of Object.entries(data)) {
          if (key === 'version') {
            next.version += 1;
          } else {
            (next as unknown as Record<string, unknown>)[key] = value;
          }
        }
        staged = next;
        return { count: 1 };
      },
    },
  } as unknown as TransactionClient;

  const logger: AuditLogger = {
    write: async (_tx, input) => {
      if (options.failAudit === true) throw new Error('감사로그 실패');
      auditWrites.push(input);
      return {
        id: 'audit-1',
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorId: input.actor.userId,
      };
    },
  };

  async function runInTransaction<T>(
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await callback(tx);
      Object.assign(committed, staged);
      commits += 1;
      return result;
    } catch (error) {
      // 롤백 — staged 를 버린다
      staged = { ...committed };
      auditWrites.length = 0;
      rollbacks += 1;
      throw error;
    }
  }

  return {
    runInTransaction,
    logger,
    auditWrites,
    committed,
    stats: () => ({ commits, rollbacks }),
  };
}

// ═══════════════════════════════════════════════════════════════
// 조회
// ═══════════════════════════════════════════════════════════════
describe('getSystemSettings', () => {
  it('설정을 반환한다', async () => {
    expect(await getSystemSettings(ADMIN, { reader: settingReader })).toEqual(INITIAL);
  });

  it('★ 초기값 — 두 자기승인 false, cutoverDate null, postingFrozen false', async () => {
    const settings = await getSystemSettings(ADMIN, { reader: settingReader });
    expect(settings.allowSelfApprovalSku).toBe(false);
    expect(settings.allowSelfApprovalBom).toBe(false);
    expect(settings.cutoverDate).toBeNull();
    expect(settings.postingFrozen).toBe(false);
    expect(settings.version).toBe(1);
  });

  it('★ 권한이 없으면 403 (ADMIN 역할이어도)', async () => {
    await expect(getSystemSettings(NO_PERMISSION, { reader: settingReader })).rejects.toMatchObject(
      { code: ERROR_CODES.FORBIDDEN, httpStatus: 403 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 요청 검증
// ═══════════════════════════════════════════════════════════════
describe('parseSettingPatch — 요청 검증', () => {
  it('부분 수정을 허용한다', () => {
    expect(parseSettingPatch({ allowSelfApprovalSku: true, version: 1 })).toEqual({
      patch: { allowSelfApprovalSku: true },
      version: 1,
    });
  });

  it('★ 빈 PATCH 를 거부한다', () => {
    expect(() => parseSettingPatch({ version: 1 })).toThrow(ValidationError);
    try {
      parseSettingPatch({ version: 1 });
    } catch (error) {
      expect((error as AppError).code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('★ version 이 없으면 거부한다', () => {
    expect(() => parseSettingPatch({ allowSelfApprovalSku: true })).toThrow(ValidationError);
    expect(() => parseSettingPatch({ allowSelfApprovalSku: true, version: '1' })).toThrow(
      ValidationError,
    );
  });

  it('★ 알 수 없는 필드를 거부한다', () => {
    expect(() => parseSettingPatch({ allowSelfApproval: true, version: 1 })).toThrow(
      ValidationError,
    );
    expect(() => parseSettingPatch({ postingFrozen: true, evil: 1, version: 1 })).toThrow(
      ValidationError,
    );
  });

  it('★ 잘못된 타입을 거부한다', () => {
    for (const body of [
      { allowSelfApprovalSku: 'true', version: 1 },
      { allowSelfApprovalBom: 1, version: 1 },
      { postingFrozen: 'yes', version: 1 },
      { cutoverDate: '2026/01/01', version: 1 },
      { cutoverDate: 20260101, version: 1 },
      { cutoverDate: '2026-13-01', version: 1 },
    ]) {
      expect(() => parseSettingPatch(body), JSON.stringify(body)).toThrow(ValidationError);
    }
  });

  it('cutoverDate 는 YYYY-MM-DD 또는 null 이다', () => {
    expect(parseSettingPatch({ cutoverDate: '2026-04-01', version: 3 }).patch).toEqual({
      cutoverDate: '2026-04-01',
    });
    expect(parseSettingPatch({ cutoverDate: null, version: 3 }).patch).toEqual({
      cutoverDate: null,
    });
  });

  it('객체가 아니면 거부한다', () => {
    for (const body of [null, [], 'x', 1]) {
      expect(() => parseSettingPatch(body)).toThrow(ValidationError);
    }
  });

  it('변경 가능한 필드는 네 개다', () => {
    expect([...UPDATABLE_FIELDS]).toEqual([
      'allowSelfApprovalSku',
      'allowSelfApprovalBom',
      'cutoverDate',
      'postingFrozen',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 변경
// ═══════════════════════════════════════════════════════════════
describe('updateSystemSettings', () => {
  it('★ 권한이 없으면 403 (Proxy 우회 직접 호출)', async () => {
    const fake = createFakeTransaction();
    await expect(
      updateSystemSettings(READER_ONLY, { postingFrozen: true }, 1, {
        runInTransaction: fake.runInTransaction,
        auditLogger: fake.logger,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN, httpStatus: 403 });

    // 권한 검사가 트랜잭션보다 먼저다
    expect(fake.stats().commits).toBe(0);
  });

  it('값을 변경하고 version 을 증가시킨다', async () => {
    const fake = createFakeTransaction();
    const result = await updateSystemSettings(ADMIN, { allowSelfApprovalSku: true }, 1, {
      runInTransaction: fake.runInTransaction,
      auditLogger: fake.logger,
    });

    expect(result.allowSelfApprovalSku).toBe(true);
    expect(result.version).toBe(2);
  });

  it('★ version 이 다르면 409 CONFLICT', async () => {
    const fake = createFakeTransaction({ version: 5 });

    try {
      await updateSystemSettings(ADMIN, { postingFrozen: true }, 3, {
        runInTransaction: fake.runInTransaction,
        auditLogger: fake.logger,
      });
      throw new Error('오류가 발생하지 않았습니다.');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe(ERROR_CODES.CONFLICT);
      expect(appError.httpStatus).toBe(409);
      expect(appError.publicDetails?.['currentVersion']).toBe(5);
    }

    expect(fake.stats().rollbacks).toBe(1);
    expect(fake.committed.postingFrozen).toBe(false);
  });

  it('★ updatedBy 가 ActorContext 와 일치한다 (요청 본문 아님)', async () => {
    const fake = createFakeTransaction();
    await updateSystemSettings(ADMIN, { postingFrozen: true }, 1, {
      runInTransaction: fake.runInTransaction,
      auditLogger: fake.logger,
    });

    expect(fake.committed.updatedBy).toBe(ADMIN.userId);
  });

  it('★ 설정 변경과 감사로그가 같은 트랜잭션에서 처리된다', async () => {
    const fake = createFakeTransaction();
    await updateSystemSettings(ADMIN, { allowSelfApprovalBom: true }, 1, {
      runInTransaction: fake.runInTransaction,
      auditLogger: fake.logger,
    });

    expect(fake.stats().commits).toBe(1);
    expect(fake.auditWrites).toHaveLength(1);

    const [write] = fake.auditWrites;
    expect(write?.entityType).toBe('SystemSetting');
    expect(write?.entityId).toBe('1');
    expect(write?.action).toBe('UPDATE');
    expect((write?.beforeValue as SystemSettingView).allowSelfApprovalBom).toBe(false);
    expect((write?.afterValue as SystemSettingView).allowSelfApprovalBom).toBe(true);
  });

  it('★ 감사로그가 실패하면 설정 변경도 롤백된다', async () => {
    const fake = createFakeTransaction({}, { failAudit: true });

    await expect(
      updateSystemSettings(ADMIN, { postingFrozen: true }, 1, {
        runInTransaction: fake.runInTransaction,
        auditLogger: fake.logger,
      }),
    ).rejects.toThrow(/감사로그 실패/);

    expect(fake.stats().rollbacks).toBe(1);
    expect(fake.stats().commits).toBe(0);
    expect(fake.committed.postingFrozen).toBe(false);
    expect(fake.committed.version).toBe(1);
  });

  it('★ 설정 변경이 실패하면 감사로그도 남지 않는다', async () => {
    const fake = createFakeTransaction({}, { failUpdate: true });

    await expect(
      updateSystemSettings(ADMIN, { postingFrozen: true }, 1, {
        runInTransaction: fake.runInTransaction,
        auditLogger: fake.logger,
      }),
    ).rejects.toThrow(/update 실패/);

    expect(fake.auditWrites).toHaveLength(0);
    expect(fake.stats().commits).toBe(0);
  });

  it('★ 변경 없는 동일 값 요청도 version 을 올리고 감사로그를 남긴다', async () => {
    // 정책: 조용히 무시하지 않는다. "누가 언제 이 값을 확정했는가"가 기록으로 필요하고,
    // 무시하면 version 이 어긋난 클라이언트가 성공했다고 오해한다.
    const fake = createFakeTransaction({ postingFrozen: false });

    const result = await updateSystemSettings(ADMIN, { postingFrozen: false }, 1, {
      runInTransaction: fake.runInTransaction,
      auditLogger: fake.logger,
    });

    expect(result.postingFrozen).toBe(false);
    expect(result.version).toBe(2);
    expect(fake.auditWrites).toHaveLength(1);
  });

  it('여러 필드를 한 번에 변경할 수 있다', async () => {
    const fake = createFakeTransaction();
    const result = await updateSystemSettings(
      ADMIN,
      { allowSelfApprovalSku: true, allowSelfApprovalBom: true, cutoverDate: '2026-04-01' },
      1,
      { runInTransaction: fake.runInTransaction, auditLogger: fake.logger },
    );

    expect(result.allowSelfApprovalSku).toBe(true);
    expect(result.allowSelfApprovalBom).toBe(true);
    expect(result.cutoverDate).toBe('2026-04-01');
    expect(result.version).toBe(2);
  });
});

describe('★ 2겹 가드 — 설정 API', () => {
  it('1차 가드는 read 권한, 2차 가드는 update 권한을 본다', async () => {
    const { resolveRoutePermission } = await import('@/modules/auth/application');

    // ★ 메서드별로 다른 권한을 요구한다
    expect(resolveRoutePermission({ pathname: '/api/system-settings', method: 'GET' })).toBe(
      SETTING_READ_PERMISSION,
    );
    expect(resolveRoutePermission({ pathname: '/api/system-settings', method: 'PATCH' })).toBe(
      SETTING_UPDATE_PERMISSION,
    );

    // read 만 가진 사용자는 1차를 통과하지만 2차에서 막힌다
    const fake = createFakeTransaction();
    expect(READER_ONLY.permissions).toContain(SETTING_READ_PERMISSION);
    await expect(
      updateSystemSettings(READER_ONLY, { postingFrozen: true }, 1, {
        runInTransaction: fake.runInTransaction,
        auditLogger: fake.logger,
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('감사로그 호출에 SystemSetting 엔티티가 전달된다', async () => {
    const seen: string[] = [];
    const fake = createFakeTransaction();
    await updateSystemSettings(ADMIN, { postingFrozen: true }, 1, {
      runInTransaction: fake.runInTransaction,
      auditLogger: {
        write: async (_tx, input) => {
          seen.push(input.entityType);
          return {
            id: 'a',
            entityType: input.entityType,
            entityId: input.entityId,
            action: input.action,
            actorId: input.actor.userId,
          };
        },
      },
    });
    expect(seen).toEqual(['SystemSetting']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 메서드별 1차 권한 가드 (T0-7 마감 보완)
// ═══════════════════════════════════════════════════════════════
describe('★ 메서드별 1차 권한 가드', () => {
  /** 1차 가드 판정. 통과하면 undefined, 차단하면 요구 권한. */
  function firstGuard(actor: ActorContext, pathname: string, method: string): string | undefined {
    const required = resolveRoutePermission({ pathname, method });
    if (required === undefined) return undefined;
    return actor.permissions.includes(required) ? undefined : required;
  }

  const PATH = '/api/system-settings';

  it('★ GET 은 read, PATCH 는 update 권한을 요구한다', () => {
    expect(resolveRoutePermission({ pathname: PATH, method: 'GET' })).toBe(SETTING_READ_PERMISSION);
    expect(resolveRoutePermission({ pathname: PATH, method: 'HEAD' })).toBe(
      SETTING_READ_PERMISSION,
    );
    expect(resolveRoutePermission({ pathname: PATH, method: 'PATCH' })).toBe(
      SETTING_UPDATE_PERMISSION,
    );
  });

  it('★ read 만 보유 — GET 통과, PATCH 는 1차에서 차단', () => {
    expect(firstGuard(READER_ONLY, PATH, 'GET')).toBeUndefined();
    expect(firstGuard(READER_ONLY, PATH, 'PATCH')).toBe(SETTING_UPDATE_PERMISSION);
  });

  it('★ read 만 보유 — PATCH 는 Application Service 도 호출되지 않는다', async () => {
    // 1차에서 막히므로 서비스까지 가지 않는다. 만약 갔더라도 2차가 막는다.
    expect(firstGuard(READER_ONLY, PATH, 'PATCH')).toBeDefined();

    let serviceCalled = 0;
    const fake = createFakeTransaction();
    await updateSystemSettings(READER_ONLY, { postingFrozen: true }, 1, {
      runInTransaction: async (callback) => {
        serviceCalled += 1;
        return fake.runInTransaction(callback);
      },
      auditLogger: fake.logger,
    }).catch(() => undefined);

    // 2차 가드가 트랜잭션보다 먼저 던진다
    expect(serviceCalled).toBe(0);
  });

  it('★ update 만 보유 — PATCH 통과, GET 은 1차에서 차단', () => {
    const updateOnly = actorWith([SETTING_UPDATE_PERMISSION]);
    expect(firstGuard(updateOnly, PATH, 'PATCH')).toBeUndefined();
    expect(firstGuard(updateOnly, PATH, 'GET')).toBe(SETTING_READ_PERMISSION);
  });

  it('★ 두 권한 보유 — GET·PATCH 모두 통과', () => {
    expect(firstGuard(ADMIN, PATH, 'GET')).toBeUndefined();
    expect(firstGuard(ADMIN, PATH, 'PATCH')).toBeUndefined();
  });

  it('★ 권한 없음 — GET·PATCH 모두 차단', () => {
    expect(firstGuard(NO_PERMISSION, PATH, 'GET')).toBe(SETTING_READ_PERMISSION);
    expect(firstGuard(NO_PERMISSION, PATH, 'PATCH')).toBe(SETTING_UPDATE_PERMISSION);
  });

  it('★ Proxy 를 우회한 PATCH 직접 호출도 update 권한이 없으면 403', async () => {
    const fake = createFakeTransaction();
    await expect(
      updateSystemSettings(READER_ONLY, { postingFrozen: true }, 1, {
        runInTransaction: fake.runInTransaction,
        auditLogger: fake.logger,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN, httpStatus: 403 });
  });

  it('메서드는 대소문자를 가리지 않는다', () => {
    expect(resolveRoutePermission({ pathname: PATH, method: 'patch' })).toBe(
      SETTING_UPDATE_PERMISSION,
    );
  });

  it('/api/roles 는 GET 만 정책이 있다', () => {
    expect(resolveRoutePermission({ pathname: '/api/roles', method: 'GET' })).toBe('role.read');
    // 정의되지 않은 메서드는 인증만 요구한다 (라우트 자체가 없으므로 404 가 된다)
    expect(resolveRoutePermission({ pathname: '/api/roles', method: 'DELETE' })).toBeUndefined();
  });

  it('정책이 없는 경로는 인증만 요구한다', () => {
    expect(resolveRoutePermission({ pathname: '/api/me', method: 'GET' })).toBeUndefined();
  });
});
