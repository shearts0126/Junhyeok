import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { COMMON_CODE_GROUP_SEED, COMMON_CODE_SEED } from '../../../prisma/seed/common-code-data';
import { seedCommonCodes } from '../../../prisma/seed/common-codes';
import { seedRolesAndPermissions } from '../../../prisma/seed/roles';

import {
  CODE_MANAGE_PERMISSION,
  CODE_READ_PERMISSION,
  createCode,
  listCodeGroups,
  listCodes,
  updateCode,
} from './application';

/**
 * 공통코드 DB 테스트 (T0-8) — 실제 PostgreSQL.
 *
 * seed idempotency·UUID 안정성·CHECK/UNIQUE/FK RESTRICT·감사로그 커밋과 롤백을
 * 실제 DB 에서 검증한다. 대역으로는 제약 위반과 트랜잭션 원자성을 재현할 수 없다.
 */

const ACTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ACTOR: ActorContext = createActorContext({
  userId: ACTOR_ID,
  email: 'code-admin@deeppoint.test',
  name: '코드 관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: [CODE_READ_PERMISSION, CODE_MANAGE_PERMISSION],
  requestId: 'req-code-db',
});

/** 테스트 픽스처 그룹 — seed 6종과 분리된 이름을 쓴다. */
const TG_PARENT = 'TG_PARENT';
const TG_CHILD = 'TG_CHILD';

async function cleanupFixtures(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(`DELETE FROM audit_log WHERE actor_id = $1`, ACTOR_ID);
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');

  // 픽스처 그룹의 코드 → 그룹 순서로 지운다 (FK RESTRICT).
  const groups = await client.commonCodeGroup.findMany({
    where: { groupCode: { in: [TG_PARENT, TG_CHILD, 'TG_ROLLBACK'] } },
    select: { id: true },
  });
  const groupIds = groups.map((group) => group.id);
  // 자식 참조를 먼저 끊는다.
  await client.commonCode.updateMany({
    where: { groupId: { in: groupIds } },
    data: { parentCodeId: null },
  });
  await client.commonCode.deleteMany({ where: { groupId: { in: groupIds } } });
  await client.commonCodeGroup.deleteMany({ where: { id: { in: groupIds } } });

  // 테스트·E2E 가 seed 그룹에 추가한 커스텀 코드 제거 (E2E 는 ZZE_ 접두사)
  await client.commonCode.deleteMany({
    where: { OR: [{ code: { startsWith: 'ZZT_' } }, { code: { startsWith: 'ZZE_' } }] },
  });

  await client.user.deleteMany({ where: { id: ACTOR_ID } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$queryRaw`SELECT 1`;
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
    await seedCommonCodes(tx);
  });
  await cleanupFixtures();
  await client.user.create({
    data: { id: ACTOR_ID, email: 'code-admin@deeppoint.test', name: '코드 관리자' },
  });

  // 계층 픽스처: TG_PARENT ← TG_CHILD
  const parent = await client.commonCodeGroup.create({
    data: { groupCode: TG_PARENT, groupName: '테스트 상위', sortOrder: 900 },
  });
  await client.commonCodeGroup.create({
    data: {
      groupCode: TG_CHILD,
      groupName: '테스트 하위',
      sortOrder: 901,
      parentGroupId: parent.id,
    },
  });
});

