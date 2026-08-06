import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../../prisma/seed/roles';

/**
 * 인증 모델 DB 테스트 (T0-6).
 *
 * 실제 PostgreSQL 이 필요하다. `DATABASE_URL` 이 없거나 연결에 실패하면
 * **건너뛴다** — 이 파일 때문에 DB 없는 환경에서 `pnpm test` 가 깨지면 안 된다.
 *
 * T0-9 의 Testcontainers 하네스가 생기면 이 조건부 skip 을 제거한다.
 */

let available = false;

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.userRole.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
  await client.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
}

beforeAll(async () => {
  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    available = true;
    await cleanup();
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (available) await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

/** DB 가 없으면 통째로 건너뛴다. */
const describeDb = describe.skipIf(!process.env['DATABASE_URL']);

describeDb('★ 인증 모델 제약 (실제 PostgreSQL)', () => {
  it('중복 email 을 차단한다', async () => {
    if (!available) return;
    const client = getPrismaClient();

    await client.user.create({
      data: { id: USER_A, email: 'dup@deeppoint.test', name: 'A' },
    });

    await expect(
      client.user.create({ data: { id: USER_B, email: 'dup@deeppoint.test', name: 'B' } }),
    ).rejects.toThrow();
  });

  it('중복 roleCode 를 차단한다', async () => {
    if (!available) return;
    const client = getPrismaClient();
    await expect(
      client.role.create({ data: { roleCode: 'ADMIN', roleName: '중복' } }),
    ).rejects.toThrow();
  });

  it('중복 permissionKey 를 차단한다', async () => {
    if (!available) return;
    const client = getPrismaClient();
    await expect(
      client.permission.create({ data: { permissionKey: 'role.read', description: '중복' } }),
    ).rejects.toThrow();
  });

  it('중복 UserRole 을 차단한다 (복합 PK)', async () => {
    if (!available) return;
    const client = getPrismaClient();
    const admin = await client.role.findUniqueOrThrow({ where: { roleCode: 'ADMIN' } });

    await client.userRole.create({ data: { userId: USER_A, roleId: admin.id } });
    await expect(
      client.userRole.create({ data: { userId: USER_A, roleId: admin.id } }),
    ).rejects.toThrow();
  });

  it('중복 RolePermission 을 차단한다 (복합 PK)', async () => {
    if (!available) return;
    const client = getPrismaClient();
    const admin = await client.role.findUniqueOrThrow({ where: { roleCode: 'ADMIN' } });
    const permission = await client.permission.findUniqueOrThrow({
      where: { permissionKey: 'role.read' },
    });

    await expect(
      client.rolePermission.create({
        data: { roleId: admin.id, permissionId: permission.id },
      }),
    ).rejects.toThrow();
  });

  it('존재하지 않는 FK 를 차단한다', async () => {
    if (!available) return;
    const client = getPrismaClient();

    await expect(
      client.userRole.create({
        data: { userId: USER_A, roleId: '00000000-0000-4000-8000-000000000000' },
      }),
    ).rejects.toThrow();

    const admin = await client.role.findUniqueOrThrow({ where: { roleCode: 'ADMIN' } });
    await expect(
      client.userRole.create({
        data: { userId: '00000000-0000-4000-8000-000000000000', roleId: admin.id },
      }),
    ).rejects.toThrow();
  });

  it('active 기본값은 true 다', async () => {
    if (!available) return;
    const client = getPrismaClient();
    const user = await client.user.findUniqueOrThrow({ where: { id: USER_A } });
    expect(user.active).toBe(true);
  });

  it('UserRole 에 grantedAt·grantedBy 가 있다', async () => {
    if (!available) return;
    const client = getPrismaClient();
    const admin = await client.role.findUniqueOrThrow({ where: { roleCode: 'ADMIN' } });
    const userRole = await client.userRole.findUniqueOrThrow({
      where: { userId_roleId: { userId: USER_A, roleId: admin.id } },
    });

    expect(userRole.grantedAt).toBeInstanceOf(Date);
    expect(userRole.grantedBy).toBeNull();
  });

  it('★ seed 를 재실행해도 중복이 생기지 않는다', async () => {
    if (!available) return;
    const client = getPrismaClient();

    const before = {
      roles: await client.role.count(),
      permissions: await client.permission.count(),
      rolePermissions: await client.rolePermission.count(),
    };

    await seedRolesAndPermissions(client);
    await seedRolesAndPermissions(client);

    expect({
      roles: await client.role.count(),
      permissions: await client.permission.count(),
      rolePermissions: await client.rolePermission.count(),
    }).toEqual(before);
  });

  it('★ ADMIN 만 role.read 를 가진다', async () => {
    if (!available) return;
    const client = getPrismaClient();

    const grants = await client.rolePermission.findMany({
      where: { permission: { permissionKey: 'role.read' } },
      select: { role: { select: { roleCode: true } } },
    });

    expect(grants.map((grant) => grant.role.roleCode)).toEqual(['ADMIN']);
  });

  it('역할 5종이 시드된다', async () => {
    if (!available) return;
    const client = getPrismaClient();
    const roles = await client.role.findMany({ orderBy: { roleCode: 'asc' } });

    expect(roles.map((role) => role.roleCode)).toEqual([
      'ADMIN',
      'EXECUTIVE',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
  });
});
