import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  EXTERNAL_MAPPING_READ_PERMISSION,
  listExternalSystems,
  parseListExternalSystemsQuery,
} from '@/modules/external-mapping/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * 외부시스템 lookup API DB 테스트 (T05-4A) — 실제 PostgreSQL.
 *
 * 계약 근거는 `docs/15_설계복구_ExternalMapping관리UI.md` §5~§8.
 *
 * 이 endpoint 는 **관리 UI 의 선택 수단 전용**이고 read-only 다. 여기서 보는 것:
 *   - `external_mapping.read` 4역할 허용 / EXECUTIVE 거부 (신규 permission 없음)
 *   - RolePermission 없는 ADMIN 거부 (ADMIN bypass 부재)
 *   - `systemCode ASC, id ASC` 결정적 정렬
 *   - `active=false` 도 숨기지 않음
 *   - 호출 전후 DB 완전 불변 (mutation·AuditLog 0)
 */

const RUN = randomBytes(4).toString('hex');
const SYS_CODE = (suffix: string) => `TXS-${RUN}-${suffix}`;

const ADMIN_ID = 'aaaaaaa3-0000-4000-8000-00000000ec01';
const LEADER_ID = 'aaaaaaa3-0000-4000-8000-00000000ec02';
const STAFF_ID = 'aaaaaaa3-0000-4000-8000-00000000ec03';
const FINANCE_ID = 'aaaaaaa3-0000-4000-8000-00000000ec04';
const EXEC_ID = 'aaaaaaa3-0000-4000-8000-00000000ec05';
const NOPERM_ID = 'aaaaaaa3-0000-4000-8000-00000000ec06';
const ACTOR_IDS = [ADMIN_ID, LEADER_ID, STAFF_ID, FINANCE_ID, EXEC_ID, NOPERM_ID];

function actorOf(
  userId: string,
  role: string,
  permissions: readonly string[],
  label: string,
): ActorContext {
  return createActorContext({
    userId,
    email: `xsys-${userId.slice(-4)}@deeppoint.test`,
    name: label,
    active: true,
    roles: [role],
    permissions: [...permissions],
    requestId: `req-xsys-${userId.slice(-4)}`,
  });
}

const READ = [EXTERNAL_MAPPING_READ_PERMISSION];

