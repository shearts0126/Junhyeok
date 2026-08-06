import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES, type AppError } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../../prisma/seed/roles';

import {
  SETTING_READ_PERMISSION,
  SETTING_UPDATE_PERMISSION,
  SYSTEM_SETTING_ID,
  getSystemSettings,
  updateSystemSettings,
} from './application';

/**
 * 시스템 설정 DB 테스트 (T0-7 마감 보완).
 *
 * **동시성 제어를 실제 PostgreSQL 에서 검증한다.** 대역으로는
 * `READ COMMITTED` 에서 두 요청이 같은 version 을 읽는 상황을 재현할 수 없다.
 */

let available = false;

const ACTOR_A_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ACTOR_B_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function actorFor(userId: string, requestId: string): ActorContext {
  return createActorContext({
    userId,
    email: `${requestId}@deeppoint.test`,
    name: requestId,
    active: true,
    roles: ['ADMIN'],
    permissions: [SETTING_READ_PERMISSION, SETTING_UPDATE_PERMISSION],
    requestId,
  });
}

const ACTOR_A = actorFor(ACTOR_A_ID, 'req-a');
const ACTOR_B = actorFor(ACTOR_B_ID, 'req-b');

async function cleanupAuditLogs(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id IN ($1, $2)`,
    ACTOR_A_ID,
    ACTOR_B_ID,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
}

/** 설정을 알려진 상태로 되돌린다. */
async function resetSetting(): Promise<number> {
  const client = getPrismaClient();
  const row = await client.systemSetting.update({
    where: { id: SYSTEM_SETTING_ID },
    data: {
      allowSelfApprovalSku: false,
      allowSelfApprovalBom: false,
      cutoverDate: null,
      postingFrozen: false,
      updatedBy: null,
      version: { increment: 1 },
    },
  });
  return row.version;
}

beforeAll(async () => {
  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    available = true;
    const client = getPrismaClient();
    await seedRolesAndPermissions(client);
    await cleanupAuditLogs();
    await client.user.deleteMany({ where: { id: { in: [ACTOR_A_ID, ACTOR_B_ID] } } });
    await client.user.create({
      data: { id: ACTOR_A_ID, email: 'req-a@deeppoint.test', name: 'A' },
    });
    await client.user.create({
      data: { id: ACTOR_B_ID, email: 'req-b@deeppoint.test', name: 'B' },
    });
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (available) {
    await cleanupAuditLogs();
    await getPrismaClient()
      .user.deleteMany({ where: { id: { in: [ACTOR_A_ID, ACTOR_B_ID] } } })
      .catch(() => undefined);
  }
  await disconnectPrisma().catch(() => undefined);
});

const describeDb = describe.skipIf(!process.env['DATABASE_URL']);

// ═══════════════════════════════════════════════════════════════
// 동시성
// ═══════════════════════════════════════════════════════════════
describeDb('★ SystemSetting 동시성 (실제 PostgreSQL)', () => {
  it('★ 같은 version 으로 동시 PATCH — 1건만 200, 1건은 409', async () => {
    if (!available) return;
    const client = getPrismaClient();
    const version = await resetSetting();
    await cleanupAuditLogs();
    const auditBefore = await client.auditLog.count({ where: { entityType: 'SystemSetting' } });

    // ★ barrier — 두 요청이 같은 version 을 들고 동시에 출발한다.
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const requestA = barrier.then(() =>
      updateSystemSettings(ACTOR_A, { allowSelfApprovalSku: true }, version),
    );
    const requestB = barrier.then(() =>
      updateSystemSettings(ACTOR_B, { allowSelfApprovalBom: true }, version),
    );

    release();
    const results = await Promise.allSettled([requestA, requestB]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // 실패한 쪽은 409 CONFLICT
    const error = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(error.code).toBe(ERROR_CODES.CONFLICT);
    expect(error.httpStatus).toBe(409);

    // ★ version 은 정확히 1만 증가한다
    const after = await client.systemSetting.findUniqueOrThrow({
      where: { id: SYSTEM_SETTING_ID },
    });
    expect(after.version).toBe(version + 1);

    // ★ 이긴 요청의 값만 저장된다 — 두 요청은 서로 다른 필드를 바꾸려 했다
    const winnerChangedSku = after.allowSelfApprovalSku;
    const winnerChangedBom = after.allowSelfApprovalBom;
    expect(winnerChangedSku !== winnerChangedBom).toBe(true);

    // 충돌 응답의 currentVersion 은 충돌 시점의 최신 version 이다
    expect(error.publicDetails?.['currentVersion']).toBe(version + 1);

    // ★ 감사로그는 정확히 1건 — 실패한 요청의 로그는 없다
    const auditAfter = await client.auditLog.count({ where: { entityType: 'SystemSetting' } });
    expect(auditAfter).toBe(auditBefore + 1);

    // 이긴 쪽의 actor 로만 로그가 남았다
    const logs = await client.auditLog.findMany({
      where: { entityType: 'SystemSetting', actorId: { in: [ACTOR_A_ID, ACTOR_B_ID] } },
      select: { actorId: true },
    });
    expect(logs).toHaveLength(1);
    expect(after.updatedBy).toBe(logs[0]?.actorId);
  });

  it('★ 같은 필드를 동시에 바꿔도 한 요청만 성공한다', async () => {
    if (!available) return;
    const client = getPrismaClient();
    const version = await resetSetting();
    await cleanupAuditLogs();

    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const results = await (async () => {
      const a = barrier.then(() => updateSystemSettings(ACTOR_A, { postingFrozen: true }, version));
      const b = barrier.then(() => updateSystemSettings(ACTOR_B, { postingFrozen: true }, version));
      release();
      return Promise.allSettled([a, b]);
    })();

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const after = await client.systemSetting.findUniqueOrThrow({
      where: { id: SYSTEM_SETTING_ID },
    });
    expect(after.version).toBe(version + 1);
    expect(after.postingFrozen).toBe(true);
  });

  it('★ 순차 요청은 최신 version 을 쓰면 모두 성공한다', async () => {
    if (!available) return;
    const client = getPrismaClient();
    let version = await resetSetting();
    await cleanupAuditLogs();
    const auditBefore = await client.auditLog.count({ where: { entityType: 'SystemSetting' } });

    for (let i = 0; i < 3; i += 1) {
      const result = await updateSystemSettings(ACTOR_A, { postingFrozen: i % 2 === 0 }, version);
      expect(result.version).toBe(version + 1);
      version = result.version;
    }

    const after = await client.systemSetting.findUniqueOrThrow({
      where: { id: SYSTEM_SETTING_ID },
    });
    expect(after.version).toBe(version);
    expect(await client.auditLog.count({ where: { entityType: 'SystemSetting' } })).toBe(
      auditBefore + 3,
    );
  });

  it('★ 오래된 version 은 409 이고 아무것도 바뀌지 않는다', async () => {
    if (!available) return;
    const client = getPrismaClient();
    const version = await resetSetting();
    await cleanupAuditLogs();
    const auditBefore = await client.auditLog.count({ where: { entityType: 'SystemSetting' } });

    await expect(
      updateSystemSettings(ACTOR_A, { postingFrozen: true }, version - 1),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT, httpStatus: 409 });

    const after = await client.systemSetting.findUniqueOrThrow({
      where: { id: SYSTEM_SETTING_ID },
    });
    expect(after.version).toBe(version);
    expect(after.postingFrozen).toBe(false);
    expect(await client.auditLog.count({ where: { entityType: 'SystemSetting' } })).toBe(
      auditBefore,
    );
  });

  it('성공 경로가 실제 DB 에서 동작한다', async () => {
    if (!available) return;
    const version = await resetSetting();

    const result = await updateSystemSettings(
      ACTOR_A,
      { allowSelfApprovalSku: true, cutoverDate: '2026-04-01' },
      version,
    );

    expect(result.allowSelfApprovalSku).toBe(true);
    expect(result.cutoverDate).toBe('2026-04-01');
    expect(result.version).toBe(version + 1);

    expect(await getSystemSettings(ACTOR_A)).toEqual(result);
  });
});

// ═══════════════════════════════════════════════════════════════
// singleton·CHECK 제약
// ═══════════════════════════════════════════════════════════════
describeDb('★ SystemSetting DB 제약 (실제 PostgreSQL)', () => {
  it('id = 1 행이 존재한다', async () => {
    if (!available) return;
    const row = await getPrismaClient().systemSetting.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.id).toBe(1);
  });

  it('★ id = 2 INSERT 는 실패한다', async () => {
    if (!available) return;
    await expect(
      getPrismaClient().$executeRawUnsafe(
        `INSERT INTO system_setting(id, updated_at) VALUES (2, now())`,
      ),
    ).rejects.toThrow(/system_setting_singleton_check/);
  });

  it('★ id = 0 INSERT 도 실패한다', async () => {
    if (!available) return;
    await expect(
      getPrismaClient().$executeRawUnsafe(
        `INSERT INTO system_setting(id, updated_at) VALUES (0, now())`,
      ),
    ).rejects.toThrow(/system_setting_singleton_check/);
  });

  it('★ Prisma 로도 두 번째 행을 만들 수 없다', async () => {
    if (!available) return;
    await expect(getPrismaClient().systemSetting.create({ data: { id: 2 } })).rejects.toThrow();
  });

  it('★ version = 0 INSERT·UPDATE 는 실패한다', async () => {
    if (!available) return;
    const client = getPrismaClient();

    await expect(
      client.$executeRawUnsafe(`UPDATE system_setting SET version = 0 WHERE id = 1`),
    ).rejects.toThrow(/system_setting_version_positive_check/);

    await expect(
      client.$executeRawUnsafe(`UPDATE system_setting SET version = -1 WHERE id = 1`),
    ).rejects.toThrow(/system_setting_version_positive_check/);
  });

  it('★ seed 를 재실행해도 전체 행 수는 1이다', async () => {
    if (!available) return;
    const client = getPrismaClient();

    await seedRolesAndPermissions(client);
    await seedRolesAndPermissions(client);

    expect(await client.systemSetting.count()).toBe(1);
  });

  it('★ 감사로그 entity_id 는 빈 문자열일 수 없다', async () => {
    if (!available) return;
    const client = getPrismaClient();

    for (const value of ['', '   ']) {
      await expect(
        client.auditLog.create({
          data: { entityType: 'T', entityId: value, action: 'X', actorId: ACTOR_A_ID },
        }),
      ).rejects.toThrow(/audit_log_entity_id_not_blank_check/);
    }
  });

  it('★ 감사로그 entity_type 도 빈 문자열일 수 없다', async () => {
    if (!available) return;
    await expect(
      getPrismaClient().auditLog.create({
        data: { entityType: '  ', entityId: '1', action: 'X', actorId: ACTOR_A_ID },
      }),
    ).rejects.toThrow(/audit_log_entity_type_not_blank_check/);
  });

  it('SystemSetting 의 entity_id 는 "1" 로 저장된다', async () => {
    if (!available) return;
    const client = getPrismaClient();
    const version = await resetSetting();
    await cleanupAuditLogs();

    await updateSystemSettings(ACTOR_A, { postingFrozen: true }, version);

    const log = await client.auditLog.findFirstOrThrow({
      where: { entityType: 'SystemSetting', actorId: ACTOR_A_ID },
      orderBy: { occurredAt: 'desc' },
    });
    expect(log.entityId).toBe('1');
  });
});
