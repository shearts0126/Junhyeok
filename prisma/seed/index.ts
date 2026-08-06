import 'dotenv/config';

import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from './roles';

/**
 * 시드 진입점.
 *
 * ```bash
 * pnpm db:seed
 * ```
 *
 * 여러 번 실행해도 안전하다(idempotent).
 */
async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const result = await seedRolesAndPermissions(prisma);

  console.log(
    `시드 완료 — 역할 ${result.roles}개, 권한 ${result.permissions}개, ` +
      `역할-권한 ${result.rolePermissions}건, 시스템 설정 ${result.systemSettings}행`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