afterAll(async () => {
  await cleanupFixtures();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// seed
// ═══════════════════════════════════════════════════════════════
describe('★ 코드사전 seed (실제 PostgreSQL)', () => {
  it('★ 그룹 6개, 코드 98개 (원본 실측 — 지시 100건과의 차이는 보고 대상)', async () => {
    const client = getPrismaClient();

    const groupCodes = COMMON_CODE_GROUP_SEED.map((group) => group.groupCode);
    expect(groupCodes).toEqual([
      'BRAND',
      'MAJOR_CATEGORY',
      'MINOR_CATEGORY',
      'MATERIAL_CATEGORY',
      'STORAGE_LOCATION',
      'CHANNEL',
    ]);

    expect(await client.commonCodeGroup.count({ where: { groupCode: { in: groupCodes } } })).toBe(
      6,
    );

    // 그룹별 수량 — 시드 데이터 파일이 단일 기준이다.
    const expected: Record<string, number> = {
      BRAND: 2,
      MAJOR_CATEGORY: 12,
      MINOR_CATEGORY: 19,
      MATERIAL_CATEGORY: 38,
      STORAGE_LOCATION: 11,
      CHANNEL: 16,
    };
    let total = 0;
    for (const [groupCode, count] of Object.entries(expected)) {
      const group = await client.commonCodeGroup.findUniqueOrThrow({ where: { groupCode } });
      const seedList = (COMMON_CODE_SEED[groupCode] ?? []).map((seed) => seed.code);
      // seed 가 관리하는 코드만 센다 — 커스텀 코드(API 추가)는 seed 수량과 무관하다.
      const actual = await client.commonCode.count({
        where: { groupId: group.id, code: { in: seedList } },
      });
      expect(actual, groupCode).toBe(count);
      expect(seedList.length, `${groupCode} (데이터 파일)`).toBe(count);
      total += actual;
    }
    expect(total).toBe(98);
  });

  it('★ seed 재실행 — 중복 없음, UUID 불변', async () => {
    const client = getPrismaClient();

    const before = await client.commonCode.findMany({
      where: { group: { groupCode: 'BRAND' } },
      orderBy: { code: 'asc' },
      select: { id: true, code: true },
    });

    await client.$transaction(async (tx) => {
      await seedCommonCodes(tx);
    });

    const after = await client.commonCode.findMany({
      where: { group: { groupCode: 'BRAND' } },
      orderBy: { code: 'asc' },
      select: { id: true, code: true },
    });

    // ★ 재실행 후에도 행 수와 UUID 가 같다.
    expect(after).toEqual(before);
    const group = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: 'MATERIAL_CATEGORY' },
    });
    const materialSeedCodes = (COMMON_CODE_SEED['MATERIAL_CATEGORY'] ?? []).map(
      (seed) => seed.code,
    );
    expect(
      await client.commonCode.count({
        where: { groupId: group.id, code: { in: materialSeedCodes } },
      }),
    ).toBe(38);
  });

  it('★ 사용자가 추가한 커스텀 코드는 seed 재실행에도 보존된다', async () => {
    const client = getPrismaClient();
    const brand = await client.commonCodeGroup.findUniqueOrThrow({ where: { groupCode: 'BRAND' } });

    await client.commonCode.create({
      data: { groupId: brand.id, code: 'ZZT_CUSTOM', name: '커스텀 브랜드', sortOrder: 999 },
    });

    await client.$transaction(async (tx) => {
      await seedCommonCodes(tx);
    });

    const custom = await client.commonCode.findUnique({
      where: { groupId_code: { groupId: brand.id, code: 'ZZT_CUSTOM' } },
    });
    expect(custom).not.toBeNull();
    // seed 코드는 그대로 2건 — 커스텀이 삭제되지도, seed 가 불어나지도 않았다.
    expect(
      await client.commonCode.count({
        where: { groupId: brand.id, code: { in: ['FB', 'BO'] } },
      }),
    ).toBe(2);
  });

  it('★ seed 값 변조는 재실행 시 기준 데이터로 복원된다 (upsert)', async () => {
    const client = getPrismaClient();
    const brand = await client.commonCodeGroup.findUniqueOrThrow({ where: { groupCode: 'BRAND' } });

    await client.commonCode.update({
      where: { groupId_code: { groupId: brand.id, code: 'FB' } },
      data: { name: '오염된 이름', active: false },
    });

    await client.$transaction(async (tx) => {
      await seedCommonCodes(tx);
    });

    const restored = await client.commonCode.findUniqueOrThrow({
      where: { groupId_code: { groupId: brand.id, code: 'FB' } },
    });
    expect(restored.name).toBe('포뷰트');
    expect(restored.active).toBe(true);
  });

  it('★ 부모 누락 seed 는 실패하고 전체 트랜잭션이 롤백된다', async () => {
    const client = getPrismaClient();

    const brokenData = {
      groups: [
        {
          groupCode: 'TG_ROLLBACK',
          groupName: '롤백 테스트',
          description: '',
          parentGroupCode: null,
          sortOrder: 950,
        },
      ],
      codes: {
        TG_ROLLBACK: [
          // 부모 그룹 코드가 시드에 없다 → CommonCodeSeedError → 전체 롤백
          {
            code: 'RB1',
            name: '롤백 1',
            parent: { groupCode: 'NO_SUCH_GROUP', code: 'X' },
            sortOrder: 1,
            attributes: null,
          },
        ],
      },
    };

    await expect(
      client.$transaction(async (tx) => {
        await seedCommonCodes(tx, brokenData);
      }),
    ).rejects.toThrow(/부모 그룹/);

    // ★ 그룹도 코드도 남아 있지 않다 — 부분 시드 없음.
    expect(
      await client.commonCodeGroup.findUnique({ where: { groupCode: 'TG_ROLLBACK' } }),
    ).toBeNull();
  });

  it('원본 이상값이 그대로 보존된다 (조용한 보정 금지)', async () => {
    const client = getPrismaClient();
    const major = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: 'MAJOR_CATEGORY' },
    });
    // 원본 오탈자 'Styiling' 을 고치지 않고 저장했다.
    const styling = await client.commonCode.findUniqueOrThrow({
      where: { groupId_code: { groupId: major.id, code: 'SL' } },
    });
    expect((styling.attributes as { nameEn: string }).nameEn).toBe('Styiling');

    // 보관처 BOC·BON 은 명칭이 같다 — 중복 의심값이지만 둘 다 원본대로 시드.
    const storage = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: 'STORAGE_LOCATION' },
    });
    const sameName = await client.commonCode.findMany({
      where: { groupId: storage.id, name: '본코스메틱' },
      select: { code: true },
      orderBy: { code: 'asc' },
    });
    expect(sameName.map((row) => row.code)).toEqual(['BOC', 'BON']);
  });
});

