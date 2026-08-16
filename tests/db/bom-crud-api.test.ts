import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  createBom,
  createBomLine,
  deleteBomLine,
  getBom,
  listBoms,
  updateBom,
  updateBomLine,
  parseCreateBomInput,
  BOM_CREATE_PERMISSION,
  BOM_HEADER_ENTITY_TYPE,
  BOM_LINE_ENTITY_TYPE,
  BOM_READ_PERMISSION,
  BOM_UPDATE_PERMISSION,
  parseDateOnly,
  type CreateBomInput,
  type CreateLineInput,
} from '@/modules/bom/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * BOM CRUD API DB 통합 테스트 (T07-3) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-6·§D-9~§D-17·§D-28·§D-29·§D-32 test matrix.
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - `BOM_ACTIVE_IMMUTABLE` (**TC-BOM-005**) 과 나머지 상태의 `BOM_NOT_EDITABLE`
 *   - 5역할 권한 matrix (★ EXECUTIVE read 가능 · FINANCE mutation 불가)
 *   - 멱등 scope 가 **BOM 별로 독립**인지
 *   - AuditLog **건수·action** 이 D-16 계약대로인지 (no-op·실패 시 0)
 *   - **header PATCH 로 `effectiveFrom` 변경 시 cycle 재검사**와 전체 rollback
 *   - **tentative line INSERT → cycle → 라인·audit·멱등 결과 전부 rollback**
 *   - `alternate_group = ''` 행이 **생기지 않음**
 *   - T07-1 DB 제약(version UNIQUE · 라인 2종 UNIQUE)의 오류 번역
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TBC-${RUN}-${suffix}`;

const STAFF_ID = 'ccc00000-0000-4000-8000-0000000c7001';
const READER_ID = 'ccc00000-0000-4000-8000-0000000c7002';
const FINANCE_ID = 'ccc00000-0000-4000-8000-0000000c7003';
const EXEC_ID = 'ccc00000-0000-4000-8000-0000000c7004';
const NOPERM_ID = 'ccc00000-0000-4000-8000-0000000c7005';
const ACTOR_IDS = [STAFF_ID, READER_ID, FINANCE_ID, EXEC_ID, NOPERM_ID];

const actor = (
  userId: string,
  roles: string[],
  permissions: string[],
  name: string,
): ActorContext =>
  createActorContext({
    userId,
    email: `${userId}@deeppoint.test`,
    name,
    active: true,
    roles,
    permissions,
    requestId: `req-${userId}`,
  });

/** SCM_STAFF — read·create·update 전부. */
const STAFF = actor(
  STAFF_ID,
  ['SCM_STAFF'],
  [BOM_READ_PERMISSION, BOM_CREATE_PERMISSION, BOM_UPDATE_PERMISSION],
  'BOM 담당자',
);
/** read 만. */
const READER = actor(READER_ID, ['SCM_STAFF'], [BOM_READ_PERMISSION], 'BOM 조회자');
/** ★ FINANCE — read 만. mutation 권한이 하나도 없다 (D-15). */
const FINANCE = actor(FINANCE_ID, ['FINANCE'], [BOM_READ_PERMISSION], '재무');
/** ★ EXECUTIVE — read 가능 (supplier 와 정반대). */
const EXECUTIVE = actor(EXEC_ID, ['EXECUTIVE'], [BOM_READ_PERMISSION], '경영진');
/** ADMIN role 이지만 permission 데이터가 없다 — bypass 가 없음을 고정한다. */
const NO_PERMISSION = actor(NOPERM_ID, ['ADMIN'], [], '권한 없는 관리자');

let seq = 0;

async function newSku(label: string, overrides: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `CRUD SKU (${label})`,
      itemType: 'FINISHED_GOOD',
      ...overrides,
    },
    select: { id: true },
  });
  return row.id;
}

function bomInput(parentSkuId: string, overrides: Partial<CreateBomInput> = {}): CreateBomInput {
  seq += 1;
  return {
    parentSkuId,
    bomType: 'MANUFACTURING',
    version: `v${String(seq).padStart(4, '0')}`,
    effectiveFrom: '2026-01-01',
    ...overrides,
  };
}

function lineInput(
  componentSkuId: string,
  overrides: Partial<CreateLineInput> = {},
): CreateLineInput {
  return { componentSkuId, componentRole: 'MATERIAL', ...overrides };
}

async function setStatus(bomId: string, status: string): Promise<void> {
  await getPrismaClient().$executeRawUnsafe(
    `UPDATE bom_header SET status = $1::"BomStatus" WHERE id = $2::uuid`,
    status,
    bomId,
  );
}

async function auditsOf(entityType: string, entityId: string) {
  return getPrismaClient().auditLog.findMany({
    where: { entityType, entityId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { action: true, actorId: true },
  });
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
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TBC-' } } } },
  });
  await client.bomLine.deleteMany({ where: { componentSku: { skuCode: { startsWith: 'TBC-' } } } });
  await client.bomHeader.deleteMany({
    where: { parentSku: { skuCode: { startsWith: 'TBC-' } } },
  });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TBC-' } } });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TBC-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: 'BOM 테스트' })),
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 권한 — 5역할 matrix (D-15)
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — proxy 를 신뢰하지 않는 2차 가드 (D-15)', () => {
  it('★ EXECUTIVE 는 BOM 을 읽을 수 있다 — 공급조건 탭과 정반대다', async () => {
    const parent = await newSku('exec', { status: 'ACTIVE' });
    const created = await createBom(STAFF, bomInput(parent));
    await expect(getBom(EXECUTIVE, created.bom.id)).resolves.toMatchObject({ id: created.bom.id });
    await expect(listBoms(EXECUTIVE, { page: 1 })).resolves.toBeDefined();
  });

  it('★ FINANCE 는 read 만 — create·update 는 403 이다', async () => {
    const parent = await newSku('fin', { status: 'ACTIVE' });
    await expect(listBoms(FINANCE, { page: 1 })).resolves.toBeDefined();
    expect(await codeOf(createBom(FINANCE, bomInput(parent)))).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ ADMIN role 이어도 permission 데이터가 없으면 전부 403 — bypass 없음', async () => {
    const parent = await newSku('bypass', { status: 'ACTIVE' });
    const created = await createBom(STAFF, bomInput(parent));
    expect(await codeOf(listBoms(NO_PERMISSION, { page: 1 }))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(getBom(NO_PERMISSION, created.bom.id))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(createBom(NO_PERMISSION, bomInput(parent)))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(updateBom(NO_PERMISSION, created.bom.id, { description: 'x' }))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it('read 권한만 있는 actor 는 mutation 이 403 이다', async () => {
    const parent = await newSku('ro', { status: 'ACTIVE' });
    const created = await createBom(STAFF, bomInput(parent));
    const component = await newSku('ro-c', { status: 'ACTIVE' });
    expect(await codeOf(createBomLine(READER, created.bom.id, lineInput(component)))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
    expect(await codeOf(deleteBomLine(READER, created.bom.id, created.bom.id))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it('★ 권한 실패는 AuditLog 를 남기지 않는다', async () => {
    const parent = await newSku('noaudit', { status: 'ACTIVE' });
    await codeOf(createBom(FINANCE, bomInput(parent)));
    const audits = await getPrismaClient().auditLog.findMany({ where: { actorId: FINANCE_ID } });
    expect(audits).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/boms (D-14 · D-2 · D-12 · D-11)
// ═══════════════════════════════════════════════════════════════

describe('BOM 생성 (D-14)', () => {
  it('★ 항상 DRAFT · createdBy=actor · approve/activate 필드는 null 이다', async () => {
    const parent = await newSku('create', { status: 'ACTIVE' });
    const { bom, replayed } = await createBom(STAFF, bomInput(parent));
    expect(replayed).toBe(false);
    expect(bom.status).toBe('DRAFT');
    expect(bom.createdBy).toBe(STAFF_ID);
    expect(bom.approvedAt).toBeNull();
    expect(bom.approvedBy).toBeNull();
    expect(bom.activatedAt).toBeNull();
  });

  it('★ 라인을 자동 생성하지 않는다', async () => {
    const parent = await newSku('noline', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    expect(bom.lineCount).toBe(0);
    expect(bom.unconfirmedCount).toBe(0);
    const detail = await getBom(STAFF, bom.id);
    expect(detail.lines).toEqual([]);
  });

  it('outputQty 기본은 "1" 이고 Decimal 은 문자열이다', async () => {
    const parent = await newSku('qty', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    expect(bom.outputQty).toBe('1');
    expect(typeof bom.outputQty).toBe('string');
  });

  it('★ outputUom 생략 시 parent baseUom 으로 채운다 (D-11)', async () => {
    const parent = await newSku('uom', { status: 'ACTIVE', baseUom: 'BOX' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    expect(bom.outputUom).toBe('BOX');
  });

  it('★ outputUom 이 parent baseUom 과 다르면 422 BOM_UOM_MISMATCH', async () => {
    const parent = await newSku('uom2', { status: 'ACTIVE', baseUom: 'EA' });
    expect(await codeOf(createBom(STAFF, bomInput(parent, { outputUom: 'BOX' })))).toBe(
      ERROR_CODES.BOM_UOM_MISMATCH,
    );
  });

  it('★ DRAFT 상위 SKU 는 422 BOM_PARENT_NOT_ELIGIBLE (D-12)', async () => {
    const parent = await newSku('draft', { status: 'DRAFT' });
    expect(await codeOf(createBom(STAFF, bomInput(parent)))).toBe(
      ERROR_CODES.BOM_PARENT_NOT_ELIGIBLE,
    );
  });

  it('★ manufacturable=false · itemType 제한 없음 — 규칙을 발명하지 않는다', async () => {
    const parent = await newSku('nomfg', {
      status: 'ACTIVE',
      manufacturable: false,
      itemType: 'RAW_MATERIAL',
    });
    await expect(createBom(STAFF, bomInput(parent))).resolves.toBeDefined();
  });

  it('없는 상위 SKU 는 404 다', async () => {
    expect(await codeOf(createBom(STAFF, bomInput('99999999-9999-4999-8999-999999999999')))).toBe(
      ERROR_CODES.NOT_FOUND,
    );
  });

  it('★ (parentSkuId, version) 중복은 409 BOM_VERSION_DUPLICATE 다 — DB 가 최종 판정', async () => {
    const parent = await newSku('dupver', { status: 'ACTIVE' });
    const input = bomInput(parent, { version: 'DUP-1' });
    await createBom(STAFF, input);
    expect(await codeOf(createBom(STAFF, { ...input, effectiveFrom: '2027-01-01' }))).toBe(
      ERROR_CODES.BOM_VERSION_DUPLICATE,
    );
  });

  it('다른 상위 SKU 라면 같은 version 문자열을 쓸 수 있다', async () => {
    const a = await newSku('ver-a', { status: 'ACTIVE' });
    const b = await newSku('ver-b', { status: 'ACTIVE' });
    await createBom(STAFF, bomInput(a, { version: 'SHARED' }));
    await expect(createBom(STAFF, bomInput(b, { version: 'SHARED' }))).resolves.toBeDefined();
  });

  it('★ productionPartner 는 실제 FK 라 존재를 검증한다 (staged Warehouse 와 다르다)', async () => {
    const parent = await newSku('pp', { status: 'ACTIVE' });
    const ghost = '88888888-8888-4888-8888-888888888888';
    expect(await codeOf(createBom(STAFF, bomInput(parent, { productionPartnerId: ghost })))).toBe(
      ERROR_CODES.NOT_FOUND,
    );

    const supplier = await getPrismaClient().supplier.create({
      data: {
        supplierCode: CODE('S001'),
        supplierName: '조립처',
        supplierType: 'MANUFACTURER',
      },
      select: { id: true },
    });
    const { bom } = await createBom(STAFF, bomInput(parent, { productionPartnerId: supplier.id }));
    expect(bom.productionPartner).toMatchObject({ supplierCode: CODE('S001') });
  });

  it('★ destinationWarehouseId 는 존재 조회 없이 UUID 그대로 저장된다 (D-32)', async () => {
    const parent = await newSku('wh', { status: 'ACTIVE' });
    const ghostWarehouse = '77777777-7777-4777-8777-777777777777';
    const { bom } = await createBom(
      STAFF,
      bomInput(parent, { destinationWarehouseId: ghostWarehouse }),
    );
    expect(bom.destinationWarehouseId).toBe(ghostWarehouse);
  });

  it('★ 날짜가 하루 밀리지 않는다 — date-only round-trip', async () => {
    const parent = await newSku('date', { status: 'ACTIVE' });
    const { bom } = await createBom(
      STAFF,
      bomInput(parent, { effectiveFrom: '2026-03-01', effectiveTo: '2026-12-31' }),
    );
    expect(bom.effectiveFrom).toBe('2026-03-01');
    expect(bom.effectiveTo).toBe('2026-12-31');
    const reread = await getBom(STAFF, bom.id);
    expect(reread.effectiveFrom).toBe('2026-03-01');
  });

  it('AuditLog 는 BomHeader CREATE 1건이다 (D-16)', async () => {
    const parent = await newSku('audit-c', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id)).toEqual([
      { action: 'CREATE', actorId: STAFF_ID },
    ]);
  });

  it('★ 생성 실패 시 AuditLog 는 0건이다 — 같은 트랜잭션', async () => {
    const parent = await newSku('audit-fail', { status: 'ACTIVE' });
    const input = bomInput(parent, { version: 'FAIL-1' });
    const { bom } = await createBom(STAFF, input);
    const before = await getPrismaClient().auditLog.count({ where: { actorId: STAFF_ID } });
    await codeOf(createBom(STAFF, { ...input, effectiveFrom: '2028-01-01' }));
    const after = await getPrismaClient().auditLog.count({ where: { actorId: STAFF_ID } });
    expect(after).toBe(before);
    expect(bom.id).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 멱등성 (D-17)
// ═══════════════════════════════════════════════════════════════

describe('★ 멱등성 — POST /api/boms scope `bom:create` (D-17)', () => {
  it('같은 key + 같은 DTO 는 replay 로 같은 BOM 을 돌려준다', async () => {
    const parent = await newSku('idem', { status: 'ACTIVE' });
    const input = bomInput(parent);
    const key = `k-${RUN}-1`;
    const first = await createBom(STAFF, input, {}, key);
    const second = await createBom(STAFF, input, {}, key);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.bom.id).toBe(first.bom.id);
    const rows = await getPrismaClient().bomHeader.count({ where: { parentSkuId: parent } });
    expect(rows).toBe(1);
  });

  it('★ 같은 key + 다른 DTO 는 409 IDEMPOTENCY_KEY_REUSED 다', async () => {
    const parent = await newSku('idem2', { status: 'ACTIVE' });
    const key = `k-${RUN}-2`;
    await createBom(STAFF, bomInput(parent), {}, key);
    expect(await codeOf(createBom(STAFF, bomInput(parent), {}, key))).toBe(
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
    );
  });

  it('다른 key 는 독립 생성이다', async () => {
    const parent = await newSku('idem3', { status: 'ACTIVE' });
    await createBom(STAFF, bomInput(parent), {}, `k-${RUN}-3a`);
    await createBom(STAFF, bomInput(parent), {}, `k-${RUN}-3b`);
    expect(await getPrismaClient().bomHeader.count({ where: { parentSkuId: parent } })).toBe(2);
  });
});

describe('★ 멱등성 — 라인 생성 scope 는 BOM 별로 독립이다 (D-17)', () => {
  it('같은 key 라도 다른 BOM 이면 각각 생성된다', async () => {
    const parentA = await newSku('lidem-a', { status: 'ACTIVE' });
    const parentB = await newSku('lidem-b', { status: 'ACTIVE' });
    const component = await newSku('lidem-c', { status: 'ACTIVE' });
    const bomA = (await createBom(STAFF, bomInput(parentA))).bom;
    const bomB = (await createBom(STAFF, bomInput(parentB))).bom;

    const key = `lk-${RUN}-1`;
    const a = await createBomLine(STAFF, bomA.id, lineInput(component), {}, key);
    const b = await createBomLine(STAFF, bomB.id, lineInput(component), {}, key);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(a.line.id).not.toBe(b.line.id);
  });

  it('같은 BOM · 같은 key · 같은 DTO 는 replay 다', async () => {
    const parent = await newSku('lidem2', { status: 'ACTIVE' });
    const component = await newSku('lidem2-c', { status: 'ACTIVE' });
    const bom = (await createBom(STAFF, bomInput(parent))).bom;
    const key = `lk-${RUN}-2`;
    const first = await createBomLine(STAFF, bom.id, lineInput(component), {}, key);
    const second = await createBomLine(STAFF, bom.id, lineInput(component), {}, key);
    expect(second.replayed).toBe(true);
    expect(second.line.id).toBe(first.line.id);
    expect(await getPrismaClient().bomLine.count({ where: { bomHeaderId: bom.id } })).toBe(1);
  });

  it('같은 BOM · 같은 key · 다른 DTO 는 409 다', async () => {
    const parent = await newSku('lidem3', { status: 'ACTIVE' });
    const c1 = await newSku('lidem3-c1', { status: 'ACTIVE' });
    const c2 = await newSku('lidem3-c2', { status: 'ACTIVE' });
    const bom = (await createBom(STAFF, bomInput(parent))).bom;
    const key = `lk-${RUN}-3`;
    await createBomLine(STAFF, bom.id, lineInput(c1), {}, key);
    expect(await codeOf(createBomLine(STAFF, bom.id, lineInput(c2), {}, key))).toBe(
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 편집 가능 상태 (D-6 · TC-BOM-005)
// ═══════════════════════════════════════════════════════════════

describe('★ 편집 가능 상태 (D-6 · TC-BOM-005)', () => {
  async function bomInStatus(status: string): Promise<{ bomId: string; componentId: string }> {
    const parent = await newSku(`st-${status}`, { status: 'ACTIVE' });
    const component = await newSku(`st-c-${status}`, { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    const line = await createBomLine(STAFF, bom.id, lineInput(component));
    await setStatus(bom.id, status);
    return { bomId: bom.id, componentId: line.line.id };
  }

  it('DRAFT·REJECTED 는 header PATCH · line 추가/수정/삭제가 전부 된다', async () => {
    for (const status of ['DRAFT', 'REJECTED']) {
      const { bomId, componentId } = await bomInStatus(status);
      await expect(updateBom(STAFF, bomId, { description: `d-${status}` })).resolves.toBeDefined();
      await expect(
        updateBomLine(STAFF, bomId, componentId, { note: `n-${status}` }),
      ).resolves.toBeDefined();
      await expect(deleteBomLine(STAFF, bomId, componentId)).resolves.toBeUndefined();
    }
  });

  it('★ ACTIVE 는 BOM_ACTIVE_IMMUTABLE 이다 (TC-BOM-005)', async () => {
    const { bomId, componentId } = await bomInStatus('ACTIVE');
    const other = await newSku('active-c2', { status: 'ACTIVE' });
    expect(await codeOf(updateBom(STAFF, bomId, { description: 'x' }))).toBe(
      ERROR_CODES.BOM_ACTIVE_IMMUTABLE,
    );
    expect(await codeOf(createBomLine(STAFF, bomId, lineInput(other)))).toBe(
      ERROR_CODES.BOM_ACTIVE_IMMUTABLE,
    );
    expect(await codeOf(updateBomLine(STAFF, bomId, componentId, { note: 'x' }))).toBe(
      ERROR_CODES.BOM_ACTIVE_IMMUTABLE,
    );
    expect(await codeOf(deleteBomLine(STAFF, bomId, componentId))).toBe(
      ERROR_CODES.BOM_ACTIVE_IMMUTABLE,
    );
  });

  it('★ PENDING_APPROVAL·APPROVED·INACTIVE·ARCHIVED 는 BOM_NOT_EDITABLE 이다', async () => {
    for (const status of ['PENDING_APPROVAL', 'APPROVED', 'INACTIVE', 'ARCHIVED']) {
      const { bomId, componentId } = await bomInStatus(status);
      expect(await codeOf(updateBom(STAFF, bomId, { description: 'x' })), status).toBe(
        ERROR_CODES.BOM_NOT_EDITABLE,
      );
      expect(await codeOf(deleteBomLine(STAFF, bomId, componentId)), status).toBe(
        ERROR_CODES.BOM_NOT_EDITABLE,
      );
    }
  });

  it('★ 편집 거부 시 DB write 도 AuditLog 도 0 이다', async () => {
    const { bomId } = await bomInStatus('ACTIVE');
    const before = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);
    await codeOf(updateBom(STAFF, bomId, { description: '거부됨' }));
    const row = await getPrismaClient().bomHeader.findUniqueOrThrow({ where: { id: bomId } });
    expect(row.description).toBeNull();
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId)).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════
// PATCH /api/boms/{id} (D-14 · D-13)
// ═══════════════════════════════════════════════════════════════

describe('BOM 헤더 수정 (D-14)', () => {
  it('부분 수정이 적용되고 AuditLog UPDATE 1건이 남는다', async () => {
    const parent = await newSku('patch', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    const updated = await updateBom(STAFF, bom.id, { description: '수정', outputQty: '5' });
    expect(updated.description).toBe('수정');
    expect(updated.outputQty).toBe('5');
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id)).toEqual([
      { action: 'CREATE', actorId: STAFF_ID },
      { action: 'UPDATE', actorId: STAFF_ID },
    ]);
  });

  it('★ no-op 은 DB write 0 · AuditLog 0 이다', async () => {
    const parent = await newSku('noop', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent, { description: '동일' }));
    const before = await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id);
    const result = await updateBom(STAFF, bom.id, { description: '동일' });
    expect(result.description).toBe('동일');
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id)).toEqual(before);
  });

  it('★ Decimal no-op — "1" 과 "1.000000" 은 같은 값이다 (Number() 없이 판정)', async () => {
    const parent = await newSku('dec-noop', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent, { outputQty: '1' }));
    const before = await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id);
    await updateBom(STAFF, bom.id, { outputQty: '1.000000' });
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id)).toEqual(before);
  });

  it('★ 변경 후 기준으로 기간 순서를 본다 — effectiveTo 만 바꿔도 검증된다', async () => {
    const parent = await newSku('period', { status: 'ACTIVE' });
    const { bom } = await createBom(
      STAFF,
      bomInput(parent, { effectiveFrom: '2026-06-01', effectiveTo: '2026-12-01' }),
    );
    await expect(updateBom(STAFF, bom.id, { effectiveTo: '2026-05-01' })).rejects.toBeDefined();
    await expect(updateBom(STAFF, bom.id, { effectiveTo: null })).resolves.toMatchObject({
      effectiveTo: null,
    });
  });

  it('없는 BOM 은 404 다', async () => {
    expect(
      await codeOf(updateBom(STAFF, '99999999-9999-4999-8999-999999999999', { description: 'x' })),
    ).toBe(ERROR_CODES.BOM_NOT_FOUND);
  });
});

// ═══════════════════════════════════════════════════════════════
// ★★ 적용기간 invalid-request path (D-5 · R5)
//
// ★ 핵심 계약: **정상 REST/application 입력이 DB CHECK
//   `bom_header_effective_period_check`(23514) 에 도달하는 경로는 0** 이다.
//   CHECK 는 application invariant 가 뚫렸을 때의 최후 방어선이며, 도달하면
//   500(계약 버그)로 드러난다 — 정상 입력이 500 이 되면 안 된다.
//
// ⚠️ docs/18 §D-29 에 BOM 전용 invalid-period 오류코드가 **없다.** 임의로 새
//    코드를 만들지 않고 공통 validation 계약(`VALIDATION_ERROR` / 400)을 쓴다.
// ═══════════════════════════════════════════════════════════════

describe('★★ 적용기간이 올바르지 않은 요청은 4xx 다 — DB CHECK 까지 가지 않는다 (D-5)', () => {
  async function auditCount(): Promise<number> {
    return getPrismaClient().auditLog.count({ where: { actorId: STAFF_ID } });
  }

  it('★ POST — 같은 날(from == to)은 400 이고 row·Audit 이 0 이다', async () => {
    const parent = await newSku('per-same', { status: 'ACTIVE' });
    const before = await auditCount();

    const code = await codeOf(
      createBom(
        STAFF,
        bomInput(parent, { effectiveFrom: '2026-08-10', effectiveTo: '2026-08-10' }),
      ),
    );
    // ⛔ P2039(23514) 가 아니다 — application 이 먼저 막았다.
    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);

    expect(await getPrismaClient().bomHeader.count({ where: { parentSkuId: parent } })).toBe(0);
    expect(await auditCount()).toBe(before);
  });

  it('★ POST — to < from 은 400 이고 row·Audit 이 0 이다', async () => {
    const parent = await newSku('per-before', { status: 'ACTIVE' });
    const before = await auditCount();

    const code = await codeOf(
      createBom(
        STAFF,
        bomInput(parent, { effectiveFrom: '2026-08-10', effectiveTo: '2026-08-09' }),
      ),
    );
    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);

    expect(await getPrismaClient().bomHeader.count({ where: { parentSkuId: parent } })).toBe(0);
    expect(await auditCount()).toBe(before);
  });

  it('★ POST — DTO 도 같은 두 입력을 400 으로 막는다 (route 경로)', () => {
    for (const bad of [
      { effectiveFrom: '2026-08-10', effectiveTo: '2026-08-10' },
      { effectiveFrom: '2026-08-10', effectiveTo: '2026-08-09' },
    ]) {
      expect(() =>
        parseCreateBomInput({
          parentSkuId: '11111111-1111-4111-8111-111111111111',
          bomType: 'MANUFACTURING',
          version: '1.0',
          ...bad,
        }),
      ).toThrow();
    }
  });

  it('★★ PATCH — merged state 가 같은 날이 되면 400 이고 원래 값이 유지된다', async () => {
    const parent = await newSku('per-patch', { status: 'ACTIVE' });
    const { bom } = await createBom(
      STAFF,
      bomInput(parent, { effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' }),
    );
    const auditsBefore = await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id);

    // body 에 effectiveTo 가 없어도 merged state 로 판정한다.
    const code = await codeOf(updateBom(STAFF, bom.id, { effectiveFrom: '2027-01-01' }));
    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);

    const row = await getPrismaClient().bomHeader.findUniqueOrThrow({ where: { id: bom.id } });
    expect(row.effectiveFrom.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(row.effectiveTo?.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id)).toEqual(auditsBefore);
  });

  it('★★ PATCH — effectiveFrom 만 바꿔 기존 effectiveTo 를 넘어서면 400 이다', async () => {
    const parent = await newSku('per-patch2', { status: 'ACTIVE' });
    const { bom } = await createBom(
      STAFF,
      bomInput(parent, { effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' }),
    );
    const auditsBefore = await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id);

    const code = await codeOf(updateBom(STAFF, bom.id, { effectiveFrom: '2028-01-01' }));
    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);

    const row = await getPrismaClient().bomHeader.findUniqueOrThrow({ where: { id: bom.id } });
    expect(row.effectiveFrom.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bom.id)).toEqual(auditsBefore);
  });

  it('★ PATCH — effectiveTo = null 은 열린 구간이라 허용된다', async () => {
    const parent = await newSku('per-open', { status: 'ACTIVE' });
    const { bom } = await createBom(
      STAFF,
      bomInput(parent, { effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' }),
    );
    const updated = await updateBom(STAFF, bom.id, { effectiveTo: null });
    expect(updated.effectiveTo).toBeNull();

    // 열린 구간이 된 뒤에는 effectiveFrom 을 뒤로 옮겨도 통과한다.
    const moved = await updateBom(STAFF, bom.id, { effectiveFrom: '2029-01-01' });
    expect(moved.effectiveFrom).toBe('2029-01-01');
  });

  it('★ 경계가 맞닿는 정상 기간은 회귀 없이 통과한다 (half-open)', async () => {
    const parent = await newSku('per-adj', { status: 'ACTIVE' });
    // to 는 from 보다 하루만 뒤여도 유효하다.
    const { bom } = await createBom(
      STAFF,
      bomInput(parent, { effectiveFrom: '2026-08-10', effectiveTo: '2026-08-11' }),
    );
    expect(bom.effectiveFrom).toBe('2026-08-10');
    expect(bom.effectiveTo).toBe('2026-08-11');
  });

  it('★★ DB CHECK 는 최후 방어선으로 살아 있다 — application 을 우회하면 거부된다', async () => {
    const parent = await newSku('per-raw', { status: 'ACTIVE' });
    const client = getPrismaClient();
    // ⛔ application 을 거치지 않는 raw INSERT — 정상 경로가 아니다.
    await expect(
      client.bomHeader.create({
        data: {
          parentSkuId: parent,
          bomType: 'MANUFACTURING',
          version: `raw-${RUN}`,
          outputUom: 'EA',
          effectiveFrom: parseDateOnly('2026-08-10'),
          effectiveTo: parseDateOnly('2026-08-10'),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2039' });
    expect(await client.bomHeader.count({ where: { parentSkuId: parent } })).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// ★★ effectiveFrom 변경 → cycle 재검사 (D-13 · §D-32 T07-3 필수)
// ═══════════════════════════════════════════════════════════════

describe('★★ header PATCH 로 effectiveFrom 변경 시 cycle 재검사 (D-13)', () => {
  /**
   * false-positive 방지 fixture 를 시간축에서 뒤집는다.
   *
   * ```
   *   A v1 ACTIVE [2020-01-01, 2027-01-01) → B     ← 2027 에 마감
   *   A v2 ACTIVE [2027-01-01, ∞)          → D     ← B 없음
   *   C  ACTIVE                            → A
   *   candidate B(DRAFT) → C
   * ```
   *
   * `effectiveFrom = 2027-06-01` 이면 `B→C→A→D` 로 **정상**,
   * `2026-06-01` 로 **앞당기면** `B→C→A→B` 로 **순환**이다.
   */
  async function fixture(): Promise<{ bomB: string; skus: Record<string, string> }> {
    const a = await newSku('cyc-A', { status: 'ACTIVE' });
    const b = await newSku('cyc-B', { status: 'ACTIVE' });
    const c = await newSku('cyc-C', { status: 'ACTIVE' });
    const d = await newSku('cyc-D', { status: 'ACTIVE' });
    const client = getPrismaClient();

    const mkActive = async (parent: string, from: string, to: string | null, child: string) => {
      seq += 1;
      const header = await client.bomHeader.create({
        data: {
          parentSkuId: parent,
          bomType: 'MANUFACTURING',
          version: `fx${String(seq).padStart(4, '0')}`,
          status: 'ACTIVE',
          outputUom: 'EA',
          effectiveFrom: parseDateOnly(from),
          effectiveTo: to === null ? null : parseDateOnly(to),
        },
        select: { id: true },
      });
      await client.bomLine.create({
        data: {
          bomHeaderId: header.id,
          lineNo: 1,
          componentSkuId: child,
          uom: 'EA',
          componentRole: 'MATERIAL',
        },
      });
    };

    await mkActive(a, '2020-01-01', '2027-01-01', b);
    await mkActive(a, '2027-01-01', null, d);
    await mkActive(c, '2020-01-01', null, a);

    const { bom } = await createBom(STAFF, bomInput(b, { effectiveFrom: '2027-06-01' }));
    await createBomLine(STAFF, bom.id, lineInput(c));
    return { bomB: bom.id, skus: { a, b, c, d } };
  }

  it('★ 2027-06-01 기준에서는 순환이 아니다 — 라인 생성이 성공한다', async () => {
    const { bomB } = await fixture();
    const detail = await getBom(STAFF, bomB);
    expect(detail.lines).toHaveLength(1);
  });

  it('★★ effectiveFrom 을 2026-06-01 로 앞당기면 422 BOM_CYCLE_DETECTED 다', async () => {
    const { bomB } = await fixture();
    expect(await codeOf(updateBom(STAFF, bomB, { effectiveFrom: '2026-06-01' }))).toBe(
      ERROR_CODES.BOM_CYCLE_DETECTED,
    );
  });

  it('★★ 순환 실패 시 effectiveFrom 이 원복되고 AuditLog 도 남지 않는다', async () => {
    const { bomB } = await fixture();
    const auditsBefore = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomB);
    await codeOf(updateBom(STAFF, bomB, { effectiveFrom: '2026-06-01' }));

    const row = await getPrismaClient().bomHeader.findUniqueOrThrow({ where: { id: bomB } });
    // ★ tentative UPDATE 가 롤백되어 원래 값이다.
    expect(row.effectiveFrom.toISOString().slice(0, 10)).toBe('2027-06-01');
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bomB)).toEqual(auditsBefore);
  });

  it('★ 순환을 만들지 않는 날짜로의 변경은 성공한다', async () => {
    const { bomB } = await fixture();
    const updated = await updateBom(STAFF, bomB, { effectiveFrom: '2028-01-01' });
    expect(updated.effectiveFrom).toBe('2028-01-01');
  });
});

// ═══════════════════════════════════════════════════════════════
// 라인 생성 (D-9 ~ D-13)
// ═══════════════════════════════════════════════════════════════

describe('BOM 라인 생성 (D-9·D-10·D-11·D-12)', () => {
  async function draftBom(label: string): Promise<{ bomId: string; parent: string }> {
    const parent = await newSku(label, { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    return { bomId: bom.id, parent };
  }

  it('★ lineNo 생략 시 서버가 max+1 로 채운다', async () => {
    const { bomId } = await draftBom('lineno');
    const c1 = await newSku('lineno-1', { status: 'ACTIVE' });
    const c2 = await newSku('lineno-2', { status: 'ACTIVE' });
    expect((await createBomLine(STAFF, bomId, lineInput(c1))).line.lineNo).toBe(1);
    expect((await createBomLine(STAFF, bomId, lineInput(c2))).line.lineNo).toBe(2);
  });

  it('★ uom 생략 시 구성품 baseUom 으로 채운다 (D-11)', async () => {
    const { bomId } = await draftBom('luom');
    const component = await newSku('luom-c', { status: 'ACTIVE', baseUom: 'KG' });
    expect((await createBomLine(STAFF, bomId, lineInput(component))).line.uom).toBe('KG');
  });

  it('★ uom 이 구성품 baseUom 과 다르면 422 다 — 환산하지 않는다', async () => {
    const { bomId } = await draftBom('luom2');
    const component = await newSku('luom2-c', { status: 'ACTIVE', baseUom: 'EA' });
    expect(await codeOf(createBomLine(STAFF, bomId, lineInput(component, { uom: 'BOX' })))).toBe(
      ERROR_CODES.BOM_UOM_MISMATCH,
    );
  });

  it('★ quantityStatus 기본은 UNKNOWN 이고 quantityPer 은 null 이다 — 자동 1 없음', async () => {
    const { bomId } = await draftBom('qty');
    const component = await newSku('qty-c', { status: 'ACTIVE' });
    const { line } = await createBomLine(STAFF, bomId, lineInput(component));
    expect(line.quantityStatus).toBe('UNKNOWN');
    expect(line.quantityPer).toBeNull();
  });

  it('★ UNKNOWN + quantityPer 은 422 BOM_QTY_STATUS_MISMATCH 다 (D-10)', async () => {
    const { bomId } = await draftBom('qty2');
    const component = await newSku('qty2-c', { status: 'ACTIVE' });
    expect(
      await codeOf(createBomLine(STAFF, bomId, lineInput(component, { quantityPer: '1' }))),
    ).toBe(ERROR_CODES.BOM_QTY_STATUS_MISMATCH);
  });

  it('★ CONFIRMED + quantityPer "0" 은 422 BOM_QTY_INVALID 다 (TC-BOM-002)', async () => {
    const { bomId } = await draftBom('qty3');
    const component = await newSku('qty3-c', { status: 'ACTIVE' });
    expect(
      await codeOf(
        createBomLine(
          STAFF,
          bomId,
          lineInput(component, { quantityStatus: 'CONFIRMED', quantityPer: '0' }),
        ),
      ),
    ).toBe(ERROR_CODES.BOM_QTY_INVALID);
  });

  it('★ 1/30 이 정밀도 손실 없이 문자열로 저장·반환된다 (TC-BOM-003)', async () => {
    const { bomId } = await draftBom('qty4');
    const component = await newSku('qty4-c', { status: 'ACTIVE' });
    const { line } = await createBomLine(
      STAFF,
      bomId,
      lineInput(component, {
        quantityStatus: 'CONFIRMED',
        quantityPer: '0.033333',
        packQuantity: '30',
      }),
    );
    expect(line.quantityPer).toBe('0.033333');
    // ★ packQuantity 는 quantityPer 와 **별도로** 저장된다 (F-19).
    expect(line.packQuantity).toBe('30');
  });

  it('★ 자기참조는 422 BOM_SELF_COMPONENT 다 (TC-BOM-001)', async () => {
    const { bomId, parent } = await draftBom('self');
    expect(await codeOf(createBomLine(STAFF, bomId, lineInput(parent)))).toBe(
      ERROR_CODES.BOM_SELF_COMPONENT,
    );
  });

  it('★ ARCHIVED 구성품은 422 BOM_COMPONENT_NOT_ELIGIBLE 다 (D-12)', async () => {
    const { bomId } = await draftBom('arch');
    const component = await newSku('arch-c', { status: 'ARCHIVED' });
    expect(await codeOf(createBomLine(STAFF, bomId, lineInput(component)))).toBe(
      ERROR_CODES.BOM_COMPONENT_NOT_ELIGIBLE,
    );
  });

  it('★ SERVICE · inventoryManaged=false · DRAFT 구성품은 허용된다 — 규칙 발명 금지', async () => {
    const { bomId } = await draftBom('allow');
    const service = await newSku('allow-svc', { status: 'ACTIVE', inventoryManaged: false });
    const draft = await newSku('allow-draft', { status: 'DRAFT' });
    await expect(
      createBomLine(STAFF, bomId, lineInput(service, { componentRole: 'SERVICE' })),
    ).resolves.toBeDefined();
    await expect(createBomLine(STAFF, bomId, lineInput(draft))).resolves.toBeDefined();
  });

  it('★ 같은 순번 재사용은 409 BOM_LINE_DUPLICATE 다', async () => {
    const { bomId } = await draftBom('dupno');
    const c1 = await newSku('dupno-1', { status: 'ACTIVE' });
    const c2 = await newSku('dupno-2', { status: 'ACTIVE' });
    await createBomLine(STAFF, bomId, lineInput(c1, { lineNo: 7 }));
    expect(await codeOf(createBomLine(STAFF, bomId, lineInput(c2, { lineNo: 7 })))).toBe(
      ERROR_CODES.BOM_LINE_DUPLICATE,
    );
  });

  it('★ 같은 구성품 + 같은(빈) 대체그룹 중복은 409 다 — NULL 끼리도 같은 그룹 (D-3)', async () => {
    const { bomId } = await draftBom('dupcomp');
    const component = await newSku('dupcomp-c', { status: 'ACTIVE' });
    await createBomLine(STAFF, bomId, lineInput(component));
    expect(await codeOf(createBomLine(STAFF, bomId, lineInput(component)))).toBe(
      ERROR_CODES.BOM_LINE_DUPLICATE,
    );
  });

  it('★ 대체그룹이 다르면 같은 구성품을 여러 번 넣을 수 있다 (D-3)', async () => {
    const { bomId } = await draftBom('altok');
    const component = await newSku('altok-c', { status: 'ACTIVE' });
    await createBomLine(STAFF, bomId, lineInput(component, { alternateGroup: 'G1' }));
    await expect(
      createBomLine(STAFF, bomId, lineInput(component, { alternateGroup: 'G2' })),
    ).resolves.toBeDefined();
  });

  it("★★ alternate_group = '' 행이 생기지 않는다 (§D-32 T07-3 필수)", async () => {
    const { bomId } = await draftBom('blank');
    const component = await newSku('blank-c', { status: 'ACTIVE' });
    await createBomLine(STAFF, bomId, lineInput(component, { alternateGroup: '   ' }));
    const rows = await getPrismaClient().bomLine.findMany({
      where: { bomHeaderId: bomId },
      select: { alternateGroup: true },
    });
    expect(rows).toEqual([{ alternateGroup: null }]);
    const blanks = await getPrismaClient().bomLine.count({ where: { alternateGroup: '' } });
    expect(blanks).toBe(0);
  });

  it('★ issueWarehouseId 는 존재 조회 없이 저장된다 (D-32)', async () => {
    const { bomId } = await draftBom('lwh');
    const component = await newSku('lwh-c', { status: 'ACTIVE' });
    const ghost = '66666666-6666-4666-8666-666666666666';
    const { line } = await createBomLine(
      STAFF,
      bomId,
      lineInput(component, { issueWarehouseId: ghost }),
    );
    expect(line.issueWarehouseId).toBe(ghost);
  });

  it('AuditLog 는 BomLine CREATE 1건이다 (D-16)', async () => {
    const { bomId } = await draftBom('laudit');
    const component = await newSku('laudit-c', { status: 'ACTIVE' });
    const { line } = await createBomLine(STAFF, bomId, lineInput(component));
    expect(await auditsOf(BOM_LINE_ENTITY_TYPE, line.id)).toEqual([
      { action: 'CREATE', actorId: STAFF_ID },
    ]);
  });

  it('없는 BOM 은 404 다', async () => {
    const component = await newSku('nobom-c', { status: 'ACTIVE' });
    expect(
      await codeOf(
        createBomLine(STAFF, '99999999-9999-4999-8999-999999999999', lineInput(component)),
      ),
    ).toBe(ERROR_CODES.BOM_NOT_FOUND);
  });
});

// ═══════════════════════════════════════════════════════════════
// ★★ 라인 생성 cycle rollback (D-13 · D-44)
// ═══════════════════════════════════════════════════════════════

describe('★★ 라인 생성 — tentative INSERT 후 cycle 이면 전부 롤백된다', () => {
  async function twoLevelFixture(): Promise<{ bomB: string; a: string }> {
    const a = await newSku('rb-A', { status: 'ACTIVE' });
    const b = await newSku('rb-B', { status: 'ACTIVE' });
    const client = getPrismaClient();
    seq += 1;
    // A(ACTIVE) → B
    const header = await client.bomHeader.create({
      data: {
        parentSkuId: a,
        bomType: 'MANUFACTURING',
        version: `rb${String(seq).padStart(4, '0')}`,
        status: 'ACTIVE',
        outputUom: 'EA',
        effectiveFrom: parseDateOnly('2020-01-01'),
      },
      select: { id: true },
    });
    await client.bomLine.create({
      data: {
        bomHeaderId: header.id,
        lineNo: 1,
        componentSkuId: b,
        uom: 'EA',
        componentRole: 'MATERIAL',
      },
    });
    // candidate: B 의 DRAFT BOM
    const { bom } = await createBom(STAFF, bomInput(b, { effectiveFrom: '2026-01-01' }));
    return { bomB: bom.id, a };
  }

  it('★ A→B 가 있는데 B→A 를 추가하면 422 BOM_CYCLE_DETECTED 다', async () => {
    const { bomB, a } = await twoLevelFixture();
    expect(await codeOf(createBomLine(STAFF, bomB, lineInput(a)))).toBe(
      ERROR_CODES.BOM_CYCLE_DETECTED,
    );
  });

  it('★★ 실패한 라인이 DB 에 남지 않는다', async () => {
    const { bomB, a } = await twoLevelFixture();
    await codeOf(createBomLine(STAFF, bomB, lineInput(a)));
    expect(await getPrismaClient().bomLine.count({ where: { bomHeaderId: bomB } })).toBe(0);
  });

  it('★★ AuditLog 도 남지 않는다', async () => {
    const { bomB, a } = await twoLevelFixture();
    const before = await getPrismaClient().auditLog.count({
      where: { entityType: BOM_LINE_ENTITY_TYPE, actorId: STAFF_ID },
    });
    await codeOf(createBomLine(STAFF, bomB, lineInput(a)));
    const after = await getPrismaClient().auditLog.count({
      where: { entityType: BOM_LINE_ENTITY_TYPE, actorId: STAFF_ID },
    });
    expect(after).toBe(before);
  });

  it('★★ 멱등 성공 결과도 기록되지 않는다 — 같은 key 로 다시 시도할 수 있다', async () => {
    const { bomB, a } = await twoLevelFixture();
    const key = `cyc-${RUN}-${seq}`;
    expect(await codeOf(createBomLine(STAFF, bomB, lineInput(a), {}, key))).toBe(
      ERROR_CODES.BOM_CYCLE_DETECTED,
    );
    const records = await getPrismaClient().idempotencyRecord.count({
      where: { actorId: STAFF_ID, idempotencyKey: key },
    });
    expect(records).toBe(0);

    // 같은 key 로 **정상 요청**을 다시 보내면 성공한다(실패가 캐시되지 않았다).
    const safe = await newSku('cyc-safe', { status: 'ACTIVE' });
    await expect(createBomLine(STAFF, bomB, lineInput(safe), {}, key)).resolves.toMatchObject({
      replayed: false,
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 라인 수정 · 삭제 (D-14 · D-13)
// ═══════════════════════════════════════════════════════════════

describe('BOM 라인 수정 (D-14)', () => {
  async function draftWithLine(label: string) {
    const parent = await newSku(label, { status: 'ACTIVE' });
    const component = await newSku(`${label}-c`, { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    const { line } = await createBomLine(STAFF, bom.id, lineInput(component));
    return { bomId: bom.id, lineId: line.id, parent, component };
  }

  it('필드 수정과 AuditLog UPDATE 1건', async () => {
    const { bomId, lineId } = await draftWithLine('lpatch');
    const updated = await updateBomLine(STAFF, bomId, lineId, {
      quantityStatus: 'CONFIRMED',
      quantityPer: '2.5',
      note: '메모',
    });
    expect(updated.quantityPer).toBe('2.5');
    expect(await auditsOf(BOM_LINE_ENTITY_TYPE, lineId)).toEqual([
      { action: 'CREATE', actorId: STAFF_ID },
      { action: 'UPDATE', actorId: STAFF_ID },
    ]);
  });

  it('★ no-op 은 DB write 0 · AuditLog 0 이다', async () => {
    const { bomId, lineId } = await draftWithLine('lnoop');
    const before = await auditsOf(BOM_LINE_ENTITY_TYPE, lineId);
    await updateBomLine(STAFF, bomId, lineId, { quantityStatus: 'UNKNOWN' });
    expect(await auditsOf(BOM_LINE_ENTITY_TYPE, lineId)).toEqual(before);
  });

  it('★ 변경 후 조합으로 D-10 정합을 본다 — status 만 바꿔도 검증된다', async () => {
    const { bomId, lineId } = await draftWithLine('lqty');
    // quantityPer 이 null 인 상태에서 CONFIRMED 로만 바꾸면 불일치다.
    expect(await codeOf(updateBomLine(STAFF, bomId, lineId, { quantityStatus: 'CONFIRMED' }))).toBe(
      ERROR_CODES.BOM_QTY_STATUS_MISMATCH,
    );
  });

  it('★ componentSkuId 변경 시 새 구성품 baseUom 으로 uom 이 맞춰진다', async () => {
    const { bomId, lineId } = await draftWithLine('lswap');
    const other = await newSku('lswap-other', { status: 'ACTIVE', baseUom: 'KG' });
    const updated = await updateBomLine(STAFF, bomId, lineId, { componentSkuId: other });
    expect(updated.componentSkuId).toBe(other);
    expect(updated.uom).toBe('KG');
  });

  it('★ componentSkuId 를 parent 로 바꾸면 422 BOM_SELF_COMPONENT 다', async () => {
    const { bomId, lineId, parent } = await draftWithLine('lself');
    expect(await codeOf(updateBomLine(STAFF, bomId, lineId, { componentSkuId: parent }))).toBe(
      ERROR_CODES.BOM_SELF_COMPONENT,
    );
  });

  it('★★ 안전한 구성품을 순환 구성품으로 바꾸면 422 이고 원래 값이 유지된다', async () => {
    // A(ACTIVE) → B  ·  candidate B(DRAFT) → safe
    const a = await newSku('lcyc-A', { status: 'ACTIVE' });
    const b = await newSku('lcyc-B', { status: 'ACTIVE' });
    const safe = await newSku('lcyc-safe', { status: 'ACTIVE' });
    const client = getPrismaClient();
    seq += 1;
    const header = await client.bomHeader.create({
      data: {
        parentSkuId: a,
        bomType: 'MANUFACTURING',
        version: `lc${String(seq).padStart(4, '0')}`,
        status: 'ACTIVE',
        outputUom: 'EA',
        effectiveFrom: parseDateOnly('2020-01-01'),
      },
      select: { id: true },
    });
    await client.bomLine.create({
      data: {
        bomHeaderId: header.id,
        lineNo: 1,
        componentSkuId: b,
        uom: 'EA',
        componentRole: 'MATERIAL',
      },
    });
    const { bom } = await createBom(STAFF, bomInput(b, { effectiveFrom: '2026-01-01' }));
    const { line } = await createBomLine(STAFF, bom.id, lineInput(safe));
    const auditsBefore = await auditsOf(BOM_LINE_ENTITY_TYPE, line.id);

    expect(await codeOf(updateBomLine(STAFF, bom.id, line.id, { componentSkuId: a }))).toBe(
      ERROR_CODES.BOM_CYCLE_DETECTED,
    );

    const row = await client.bomLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(row.componentSkuId).toBe(safe);
    expect(await auditsOf(BOM_LINE_ENTITY_TYPE, line.id)).toEqual(auditsBefore);
  });

  it('★ 다른 BOM 의 라인은 404 다 — 403 이 아니다 (nested ownership)', async () => {
    const first = await draftWithLine('own-1');
    const second = await draftWithLine('own-2');
    expect(await codeOf(updateBomLine(STAFF, first.bomId, second.lineId, { note: 'x' }))).toBe(
      ERROR_CODES.BOM_NOT_FOUND,
    );
    expect(await codeOf(deleteBomLine(STAFF, first.bomId, second.lineId))).toBe(
      ERROR_CODES.BOM_NOT_FOUND,
    );
    // 원래 소속 BOM 에서는 정상 동작한다 — 라인 자체는 존재한다.
    await expect(
      updateBomLine(STAFF, second.bomId, second.lineId, { note: 'ok' }),
    ).resolves.toBeDefined();
  });

  it('★ 중복 제약 위반은 409 BOM_LINE_DUPLICATE 다', async () => {
    const { bomId, lineId, component } = await draftWithLine('ldup');
    const other = await newSku('ldup-other', { status: 'ACTIVE' });
    await createBomLine(STAFF, bomId, lineInput(other));
    // 두 번째 라인을 첫 번째와 같은 구성품으로 바꾸면 표현식 UNIQUE 위반.
    const lines = await getPrismaClient().bomLine.findMany({
      where: { bomHeaderId: bomId },
      select: { id: true },
      orderBy: { lineNo: 'asc' },
    });
    const secondLineId = lines[1]?.id ?? '';
    expect(secondLineId).not.toBe(lineId);
    expect(
      await codeOf(updateBomLine(STAFF, bomId, secondLineId, { componentSkuId: component })),
    ).toBe(ERROR_CODES.BOM_LINE_DUPLICATE);
  });
});

describe('BOM 라인 삭제 (D-6)', () => {
  it('★ DRAFT 에서 삭제되고 AuditLog DELETE 1건이 남는다', async () => {
    const parent = await newSku('del', { status: 'ACTIVE' });
    const component = await newSku('del-c', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    const { line } = await createBomLine(STAFF, bom.id, lineInput(component));

    await deleteBomLine(STAFF, bom.id, line.id);

    expect(await getPrismaClient().bomLine.count({ where: { id: line.id } })).toBe(0);
    expect(await auditsOf(BOM_LINE_ENTITY_TYPE, line.id)).toEqual([
      { action: 'CREATE', actorId: STAFF_ID },
      { action: 'DELETE', actorId: STAFF_ID },
    ]);
  });

  it('★ 재삭제는 404 다 — 조용한 204 로 흡수하지 않는다', async () => {
    const parent = await newSku('del2', { status: 'ACTIVE' });
    const component = await newSku('del2-c', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    const { line } = await createBomLine(STAFF, bom.id, lineInput(component));
    await deleteBomLine(STAFF, bom.id, line.id);
    expect(await codeOf(deleteBomLine(STAFF, bom.id, line.id))).toBe(ERROR_CODES.BOM_NOT_FOUND);
  });

  it('삭제 후 헤더의 lineCount 가 줄어든다', async () => {
    const parent = await newSku('del3', { status: 'ACTIVE' });
    const c1 = await newSku('del3-1', { status: 'ACTIVE' });
    const c2 = await newSku('del3-2', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    const first = await createBomLine(STAFF, bom.id, lineInput(c1));
    await createBomLine(STAFF, bom.id, lineInput(c2));
    expect((await getBom(STAFF, bom.id)).lineCount).toBe(2);
    await deleteBomLine(STAFF, bom.id, first.line.id);
    expect((await getBom(STAFF, bom.id)).lineCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// GET 목록·상세 (D-14 · D-31)
// ═══════════════════════════════════════════════════════════════

describe('BOM 목록·상세 (D-14·D-31)', () => {
  it('★ 상세는 라인을 lineNo 순으로 낸다', async () => {
    const parent = await newSku('detail', { status: 'ACTIVE' });
    const c1 = await newSku('detail-1', { status: 'ACTIVE' });
    const c2 = await newSku('detail-2', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    await createBomLine(STAFF, bom.id, lineInput(c2, { lineNo: 5 }));
    await createBomLine(STAFF, bom.id, lineInput(c1, { lineNo: 2 }));

    const detail = await getBom(STAFF, bom.id);
    expect(detail.lines.map((line) => line.lineNo)).toEqual([2, 5]);
    expect(detail.lines[0]?.componentSku).toMatchObject({ id: c1 });
  });

  it('★ 목록은 lines 없이 lineCount·unconfirmedCount 만 낸다', async () => {
    const parent = await newSku('list', { status: 'ACTIVE' });
    const c1 = await newSku('list-1', { status: 'ACTIVE' });
    const c2 = await newSku('list-2', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    await createBomLine(STAFF, bom.id, lineInput(c1));
    await createBomLine(
      STAFF,
      bom.id,
      lineInput(c2, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
    );

    const result = await listBoms(STAFF, { page: 1, parentSkuId: parent });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty('lines');
    expect(result.items[0]?.lineCount).toBe(2);
    expect(result.items[0]?.unconfirmedCount).toBe(1);
    expect(result.pageSize).toBe(50);
    expect(result.total).toBe(1);
    expect(result.totalPages).toBe(1);
  });

  it('0건이면 total 0 · totalPages 0 이다', async () => {
    const parent = await newSku('empty', { status: 'ACTIVE' });
    const result = await listBoms(STAFF, { page: 1, parentSkuId: parent });
    expect(result).toMatchObject({ total: 0, totalPages: 0 });
    expect(result.items).toEqual([]);
  });

  it('★ effectiveOn 은 반열림 — from==D 포함, to==D 제외', async () => {
    const parent = await newSku('eff', { status: 'ACTIVE' });
    await createBom(
      STAFF,
      bomInput(parent, { effectiveFrom: '2026-06-01', effectiveTo: '2026-07-01' }),
    );
    const on = async (date: string) =>
      (await listBoms(STAFF, { page: 1, parentSkuId: parent, effectiveOn: date })).total;

    expect(await on('2026-05-31')).toBe(0);
    expect(await on('2026-06-01')).toBe(1); // from 포함
    expect(await on('2026-06-30')).toBe(1);
    expect(await on('2026-07-01')).toBe(0); // to 제외
  });

  it('★ effectiveOn 은 status 를 함의하지 않는다 — DRAFT 도 잡힌다', async () => {
    const parent = await newSku('eff2', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent, { effectiveFrom: '2026-06-01' }));
    expect(bom.status).toBe('DRAFT');
    const result = await listBoms(STAFF, {
      page: 1,
      parentSkuId: parent,
      effectiveOn: '2026-06-02',
    });
    expect(result.total).toBe(1);
  });

  it('★ hasUnknownQty 로 미확정 BOM 을 가른다', async () => {
    const parent = await newSku('unk', { status: 'ACTIVE' });
    const c = await newSku('unk-c', { status: 'ACTIVE' });
    const withUnknown = (await createBom(STAFF, bomInput(parent))).bom;
    await createBomLine(STAFF, withUnknown.id, lineInput(c));
    const allConfirmed = (await createBom(STAFF, bomInput(parent))).bom;
    await createBomLine(
      STAFF,
      allConfirmed.id,
      lineInput(c, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
    );

    const yes = await listBoms(STAFF, { page: 1, parentSkuId: parent, hasUnknownQty: 'true' });
    const no = await listBoms(STAFF, { page: 1, parentSkuId: parent, hasUnknownQty: 'false' });
    expect(yes.items.map((item) => item.id)).toEqual([withUnknown.id]);
    expect(no.items.map((item) => item.id)).toContain(allConfirmed.id);
  });

  it('q·status·bomType 필터가 동작한다', async () => {
    const parent = await newSku('filt', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent, { bomType: 'KIT' }));
    expect((await listBoms(STAFF, { page: 1, q: CODE('') })).total).toBeGreaterThan(0);
    expect(
      (await listBoms(STAFF, { page: 1, parentSkuId: parent, bomType: 'KIT' })).items.map(
        (item) => item.id,
      ),
    ).toEqual([bom.id]);
    expect((await listBoms(STAFF, { page: 1, parentSkuId: parent, bomType: 'REPACK' })).total).toBe(
      0,
    );
    expect((await listBoms(STAFF, { page: 1, parentSkuId: parent, status: 'ACTIVE' })).total).toBe(
      0,
    );
  });

  it('★ 정렬은 effectiveFrom DESC — 같은 parent 의 최신 버전이 먼저다', async () => {
    const parent = await newSku('sort', { status: 'ACTIVE' });
    const older = (await createBom(STAFF, bomInput(parent, { effectiveFrom: '2026-01-01' }))).bom;
    const newer = (await createBom(STAFF, bomInput(parent, { effectiveFrom: '2027-01-01' }))).bom;
    const result = await listBoms(STAFF, { page: 1, parentSkuId: parent });
    expect(result.items.map((item) => item.id)).toEqual([newer.id, older.id]);
  });

  it('없는 BOM 상세는 404 다', async () => {
    expect(await codeOf(getBom(STAFF, '99999999-9999-4999-8999-999999999999'))).toBe(
      ERROR_CODES.BOM_NOT_FOUND,
    );
  });

  it('★ read 는 AuditLog 를 만들지 않는다', async () => {
    const parent = await newSku('roaudit', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    const before = await getPrismaClient().auditLog.count({ where: { actorId: READER_ID } });
    await listBoms(READER, { page: 1 });
    await getBom(READER, bom.id);
    expect(await getPrismaClient().auditLog.count({ where: { actorId: READER_ID } })).toBe(before);
  });

  it('★ 응답에 Prisma relation 객체가 통째로 실리지 않는다 — 최소 projection', async () => {
    const parent = await newSku('proj', { status: 'ACTIVE' });
    const { bom } = await createBom(STAFF, bomInput(parent));
    const detail = await getBom(STAFF, bom.id);
    expect(Object.keys(detail.parentSku).sort()).toEqual(['id', 'skuCode', 'skuName']);
  });
});
