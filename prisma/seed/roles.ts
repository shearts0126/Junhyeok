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
  { permissionKey: 'sku.read', description: 'SKU 조회' },
  { permissionKey: 'sku.create', description: 'SKU 생성' },
  { permissionKey: 'sku.update', description: 'SKU 수정' },
  { permissionKey: 'sku.submit', description: 'SKU 승인 요청' },
  { permissionKey: 'sku.approve', description: 'SKU 승인·반려 (동일 authority)' },
  { permissionKey: 'sku.deactivate', description: 'SKU 사용중지' },
  { permissionKey: 'sku.suggest_code', description: 'SKU 코드 추천 (저장 없음)' },
  { permissionKey: 'barcode.read', description: 'SKU 바코드 조회' },
  { permissionKey: 'barcode.create', description: 'SKU 바코드 추가' },
  { permissionKey: 'barcode.update', description: 'SKU 바코드 수정' },
  { permissionKey: 'barcode.deactivate', description: 'SKU 바코드 비활성 (물리삭제 아님)' },
  { permissionKey: 'barcode.request_duplicate', description: 'SKU 바코드 중복 예외 요청' },
  { permissionKey: 'barcode.approve_duplicate', description: 'SKU 바코드 중복 예외 승인' },
  { permissionKey: 'external_mapping.read', description: '외부 상품 매핑 조회' },
  { permissionKey: 'external_mapping.create', description: '외부 상품 매핑 생성' },
  { permissionKey: 'external_mapping.update', description: '외부 상품 매핑 수정' },
  { permissionKey: 'supplier.read', description: '거래처·공급조건 조회' },
  { permissionKey: 'supplier.create', description: '거래처·공급조건 생성' },
  { permissionKey: 'supplier.update', description: '거래처·공급조건 수정' },
  { permissionKey: 'supplier_price.read', description: '공급 가격이력 조회' },
  { permissionKey: 'supplier_price.create', description: '공급 가격 등록 (미승인 제안행)' },
  { permissionKey: 'supplier_price.approve', description: '공급 가격 승인 (발효)' },
  { permissionKey: 'bom.read', description: 'BOM 조회' },
  { permissionKey: 'bom.create', description: 'BOM 생성' },
  { permissionKey: 'bom.update', description: 'BOM 수정 (라인 추가·수정·삭제 포함)' },
  { permissionKey: 'bom.submit', description: 'BOM 승인 요청' },
  { permissionKey: 'bom.approve', description: 'BOM 승인·반려·활성화·사용종료' },
];

