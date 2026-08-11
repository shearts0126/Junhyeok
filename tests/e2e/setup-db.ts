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

  const [adminUser, staffUser, financeUser, leaderUser, execUser] = E2E_USERS;

  for (const [fixture, roleCode, name] of [
    [adminUser, 'ADMIN', 'E2E 관리자'],
    [staffUser, 'SCM_STAFF', 'E2E 담당자'],
    [financeUser, 'FINANCE', 'E2E 재무'],
    [leaderUser, 'SCM_LEADER', 'E2E 리더'],
    [execUser, 'EXECUTIVE', 'E2E 경영진'],
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

  // ⚠️ 외부 매핑을 **가장 먼저** 지운다 — 매핑이 SKU·외부시스템을 FK RESTRICT 로
  //    붙들고 있어서, 남아 있으면 아래 SKU 정리가 실패한다 (T05-4A).
  await prisma.skuExternalMapping.deleteMany({
    where: {
      OR: [
        { sku: { skuCode: { startsWith: 'ZZS-' } } },
        { externalSystem: { systemCode: { startsWith: 'ZZX-' } } },
      ],
    },
  });
  await prisma.externalSystem.deleteMany({ where: { systemCode: { startsWith: 'ZZX-' } } });

  // ⚠️ SKU 픽스처를 **먼저** 지운다 — SKU 가 참조 중인 공통코드는 FK RESTRICT 로
  //    삭제되지 않기 때문이다.
  await prisma.sku.deleteMany({ where: { skuCode: { startsWith: 'ZZS-' } } });

  // 이전 실행 잔여물 정리 — E2E 가 만든 코드는 전부 ZZE_ 접두사를 쓴다.
  await prisma.commonCode.deleteMany({ where: { code: { startsWith: 'ZZE_' } } });

  // 자가승인 차단(403) 시나리오가 결정적이도록 설정을 기본값으로 되돌린다.
  await prisma.systemSetting.updateMany({
    where: { id: 1 },
    data: { allowSelfApprovalSku: false },
  });

  // ── SKU 화면 픽스처 (T1-5A 목록 / T1-6A 상세·워크플로) — 접두사 ZZS- ──
  // 감사로그를 만들지 않는 순수 데이터 픽스처다 (화면 검증용).
  const brandGroup = await prisma.commonCodeGroup.findUniqueOrThrow({
    where: { groupCode: 'BRAND' },
  });
  const brandFb = await prisma.commonCode.findUniqueOrThrow({
    where: { groupId_code: { groupId: brandGroup.id, code: 'FB' } },
  });
  // 비활성 참조 시나리오용 — 활성 목록에 없는 브랜드를 SKU 가 참조한 상태.
  const inactiveBrand = await prisma.commonCode.create({
    data: {
      groupId: brandGroup.id,
      code: 'ZZE_OFF_BRAND',
      name: 'E2E 비활성 브랜드',
      sortOrder: 995,
      active: false,
    },
  });

  await prisma.sku.createMany({
    data: [
      {
        skuCode: 'ZZS-E2E-001',
        skuName: 'E2E 활성 샴푸',
        skuNameEn: 'E2E Active Shampoo',
        itemType: 'FINISHED_GOOD',
        status: 'ACTIVE',
        brandId: brandFb.id,
        createdBy: adminUser.id,
        updatedBy: adminUser.id,
      },
      {
        skuCode: 'ZZS-E2E-002',
        skuName: 'E2E 작성중 트리트먼트',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        createdBy: adminUser.id,
        updatedBy: adminUser.id,
      },
      {
        skuCode: 'ZZS-E2E-003',
        skuName: 'E2E 중지 소모품',
        itemType: 'CONSUMABLE',
        status: 'INACTIVE',
        createdBy: adminUser.id,
        updatedBy: adminUser.id,
      },
      // ── T1-6A 워크플로 픽스처 ─────────────────────────────────
      // 작성자를 STAFF 로 두어 ADMIN 이 자가승인 없이 승인/반려할 수 있게 한다.
      {
        skuCode: 'ZZS-E2E-004',
        skuName: 'E2E 승인요청 대상',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      {
        // ⚠️ 이 SKU 는 워크플로 E2E 에서 ACTIVE→INACTIVE 까지 진행된다.
        //    목록 E2E 의 "INACTIVE + FINISHED_GOOD = 결과 없음" 시나리오와
        //    겹치지 않도록 품목구분을 달리 둔다.
        skuCode: 'ZZS-E2E-005',
        skuName: 'E2E 승인 대상',
        itemType: 'SEMI_FINISHED_GOOD',
        status: 'PENDING_APPROVAL',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      {
        skuCode: 'ZZS-E2E-006',
        skuName: 'E2E 반려 대상',
        itemType: 'FINISHED_GOOD',
        status: 'PENDING_APPROVAL',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // 작성자 = ADMIN → ADMIN 이 승인 시도하면 자가승인 403 (설정 false)
      {
        skuCode: 'ZZS-E2E-007',
        skuName: 'E2E 자가승인 대상',
        itemType: 'FINISHED_GOOD',
        status: 'PENDING_APPROVAL',
        createdBy: adminUser.id,
        updatedBy: adminUser.id,
      },
      // 승인 전 검증 V3(품목구분 미매핑) ERROR 시나리오
      {
        skuCode: 'ZZS-E2E-008',
        skuName: 'E2E 검증실패 대상',
        itemType: 'LEGACY_UNMAPPED',
        status: 'DRAFT',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // 거래 이력 있음 → skuCode 읽기 전용
      {
        skuCode: 'ZZS-E2E-009',
        skuName: 'E2E 거래이력 SKU',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        hasTransaction: true,
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // 비활성 브랜드를 참조 중 — 다른 필드만 수정하는 PATCH 가 막히면 안 된다
      {
        skuCode: 'ZZS-E2E-010',
        skuName: 'E2E 비활성참조 SKU',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        brandId: inactiveBrand.id,
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
    ],
  });

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

  // ── 외부 상품 매핑 화면 픽스처 (T05-4A) — 접두사 ZZX- ──────────
  // (정리는 위에서 이미 했다 — FK RESTRICT 때문에 SKU 정리보다 앞서야 한다)
  await prisma.externalSystem.createMany({
    data: [
      { systemCode: 'ZZX-ERP', systemName: 'E2E 이카운트', systemType: 'ERP', active: true },
      // 비활성 외부시스템도 lookup 에서 숨기지 않는다 (선택 자체를 막지 않는다).
      {
        systemCode: 'ZZX-OFF',
        systemName: 'E2E 종료된 3PL',
        systemType: 'THREE_PL',
        active: false,
      },
    ],
  });

  await disconnectPrisma();
}

main().catch((error: unknown) => {
  console.error('[e2e setup-db] 실패:', error);
  process.exit(1);
});