// ═══════════════════════════════════════════════════════════════
// DB 제약
// ═══════════════════════════════════════════════════════════════
describe('★ 공통코드 DB 제약 (실제 PostgreSQL)', () => {
  it('★ group_code UNIQUE', async () => {
    await expect(
      getPrismaClient().commonCodeGroup.create({
        data: { groupCode: TG_PARENT, groupName: '중복', sortOrder: 0 },
      }),
    ).rejects.toThrow();
  });

  it('★ UNIQUE(group_id, code) — 같은 그룹 중복 차단, 다른 그룹 동일 code 허용', async () => {
    const client = getPrismaClient();
    const parent = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: TG_PARENT },
    });
    const child = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: TG_CHILD },
    });

    await client.commonCode.create({
      data: { groupId: parent.id, code: 'DUP', name: '원본', sortOrder: 1 },
    });
    await expect(
      client.commonCode.create({
        data: { groupId: parent.id, code: 'DUP', name: '중복', sortOrder: 2 },
      }),
    ).rejects.toThrow();

    // 다른 그룹에서는 같은 code 허용
    const other = await client.commonCode.create({
      data: { groupId: child.id, code: 'DUP', name: '다른 그룹', sortOrder: 1 },
    });
    expect(other.code).toBe('DUP');
  });

  it('★ code·name 공백 CHECK — 빈 값·앞뒤 공백 차단', async () => {
    const client = getPrismaClient();
    const parent = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: TG_PARENT },
    });

    for (const bad of ['', '  ', ' X', 'X ']) {
      await expect(
        client.commonCode.create({
          data: { groupId: parent.id, code: bad, name: '이름', sortOrder: 0 },
        }),
        `code=${JSON.stringify(bad)}`,
      ).rejects.toThrow(/common_code_code_not_blank_check/);
    }
    await expect(
      client.commonCode.create({
        data: { groupId: parent.id, code: 'OKC', name: '  ', sortOrder: 0 },
      }),
    ).rejects.toThrow(/common_code_name_not_blank_check/);
  });

  it('★ group_code 공백 CHECK', async () => {
    await expect(
      getPrismaClient().commonCodeGroup.create({
        data: { groupCode: ' BAD ', groupName: 'x', sortOrder: 0 },
      }),
    ).rejects.toThrow(/common_code_group_code_not_blank_check/);
  });

  it('★ sort_order 음수 차단 (그룹·코드)', async () => {
    const client = getPrismaClient();
    const parent = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: TG_PARENT },
    });
    await expect(
      client.commonCode.create({
        data: { groupId: parent.id, code: 'NEG', name: '음수', sortOrder: -1 },
      }),
    ).rejects.toThrow(/common_code_sort_order_check/);
    await expect(
      client.commonCodeGroup.create({
        data: { groupCode: 'TG_NEG', groupName: '음수', sortOrder: -1 },
      }),
    ).rejects.toThrow(/common_code_group_sort_order_check/);
  });

  it('★ 코드가 있는 그룹은 직접 SQL 로도 삭제할 수 없다 (FK RESTRICT)', async () => {
    const client = getPrismaClient();
    const brand = await client.commonCodeGroup.findUniqueOrThrow({ where: { groupCode: 'BRAND' } });
    await expect(
      client.$executeRawUnsafe(`DELETE FROM common_code_group WHERE id = $1::uuid`, brand.id),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('★ 자식이 참조하는 parent 코드는 직접 SQL 로도 삭제할 수 없다 (FK RESTRICT)', async () => {
    const client = getPrismaClient();
    const parent = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: TG_PARENT },
    });
    const child = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: TG_CHILD },
    });

    const parentCode = await client.commonCode.create({
      data: { groupId: parent.id, code: 'PDEL', name: '부모', sortOrder: 5 },
    });
    await client.commonCode.create({
      data: {
        groupId: child.id,
        code: 'CDEL',
        name: '자식',
        sortOrder: 5,
        parentCodeId: parentCode.id,
      },
    });

    await expect(
      client.$executeRawUnsafe(`DELETE FROM common_code WHERE id = $1::uuid`, parentCode.id),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('★ 자기 자신 parent CHECK (코드·그룹)', async () => {
    const client = getPrismaClient();
    const parent = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: TG_PARENT },
    });
    const row = await client.commonCode.create({
      data: { groupId: parent.id, code: 'SELF', name: '자기', sortOrder: 6 },
    });
    await expect(
      client.$executeRawUnsafe(
        `UPDATE common_code SET parent_code_id = id WHERE id = $1::uuid`,
        row.id,
      ),
    ).rejects.toThrow(/common_code_no_self_parent_check/);
    await expect(
      client.$executeRawUnsafe(
        `UPDATE common_code_group SET parent_group_id = id WHERE id = $1::uuid`,
        parent.id,
      ),
    ).rejects.toThrow(/common_code_group_no_self_parent_check/);
  });
});

