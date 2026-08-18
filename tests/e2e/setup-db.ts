import 'dotenv/config';

import { seedCommonCodes } from '../../prisma/seed/common-codes';
import { seedRolesAndPermissions } from '../../prisma/seed/roles';
import { Prisma } from '../../src/generated/prisma/client';
import { disconnectPrisma, getPrismaClient } from '../../src/shared/db';

import {
  E2E_DUPLICATE_BARCODE,
  E2E_HISTORY_BARCODE,
  E2E_MAPPING_CODE,
  E2E_MAPPING_ENDED_CODE,
  E2E_MAPPING_REVIEW_NAME,
  E2E_USERS,
} from './fixtures';

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

  // ⚠️ 바코드도 SKU 를 FK RESTRICT 로 붙들고 있다 — SKU 정리보다 앞서야 한다 (T1-6B1).
  await prisma.skuBarcode.deleteMany({
    where: { sku: { skuCode: { startsWith: 'ZZS-' } } },
  });

  // ⚠️ 거래처 픽스처(T06-4)도 SKU 를 FK RESTRICT 로 붙든다 — 가격 → 공급조건 →
  //    거래처 순으로 지운다. 접두사 ZZV-.
  await prisma.supplierSkuPrice.deleteMany({
    where: { supplierSku: { supplier: { supplierCode: { startsWith: 'ZZV-' } } } },
  });
  await prisma.supplierSku.deleteMany({
    where: { supplier: { supplierCode: { startsWith: 'ZZV-' } } },
  });
  await prisma.supplier.deleteMany({ where: { supplierCode: { startsWith: 'ZZV-' } } });

  // ⚠️ SKU 픽스처를 **먼저** 지운다 — SKU 가 참조 중인 공통코드는 FK RESTRICT 로
  //    삭제되지 않기 때문이다.
  // ⚠️ BOM 은 SKU 를 FK RESTRICT 로 붙들고 있으므로 **SKU 정리보다 먼저** 지운다
  //    (T1-6B5). 라인 → 헤더 순서도 지켜야 한다.
  await prisma.bomLine.deleteMany({
    where: {
      OR: [
        { bomHeader: { parentSku: { skuCode: { startsWith: 'ZZS-' } } } },
        { componentSku: { skuCode: { startsWith: 'ZZS-' } } },
      ],
    },
  });
  await prisma.bomHeader.deleteMany({
    where: { parentSku: { skuCode: { startsWith: 'ZZS-' } } },
  });
  await prisma.sku.deleteMany({ where: { skuCode: { startsWith: 'ZZS-' } } });

  // 이전 실행 잔여물 정리 — E2E 가 만든 코드는 전부 ZZE_ 접두사를 쓴다.
  await prisma.commonCode.deleteMany({ where: { code: { startsWith: 'ZZE_' } } });

  // ⚠️ 변경이력 픽스처(T1-6B3)가 심은 감사로그를 지운다 — AuditLog 는 불변이라
  //    트리거를 잠시 끈다. 픽스처가 매 실행 재생성되므로 누적을 막아야 한다.
  //    (지우는 대상은 이 setup 이 심은 행뿐이다 — occurredAt 이 고정 날짜다.)
  await prisma.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE occurred_at >= '2026-08-01' AND occurred_at < '2026-08-05'
       AND entity_type IN ('Sku', 'SkuBarcode', 'SkuExternalMapping')`,
  );
  await prisma.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');

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
      // ── T1-6B1 바코드 탭 픽스처 ──────────────────────────────
      // 일반 바코드 CRUD 시나리오 전용 (등록·대표·비활성·재활성).
      {
        skuCode: 'ZZS-E2E-011',
        skuName: 'E2E 바코드 대상',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // 중복 예외 시나리오의 **원본** — 아래에서 ACTIVE 바코드를 하나 심는다.
      {
        skuCode: 'ZZS-E2E-012',
        skuName: 'E2E 바코드 원본',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // 중복 예외 시나리오의 **요청자 측** — 같은 바코드를 등록하려다 409 를 받는다.
      {
        skuCode: 'ZZS-E2E-013',
        skuName: 'E2E 바코드 중복요청',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // SCM_STAFF 권한 시나리오 전용 (승인 버튼이 없다는 것을 본다).
      {
        skuCode: 'ZZS-E2E-014',
        skuName: 'E2E 바코드 권한',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // ── T1-6B2 외부시스템 매핑 탭 픽스처 ─────────────────────
      // MATCHED · REVIEW_REQUIRED · 종료된 매핑 3건을 갖는다.
      {
        skuCode: 'ZZS-E2E-015',
        skuName: 'E2E 외부매핑 요약',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // ── T1-6B3 변경이력 탭 픽스처 ────────────────────────────
      // 아래에서 감사로그(SKU CREATE/UPDATE + 바코드 CREATE)와
      // "표시되면 안 되는" 외부매핑 감사로그를 함께 심는다.
      {
        skuCode: 'ZZS-E2E-016',
        skuName: 'E2E 변경이력 대상',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // 51건 — 페이지 크기 50 을 한 건 넘겨 이전/다음 컨트롤을 켠다.
      {
        skuCode: 'ZZS-E2E-017',
        skuName: 'E2E 변경이력 페이지네이션',
        itemType: 'FINISHED_GOOD',
        status: 'DRAFT',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // ⑥ 공급조건 탭 전용 (T1-6B4). ⚠️ 다른 spec 이 건드리지 않는 SKU 다 —
      //    mutation 이 닿으면 현재/과거/미래 판정이 흔들린다.
      {
        skuCode: 'ZZS-E2E-018',
        skuName: 'E2E 공급조건 탭',
        itemType: 'FINISHED_GOOD',
        status: 'ACTIVE',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // ⑥ 공급조건 탭 — **가격 chain 손상** 전용 SKU (T1-6B4 remediation R2-5).
      // ⚠️ 반드시 ZZS-E2E-018 과 분리한다 — chain conflict 는 whole-request 409 라
      //    같은 SKU 에 두면 정상 시나리오 테스트가 전부 409 가 된다.
      {
        skuCode: 'ZZS-E2E-019',
        skuName: 'E2E 공급조건 가격손상',
        itemType: 'FINISHED_GOOD',
        status: 'ACTIVE',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      // ⑦ BOM 탭 (T1-6B5) — 상위/구성품 두 방향을 한 화면에서 보기 위한 3종.
      //   ZZS-E2E-020  완제품   : 상위 BOM 2건(ACTIVE·DRAFT) 보유
      //   ZZS-E2E-021  구성품   : 020 의 BOM 에 **두 번**(대체그룹 다름) 들어간다
      //   ZZS-E2E-022  반제품   : 020 의 구성품이면서 자신도 상위 BOM 을 갖는다
      {
        skuCode: 'ZZS-E2E-020',
        skuName: 'E2E BOM 완제품',
        itemType: 'FINISHED_GOOD',
        status: 'ACTIVE',
        baseUom: 'EA',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      {
        skuCode: 'ZZS-E2E-021',
        skuName: 'E2E BOM 구성품',
        itemType: 'RAW_MATERIAL',
        status: 'ACTIVE',
        baseUom: 'EA',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
      {
        skuCode: 'ZZS-E2E-022',
        skuName: 'E2E BOM 반제품',
        itemType: 'FINISHED_GOOD',
        status: 'ACTIVE',
        baseUom: 'EA',
        createdBy: staffUser.id,
        updatedBy: staffUser.id,
      },
    ],
  });

  // ── 바코드 픽스처 (T1-6B1) ────────────────────────────────────
  // ZZS-E2E-012 가 `ZZB0000000012` 를 **활성**으로 쓰고 있다 →
  // ZZS-E2E-013 이 같은 값을 등록하면 409 `BARCODE_DUPLICATE` 가 난다.
  // ⚠️ 감사로그를 만들지 않는 순수 데이터 픽스처다 (화면 검증용).
  const duplicateSourceSku = await prisma.sku.findUniqueOrThrow({
    where: { skuCode: 'ZZS-E2E-012' },
  });
  await prisma.skuBarcode.create({
    data: {
      skuId: duplicateSourceSku.id,
      barcode: E2E_DUPLICATE_BARCODE,
      barcodeType: 'UNIT',
      isPrimary: true,
      status: 'ACTIVE',
    },
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

  // ── 외부 매핑 픽스처 (T1-6B2) ─────────────────────────────────
  // `ZZS-E2E-015` 가 MATCHED(대표) · REVIEW_REQUIRED(상품명만) · 종료된 매핑을
  // 하나씩 갖는다. SKU 상세 외부시스템 매핑 탭의 read-only 요약 검증용이다.
  //
  // ⚠️ 조건부 UNIQUE 를 지킨다 —
  //    `ux_external_mapping_code`(외부시스템+외부코드, 종료 안 된 행)와
  //    `ux_external_mapping_primary`(SKU+외부시스템, 대표 행)에 걸리지 않도록
  //    코드를 다르게 두고 대표는 1건뿐이다.
  const mappingSku = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'ZZS-E2E-015' } });
  const mappingSystem = await prisma.externalSystem.findUniqueOrThrow({
    where: { systemCode: 'ZZX-ERP' },
  });
  await prisma.skuExternalMapping.createMany({
    data: [
      {
        skuId: mappingSku.id,
        externalSystemId: mappingSystem.id,
        externalProductCode: E2E_MAPPING_CODE,
        externalProductName: 'E2E 이카운트 상품명',
        mappingStatus: 'MATCHED',
        isPrimary: true,
        effectiveFrom: new Date('2026-01-01'),
      },
      {
        skuId: mappingSku.id,
        externalSystemId: mappingSystem.id,
        // 상품명만 있는 매핑 — 자동 원장 반영 대상이 아니다 (T05-2 판정 규칙).
        externalProductName: E2E_MAPPING_REVIEW_NAME,
        mappingStatus: 'REVIEW_REQUIRED',
        isPrimary: false,
      },
      {
        skuId: mappingSku.id,
        externalSystemId: mappingSystem.id,
        externalProductCode: E2E_MAPPING_ENDED_CODE,
        externalProductName: 'E2E 종료된 매핑',
        mappingStatus: 'MATCHED',
        isPrimary: false,
        effectiveFrom: new Date('2025-01-01'),
        // 종료된 매핑도 GET 이 반환하며 탭이 숨기지 않는다.
        effectiveTo: new Date('2025-12-31'),
      },
    ],
  });

  // ── 변경이력 픽스처 (T1-6B3) ──────────────────────────────────
  // 감사로그를 **직접 심는다** — 화면 검증용 결정적 데이터가 필요하고,
  // 실제 producer 를 돌리면 상태가 다른 E2E 와 얽힌다.
  //
  // ★ `SkuExternalMapping` 감사로그도 함께 심어, **SKU 변경이력 탭에는 나오지
  //   않는다**는 경계를 E2E 가 고정할 수 있게 한다 (docs/16 §29).
  const historySku = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'ZZS-E2E-016' } });
  const historyBarcode = await prisma.skuBarcode.create({
    data: {
      skuId: historySku.id,
      barcode: E2E_HISTORY_BARCODE,
      barcodeType: 'UNIT',
      isPrimary: false,
      status: 'ACTIVE',
    },
  });
  const historyMapping = await prisma.skuExternalMapping.create({
    data: {
      skuId: historySku.id,
      externalSystemId: mappingSystem.id,
      externalProductCode: `ZZX-HIST-016`,
      mappingStatus: 'MATCHED',
    },
  });

  await prisma.auditLog.createMany({
    data: [
      {
        entityType: 'Sku',
        entityId: historySku.id,
        action: 'CREATE',
        beforeValue: Prisma.JsonNull,
        afterValue: { skuCode: 'ZZS-E2E-016', skuName: 'E2E 변경이력 대상' },
        actorId: adminUser.id,
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
      },
      {
        entityType: 'Sku',
        entityId: historySku.id,
        action: 'UPDATE',
        beforeValue: { skuName: 'E2E 변경이력 이전' },
        afterValue: { skuName: 'E2E 변경이력 대상', brand: { code: 'FB', active: true } },
        actorId: adminUser.id,
        occurredAt: new Date('2026-08-02T00:00:00.000Z'),
        reason: 'E2E 변경 사유',
      },
      {
        entityType: 'SkuBarcode',
        entityId: historyBarcode.id,
        action: 'CREATE',
        beforeValue: Prisma.JsonNull,
        afterValue: { barcode: E2E_HISTORY_BARCODE, skuId: historySku.id },
        actorId: adminUser.id,
        occurredAt: new Date('2026-08-03T00:00:00.000Z'),
      },
      // ⛔ 이 행은 SKU 변경이력 탭에 **나오면 안 된다**.
      {
        entityType: 'SkuExternalMapping',
        entityId: historyMapping.id,
        action: 'CREATE',
        beforeValue: Prisma.JsonNull,
        afterValue: { externalProductCode: 'ZZX-HIST-016' },
        actorId: adminUser.id,
        occurredAt: new Date('2026-08-04T00:00:00.000Z'),
      },
    ],
  });

  // ── 페이지네이션 픽스처 (T1-6B3) ──────────────────────────────
  // `ZZS-E2E-017` 에 **51건** 을 심는다 — 페이지 크기 50 을 한 건 넘겨야
  // 이전/다음 컨트롤이 켜진다 (`docs/16` §36).
  // occurredAt 을 1분 간격으로 내려 최신순이 결정적이게 한다.
  const pagingSku = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'ZZS-E2E-017' } });
  await prisma.auditLog.createMany({
    data: Array.from({ length: 51 }, (_, index) => ({
      entityType: 'Sku',
      entityId: pagingSku.id,
      action: 'UPDATE',
      beforeValue: { seq: index },
      afterValue: { seq: index + 1 },
      actorId: adminUser.id,
      // 2026-08-03T23:59:00Z 부터 1분씩 거슬러 올라간다 — 위 정리 쿼리의
      // `>= 08-01 AND < 08-05` 범위 안에 있어야 다음 실행에서 지워진다.
      occurredAt: new Date(Date.UTC(2026, 7, 3, 23, 59 - index, 0)),
    })),
  });

  // ── 거래처 화면 픽스처 (T06-4) — 접두사 ZZV- ────────────────
  // `ZZV-E2E-001`: 공급조건 1건 + 승인/미승인 가격 각 1건 (권한·상태 표시 검증용).
  // `ZZV-E2E-002`: 공급조건 0건 (빈 상태 검증용 — mutation 이 닿지 않는 픽스처).
  const supplierWithTerms = await prisma.supplier.create({
    data: {
      supplierCode: 'ZZV-E2E-001',
      supplierName: 'E2E 공급업체 알파',
      supplierType: 'MANUFACTURER',
      businessRegistrationNo: '111-22-33333',
      contactName: 'E2E 담당자',
      // ★ 0 은 즉시납 — 화면이 `—` 로 표시하면 안 된다 (G-03).
      defaultLeadTimeDays: 0,
    },
  });
  await prisma.supplier.create({
    data: {
      supplierCode: 'ZZV-E2E-002',
      supplierName: 'E2E 공급업체 베타',
      supplierType: 'VENDOR',
    },
  });

  const termSku = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'ZZS-E2E-001' } });
  const e2eTerm = await prisma.supplierSku.create({
    data: {
      supplierId: supplierWithTerms.id,
      skuId: termSku.id,
      supplyType: 'SELF_SUPPLIED',
      supplierSkuCode: 'ZZV-SKU-001',
      moq: '100',
      // ★ leadTimeDays 는 null — 화면이 입력값 `—` / 적용값 `0`(거래처 기본값)로
      //   나눠 보여줘야 한다 (D-13).
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await prisma.supplierSkuPrice.createMany({
    data: [
      {
        supplierSkuId: e2eTerm.id,
        unitPrice: '1000.0000',
        currency: 'KRW',
        vatIncluded: false,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        createdBy: adminUser.id,
        // 승인된 가격 — 승인 버튼이 보이면 안 된다.
        approvedBy: leaderUser.id,
      },
      {
        supplierSkuId: e2eTerm.id,
        unitPrice: '0',
        currency: 'KRW',
        vatIncluded: false,
        effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
        // ★ 미승인 + 0원 — "미승인" 표시와 0원 표시를 함께 검증한다.
        createdBy: adminUser.id,
      },
    ],
  });

  // ── SKU 상세 ⑥ 공급조건 탭 픽스처 (T1-6B4) ──────────────────
  // `ZZS-E2E-018` 이 네 거래처와 관계를 갖는다:
  //   ZZV-TAB-CUR     현재 유효 · 리드타임 미입력(거래처 기본값 7 fallback) ·
  //                   MOQ 100 · 대표 · **0원 승인 가격** + 미래 미승인 가격
  //   ZZV-TAB-NOPRICE 현재 유효 · **현재 발효 구간의 미승인 가격만** 보유 →
  //                   최근 단가가 `—` 여야 한다 (pending 이 새면 55555 가 보인다)
  //   ZZV-TAB-PAST    이미 종료 → 탭에 보이면 안 된다
  //   ZZV-TAB-FUT     미래 시작 → 탭에 보이면 안 된다
  //
  // `ZZS-E2E-019` 는 chain 손상 전용이다 (아래).
  const tabSku = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'ZZS-E2E-018' } });

  const tabCurrentSupplier = await prisma.supplier.create({
    data: {
      supplierCode: 'ZZV-TAB-CUR',
      supplierName: 'E2E 탭 현재 거래처',
      supplierType: 'MANUFACTURER',
      // ★ 공급조건 leadTimeDays 가 null 이라 이 값이 적용 리드타임이 된다.
      defaultLeadTimeDays: 7,
    },
  });
  const tabPastSupplier = await prisma.supplier.create({
    data: {
      supplierCode: 'ZZV-TAB-PAST',
      supplierName: 'E2E 탭 과거 거래처',
      supplierType: 'VENDOR',
    },
  });
  const tabFutureSupplier = await prisma.supplier.create({
    data: {
      supplierCode: 'ZZV-TAB-FUT',
      supplierName: 'E2E 탭 미래 거래처',
      supplierType: 'VENDOR',
    },
  });
  // ★ 거래처 기본 리드타임도 없다 → 적용 리드타임이 `—` 로 나온다 (G-03 null 쪽).
  const tabNoPriceSupplier = await prisma.supplier.create({
    data: {
      supplierCode: 'ZZV-TAB-NOPRICE',
      supplierName: 'E2E 탭 미승인가격 거래처',
      supplierType: 'VENDOR',
      defaultLeadTimeDays: null,
    },
  });

  const tabCurrentTerm = await prisma.supplierSku.create({
    data: {
      supplierId: tabCurrentSupplier.id,
      skuId: tabSku.id,
      supplyType: 'TURNKEY',
      supplierSkuCode: 'ZZV-TAB-SKU-1',
      moq: '100',
      leadTimeDays: null,
      isPrimary: true,
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
    },
  });
  await prisma.supplierSku.create({
    data: {
      supplierId: tabPastSupplier.id,
      skuId: tabSku.id,
      supplyType: 'SELF_SUPPLIED',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2021-01-01T00:00:00.000Z'),
    },
  });
  await prisma.supplierSku.create({
    data: {
      supplierId: tabFutureSupplier.id,
      skuId: tabSku.id,
      supplyType: 'SELF_SUPPLIED',
      effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
      effectiveTo: null,
    },
  });
  // ★ 현재 유효한 공급조건이지만 **승인된 가격이 없다**.
  const tabNoPriceTerm = await prisma.supplierSku.create({
    data: {
      supplierId: tabNoPriceSupplier.id,
      skuId: tabSku.id,
      supplyType: 'SELF_SUPPLIED',
      supplierSkuCode: 'ZZV-TAB-SKU-2',
      moq: null,
      leadTimeDays: null,
      isPrimary: false,
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
    },
  });
  await prisma.supplierSkuPrice.createMany({
    data: [
      {
        supplierSkuId: tabCurrentTerm.id,
        // ⛔ 이미 마감된 승인 가격 — "승인됐다"는 이유로 잡히면 안 된다.
        //    최근 단가는 **지금 유효한** 승인 가격이다 (asOf 판정).
        unitPrice: '1234.5678',
        currency: 'KRW',
        vatIncluded: false,
        effectiveFrom: new Date('2019-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2020-01-01T00:00:00.000Z'),
        createdBy: adminUser.id,
        approvedBy: leaderUser.id,
      },
      {
        supplierSkuId: tabCurrentTerm.id,
        // ★ 현재 유효한 승인 가격. 0원이라 탭이 `0 KRW` 로 보여야 한다
        //   ("가격 없음"과 구분 — D-17).
        unitPrice: '0',
        currency: 'KRW',
        vatIncluded: false,
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
        createdBy: adminUser.id,
        approvedBy: leaderUser.id,
      },
      {
        supplierSkuId: tabCurrentTerm.id,
        // ⛔ 미승인 — 탭 단가에 반영되면 안 된다.
        unitPrice: '99999',
        currency: 'KRW',
        vatIncluded: false,
        effectiveFrom: new Date('2098-01-01T00:00:00.000Z'),
        createdBy: adminUser.id,
      },
      {
        supplierSkuId: tabNoPriceTerm.id,
        // ★★ **지금 발효 구간**의 미승인 가격이다 — 승인 여부만 다르다.
        //     resolver 가 `approvedBy IS NOT NULL` 을 빠뜨리면 곧바로
        //     `55555 KRW` 가 보인다. 기대값은 `—` 다 (D-16·D-17).
        unitPrice: '55555',
        currency: 'KRW',
        vatIncluded: false,
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
        createdBy: adminUser.id,
        approvedBy: null,
      },
    ],
  });

  // ── ⑥ 공급조건 탭 — 가격 chain 손상 픽스처 (remediation R2-5) ──
  //
  // 승인된 가격 두 건이 **같은 시점에 동시에 유효**하다:
  //   [2020-01-01, ∞) 와 [2021-01-01, ∞)
  // T06-3 승인 트랜잭션은 이런 상태를 만들지 않지만, DB 에는 이를 막는 제약이
  // 없다 (`SupplierSkuPrice` 에 EXCLUDE 를 두지 않는다 — docs/17 §21). 즉
  // **직접 심어야만 재현되는 손상 상태**이며, 그래서 픽스처로 심는다.
  //
  // 기대: resolver 가 candidate 2건을 발견 → whole-request 409
  //       `SUPPLIER_PRICE_CHAIN_CONFLICT` → 탭이 ErrorBanner 로 드러낸다.
  //       ⛔ `LIMIT 1` 로 최신 하나를 골라 조용히 넘어가지 않는다 (D-18·D-23).
  const conflictSku = await prisma.sku.findUniqueOrThrow({
    where: { skuCode: 'ZZS-E2E-019' },
  });
  const conflictSupplier = await prisma.supplier.create({
    data: {
      supplierCode: 'ZZV-TAB-CONFLICT',
      supplierName: 'E2E 탭 가격손상 거래처',
      supplierType: 'VENDOR',
      defaultLeadTimeDays: 3,
    },
  });
  const conflictTerm = await prisma.supplierSku.create({
    data: {
      supplierId: conflictSupplier.id,
      skuId: conflictSku.id,
      supplyType: 'TURNKEY',
      supplierSkuCode: 'ZZV-TAB-SKU-3',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
    },
  });
  await prisma.supplierSkuPrice.createMany({
    data: [
      {
        supplierSkuId: conflictTerm.id,
        unitPrice: '1000',
        currency: 'KRW',
        vatIncluded: false,
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        // ⚠️ 마감되지 않았다 — 아래 행과 구간이 겹친다.
        effectiveTo: null,
        createdBy: adminUser.id,
        approvedBy: leaderUser.id,
      },
      {
        supplierSkuId: conflictTerm.id,
        unitPrice: '2000',
        currency: 'KRW',
        vatIncluded: false,
        effectiveFrom: new Date('2021-01-01T00:00:00.000Z'),
        effectiveTo: null,
        createdBy: adminUser.id,
        approvedBy: leaderUser.id,
      },
    ],
  });

  // ── ⑦ BOM 픽스처 (T1-6B5) ────────────────────────────────────
  //
  // 화면이 확인해야 하는 것:
  //   ① 상위 BOM 2건 — 상태(ACTIVE/DRAFT)·적용기간·확정 진행률이 서로 다르다
  //   ② where-used 에서 **같은 BOM 이 두 행**으로 나온다(대체그룹만 다름)
  //   ③ `quantityStatus=UNKNOWN` 행은 소요량이 `—` 다 (0 이 아니다)
  //   ④ `SUGGESTED` 는 미확정에 포함된다 — 진행률이 "확정 1 / 전체 3"
  //
  // ⚠️ 감사로그·멱등 레코드를 만들지 않는 순수 데이터 픽스처다.
  const bomParent = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'ZZS-E2E-020' } });
  const bomComponent = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'ZZS-E2E-021' } });
  const bomSemi = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'ZZS-E2E-022' } });

  // ① ACTIVE 버전 — 라인 3개(CONFIRMED 1 · SUGGESTED 1 · UNKNOWN 1) → 확정 1/3
  const activeBom = await prisma.bomHeader.create({
    data: {
      parentSkuId: bomParent.id,
      bomType: 'MANUFACTURING',
      version: 'ZZB-1.0',
      status: 'ACTIVE',
      outputQty: '1',
      outputUom: 'EA',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      createdBy: staffUser.id,
    },
    select: { id: true },
  });
  await prisma.bomLine.createMany({
    data: [
      {
        bomHeaderId: activeBom.id,
        lineNo: 1,
        componentSkuId: bomComponent.id,
        quantityPer: '2.500000',
        quantityStatus: 'CONFIRMED',
        uom: 'EA',
        componentRole: 'MATERIAL',
        alternateGroup: 'ZZG-A',
        isRequired: true,
      },
      // ★ 같은 구성품이 **대체그룹만 달리해** 한 번 더 들어간다 →
      //   where-used 에서 같은 header 가 두 행으로 나와야 한다(dedup 금지).
      {
        bomHeaderId: activeBom.id,
        lineNo: 2,
        componentSkuId: bomComponent.id,
        quantityPer: '0.033333',
        quantityStatus: 'SUGGESTED',
        uom: 'EA',
        componentRole: 'MATERIAL',
        alternateGroup: 'ZZG-B',
        isRequired: false,
      },
      // ★ UNKNOWN — quantityPer 이 null 이라 화면에서 `—` 여야 한다.
      {
        bomHeaderId: activeBom.id,
        lineNo: 3,
        componentSkuId: bomSemi.id,
        quantityPer: null,
        quantityStatus: 'UNKNOWN',
        uom: 'EA',
        componentRole: 'SERVICE',
        alternateGroup: null,
        isRequired: true,
      },
    ],
  });

  // ② DRAFT 버전 — 라인 0건. 미래 시작 + 종료일 있음(적용기간 표기 확인용).
  await prisma.bomHeader.create({
    data: {
      parentSkuId: bomParent.id,
      bomType: 'KIT',
      version: 'ZZB-2.0',
      status: 'DRAFT',
      outputQty: '1',
      outputUom: 'EA',
      effectiveFrom: new Date('2030-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2031-01-01T00:00:00.000Z'),
      createdBy: staffUser.id,
    },
  });

  // ③ 반제품도 자신의 상위 BOM 을 갖는다 — "상위/구성품은 다른 질문"을 보여준다.
  const semiBom = await prisma.bomHeader.create({
    data: {
      parentSkuId: bomSemi.id,
      bomType: 'MANUFACTURING',
      version: 'ZZB-SEMI-1.0',
      status: 'ACTIVE',
      outputQty: '1',
      outputUom: 'EA',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      createdBy: staffUser.id,
    },
    select: { id: true },
  });
  await prisma.bomLine.create({
    data: {
      bomHeaderId: semiBom.id,
      lineNo: 1,
      componentSkuId: bomComponent.id,
      quantityPer: '1',
      quantityStatus: 'CONFIRMED',
      uom: 'EA',
      componentRole: 'MATERIAL',
      isRequired: true,
    },
  });

  await disconnectPrisma();
}

main().catch((error: unknown) => {
  console.error('[e2e setup-db] 실패:', error);
  process.exit(1);
});