const ADMIN = actorOf(ADMIN_ID, 'ADMIN', READ, '관리자');
const LEADER = actorOf(LEADER_ID, 'SCM_LEADER', READ, '리더');
const STAFF = actorOf(STAFF_ID, 'SCM_STAFF', READ, '담당자');
const FINANCE = actorOf(FINANCE_ID, 'FINANCE', READ, '재무');
/** ★ 화면별 권한표 채택으로 EXECUTIVE 는 read 조차 없다 (docs/13 §11). */
const EXECUTIVE = actorOf(EXEC_ID, 'EXECUTIVE', [], '경영진');
/** ★ ADMIN 역할이지만 RolePermission 행이 없는 actor — ADMIN bypass 부재 증명. */
const ADMIN_NO_PERMISSION = actorOf(NOPERM_ID, 'ADMIN', [], '권한없는 관리자');

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.externalSystem.deleteMany({ where: { systemCode: { startsWith: 'TXS-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  await cleanup();
  await seedRolesAndPermissions(getPrismaClient());

  // ⚠️ 정렬 검증을 위해 **코드 오름차순과 다른 순서**로 넣는다.
  await getPrismaClient().externalSystem.createMany({
    data: [
      { systemCode: SYS_CODE('C'), systemName: '올펀', systemType: 'CHANNEL', active: true },
      { systemCode: SYS_CODE('A'), systemName: '이카운트', systemType: 'ERP', active: true },
      { systemCode: SYS_CODE('B'), systemName: '구 3PL', systemType: 'THREE_PL', active: false },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

function ours<T extends { systemCode: string }>(items: readonly T[]): T[] {
  return items.filter((item) => item.systemCode.startsWith(`TXS-${RUN}-`));
}

// ═══════════════════════════════════════════════════════════════
// 권한 — 2겹 가드 · ADMIN bypass 없음
// ═══════════════════════════════════════════════════════════════

describe('★ 권한', () => {
  it('1~4. ADMIN·SCM_LEADER·SCM_STAFF·FINANCE 는 조회할 수 있다', async () => {
    for (const actor of [ADMIN, LEADER, STAFF, FINANCE]) {
      const result = await listExternalSystems(actor);
      expect(ours(result.items), actor.roles.join(',')).toHaveLength(3);
    }
  });

  it('5. ★ EXECUTIVE 는 거부된다', async () => {
    await expect(listExternalSystems(EXECUTIVE)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
  });

  it('6. ★ ADMIN 역할이어도 RolePermission 이 없으면 거부된다', async () => {
    await expect(listExternalSystems(ADMIN_NO_PERMISSION)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
  });

  it('7. 시드된 external_mapping.read 가 실 DB 에 그대로 있다 (신규 permission 없음)', async () => {
    const client = getPrismaClient();
    const rows = await client.rolePermission.findMany({
      where: { permission: { permissionKey: EXTERNAL_MAPPING_READ_PERMISSION } },
      include: { role: true },
    });
    expect(rows.map((row) => row.role.roleCode).sort()).toEqual([
      'ADMIN',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);

    // ⛔ external_system.* 같은 신규 permission 을 만들지 않았다.
    const invented = await client.permission.findMany({
      where: { permissionKey: { startsWith: 'external_system' } },
    });
    expect(invented).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 결과 계약
// ═══════════════════════════════════════════════════════════════

describe('★ 결과 계약', () => {
  it('8. ★ systemCode ASC, id ASC 로 결정적으로 정렬된다', async () => {
    const first = ours((await listExternalSystems(ADMIN)).items);
    expect(first.map((item) => item.systemCode)).toEqual([
      SYS_CODE('A'),
      SYS_CODE('B'),
      SYS_CODE('C'),
    ]);

    // 두 번 호출해도 같은 순서다.
    const second = ours((await listExternalSystems(ADMIN)).items);
    expect(second).toEqual(first);
  });

  it('9. ★ active=false 도 숨기지 않는다', async () => {
    const items = ours((await listExternalSystems(ADMIN)).items);
    const inactive = items.find((item) => item.systemCode === SYS_CODE('B'));
    expect(inactive).toBeDefined();
    expect(inactive?.active).toBe(false);
    expect(items.filter((item) => item.active).length).toBe(2);
  });

  it('항목 필드가 5개뿐이다 (pagination envelope 없음)', async () => {
    const result = await listExternalSystems(ADMIN);
    expect(Object.keys(result)).toEqual(['items']);

    const item = ours(result.items)[0];
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'active',
      'id',
      'systemCode',
      'systemName',
      'systemType',
    ]);
  });

  it('11. ★ 어떤 query parameter 도 받지 않는다 — 400', () => {
    expect(() => parseListExternalSystemsQuery(new URLSearchParams())).not.toThrow();
    for (const search of ['page=1', 'active=true', 'q=x']) {
      expect(() => parseListExternalSystemsQuery(new URLSearchParams(search)), search).toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// read-only
// ═══════════════════════════════════════════════════════════════

describe('★ read-only — 호출 전후 DB 가 완전히 동일하다', () => {
  it('10. mutation·AuditLog 가 전혀 생기지 않는다', async () => {
    const client = getPrismaClient();
    const snapshot = async () => ({
      systems: await client.externalSystem.count(),
      rows: await client.externalSystem.findMany({
        where: { systemCode: { startsWith: `TXS-${RUN}-` } },
        orderBy: { id: 'asc' },
      }),
      mappings: await client.skuExternalMapping.count(),
      audit: await client.auditLog.count(),
      idempotency: await client.idempotencyRecord.count(),
    });

    const before = await snapshot();
    await listExternalSystems(ADMIN);
    await listExternalSystems(FINANCE);
    expect(await snapshot()).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════
// T05-4A 범위 고정
// ═══════════════════════════════════════════════════════════════

describe('★ T05-4A 범위 고정', () => {
  it('⛔ ExternalSystem 라우트는 lookup GET 하나뿐이다 (CRUD 없음)', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../src/app/api/external-systems', import.meta.url));
    expect(readdirSync(dir).sort()).toEqual(['route.ts']);
  });

  it('⛔ 외부 매핑 라우트에 unmatched·import 가 없다 (T05-4B)', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../src/app/api/external-mappings', import.meta.url));
    expect(readdirSync(dir).sort()).toEqual(['[id]', 'route.ts']);
  });

  it('⛔ 화면 라우트에 별도 상세/신규 페이지가 없다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../src/app/master/external-mappings', import.meta.url));
    expect(readdirSync(dir).sort()).toEqual([
      'external-mappings-client.tsx',
      'list-params.ts',
      'mapping-form.ts',
      'mapping-ui.test.ts',
      'page.tsx',
    ]);
  });

  it('⛔ T15·T17 테이블이 여전히 없다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('import_job', 'import_row', 'external_inventory_snapshot',
                           'data_issue', 'inventory_exception')`;
    expect(rows).toEqual([]);
  });
});
