import 'dotenv/config';

import { seedCommonCodes } from '../../prisma/seed/common-codes';
import { seedRolesAndPermissions } from '../../prisma/seed/roles';
import { disconnectPrisma, getPrismaClient } from '../../src/shared/db';

import { E2E_USERS } from './fixtures';

/**
 * E2E DB 준비 (T0-8) — `global-setup.ts` 가 tsx 자식 프로세스로 실행한다.
 * (Playwright 의 자체 TS 로더는 Prisma 생성 클라이언트의 `import.meta` 를
 * 다루지 못하므로 tsx 로 실행해야 한다)
 *
 * - 역할·권한·코드사전 seed (idempotent)
 * - E2E 픽스처 사용자 2명: ADMIN(관리) / SCM_STAFF(read-only)
 *   → 스텁 인증 서버와 **같은 UUID** 를 로컬 `user` 표에 넣는다.
 * - 부모 비활성화 차단 시나리오용 계층 그룹 (E2EP ← E2EC)
 * - 이전 실행이 남긴 E2E 코드 정리 (ZZE_ 접두사)
 */
async function main(): Promise<void> {
  const prisma = getPrismaClient();

  await prisma.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
    await seedCommonCodes(tx);
  });

  const [adminUser, staffUser] = E2E_USERS;

  for (const [fixture, roleCode, name] of [
    [adminUser, 'ADMIN', 'E2E 관리자'],
    [staffUser, 'SCM_STAFF', 'E2E 담당자'],
  ] as const) {
    await prisma.user.upsert({
      where: { id: fixture.id },
      update: { email: fixture.email, name, active: true },
      create: { id: fixture.id, email: fixture.email, name, active: true },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { roleCode } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: fixture.id, roleId: role.id } },
      update: {},
      create: { userId: fixture.id, roleId: role.id },
    });
  }

  // 이전 실행 잔여물 정리 — E2E 가 만든 코드는 전부 ZZE_ 접두사를 쓴다.
  await prisma.commonCode.deleteMany({ where: { code: { startsWith: 'ZZE_' } } });

  // 부모 비활성화 차단 시나리오 픽스처: E2EP(상위) ← E2EC(하위)
  const parentGroup = await prisma.commonCodeGroup.upsert({
    where: { groupCode: 'E2EP' },
    update: { active: true },
    create: { groupCode: 'E2EP', groupName: 'E2E 상위', sortOrder: 990 },
  });
  const childGroup = await prisma.commonCodeGroup.upsert({
    where: { groupCode: 'E2EC' },
    update: { active: true, parentGroupId: parentGroup.id },
    create: {
      groupCode: 'E2EC',
      groupName: 'E2E 하위',
      sortOrder: 991,
      parentGroupId: parentGroup.id,
    },
  });

  const parentCode = await prisma.commonCode.upsert({
    where: { groupId_code: { groupId: parentGroup.id, code: 'EP1' } },
    update: { active: true, name: 'E2E 부모 코드' },
    create: { groupId: parentGroup.id, code: 'EP1', name: 'E2E 부모 코드', sortOrder: 1 },
  });
  await prisma.commonCode.upsert({
    where: { groupId_code: { groupId: childGroup.id, code: 'EC1' } },
    update: { active: true, parentCodeId: parentCode.id, name: 'E2E 자식 코드' },
    create: {
      groupId: childGroup.id,
      code: 'EC1',
      name: 'E2E 자식 코드',
      sortOrder: 1,
      parentCodeId: parentCode.id,
    },
  });

  await disconnectPrisma();
}

main().catch((error: unknown) => {
  console.error('[e2e setup-db] 실패:', error);
  process.exit(1);
});