/**
 * 역할 → 권한.
 *
 * 공통코드(T0-8): 조회는 전 역할, 관리는 ADMIN 만.
 * SKU(T1-3, 05 API 권한표): 조회는 전 역할 / 생성·수정은 ADMIN·SCM_LEADER·SCM_STAFF.
 *   FINANCE·EXECUTIVE 는 read-only — 작성 권한을 부여하지 않는다.
 * SKU 워크플로(T1-4A): submit 은 S·L·A / approve(반려 겸용)·deactivate 는 L·A.
 *   sku.archive 는 T1-4B 에서 ADMIN 에 추가 예정 — 아직 시드하지 않는다.
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
  { roleCode: 'ADMIN', permissionKey: 'sku.read' },
  { roleCode: 'SCM_LEADER', permissionKey: 'sku.read' },
  { roleCode: 'SCM_STAFF', permissionKey: 'sku.read' },
  { roleCode: 'FINANCE', permissionKey: 'sku.read' },
  { roleCode: 'EXECUTIVE', permissionKey: 'sku.read' },
  { roleCode: 'ADMIN', permissionKey: 'sku.create' },
  { roleCode: 'SCM_LEADER', permissionKey: 'sku.create' },
  { roleCode: 'SCM_STAFF', permissionKey: 'sku.create' },
  { roleCode: 'ADMIN', permissionKey: 'sku.update' },
  { roleCode: 'SCM_LEADER', permissionKey: 'sku.update' },
  { roleCode: 'SCM_STAFF', permissionKey: 'sku.update' },
  { roleCode: 'ADMIN', permissionKey: 'sku.submit' },
  { roleCode: 'SCM_LEADER', permissionKey: 'sku.submit' },
  { roleCode: 'SCM_STAFF', permissionKey: 'sku.submit' },
  { roleCode: 'ADMIN', permissionKey: 'sku.approve' },
  { roleCode: 'SCM_LEADER', permissionKey: 'sku.approve' },
  { roleCode: 'ADMIN', permissionKey: 'sku.deactivate' },
  { roleCode: 'SCM_LEADER', permissionKey: 'sku.deactivate' },
  // 코드 추천(T03-7) — 작성 계열과 역할집합이 같아도 독립 permission 이다.
  { roleCode: 'ADMIN', permissionKey: 'sku.suggest_code' },
  { roleCode: 'SCM_LEADER', permissionKey: 'sku.suggest_code' },
  { roleCode: 'SCM_STAFF', permissionKey: 'sku.suggest_code' },
  // 바코드(T04-3, docs/10 §3) — 독립 capability 다. `sku.*` 를 재사용하지 않는다.
  // 조회는 전 역할, 작성·수정·비활성은 S·L·A. FINANCE·EXECUTIVE 는 read-only.
  // (중복 예외 권한 2종은 T04-4A 에서 아래에 추가되었다 — docs/11 §3.)
  { roleCode: 'ADMIN', permissionKey: 'barcode.read' },
  { roleCode: 'SCM_LEADER', permissionKey: 'barcode.read' },
  { roleCode: 'SCM_STAFF', permissionKey: 'barcode.read' },
  { roleCode: 'FINANCE', permissionKey: 'barcode.read' },
  { roleCode: 'EXECUTIVE', permissionKey: 'barcode.read' },
  { roleCode: 'ADMIN', permissionKey: 'barcode.create' },
  { roleCode: 'SCM_LEADER', permissionKey: 'barcode.create' },
  { roleCode: 'SCM_STAFF', permissionKey: 'barcode.create' },
  { roleCode: 'ADMIN', permissionKey: 'barcode.update' },
  { roleCode: 'SCM_LEADER', permissionKey: 'barcode.update' },
  { roleCode: 'SCM_STAFF', permissionKey: 'barcode.update' },
  { roleCode: 'ADMIN', permissionKey: 'barcode.deactivate' },
  { roleCode: 'SCM_LEADER', permissionKey: 'barcode.deactivate' },
  { roleCode: 'SCM_STAFF', permissionKey: 'barcode.deactivate' },
  // 중복 예외(T04-4A, docs/11 §3) — 요청은 S·L·A, 승인은 **L·A** 다.
  // 역할집합이 다르므로 barcode.create·barcode.update 를 재사용하지 않는다.
  { roleCode: 'ADMIN', permissionKey: 'barcode.request_duplicate' },
  { roleCode: 'SCM_LEADER', permissionKey: 'barcode.request_duplicate' },
  { roleCode: 'SCM_STAFF', permissionKey: 'barcode.request_duplicate' },
  { roleCode: 'ADMIN', permissionKey: 'barcode.approve_duplicate' },
  { roleCode: 'SCM_LEADER', permissionKey: 'barcode.approve_duplicate' },
  // 외부 상품 매핑 (T05-2, docs/13 §11).
  // ★ read 에 **EXECUTIVE 가 없다** — API 표의 "전체"와 화면별 권한표
  //   (`외부 상품 매핑 … E = —`)가 충돌했고 화면별 권한표를 채택했다.
  //   sku.read·barcode.read 는 화면표에서도 E=R 이라 5역할이다 (다른 사례다).
  { roleCode: 'ADMIN', permissionKey: 'external_mapping.read' },
  { roleCode: 'SCM_LEADER', permissionKey: 'external_mapping.read' },
  { roleCode: 'SCM_STAFF', permissionKey: 'external_mapping.read' },
  { roleCode: 'FINANCE', permissionKey: 'external_mapping.read' },
  { roleCode: 'ADMIN', permissionKey: 'external_mapping.create' },
  { roleCode: 'SCM_LEADER', permissionKey: 'external_mapping.create' },
  { roleCode: 'SCM_STAFF', permissionKey: 'external_mapping.create' },
  { roleCode: 'ADMIN', permissionKey: 'external_mapping.update' },
  { roleCode: 'SCM_LEADER', permissionKey: 'external_mapping.update' },
  { roleCode: 'SCM_STAFF', permissionKey: 'external_mapping.update' },
  // 거래처·공급조건 (T06-2, docs/17 §44·§45): 조회 A·L·S·F / 작성·수정 A·L·S.
  // ★ read 에도 **EXECUTIVE 가 없다** — API 표 "전체"와 화면별 권한표
  //   (`거래처·공급조건 … E = —`)의 충돌에서 화면별 권한표를 채택했다 (D-21,
  //   external_mapping 과 동일한 판단).
  { roleCode: 'ADMIN', permissionKey: 'supplier.read' },
  { roleCode: 'SCM_LEADER', permissionKey: 'supplier.read' },
  { roleCode: 'SCM_STAFF', permissionKey: 'supplier.read' },
  { roleCode: 'FINANCE', permissionKey: 'supplier.read' },
  { roleCode: 'ADMIN', permissionKey: 'supplier.create' },
  { roleCode: 'SCM_LEADER', permissionKey: 'supplier.create' },
  { roleCode: 'SCM_STAFF', permissionKey: 'supplier.create' },
  { roleCode: 'ADMIN', permissionKey: 'supplier.update' },
  { roleCode: 'SCM_LEADER', permissionKey: 'supplier.update' },
  { roleCode: 'SCM_STAFF', permissionKey: 'supplier.update' },
  // 가격이력 (T06-3, docs/17 §58~ D-27·D-28): read/create 는 A·L·S·F,
  // approve 는 **A·L·F** — SCM_STAFF 는 등록만 가능하고 승인은 불가하다.
  // ★ FINANCE 가 create 에 있다 — supplier.create(A·L·S)와 역할집합이 달라
  //   `supplier.*` 를 재사용하지 않는 근거다. EXECUTIVE 는 전부 denied.
  { roleCode: 'ADMIN', permissionKey: 'supplier_price.read' },
  { roleCode: 'SCM_LEADER', permissionKey: 'supplier_price.read' },
  { roleCode: 'SCM_STAFF', permissionKey: 'supplier_price.read' },
  { roleCode: 'FINANCE', permissionKey: 'supplier_price.read' },
  { roleCode: 'ADMIN', permissionKey: 'supplier_price.create' },
  { roleCode: 'SCM_LEADER', permissionKey: 'supplier_price.create' },
  { roleCode: 'SCM_STAFF', permissionKey: 'supplier_price.create' },
  { roleCode: 'FINANCE', permissionKey: 'supplier_price.create' },
  { roleCode: 'ADMIN', permissionKey: 'supplier_price.approve' },
  { roleCode: 'SCM_LEADER', permissionKey: 'supplier_price.approve' },
  { roleCode: 'FINANCE', permissionKey: 'supplier_price.approve' },
  // BOM (T07-3, docs/18 §D-15). ★ `supplier.*` 와 **정반대 두 지점**이 있다:
  //   ① read 에 **EXECUTIVE 가 있다** (`05v2:661` `BOM 목록·상세 RW RW RW R R`)
  //   ② FINANCE 는 **read 만** — mutation 권한이 하나도 없다 (`05v2:661-662`)
  // ⛔ `bom.cost` 를 만들지 않는다 — 원가도 `bom.read` 로 판정한다.
  // ⚠️ `bom.submit`·`bom.approve` 의 **사용처(endpoint)는 T07-5** 다.
  //    docs/18 §5 가 permission seed 5종을 T07-3 에 배정했으므로 키만 먼저 넣는다.
  { roleCode: 'ADMIN', permissionKey: 'bom.read' },
  { roleCode: 'SCM_LEADER', permissionKey: 'bom.read' },
  { roleCode: 'SCM_STAFF', permissionKey: 'bom.read' },
  { roleCode: 'FINANCE', permissionKey: 'bom.read' },
  { roleCode: 'EXECUTIVE', permissionKey: 'bom.read' },
  { roleCode: 'ADMIN', permissionKey: 'bom.create' },
  { roleCode: 'SCM_LEADER', permissionKey: 'bom.create' },
  { roleCode: 'SCM_STAFF', permissionKey: 'bom.create' },
  { roleCode: 'ADMIN', permissionKey: 'bom.update' },
  { roleCode: 'SCM_LEADER', permissionKey: 'bom.update' },
  { roleCode: 'SCM_STAFF', permissionKey: 'bom.update' },
  { roleCode: 'ADMIN', permissionKey: 'bom.submit' },
  { roleCode: 'SCM_LEADER', permissionKey: 'bom.submit' },
  { roleCode: 'SCM_STAFF', permissionKey: 'bom.submit' },
  { roleCode: 'ADMIN', permissionKey: 'bom.approve' },
  { roleCode: 'SCM_LEADER', permissionKey: 'bom.approve' },
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
