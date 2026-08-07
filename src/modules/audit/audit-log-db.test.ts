import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { auditLogger } from '@/modules/audit/application/audit-logger';
import { createActorContext } from '@/modules/auth/application';
import { disconnectPrisma, getPrismaClient, withTransaction } from '@/shared/db';

import { seedRolesAndPermissions } from '../../../prisma/seed/roles';

/**
 * 감사로그·시스템 설정 DB 테스트 (T0-7).
 *
 * 실제 PostgreSQL 이 필요하다. `DATABASE_URL` 이 없으면 건너뛴다.
 * T0-9 의 Testcontainers 하네스가 생기면 조건부 skip 을 제거한다.
 */

const ACTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const ACTOR = createActorContext({
  userId: ACTOR_ID,
  email: 'audit@deeppoint.test',
  name: '감사 테스트',
  active: true,
  roles: ['ADMIN'],
  permissions: ['system_setting.update'],
  requestId: 'req-db-audit',
  sessionId: 'sess-db',
  ipAddress: '10.9.9.9',
});

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  // 감사로그는 지울 수 없으므로 트리거를 잠시 끄고 정리한다(테스트 격리 목적).
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id IN ($1, $2)`,
    ACTOR_ID,
    OTHER_ID,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.user.deleteMany({ where: { id: { in: [ACTOR_ID, OTHER_ID] } } });
}

beforeAll(async () => {
  await getPrismaClient().$queryRaw`SELECT 1`;
  await cleanup();
  const client = getPrismaClient();
  await seedRolesAndPermissions(client);
  await client.user.create({
    data: { id: ACTOR_ID, email: 'audit@deeppoint.test', name: '감사 테스트' },
  });
  await client.user.create({
    data: { id: OTHER_ID, email: 'other@deeppoint.test', name: '기타' },
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

describe('★ 감사로그 불변성 (실제 PostgreSQL)', () => {
  it('INSERT 는 성공한다', async () => {
    const created = await withTransaction(async (tx) =>
      auditLogger.write(tx, {
        actor: ACTOR,
        entityType: 'SystemSetting',
        entityId: '1',
        action: 'UPDATE',
        beforeValue: { postingFrozen: false },
        afterValue: { postingFrozen: true },
      }),
    );

    expect(created.id).toBeTruthy();
    expect(created.actorId).toBe(ACTOR_ID);
  });

  it('★ UPDATE 는 AUDIT_LOG_IMMUTABLE 로 실패한다', async () => {
    await expect(
      getPrismaClient().$executeRawUnsafe(
        `UPDATE audit_log SET action = 'HACKED' WHERE actor_id = $1`,
        ACTOR_ID,
      ),
    ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
  });

  it('★ DELETE 는 AUDIT_LOG_IMMUTABLE 로 실패한다', async () => {
    await expect(
      getPrismaClient().$executeRawUnsafe(`DELETE FROM audit_log WHERE actor_id = $1`, ACTOR_ID),
    ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
  });

  it('★ 대량 DELETE 도 실패한다', async () => {
    await expect(getPrismaClient().$executeRawUnsafe(`DELETE FROM audit_log`)).rejects.toThrow(
      /AUDIT_LOG_IMMUTABLE/,
    );
  });

  it('★ TRUNCATE 도 실패한다', async () => {
    await expect(getPrismaClient().$executeRawUnsafe(`TRUNCATE audit_log`)).rejects.toThrow(
      /AUDIT_LOG_IMMUTABLE/,
    );
  });

  it('★ Prisma 의 update·delete 도 막힌다', async () => {
    const client = getPrismaClient();
    const row = await client.auditLog.findFirstOrThrow({ where: { actorId: ACTOR_ID } });

    await expect(
      client.auditLog.update({ where: { id: row.id }, data: { action: 'X' } }),
    ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(client.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
      /AUDIT_LOG_IMMUTABLE/,
    );
  });

  it('★ 존재하지 않는 actor 는 FK 로 차단된다', async () => {
    await expect(
      getPrismaClient().auditLog.create({
        data: {
          entityType: 'X',
          entityId: '1',
          action: 'CREATE',
          actorId: '00000000-0000-4000-8000-000000000000',
        },
      }),
    ).rejects.toThrow();
  });

  it('★ 감사로그가 있는 User 는 삭제되지 않는다 (ON DELETE RESTRICT)', async () => {
    await expect(getPrismaClient().user.delete({ where: { id: ACTOR_ID } })).rejects.toThrow();
  });

  it('★ 두 인덱스가 존재한다', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'audit_log' ORDER BY indexname`,
    );
    const names = rows.map((row) => row.indexname);

    expect(names).toContain('audit_log_entity_type_entity_id_occurred_at_idx');
    expect(names).toContain('audit_log_actor_id_occurred_at_idx');
  });

  it('★ occurred_at 은 DB 기본값으로 채워진다', async () => {
    const row = await getPrismaClient().auditLog.findFirstOrThrow({ where: { actorId: ACTOR_ID } });
    expect(row.occurredAt).toBeInstanceOf(Date);
    expect(row.occurredAt.getTime()).toBeGreaterThan(0);
  });

  it('updated_at 컬럼이 없다', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'`,
    );
    expect(rows.map((row) => row.column_name)).not.toContain('updated_at');
  });
});