// ═══════════════════════════════════════════════════════════════
// Application Service — 실제 DB 통합
// ═══════════════════════════════════════════════════════════════
describe('★ 공통코드 서비스 통합 (실제 PostgreSQL)', () => {
  it('그룹 목록 — 수량 집계와 정렬', async () => {
    const groups = await listCodeGroups(ACTOR);
    const brand = groups.find((group) => group.groupCode === 'BRAND');
    expect(brand?.parentGroupCode).toBeNull();
    expect(brand?.codeCount).toBeGreaterThanOrEqual(2);

    const child = groups.find((group) => group.groupCode === TG_CHILD);
    expect(child?.parentGroupCode).toBe(TG_PARENT);

    // sortOrder ASC 정렬 확인
    const sortOrders = groups.map((group) => group.sortOrder);
    expect([...sortOrders].sort((a, b) => a - b)).toEqual(sortOrders);
  });

  it('★ 생성 → 감사로그 CREATE 1건이 같은 트랜잭션으로 남는다', async () => {
    const client = getPrismaClient();

    const view = await createCode(
      ACTOR,
      TG_PARENT,
      {
        code: 'AUD1',
        name: '감사 대상',
        parentCode: null,
        sortOrder: 10,
        attributes: { note: 'x' },
      },
      {},
    );

    const audits = await client.auditLog.findMany({
      where: { entityType: 'CommonCode', entityId: view.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('CREATE');
    expect(audits[0]?.actorId).toBe(ACTOR_ID);
    expect(audits[0]?.requestId).toBe('req-code-db');

    const row = await client.commonCode.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.createdBy).toBe(ACTOR_ID);
  });

  it('★ 하위 코드 생성·수정·비활성화·재활성화 전체 흐름 + active 필터', async () => {
    // 부모 생성
    await createCode(ACTOR, TG_PARENT, {
      code: 'FLOW_P',
      name: '흐름 부모',
      parentCode: null,
      sortOrder: 20,
      attributes: null,
    });
    // 자식 생성 (부모는 상위 그룹의 코드)
    const child = await createCode(ACTOR, TG_CHILD, {
      code: 'FLOW_C',
      name: '흐름 자식',
      parentCode: 'FLOW_P',
      sortOrder: 20,
      attributes: null,
    });
    expect(child.parent?.code).toBe('FLOW_P');
    expect(child.parent?.groupCode).toBe(TG_PARENT);

    // ★ 하위 active 코드가 있는 부모 비활성화 → 409
    await expect(updateCode(ACTOR, TG_PARENT, 'FLOW_P', { active: false })).rejects.toMatchObject({
      code: ERROR_CODES.CONFLICT,
      httpStatus: 409,
    });

    // 자식 먼저 비활성화 → 부모 비활성화 성공
    await updateCode(ACTOR, TG_CHILD, 'FLOW_C', { active: false });
    await updateCode(ACTOR, TG_PARENT, 'FLOW_P', { active: false });

    // ★ 비활성 부모 아래 자식 재활성화 → 409
    await expect(updateCode(ACTOR, TG_CHILD, 'FLOW_C', { active: true })).rejects.toMatchObject({
      code: ERROR_CODES.CONFLICT,
      httpStatus: 409,
    });

    // 부모 재활성화 후 자식 재활성화 성공
    await updateCode(ACTOR, TG_PARENT, 'FLOW_P', { active: true });
    const reactivated = await updateCode(ACTOR, TG_CHILD, 'FLOW_C', { active: true });
    expect(reactivated.active).toBe(true);

    // active 필터 — 비활성은 기본(active=true) 목록에서 빠지고 false 목록에 나온다
    await updateCode(ACTOR, TG_CHILD, 'FLOW_C', { active: false });
    const activeOnly = await listCodes(ACTOR, TG_CHILD, 'true');
    expect(activeOnly.codes.some((row) => row.code === 'FLOW_C')).toBe(false);
    const inactiveOnly = await listCodes(ACTOR, TG_CHILD, 'false');
    expect(inactiveOnly.codes.some((row) => row.code === 'FLOW_C')).toBe(true);
    const all = await listCodes(ACTOR, TG_CHILD, 'all');
    expect(all.codes.some((row) => row.code === 'FLOW_C')).toBe(true);

    // ★ 비활성화돼도 행은 DB 에 남는다 — 물리삭제 아님
    const client = getPrismaClient();
    const row = await client.commonCode.findUnique({ where: { id: child.id } });
    expect(row?.active).toBe(false);

    // 감사로그 액션 사슬 확인
    const audits = await client.auditLog.findMany({
      where: { entityType: 'CommonCode', entityId: child.id },
      orderBy: { occurredAt: 'asc' },
      select: { action: true },
    });
    expect(audits.map((audit) => audit.action)).toEqual([
      'CREATE',
      'DEACTIVATE',
      'REACTIVATE',
      'DEACTIVATE',
    ]);
  });

  it('★ 동일 값 PATCH 는 400 이고 감사로그가 남지 않는다', async () => {
    const client = getPrismaClient();
    const before = await client.auditLog.count({ where: { actorId: ACTOR_ID } });

    await expect(updateCode(ACTOR, TG_PARENT, 'AUD1', { name: '감사 대상' })).rejects.toMatchObject(
      { code: ERROR_CODES.VALIDATION_ERROR, httpStatus: 400 },
    );

    expect(await client.auditLog.count({ where: { actorId: ACTOR_ID } })).toBe(before);
  });

  it('★ 존재하지 않는 그룹은 404', async () => {
    await expect(listCodes(ACTOR, 'NO_SUCH', 'true')).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
      httpStatus: 404,
    });
  });

  it('정렬 — sort_order ASC, code ASC', async () => {
    const { codes } = await listCodes(ACTOR, 'MAJOR_CATEGORY', 'all');
    const keys = codes.map((row) => [row.sortOrder, row.code] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1], 'en'));
    expect(keys).toEqual(sorted);
    expect(codes[0]?.code).toBe('DV'); // 원본 첫 행
  });

  it('seed 코드의 attributes 가 원본 값 그대로 조회된다', async () => {
    const { codes } = await listCodes(ACTOR, 'CHANNEL', 'all');
    const channelA = codes.find((row) => row.code === 'A');
    expect(channelA?.name).toBe('자사몰');
    expect(channelA?.attributes).toMatchObject({
      rawLabel: 'A. 자사몰',
      salesPartner: '카페24',
      outboundType: 'B2C',
    });
  });
});
