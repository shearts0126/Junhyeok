import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  SKU_CREATE_PERMISSION,
  SKU_READ_PERMISSION,
  SKU_SUGGEST_CODE_PERMISSION,
  createSku,
  parseCreateSkuInput,
  parseSuggestSkuCodeInput,
  suggestSkuCode,
} from '@/modules/sku/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedCommonCodes } from '../../prisma/seed/common-codes';
import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * SKU 코드 추천 DB 테스트 (T03-7) — 실제 PostgreSQL.
 *
 * 대역으로 재현할 수 없는 것:
 *   - **동시 추천**이 같은 코드를 내도 되고(예약 없음), 그 코드로 실제 생성하면
 *     정확히 하나만 성공하는 UNIQUE 최종방어
 *   - soft-delete·ARCHIVED 행이 serial 계산에 포함되는지 (실 컬럼 기준)
 *   - 추천이 **아무 행도 만들지 않는지** (Sku·AuditLog·IdempotencyRecord)
 *   - RolePermission 시드 반영
 */

const RUN = randomBytes(3).toString('hex').toUpperCase();
const ACTOR_ID = '99999999-9999-4999-8999-999999999901';
const READER_ID = '99999999-9999-4999-8999-999999999902';

function actorOf(userId: string, permissions: readonly string[], roles: string[]): ActorContext {
  return createActorContext({
    userId,
    email: `suggest-${userId.slice(-1)}@deeppoint.test`,
    name: '추천 테스트',
    active: true,
    roles,
    permissions,
    requestId: 'req-suggest-db',
  });
}

const ACTOR = actorOf(
  ACTOR_ID,
  [SKU_READ_PERMISSION, SKU_CREATE_PERMISSION, SKU_SUGGEST_CODE_PERMISSION],
  ['SCM_STAFF'],
);
const READER = actorOf(READER_ID, [SKU_READ_PERMISSION], ['FINANCE']);

/** 테스트 전용 공통코드 (ZZT_ 접두사) — 실 seed 코드를 오염시키지 않는다. */
let brandId = '';
let majorId = '';
let minorId = '';
let brandCode = '';
let majorCode = '';
let minorCode = '';
let prefix = '';

