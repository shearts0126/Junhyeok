import 'dotenv/config';

import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { formatCommonCodeSeedSummary, seedCommonCodes } from './common-codes';
import { seedRolesAndPermissions } from './roles';
import { formatWarehouseSeedSummary, seedWarehouses } from './warehouses';

/**
 * 시드 진입점.
 *
 * ```bash
 * pnpm db:seed
 * ```
 *
 * 여러 번 실행해도 안전하다(idempotent).
 *
 * ⚠️ **하나의 트랜잭션**으로 실행한다. 코드사전 시드가 중간에 실패하면
 *    (예: 부모 코드 누락) 부분 시드가 남지 않고 전체가 롤백된다.
 */
async function main(): Promise<void> {
  const prisma = getPrismaClient();

  const { roles, commonCodes, warehouses } = await prisma.$transaction(async (tx) => {
    const rolesResult = await seedRolesAndPermissions(tx);
    const commonCodesResult = await seedCommonCodes(tx);
    // ★ 창고 15종 + DEFAULT 로케이션 15개 (T08-2, docs/19 §W-D37).
    //   ⛔ AuditLog 를 남기지 않는다 — seed 는 runtime actor mutation 이 아니다.
    const warehousesResult = await seedWarehouses(tx);
    return { roles: rolesResult, commonCodes: commonCodesResult, warehouses: warehousesResult };
  });

  console.log(
    `시드 완료 — 역할 ${roles.roles}개, 권한 ${roles.permissions}개, ` +
      `역할-권한 ${roles.rolePermissions}건, 시스템 설정 ${roles.systemSettings}행`,
  );
  console.log(formatCommonCodeSeedSummary(commonCodes));
  console.log(formatWarehouseSeedSummary(warehouses));
}

main()
  .catch((error: unknown) => {
    console.error('시드 실패:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
