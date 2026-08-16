import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  createBom,
  createBomLine,
  hasBomUsage,
  listBomWhereUsed,
  BOM_CREATE_PERMISSION,
  BOM_READ_PERMISSION,
  BOM_UPDATE_PERMISSION,
  parseDateOnly,
} from '@/modules/bom/application';
import { canArchiveSku, skuArchiveBlockers } from '@/modules/sku/domain';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * where-used · hasBomUsage DB 통합 테스트 (T07-3) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-30(T1-6B5 boundary) · §D-32(hasBomUsage).
 *
 * 두 read 계약이 **서로 다른 질문**에 답한다는 것을 고정한다:
 *   - `where-used`  : 이 SKU 가 **구성품으로** 쓰인 **라인들** (T1-6B5 ⑦탭 항목 2)
 *   - `?parentSkuId=`: 이 SKU 가 **상위인** BOM 들 (⑦탭 항목 1) — CRUD 테스트가 다룬다
 *   - `hasBomUsage` : parent **또는** component 로 쓰인 적이 있는가 (archive 판정)
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TBU-${RUN}-${suffix}`;

const STAFF_ID = 'ddd00000-0000-4000-8000-0000000d7001';
const EXEC_ID = 'ddd00000-0000-4000-8000-0000000d7002';
const NOPERM_ID = 'ddd00000-0000-4000-8000-0000000d7003';
const ACTOR_IDS = [STAFF_ID, EXEC_ID, NOPERM_ID];

const STAFF: ActorContext = createActorContext({
  userId: STAFF_ID,
  email: 'usage-staff@deeppoint.test',
  name: 'BOM 담당자',
  active: true,
  roles: ['SCM_STAFF'],
  permissions: [BOM_READ_PERMISSION, BOM_CREATE_PERMISSION, BOM_UPDATE_PERMISSION],
  requestId: 'req-usage-staff',
});

/** ★ EXECUTIVE 도 where-used 를 읽는다 (D-15·D-30). */
const EXECUTIVE: ActorContext = createActorContext({
  userId: EXEC_ID,
  email: 'usage-exec@deeppoint.test',
  name: '경영진',
  active: true,
  roles: ['EXECUTIVE'],
  permissions: [BOM_READ_PERMISSION],
  requestId: 'req-usage-exec',
});

const NO_PERMISSION: ActorContext = createActorContext({
  userId: NOPERM_ID,
  email: 'usage-noperm@deeppoint.test',
  name: '권한 없는 관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: [],
  requestId: 'req-usage-noperm',
});

let seq = 0;

async function newSku(label: string, overrides: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `usage SKU (${label})`,
      itemType: 'FINISHED_GOOD',
      ...overrides,
    },
    select: { id: true },
  });
  return row.id;
}

/** 임의 status 의 BOM 을 라인과 함께 만든다 (status 는 raw UPDATE 로 맞춘다). */
async function makeBom(
  parentSkuId: string,
  components: readonly string[],
  options: { status?: string; from?: string; alternateGroups?: readonly (string | null)[] } = {},
): Promise<string> {
  const client = getPrismaClient();
  seq += 1;
  const header = await client.bomHeader.create({
    data: {
      parentSkuId,
      bomType: 'MANUFACTURING',
      version: `u${String(seq).padStart(4, '0')}`,
      outputUom: 'EA',
      effectiveFrom: parseDateOnly(options.from ?? '2026-01-01'),
    },
    select: { id: true },
  });
  let lineNo = 0;
  for (const componentSkuId of components) {
    const alternateGroup = options.alternateGroups?.[lineNo] ?? null;
    lineNo += 1;
    await client.bomLine.create({
      data: {
        bomHeaderId: header.id,
        lineNo,
        componentSkuId,
        uom: 'EA',
        componentRole: 'MATERIAL',
        alternateGroup,
      },
    });
  }
  if (options.status !== undefined && options.status !== 'DRAFT') {
    await client.$executeRawUnsafe(
      `UPDATE bom_header SET status = $1::"BomStatus" WHERE id = $2::uuid`,
      options.status,
      header.id,
    );
  }
  return header.id;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('예외가 발생하지 않았다');
}

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`,
    ACTOR_IDS,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({ where: { actorId: { in: ACTOR_IDS } } });
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TBU-' } } } },
  });
  await client.bomLine.deleteMany({ where: { componentSku: { skuCode: { startsWith: 'TBU-' } } } });
  await client.bomHeader.deleteMany({ where: { parentSku: { skuCode: { startsWith: 'TBU-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TBU-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: 'usage 테스트' })),
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// GET /api/skus/{id}/where-used (D-30)
// ═══════════════════════════════════════════════════════════════

describe('★ where-used — 이 SKU 를 구성품으로 쓰는 BOM (D-30)', () => {
  it('쓰이지 않으면 빈 배열이다 (404 아님)', async () => {
    const orphan = await newSku('orphan', { status: 'ACTIVE' });
    expect(await listBomWhereUsed(STAFF, orphan)).toEqual({ items: [] });
  });

  it('한 BOM 에서 쓰이면 상위 SKU·버전·상태·소요량이 나온다', async () => {
    const parent = await newSku('wu-parent', { status: 'ACTIVE' });
    const component = await newSku('wu-comp', { status: 'ACTIVE' });
    const bomId = await makeBom(parent, [component]);

    const { items } = await listBomWhereUsed(STAFF, component);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      bomHeaderId: bomId,
      parentSkuId: parent,
      status: 'DRAFT',
      lineNo: 1,
      quantityStatus: 'UNKNOWN',
      quantityPer: null,
      componentRole: 'MATERIAL',
      isRequired: true,
    });
    expect(items[0]?.parentSku).toMatchObject({ id: parent });
  });

  it('여러 BOM 에서 쓰이면 여러 행이 나온다', async () => {
    const p1 = await newSku('wu2-p1', { status: 'ACTIVE' });
    const p2 = await newSku('wu2-p2', { status: 'ACTIVE' });
    const component = await newSku('wu2-c', { status: 'ACTIVE' });
    await makeBom(p1, [component]);
    await makeBom(p2, [component]);

    const { items } = await listBomWhereUsed(STAFF, component);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.parentSkuId))).toEqual(new Set([p1, p2]));
  });

  it('★★ 같은 BOM 에 대체그룹만 다른 라인으로 두 번 쓰이면 **행이 2개**다 — header 를 접지 않는다', async () => {
    const parent = await newSku('wu3-p', { status: 'ACTIVE' });
    const component = await newSku('wu3-c', { status: 'ACTIVE' });
    const bomId = await makeBom(parent, [component, component], {
      alternateGroups: ['G1', 'G2'],
    });

    const { items } = await listBomWhereUsed(STAFF, component);
    expect(items).toHaveLength(2);
    // 같은 header 가 두 번 나온다 — 소요량이 라인 단위 사실이기 때문이다.
    expect(items.every((item) => item.bomHeaderId === bomId)).toBe(true);
    expect(items.map((item) => item.alternateGroup)).toEqual(['G1', 'G2']);
    expect(items.map((item) => item.lineNo)).toEqual([1, 2]);
  });

  it('★ status 로 거르지 않는다 — 모든 상태의 BOM 이 나온다', async () => {
    const component = await newSku('wu4-c', { status: 'ACTIVE' });
    const statuses = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'INACTIVE', 'ARCHIVED'];
    for (const status of statuses) {
      const parent = await newSku(`wu4-p-${status}`, { status: 'ACTIVE' });
      await makeBom(parent, [component], { status });
    }
    const { items } = await listBomWhereUsed(STAFF, component);
    expect(items).toHaveLength(statuses.length);
    expect(new Set(items.map((item) => item.status))).toEqual(new Set(statuses));
  });

  it('★ 적용기간으로도 거르지 않는다 — 과거·미래 BOM 이 모두 나온다', async () => {
    const component = await newSku('wu5-c', { status: 'ACTIVE' });
    const past = await newSku('wu5-past', { status: 'ACTIVE' });
    const future = await newSku('wu5-future', { status: 'ACTIVE' });
    await makeBom(past, [component], { from: '2000-01-01' });
    await makeBom(future, [component], { from: '2099-01-01' });
    expect((await listBomWhereUsed(STAFF, component)).items).toHaveLength(2);
  });

  it('★ parent 로만 쓰인 SKU 는 where-used 에 나오지 않는다 — 두 질문은 다르다', async () => {
    const parent = await newSku('wu6-p', { status: 'ACTIVE' });
    const component = await newSku('wu6-c', { status: 'ACTIVE' });
    await makeBom(parent, [component]);
    expect((await listBomWhereUsed(STAFF, parent)).items).toEqual([]);
  });

  it('없는 SKU 는 404 다 — 빈 배열로 위장하지 않는다', async () => {
    expect(await codeOf(listBomWhereUsed(STAFF, '99999999-9999-4999-8999-999999999999'))).toBe(
      ERROR_CODES.NOT_FOUND,
    );
  });

  it('UUID 형식 오류는 400 이다', async () => {
    expect(await codeOf(listBomWhereUsed(STAFF, 'not-a-uuid'))).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('★ EXECUTIVE 는 읽을 수 있고, permission 없는 ADMIN 은 403 이다', async () => {
    const parent = await newSku('wu7-p', { status: 'ACTIVE' });
    const component = await newSku('wu7-c', { status: 'ACTIVE' });
    await makeBom(parent, [component]);

    await expect(listBomWhereUsed(EXECUTIVE, component)).resolves.toMatchObject({
      items: expect.any(Array),
    });
    expect(await codeOf(listBomWhereUsed(NO_PERMISSION, component))).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ read 는 AuditLog 를 만들지 않는다', async () => {
    const parent = await newSku('wu8-p', { status: 'ACTIVE' });
    const component = await newSku('wu8-c', { status: 'ACTIVE' });
    await makeBom(parent, [component]);
    const before = await getPrismaClient().auditLog.count({ where: { actorId: EXEC_ID } });
    await listBomWhereUsed(EXECUTIVE, component);
    expect(await getPrismaClient().auditLog.count({ where: { actorId: EXEC_ID } })).toBe(before);
  });

  it('정렬이 결정적이다 — 같은 입력에 같은 순서', async () => {
    const component = await newSku('wu9-c', { status: 'ACTIVE' });
    for (let i = 0; i < 3; i += 1) {
      const parent = await newSku(`wu9-p${i}`, { status: 'ACTIVE' });
      await makeBom(parent, [component]);
    }
    const first = await listBomWhereUsed(STAFF, component);
    const second = await listBomWhereUsed(STAFF, component);
    expect(second.items.map((item) => item.lineId)).toEqual(first.items.map((item) => item.lineId));
  });
});

// ═══════════════════════════════════════════════════════════════
// hasBomUsage provider (D-32)
// ═══════════════════════════════════════════════════════════════

describe('★ hasBomUsage provider (D-32)', () => {
  it('쓰이지 않은 SKU 는 false 다', async () => {
    const orphan = await newSku('hu-orphan', { status: 'ACTIVE' });
    expect(await hasBomUsage(orphan)).toBe(false);
  });

  it('★ parent 로만 쓰여도 true 다', async () => {
    const parent = await newSku('hu-parent', { status: 'ACTIVE' });
    const component = await newSku('hu-parent-c', { status: 'ACTIVE' });
    await makeBom(parent, [component]);
    expect(await hasBomUsage(parent)).toBe(true);
  });

  it('★ component 로만 쓰여도 true 다', async () => {
    const parent = await newSku('hu-comp-p', { status: 'ACTIVE' });
    const component = await newSku('hu-comp', { status: 'ACTIVE' });
    await makeBom(parent, [component]);
    expect(await hasBomUsage(component)).toBe(true);
  });

  it('둘 다여도 true 다', async () => {
    const middle = await newSku('hu-both', { status: 'ACTIVE' });
    const top = await newSku('hu-both-top', { status: 'ACTIVE' });
    const bottom = await newSku('hu-both-bottom', { status: 'ACTIVE' });
    await makeBom(top, [middle]);
    await makeBom(middle, [bottom]);
    expect(await hasBomUsage(middle)).toBe(true);
  });

  it('★ ARCHIVED·INACTIVE BOM 에 쓰인 것도 true 다 — 이력을 숨기지 않는다', async () => {
    for (const status of ['ARCHIVED', 'INACTIVE']) {
      const parent = await newSku(`hu-${status}-p`, { status: 'ACTIVE' });
      const component = await newSku(`hu-${status}-c`, { status: 'ACTIVE' });
      await makeBom(parent, [component], { status });
      expect(await hasBomUsage(component), status).toBe(true);
      expect(await hasBomUsage(parent), status).toBe(true);
    }
  });

  it('★ optional·SERVICE·UNKNOWN 라인도 usage 다 — 라인 속성으로 거르지 않는다', async () => {
    const parent = await newSku('hu-attr-p', { status: 'ACTIVE' });
    const optional = await newSku('hu-attr-opt', { status: 'ACTIVE' });
    const service = await newSku('hu-attr-svc', { status: 'ACTIVE', inventoryManaged: false });
    const client = getPrismaClient();
    seq += 1;
    const header = await client.bomHeader.create({
      data: {
        parentSkuId: parent,
        bomType: 'MANUFACTURING',
        version: `ua${String(seq).padStart(4, '0')}`,
        outputUom: 'EA',
        effectiveFrom: parseDateOnly('2026-01-01'),
      },
      select: { id: true },
    });
    await client.bomLine.createMany({
      data: [
        {
          bomHeaderId: header.id,
          lineNo: 1,
          componentSkuId: optional,
          uom: 'EA',
          componentRole: 'MATERIAL',
          isRequired: false,
        },
        {
          bomHeaderId: header.id,
          lineNo: 2,
          componentSkuId: service,
          uom: 'EA',
          componentRole: 'SERVICE',
        },
      ],
    });

    expect(await hasBomUsage(optional)).toBe(true);
    expect(await hasBomUsage(service)).toBe(true);
  });

  it('★ 라인이 삭제되면 usage 도 사라진다 — 현재 사실을 본다', async () => {
    const parent = await newSku('hu-del-p', { status: 'ACTIVE' });
    const component = await newSku('hu-del-c', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, {
      parentSkuId: parent,
      bomType: 'MANUFACTURING',
      version: `hd-${RUN}`,
      effectiveFrom: '2026-01-01',
    });
    const { line } = await createBomLine(STAFF, bom.id, {
      componentSkuId: component,
      componentRole: 'MATERIAL',
    });
    expect(await hasBomUsage(component)).toBe(true);
    await getPrismaClient().bomLine.delete({ where: { id: line.id } });
    expect(await hasBomUsage(component)).toBe(false);
    // parent 쪽 usage 는 헤더가 남아 있으므로 그대로 true 다.
    expect(await hasBomUsage(parent)).toBe(true);
  });

  it('★★ canArchiveSku 와 결합하면 BOM_USAGE blocker 가 된다 (D-32)', async () => {
    const parent = await newSku('hu-arch-p', { status: 'ACTIVE' });
    const component = await newSku('hu-arch-c', { status: 'ACTIVE' });
    await makeBom(parent, [component]);

    const usedFacts = { hasTransaction: false, hasBomUsage: await hasBomUsage(component) };
    expect(canArchiveSku(usedFacts)).toBe(false);
    expect(skuArchiveBlockers(usedFacts)).toContain('BOM_USAGE');

    const free = await newSku('hu-arch-free', { status: 'ACTIVE' });
    const freeFacts = { hasTransaction: false, hasBomUsage: await hasBomUsage(free) };
    expect(canArchiveSku(freeFacts)).toBe(true);
    expect(skuArchiveBlockers(freeFacts)).toEqual([]);
  });
});