async function upsertCode(groupCode: string, code: string, name: string) {
  const client = getPrismaClient();
  const group = await client.commonCodeGroup.findUniqueOrThrow({ where: { groupCode } });
  return client.commonCode.upsert({
    where: { groupId_code: { groupId: group.id, code } },
    update: { active: true, name },
    create: { groupId: group.id, code, name, sortOrder: 980, active: true },
  });
}

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id IN ($1::uuid, $2::uuid)`,
    ACTOR_ID,
    READER_ID,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({ where: { actorId: { in: [ACTOR_ID, READER_ID] } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: `ZB${RUN}-` } } });
  await client.commonCode.deleteMany({ where: { code: { startsWith: `ZZT_SG${RUN}` } } });
  await client.user.deleteMany({ where: { id: { in: [ACTOR_ID, READER_ID] } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
    await seedCommonCodes(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: [
      { id: ACTOR_ID, email: 'suggest-1@deeppoint.test', name: '추천 사용자' },
      { id: READER_ID, email: 'suggest-2@deeppoint.test', name: '조회 전용' },
    ],
  });

  // prefix 세그먼트를 테스트 전용 코드로 만들어 실 데이터와 충돌하지 않게 한다.
  brandCode = `ZB${RUN}`;
  majorCode = `ZM${RUN}`;
  minorCode = `ZN${RUN}`;
  const [brand, major, minor] = await Promise.all([
    upsertCode('BRAND', brandCode, '추천 테스트 브랜드'),
    upsertCode('MAJOR_CATEGORY', majorCode, '추천 테스트 대분류'),
    upsertCode('MINOR_CATEGORY', minorCode, '추천 테스트 소분류'),
  ]);
  brandId = brand.id;
  majorId = major.id;
  minorId = minor.id;
  prefix = `${brandCode}-${majorCode}-${minorCode}`;
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

function request() {
  return parseSuggestSkuCodeInput({ brandId, majorId, minorId });
}

/** 감사로그 없이 SKU 행만 만든다 (serial 점유 픽스처). */
async function seedSkuRow(skuCode: string, overrides: Record<string, unknown> = {}) {
  await getPrismaClient().sku.create({
    data: {
      skuCode,
      skuName: `추천 픽스처 ${skuCode}`,
      itemType: 'FINISHED_GOOD',
      createdBy: ACTOR_ID,
      updatedBy: ACTOR_ID,
      ...overrides,
    },
  });
}

describe('★ RolePermission seed — sku.suggest_code (실제 PostgreSQL)', () => {
  it('★ ADMIN·SCM_LEADER·SCM_STAFF 만 보유한다', async () => {
    const rows = await getPrismaClient().rolePermission.findMany({
      where: { permission: { permissionKey: 'sku.suggest_code' } },
      include: { role: true },
    });
    expect(rows.map((row) => row.role.roleCode).sort()).toEqual([
      'ADMIN',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
  });
});

describe('★ suggestSkuCode (실제 PostgreSQL)', () => {
  it('★ 첫 추천은 001, 이후 MAX+1 — soft-delete·ARCHIVED 도 사용 이력이다', async () => {
    const first = await suggestSkuCode(ACTOR, request());
    expect(first).toEqual({ suggestedCode: `${prefix}-001`, serialNumber: '001' });

    // 001 = 일반, 002 = soft-deleted, 003 = ARCHIVED → 다음은 004 (gap 재사용 없음)
    await seedSkuRow(`${prefix}-001`);
    await seedSkuRow(`${prefix}-002`, { deletedAt: new Date() });
    await seedSkuRow(`${prefix}-003`, { status: 'ARCHIVED' });

    const next = await suggestSkuCode(ACTOR, request());
    expect(next.suggestedCode).toBe(`${prefix}-004`);
  });

  it('★ legacy suffix 코드가 serial 을 점유한다 (FB-…-005-EU 형태)', async () => {
    await seedSkuRow(`${prefix}-005-EU`);
    const result = await suggestSkuCode(ACTOR, request());
    expect(result.suggestedCode).toBe(`${prefix}-006`);
    // ⛔ additionalCode 를 자동으로 붙이지 않는다 — 항상 4세그먼트
    expect(result.suggestedCode.split('-')).toHaveLength(4);
  });

  it('★ 비정형 legacy 는 무시된다 — A01·01·0001', async () => {
    await seedSkuRow(`${prefix}-A01`);
    await seedSkuRow(`${prefix}-01`);
    await seedSkuRow(`${prefix}-0001`);
    const result = await suggestSkuCode(ACTOR, request());
    // 앞 테스트까지의 최대는 005(-EU) → 여전히 006
    expect(result.suggestedCode).toBe(`${prefix}-006`);
  });

  it('★ 추천은 아무 것도 저장하지 않는다 — Sku·AuditLog·IdempotencyRecord 불변', async () => {
    const client = getPrismaClient();
    const before = await Promise.all([
      client.sku.count(),
      client.auditLog.count(),
      client.idempotencyRecord.count(),
    ]);

    await suggestSkuCode(ACTOR, request());
    await suggestSkuCode(ACTOR, request());

    const after = await Promise.all([
      client.sku.count(),
      client.auditLog.count(),
      client.idempotencyRecord.count(),
    ]);
    expect(after).toEqual(before);
  });

  it('★ 권한 없으면 403 (실 시드 기준 FINANCE)', async () => {
    await expect(suggestSkuCode(READER, request())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
  });

  it('★ 다른 group·비활성·미존재 공통코드는 400', async () => {
    const client = getPrismaClient();
    const channelGroup = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: 'CHANNEL' },
    });
    const channel = await client.commonCode.findFirstOrThrow({
      where: { groupId: channelGroup.id },
    });
    const inactive = await upsertCode('BRAND', `ZZT_SG${RUN}_OFF`, '비활성 추천 브랜드');
    await client.commonCode.update({ where: { id: inactive.id }, data: { active: false } });

    for (const bad of [
      { brandId: channel.id, majorId, minorId },
      { brandId, majorId: channel.id, minorId },
      { brandId, majorId, minorId: channel.id },
      { brandId: inactive.id, majorId, minorId },
      { brandId: '00000000-0000-4000-8000-000000000000', majorId, minorId },
    ]) {
      await expect(
        suggestSkuCode(ACTOR, parseSuggestSkuCodeInput(bad)),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 400 });
    }
  });

  it('★ 999 소진 시 409 SKU_CODE_SEQUENCE_EXHAUSTED', async () => {
    // 별도 조합을 만들어 999 를 점유한다 (다른 테스트에 영향 없음).
    const exhaustMinor = await upsertCode('MINOR_CATEGORY', `ZZT_SG${RUN}_X`, '소진 테스트');
    const exhaustPrefix = `${brandCode}-${majorCode}-ZZT_SG${RUN}_X`;
    await seedSkuRow(`${exhaustPrefix}-999`);

    await expect(
      suggestSkuCode(
        ACTOR,
        parseSuggestSkuCodeInput({ brandId, majorId, minorId: exhaustMinor.id }),
      ),
    ).rejects.toMatchObject({ code: 'SKU_CODE_SEQUENCE_EXHAUSTED', httpStatus: 409 });
  });
});

describe('★ 동시 추천 — 예약 없음, UNIQUE 가 최종 방어선 (실제 PostgreSQL)', () => {
  it('★ 동시 호출은 같은 코드를 받을 수 있고, 그 코드로 생성하면 하나만 성공한다', async () => {
    // 이 테스트 전용 조합
    const ccMinor = await upsertCode('MINOR_CATEGORY', `ZZT_SG${RUN}_C`, '동시성 테스트');
    const ccRequest = parseSuggestSkuCodeInput({ brandId, majorId, minorId: ccMinor.id });

    const [a, b] = await Promise.all([
      suggestSkuCode(ACTOR, ccRequest),
      suggestSkuCode(ACTOR, ccRequest),
    ]);

    // 예약이 없으므로 동일 코드가 나오는 것이 정상이다.
    expect(a.suggestedCode).toBe(b.suggestedCode);
    expect(a.serialNumber).toBe('001');

    // ★ 추천 자체는 SKU 를 만들지 않았다
    expect(await getPrismaClient().sku.count({ where: { skuCode: a.suggestedCode } })).toBe(0);

    // 같은 추천 코드로 실제 생성 2건 동시 실행 → 정확히 하나만 성공
    const results = await Promise.allSettled([
      createSku(
        ACTOR,
        parseCreateSkuInput({
          skuCode: a.suggestedCode,
          skuName: '동시 생성 A',
          itemType: 'FINISHED_GOOD',
        }),
      ),
      createSku(
        ACTOR,
        parseCreateSkuInput({
          skuCode: b.suggestedCode,
          skuName: '동시 생성 B',
          itemType: 'FINISHED_GOOD',
        }),
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'SKU_CODE_DUPLICATE',
      httpStatus: 409,
    });
    expect(await getPrismaClient().sku.count({ where: { skuCode: a.suggestedCode } })).toBe(1);

    // 실패한 사용자는 다시 추천을 받아 다음 번호를 쓴다
    const retry = await suggestSkuCode(ACTOR, ccRequest);
    expect(retry.suggestedCode).toBe(`${brandCode}-${majorCode}-ZZT_SG${RUN}_C-002`);
  });
});
