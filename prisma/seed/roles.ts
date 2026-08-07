import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { SYSTEM_SETTING_ID } from '@/modules/settings/application';

/**
 * 역할·권한 초기 데이터 (T0-6).
 *
 * **idempotent** 하다. 몇 번을 실행해도 중복 행이 생기지 않는다.
 *
 * ⚠️ 지금 필요한 최소 권한만 등록한다. SKU·BOM·재고 권한을 미리 대량으로
 *    넣지 않는다. 쓰이지 않는 권한 행은 "누가 무엇을 할 수 있는가"를
 *    흐리게 만들고, 나중에 실제 권한 설계와 어긋난다.
 *
 * ⚠️ **ADMIN 을 코드로 무조건 통과시키지 않는다.** ADMIN 도 `role_permission`
 *    데이터로 권한을 취득한다. 코드상 예외를 두면 권한 표가 실제 접근 권한을
 *    설명하지 못하게 되고, 감사에서 근거를 댈 수 없다.
 */

export const ROLE_CODES = ['ADMIN', 'SCM_LEADER', 'SCM_STAFF', 'FINANCE', 'EXECUTIVE'] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_SEED: ReadonlyArray<{ roleCode: RoleCode; roleName: string }> = [
  { roleCode: 'ADMIN', roleName: '시스템 관리자' },
  { roleCode: 'SCM_LEADER', roleName: 'SCM 리더' },
  { roleCode: 'SCM_STAFF', roleName: 'SCM 담당자' },
  { roleCode: 'FINANCE', roleName: '재무' },
  { roleCode: 'EXECUTIVE', roleName: '경영진' },
];

/** 실제로 사용하는 권한만 등록한다. */
export const PERMISSION_SEED: ReadonlyArray<{ permissionKey: string; description: string }> = [
  { permissionKey: 'role.read', description: '역할 목록 조회' },
  { permissionKey: 'system_setting.read', description: '시스템 설정 조회' },
  { permissionKey: 'system_setting.update', description: '시스템 설정 변경' },
  { permissionKey: 'common_code.read', description: '공통코드 조회' },
  { permissionKey: 'common_code.manage', description: '공통코드 생성·수정·비활성화' },
];

/**
 * 역할 → 권한.
 *
 * 공통코드(T0-8): 조회는 전 역할, 관리는 ADMIN 만.
 * ADMIN 도 이 표의 행으로만 권한을 얻는다 — 코드상 무조건 통과 없음.
 */
export const ROLE_PERMISSION_SEED: ReadonlyArray<{
  roleCode: RoleCode;
  permissionKey: string;
}> = [
  { roleCode: 'ADMIN', permissionKey: 'role.read' },
  { roleCode: 'ADMIN', permissionKey: 'system_setting.read' },
  { roleCode: 'ADMIN', permissionKey: 'system_setting.update' },
  { roleCode: 'ADMIN', permissionKey: 'common_code.read' },
  { roleCode: 'ADMIN', permissionKey: 'common_code.manage' },
  { roleCode: 'SCM_LEADER', permissionKey: 'common_code.read' },
  { roleCode: 'SCM_STAFF', permissionKey: 'common_code.read' },
  { roleCode: 'FINANCE', permissionKey: 'common_code.read' },
  { roleCode: 'EXECUTIVE', permissionKey: 'common_code.read' },
];

/** 시드가 실행할 수 있는 최소 클라이언트 인터페이스. 트랜잭션 클라이언트도 받는다. */
export type SeedClient =
  | Pick<PrismaClient, 'role' | 'permission' | 'rolePermission' | 'systemSetting'>
  | Prisma.TransactionClient;

export interface SeedResult {
  readonly roles: number;
  readonly permissions: number;
  readonly rolePermissions: number;
  readonly systemSettings: number;
}

/**
 * 역할·권한을 생성한다. 이미 있으면 이름만 최신화한다.
 *
 * `upsert` 를 쓰므로 재실행해도 중복이 생기지 않는다.
 */
export async function seedRolesAndPermissions(client: SeedClient): Promise<SeedResult> {
  for (const role of ROLE_SEED) {
    await client.role.upsert({
      where: { roleCode: role.roleCode },
      update: { roleName: role.roleName },
      create: { roleCode: role.roleCode, roleName: role.roleName },
    });
  }

  for (const permission of PERMISSION_SEED) {
    await client.permission.upsert({
      where: { permissionKey: permission.permissionKey },
      update: { description: permission.description },
      create: {
        permissionKey: permission.permissionKey,
        description: permission.description,
      },
    });
  }

  for (const grant of ROLE_PERMISSION_SEED) {
    const role = await client.role.findUniqueOrThrow({ where: { roleCode: grant.roleCode } });
    const permission = await client.permission.findUniqueOrThrow({
      where: { permissionKey: grant.permissionKey },
    });

    await client.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }

  // 시스템 설정 singleton (T0-7). 초기값은 전부 비활성·NULL 이다.
  await client.systemSetting.upsert({
    where: { id: SYSTEM_SETTING_ID },
    update: {},
    create: {
      id: SYSTEM_SETTING_ID,
      allowSelfApprovalSku: false,
      allowSelfApprovalBom: false,
      cutoverDate: null,
      postingFrozen: false,
    },
  });

  return {
    roles: ROLE_SEED.length,
    permissions: PERMISSION_SEED.length,
    rolePermissions: ROLE_PERMISSION_SEED.length,
    systemSettings: 1,
  };
}
