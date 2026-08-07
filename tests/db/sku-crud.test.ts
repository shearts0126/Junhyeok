import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  SKU_CREATE_PERMISSION,
  SKU_READ_PERMISSION,
  SKU_UPDATE_PERMISSION,
  createSku,
  getSku,
  listSkus,
  parseCreateSkuInput,
  parseListSkusQuery,
  parseUpdateSkuInput,
  updateSku,
} from '@/modules/sku/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedCommonCodes } from '../../prisma/seed/common-codes';
import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * SKU CRUD DB 테스트 (T1-3) — 실제 PostgreSQL.
 *
 * 대역으로 재현할 수 없는 것을 검증한다:
 *   - DB UNIQUE 최종 판정(P2002 → 409)과 실제 감사로그 행
 *   - 감사로그 실패 시 **실 트랜잭션 롤백**
 *   - group 정체성 검증이 실 seed 코드사전 위에서 동작
 *   - RolePermission seed 가 실제 DB 에 반영
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TSC-${RUN}-${suffix}`;

const ACTOR_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const ACTOR: ActorContext = createActorContext({
  userId: ACTOR_ID,
  email: 'sku-writer@deeppoint.test',
  name: 'SKU 작성자',
  active: true,
  roles: ['SCM_STAFF'],
  permissions: [SKU_READ_PERMISSION, SKU_CREATE_PERMISSION, SKU_UPDATE_PERMISSION],
  requestId: 'req-sku-db',
});

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(`DELETE FROM audit_log WHERE actor_id = $1`, ACTOR_ID);
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TSC-' } } });
  await client.user.deleteMany({ where: { id: ACTOR_ID } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
    await seedCommonCodes(tx);
  });
  await cleanup();
  await client.user.create({
    data: { id: ACTOR_ID, email: 'sku-writer@deeppoint.test', name: 'SKU 작성자' },
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

/** seed 코드사전에서 그룹별 코드 id 를 얻는다. */
async function codeId(groupCode: string, code: string): Promise<string> {
  const client = getPrismaClient();
  const group = await client.commonCodeGroup.findUniqueOrThrow({ where: { groupCode } });
  const row = await client.commonCode.findUniqueOrThrow({
    where: { groupId_code: { groupId: group.id, code } },
  });
  return row.id;
}

async function auditRows(entityId: string) {
  return getPrismaClient().auditLog.findMany({
    where: { entityType: 'Sku', entityId },
    orderBy: { occurredAt: 'asc' },
  });
}

describe('★ RolePermission seed — sku 권한 3종 (실제 PostgreSQL)', () => {
  it('★ sku.read 5역할 / sku.create·update 는 ADMIN·SCM_LEADER·SCM_STAFF 만', async () => {
    const client = getPrismaClient();
    const rows = await client.rolePermission.findMany({
      where: { permission: { permissionKey: { in: ['sku.read', 'sku.create', 'sku.update'] } } },
      include: { role: true, permission: true },
    });

    const byKey = new Map<string, string[]>();
    for (const row of rows) {
      const list = byKey.get(row.permission.permissionKey) ?? [];
      list.push(row.role.roleCode);
      byKey.set(row.permission.permissionKey, list);
    }

    expect(byKey.get('sku.read')?.sort()).toEqual([
      'ADMIN',
      'EXECUTIVE',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    expect(byKey.get('sku.create')?.sort()).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    expect(byKey.get('sku.update')?.sort()).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
  });
});

describe('★ createSku (실제 PostgreSQL)', () => {
  it('★ 생성 + 감사로그 CREATE 가 같은 트랜잭션으로 커밋된다', async () => {
    const [brandId, majorId, minorId] = await Promise.all([
      codeId('BRAND', 'FB'),
      codeId('MAJOR_CATEGORY', 'HC'),
      codeId('MINOR_CATEGORY', 'SH'),
    ]);

    const view = await createSku(
      ACTOR,
      parseCreateSkuInput({
        skuCode: CODE('C1'),
        skuName: '실DB 생성',
        itemType: 'FINISHED',
        brandId,
        majorCategoryId: majorId,
        minorCategoryId: minorId,
        unitConversionQty: '12.5',
        serialNumber: '00042',
      }),
    );

    expect(view.status).toBe('DRAFT');
    expect(view.hasTransaction).toBe(false);
    expect(view.createdBy).toBe(ACTOR_ID);
    expect(view.unitConversionQty).toBe('12.5');
    expect(view.serialNumber).toBe('00042');
    expect(view.brand?.code).toBe('FB');

    const audits = await auditRows(view.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('CREATE');
    expect(audits[0]?.actorId).toBe(ACTOR_ID);
    expect(audits[0]?.beforeValue).toBeNull();
  });

  it('★ 중복 skuCode 는 DB UNIQUE 최종 판정 → 409 SKU_CODE_DUPLICATE, 감사로그 없음', async () => {
    const skuCode = CODE('C2');
    await createSku(ACTOR, parseCreateSkuInput({ skuCode, skuName: '먼저', itemType: 'FINISHED' }));

    const before = await getPrismaClient().auditLog.count({
      where: { entityType: 'Sku', actorId: ACTOR_ID },
    });

    await expect(
      createSku(ACTOR, parseCreateSkuInput({ skuCode, skuName: '중복', itemType: 'FINISHED' })),
    ).rejects.toMatchObject({ code: 'SKU_CODE_DUPLICATE', httpStatus: 409 });

    const after = await getPrismaClient().auditLog.count({
      where: { entityType: 'Sku', actorId: ACTOR_ID },
    });
    expect(after).toBe(before);
  });

  it('★ 다른 그룹의 실존 코드 ID 는 실패한다 — DB FK 는 통과하는 조합 (실 seed 기준)', async () => {
    // CHANNEL 그룹의 실존 코드(A=자사몰)를 brandId 에 — T1-1 limitation 해소를 실 데이터로 확인.
    const channelId = await codeId('CHANNEL', 'A');

    await expect(
      createSku(
        ACTOR,
        parseCreateSkuInput({
          skuCode: CODE('C3'),
          skuName: '그룹 불일치',
          itemType: 'FINISHED',
          brandId: channelId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // 행이 생기지 않았다
    expect(await getPrismaClient().sku.count({ where: { skuCode: CODE('C3') } })).toBe(0);
  });

  it('★ 감사로그 실패 시 SKU 생성도 롤백된다 (실 트랜잭션)', async () => {
    const skuCode = CODE('C4');
    const failingLogger = {
      write: async () => {
        throw new Error('감사로그 강제 실패');
      },
    };

    await expect(
      createSku(
        ACTOR,
        parseCreateSkuInput({ skuCode, skuName: '롤백 검증', itemType: 'FINISHED' }),
        { auditLogger: failingLogger },
      ),
    ).rejects.toThrow('감사로그 강제 실패');

    expect(await getPrismaClient().sku.count({ where: { skuCode } })).toBe(0);
  });
});

describe('★ updateSku (실제 PostgreSQL)', () => {
  it('★ 수정 + 감사로그 UPDATE(before/after) 커밋, 감사 실패 시 수정 롤백', async () => {
    const created = await createSku(
      ACTOR,
      parseCreateSkuInput({ skuCode: CODE('U1'), skuName: '수정 전', itemType: 'FINISHED' }),
    );

    const updated = await updateSku(
      ACTOR,
      created.id,
      parseUpdateSkuInput({ skuName: '수정 후', note: '실DB 수정' }),
    );
    expect(updated.skuName).toBe('수정 후');
    expect(updated.updatedBy).toBe(ACTOR_ID);

    const audits = await auditRows(created.id);
    expect(audits.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
    expect((audits[1]?.beforeValue as { skuName: string }).skuName).toBe('수정 전');
    expect((audits[1]?.afterValue as { skuName: string }).skuName).toBe('수정 후');

    // 감사 실패 → 수정 롤백
    await expect(
      updateSku(ACTOR, created.id, parseUpdateSkuInput({ skuName: '롤백되어야 함' }), {
        auditLogger: {
          write: async () => {
            throw new Error('감사로그 강제 실패');
          },
        },
      }),
    ).rejects.toThrow('감사로그 강제 실패');

    const row = await getPrismaClient().sku.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.skuName).toBe('수정 후');
  });

  it('★ ACTIVE SKU 일반 수정 차단 (422) — 실 상태값 기준', async () => {
    const created = await createSku(
      ACTOR,
      parseCreateSkuInput({ skuCode: CODE('U2'), skuName: '활성화 예정', itemType: 'FINISHED' }),
    );
    // 상태전이 API 는 T1-4 이후이므로 테스트 픽스처는 DB 직접 갱신으로 만든다.
    await getPrismaClient().sku.update({ where: { id: created.id }, data: { status: 'ACTIVE' } });

    await expect(
      updateSku(ACTOR, created.id, parseUpdateSkuInput({ skuName: '수정 시도' })),
    ).rejects.toMatchObject({ code: 'SKU_ACTIVE_UPDATE_RESTRICTED', httpStatus: 422 });
  });

  it('★ TC-SKU-007 위임 — hasTransaction=true 코드 변경 422, 코드 외 수정은 허용', async () => {
    const created = await createSku(
      ACTOR,
      parseCreateSkuInput({ skuCode: CODE('U3'), skuName: '거래 발생', itemType: 'FINISHED' }),
    );
    await getPrismaClient().sku.update({
      where: { id: created.id },
      data: { hasTransaction: true },
    });

    await expect(
      updateSku(ACTOR, created.id, parseUpdateSkuInput({ skuCode: CODE('U3X') })),
    ).rejects.toMatchObject({ code: 'SKU_CODE_IMMUTABLE', httpStatus: 422 });

    const renamed = await updateSku(
      ACTOR,
      created.id,
      parseUpdateSkuInput({ skuName: '이름은 수정 가능' }),
    );
    expect(renamed.skuName).toBe('이름은 수정 가능');
  });

  it('비활성 코드를 새로 선택하면 실패, null 해제는 허용', async () => {
    const brandId = await codeId('BRAND', 'FB');
    const created = await createSku(
      ACTOR,
      parseCreateSkuInput({
        skuCode: CODE('U4'),
        skuName: '참조 수정',
        itemType: 'FINISHED',
        brandId,
      }),
    );

    // seed 를 건드리지 않도록 테스트 전용 비활성 코드를 BRAND 그룹에 추가한다.
    const client = getPrismaClient();
    const group = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: 'BRAND' },
    });
    const inactive = await client.commonCode.upsert({
      where: { groupId_code: { groupId: group.id, code: 'ZZT_SKU_OFF' } },
      update: { active: false },
      create: {
        groupId: group.id,
        code: 'ZZT_SKU_OFF',
        name: '테스트 비활성 브랜드',
        sortOrder: 990,
        active: false,
      },
    });

    await expect(
      updateSku(ACTOR, created.id, parseUpdateSkuInput({ brandId: inactive.id })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const cleared = await updateSku(ACTOR, created.id, parseUpdateSkuInput({ brandId: null }));
    expect(cleared.brand).toBeNull();

    await client.sku.update({ where: { id: created.id }, data: { brandId: null } });
    await client.commonCode.delete({ where: { id: inactive.id } });
  });
});

describe('★ getSku · listSkus (실제 PostgreSQL)', () => {
  it('★ soft-delete 는 상세 404·목록 제외, q 는 3필드 검색', async () => {
    const keep = await createSku(
      ACTOR,
      parseCreateSkuInput({
        skuCode: CODE('L1'),
        skuName: `실DB목록유지-${RUN}`,
        itemType: 'FINISHED',
      }),
    );
    const removed = await createSku(
      ACTOR,
      parseCreateSkuInput({
        skuCode: CODE('L2'),
        skuName: `실DB목록삭제-${RUN}`,
        itemType: 'FINISHED',
      }),
    );
    await getPrismaClient().sku.update({
      where: { id: removed.id },
      data: { deletedAt: new Date() },
    });

    await expect(getSku(ACTOR, removed.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
    expect((await getSku(ACTOR, keep.id)).id).toBe(keep.id);

    const bySkuName = await listSkus(
      ACTOR,
      parseListSkusQuery(new URLSearchParams(`q=실DB목록&pageSize=50`)),
    );
    const ids = bySkuName.items.map((item) => item.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(removed.id);

    // skuCode 로도 검색된다 (대소문자 무시)
    const byCode = await listSkus(
      ACTOR,
      parseListSkusQuery(new URLSearchParams(`q=tsc-${RUN}-l1`)),
    );
    expect(byCode.items.map((item) => item.id)).toContain(keep.id);
  });

  it('정렬 skuCode_asc + tie-breaker 가 결정적이다', async () => {
    const result = await listSkus(
      ACTOR,
      parseListSkusQuery(new URLSearchParams(`q=TSC-${RUN}&sort=skuCode_asc&pageSize=200`)),
    );
    const codes = result.items.map((item) => item.skuCode);
    expect(codes.length).toBeGreaterThan(1);
    expect([...codes].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(codes);
    expect(result.total).toBe(result.items.length);
  });
});