describe('★ 감사로그 트랜잭션 결합 (실제 PostgreSQL)', () => {
  it('★ 업무 변경이 실패하면 감사로그도 남지 않는다', async () => {
    const client = getPrismaClient();
    const before = await client.auditLog.count({ where: { entityType: 'RollbackProbe' } });

    await withTransaction(async (tx) => {
      await auditLogger.write(tx, {
        actor: ACTOR,
        entityType: 'RollbackProbe',
        entityId: 'x',
        action: 'CREATE',
      });
      throw new Error('업무 실패');
    }).catch(() => undefined);

    expect(await client.auditLog.count({ where: { entityType: 'RollbackProbe' } })).toBe(before);
  });

  it('★ 설정 변경과 감사로그가 같은 트랜잭션에서 커밋된다', async () => {
    const client = getPrismaClient();
    const setting = await client.systemSetting.findUniqueOrThrow({ where: { id: 1 } });

    const logCountBefore = await client.auditLog.count({ where: { entityType: 'SystemSetting' } });

    await withTransaction(async (tx) => {
      await tx.systemSetting.update({
        where: { id: 1 },
        data: { postingFrozen: !setting.postingFrozen, version: { increment: 1 } },
      });
      await auditLogger.write(tx, {
        actor: ACTOR,
        entityType: 'SystemSetting',
        entityId: '1',
        action: 'UPDATE',
      });
    });

    const after = await client.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
    expect(after.version).toBe(setting.version + 1);
    expect(await client.auditLog.count({ where: { entityType: 'SystemSetting' } })).toBe(
      logCountBefore + 1,
    );

    // 원복
    await client.systemSetting.update({
      where: { id: 1 },
      data: { postingFrozen: setting.postingFrozen, version: setting.version },
    });
  });
});

describe('★ 시스템 설정 singleton (실제 PostgreSQL)', () => {
  it('★ seed 재실행에도 1행만 유지된다', async () => {
    const client = getPrismaClient();

    await seedRolesAndPermissions(client);
    await seedRolesAndPermissions(client);

    expect(await client.systemSetting.count()).toBe(1);
    const row = await client.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.id).toBe(1);
  });

  it('★ 설정 권한 2종이 ADMIN 에만 부여된다', async () => {
    const grants = await getPrismaClient().rolePermission.findMany({
      where: {
        permission: { permissionKey: { in: ['system_setting.read', 'system_setting.update'] } },
      },
      select: { role: { select: { roleCode: true } } },
    });

    expect(grants).toHaveLength(2);
    expect(new Set(grants.map((grant) => grant.role.roleCode))).toEqual(new Set(['ADMIN']));
  });

  it('일반 allow_self_approval 컬럼이 없다', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'system_setting'`,
    );
    const names = rows.map((row) => row.column_name);

    expect(names).toContain('allow_self_approval_sku');
    expect(names).toContain('allow_self_approval_bom');
    expect(names).not.toContain('allow_self_approval');
  });
});
