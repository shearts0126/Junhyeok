import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  createSupplier,
  createSupplierSku,
  listSuppliers,
  listSupplierSkus,
  parseListSuppliersQuery,
  parseUpdateSupplierSkuInput,
  SUPPLIER_CREATE_PERMISSION,
  SUPPLIER_READ_PERMISSION,
  SUPPLIER_UPDATE_PERMISSION,
  updateSupplier,
  updateSupplierSku,
  type CreateSupplierInput,
  type CreateSupplierSkuInput,
} from '@/modules/supplier/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * 거래처·공급조건 API DB 통합 테스트 (T06-2) — 실제 PostgreSQL.
 *
 * 근거: `docs/17_설계복구_거래처공급조건.md` §39~ (D-25·D-29 acceptance).
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - EXCLUDE·partial UNIQUE 위반이 **application 오류로 정확히 번역**되는지
 *   - temporal versioning(old close → new insert)이 단일 트랜잭션에서 동작하는지
 *   - AuditLog 가 mutation 과 같은 트랜잭션에서 정확한 건수로 남는지
 *   - G-03 lead-time 폴백이 실제 조회 경로에서 0 을 삼키지 않는지
 *   - 멱등 scope 에 supplierId 가 포함되어 supplier 별로 독립인지
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TSA-${RUN}-${suffix}`;

const WRITER_ID = 'eeeeeeee-0000-4000-8000-0000000e2001';
const READER_ID = 'eeeeeeee-0000-4000-8000-0000000e2002';
const NOPERM_ID = 'eeeeeeee-0000-4000-8000-0000000e2003';
const ACTOR_IDS = [WRITER_ID, READER_ID, NOPERM_ID];

/** 쓰기 actor — supplier 3권한 전부. */
const WRITER: ActorContext = createActorContext({
  userId: WRITER_ID,
  email: 'supplier-writer@deeppoint.test',
  name: '공급 작성자',
  active: true,
  roles: ['SCM_STAFF'],
  permissions: [SUPPLIER_READ_PERMISSION, SUPPLIER_CREATE_PERMISSION, SUPPLIER_UPDATE_PERMISSION],
  requestId: 'req-supplier-writer',
});

/** FINANCE 상당 — read 만. */
const READER: ActorContext = createActorContext({
  userId: READER_ID,
  email: 'supplier-reader@deeppoint.test',
  name: '공급 조회자',
  active: true,
  roles: ['FINANCE'],
  permissions: [SUPPLIER_READ_PERMISSION],
  requestId: 'req-supplier-reader',
});

/** EXECUTIVE 상당 + ADMIN 역할 — supplier.* 없음. bypass 부재 증명용. */
const NO_PERMISSION: ActorContext = createActorContext({
  userId: NOPERM_ID,
  email: 'supplier-noperm@deeppoint.test',
  name: '권한 없는 관리자',
  active: true,
  roles: ['ADMIN', 'EXECUTIVE'],
  permissions: ['sku.read'],
  requestId: 'req-supplier-noperm',
});

let seq = 0;

function nextCode(prefix: string): string {
  seq += 1;
  return CODE(`${prefix}${String(seq).padStart(3, '0')}`);
}

function supplierInput(overrides: Partial<CreateSupplierInput> = {}): CreateSupplierInput {
  return {
    supplierCode: nextCode('S'),
    supplierName: `테스트 거래처 ${seq}`,
    supplierType: 'MANUFACTURER',
    ...overrides,
  };
}

async function newSupplierId(overrides: Partial<CreateSupplierInput> = {}): Promise<string> {
  const result = await createSupplier(WRITER, supplierInput(overrides));
  return result.supplier.id;
}

async function newSkuId(label: string): Promise<string> {
  const row = await getPrismaClient().sku.create({
    data: { skuCode: nextCode('K'), skuName: `공급 API SKU (${label})`, itemType: 'FINISHED_GOOD' },
    select: { id: true },
  });
  return row.id;
}

function termInput(
  skuId: string,
  overrides: Partial<CreateSupplierSkuInput> = {},
): CreateSupplierSkuInput {
  return { skuId, supplyType: 'SELF_SUPPLIED', effectiveFrom: '2026-01-01', ...overrides };
}

async function auditCount(entityType: string, entityId: string): Promise<number> {
  return getPrismaClient().auditLog.count({ where: { entityType, entityId } });
}

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [
    WRITER_ID,
    READER_ID,
    NOPERM_ID,
  ]);
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({ where: { actorId: { in: ACTOR_IDS } } });
  await client.supplierSku.deleteMany({
    where: { supplier: { supplierCode: { startsWith: 'TSA-' } } },
  });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TSA-' } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TSA-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: [
      { id: WRITER_ID, email: 'supplier-writer@deeppoint.test', name: '공급 작성자' },
      { id: READER_ID, email: 'supplier-reader@deeppoint.test', name: '공급 조회자' },
      { id: NOPERM_ID, email: 'supplier-noperm@deeppoint.test', name: '권한 없는 관리자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 권한 · seed matrix
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — proxy 를 신뢰하지 않는 2차 가드', () => {
  it('1~4. read 는 supplier.read — FINANCE 가능, 권한 없는 ADMIN·EXECUTIVE 는 403', async () => {
    const query = parseListSuppliersQuery(new URLSearchParams());
    await expect(listSuppliers(READER, query)).resolves.toBeDefined();
    // ★ ADMIN 역할이어도 RolePermission 이 없으면 bypass 가 없다.
    await expect(listSuppliers(NO_PERMISSION, query)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('27·103. mutation 은 create/update — FINANCE·무권한 전부 403', async () => {
    await expect(createSupplier(READER, supplierInput())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(createSupplier(NO_PERMISSION, supplierInput())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const supplierId = await newSupplierId();
    await expect(
      updateSupplier(READER, supplierId, { supplierName: '변경 시도' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('★ seed matrix — supplier.read 는 A·L·S·F, create/update 는 A·L·S, EXECUTIVE 0', async () => {
    const rows = await getPrismaClient().rolePermission.findMany({
      where: { permission: { permissionKey: { startsWith: 'supplier.' } } },
      select: {
        role: { select: { roleCode: true } },
        permission: { select: { permissionKey: true } },
      },
    });
    const byKey = new Map<string, string[]>();
    for (const row of rows) {
      const list = byKey.get(row.permission.permissionKey) ?? [];
      list.push(row.role.roleCode);
      byKey.set(row.permission.permissionKey, list);
    }
    expect(byKey.get('supplier.read')?.sort()).toEqual([
      'ADMIN',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    expect(byKey.get('supplier.create')?.sort()).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    expect(byKey.get('supplier.update')?.sort()).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    // EXECUTIVE 는 supplier.* 0개.
    expect(rows.some((row) => row.role.roleCode === 'EXECUTIVE')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Supplier — 목록 · 생성 · 수정
// ═══════════════════════════════════════════════════════════════

describe('Supplier 목록 (D-2)', () => {
  it('5~8·13·15. q(code·name)·supplierType·status 필터와 supplierCode ASC 정렬', async () => {
    const marker = `QF${RUN}`;
    await newSupplierId({
      supplierCode: nextCode('QA'),
      supplierName: `${marker} 알파 상사`,
      supplierType: 'VENDOR',
    });
    await newSupplierId({
      supplierCode: nextCode('QB'),
      supplierName: `${marker} 베타 물산`,
      supplierType: 'FORWARDER',
    });

    // q — supplierName 검색 (대소문자 무시 contains).
    const byName = await listSuppliers(
      READER,
      parseListSuppliersQuery(new URLSearchParams(`q=${marker.toLowerCase()}`)),
    );
    expect(byName.total).toBe(2);
    // ★ 정렬 supplierCode ASC — QA 가 QB 보다 앞이다.
    expect(byName.items[0]?.supplierName).toContain('알파');

    // q — supplierCode 검색.
    const byCode = await listSuppliers(
      READER,
      parseListSuppliersQuery(new URLSearchParams(`q=${CODE('QA').slice(0, -3)}`)),
    );
    expect(byCode.total).toBeGreaterThanOrEqual(1);

    // supplierType exact.
    const byType = await listSuppliers(
      READER,
      parseListSuppliersQuery(new URLSearchParams(`q=${marker}&supplierType=VENDOR`)),
    );
    expect(byType.total).toBe(1);
    expect(byType.items[0]?.supplierType).toBe('VENDOR');

    // envelope 형태.
    expect(byName.pageSize).toBe(50);
    expect(byName.page).toBe(1);
    expect(byName.totalPages).toBe(1);
  });

  it('14. 0건이면 total 0 · totalPages 0 · items []', async () => {
    const result = await listSuppliers(
      READER,
      parseListSuppliersQuery(new URLSearchParams('q=존재하지않는거래처명xyz')),
    );
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
  });

  it('★ status filter — 기본 조회는 status 로 자동 필터하지 않는다', async () => {
    // status 는 API 로 바꿀 수 없으므로 DB 로 직접 만들어 조회만 검증한다.
    const code = nextCode('ST');
    await getPrismaClient().supplier.create({
      data: {
        supplierCode: code,
        supplierName: '중지된 거래처',
        supplierType: 'VENDOR',
        status: 'INACTIVE',
      },
    });
    const all = await listSuppliers(
      READER,
      parseListSuppliersQuery(new URLSearchParams(`q=${code}`)),
    );
    expect(all.total).toBe(1); // INACTIVE 도 기본 조회에 포함된다.
    const filtered = await listSuppliers(
      READER,
      parseListSuppliersQuery(new URLSearchParams(`q=${code}&status=INACTIVE`)),
    );
    expect(filtered.total).toBe(1);
  });
});

describe('Supplier 생성 (D-4·D-6)', () => {
  it('16~20. 생성 성공 — status 는 항상 ACTIVE, leadTime null/0 보존', async () => {
    const nullLead = await createSupplier(WRITER, supplierInput({ defaultLeadTimeDays: null }));
    expect(nullLead.supplier.status).toBe('ACTIVE');
    expect(nullLead.supplier.defaultLeadTimeDays).toBeNull();
    expect(nullLead.replayed).toBe(false);

    const zeroLead = await createSupplier(WRITER, supplierInput({ defaultLeadTimeDays: 0 }));
    // ★ 0 이 null·삭제로 바뀌지 않는다.
    expect(zeroLead.supplier.defaultLeadTimeDays).toBe(0);
  });

  it('24. supplierCode 중복 → 409 SUPPLIER_CODE_DUPLICATE', async () => {
    const input = supplierInput();
    await createSupplier(WRITER, input);
    await expect(
      createSupplier(WRITER, { ...input, supplierName: '다른 이름' }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_CODE_DUPLICATE' });
  });

  it('28. ★ Audit CREATE 가 같은 트랜잭션에 1건 남는다', async () => {
    const result = await createSupplier(WRITER, supplierInput());
    const logs = await getPrismaClient().auditLog.findMany({
      where: { entityType: 'Supplier', entityId: result.supplier.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.action).toBe('CREATE');
    expect(logs[0]?.beforeValue).toBeNull();
    expect(logs[0]?.actorId).toBe(WRITER_ID);
  });

  it('25·26. ★ 멱등 — 같은 key+body 는 200 replay, 같은 key+다른 body 는 409', async () => {
    const input = supplierInput();
    const key = `sup-key-${RUN}-1`;

    const first = await createSupplier(WRITER, input, {}, key);
    expect(first.replayed).toBe(false);

    const replay = await createSupplier(WRITER, input, {}, key);
    expect(replay.replayed).toBe(true);
    expect(replay.supplier.id).toBe(first.supplier.id);
    // replay 는 Supplier 도 AuditLog 도 새로 만들지 않는다.
    expect(await auditCount('Supplier', first.supplier.id)).toBe(1);

    await expect(createSupplier(WRITER, supplierInput(), {}, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });
});

describe('Supplier 수정 (D-7·D-8)', () => {
  it('29·33·34·37. 편집 가능 필드 · null clearing · leadTime 0 · Audit UPDATE', async () => {
    const supplierId = await newSupplierId({
      businessRegistrationNo: '123-45-67890',
      defaultLeadTimeDays: 14,
    });

    const updated = await updateSupplier(WRITER, supplierId, {
      supplierName: '개명한 거래처',
      businessRegistrationNo: null,
      defaultLeadTimeDays: 0,
    });
    expect(updated.supplierName).toBe('개명한 거래처');
    expect(updated.businessRegistrationNo).toBeNull();
    // ★ 0 으로의 변경이 "값 없음" 으로 오인되지 않는다.
    expect(updated.defaultLeadTimeDays).toBe(0);

    const logs = await getPrismaClient().auditLog.findMany({
      where: { entityType: 'Supplier', entityId: supplierId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(logs.map((log) => log.action)).toEqual(['CREATE', 'UPDATE']);
  });

  it('35. ★ no-op — 200 현재 행 / DB write 0 / Audit 0', async () => {
    const supplierId = await newSupplierId();
    const before = await getPrismaClient().supplier.findUniqueOrThrow({
      where: { id: supplierId },
    });

    const result = await updateSupplier(WRITER, supplierId, {
      supplierName: before.supplierName,
    });
    expect(result.supplierName).toBe(before.supplierName);

    const after = await getPrismaClient().supplier.findUniqueOrThrow({ where: { id: supplierId } });
    // updatedAt 이 그대로다 — UPDATE 자체가 없었다.
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await auditCount('Supplier', supplierId)).toBe(1); // CREATE 뿐.
  });

  it('36. 없는 거래처는 404', async () => {
    await expect(
      updateSupplier(WRITER, '00000000-0000-4000-8000-000000000000', { supplierName: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ═══════════════════════════════════════════════════════════════
// SupplierSku — 목록
// ═══════════════════════════════════════════════════════════════

describe('SupplierSku 목록 (D-10·D-11·D-18)', () => {
  it('38. parent 거래처가 없으면 404 — 빈 목록으로 위장하지 않는다', async () => {
    await expect(
      listSupplierSkus(READER, '00000000-0000-4000-8000-000000000000', { page: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('39~46. 이력 전부 포함 · effectiveFrom DESC 정렬 · projection 계약', async () => {
    const supplierId = await newSupplierId({ defaultLeadTimeDays: 30 });
    const skuId = await newSkuId('목록');

    // 과거(종료) → 현재(무기한) 두 기간. 미래 기간은 다른 SKU 로.
    await createSupplierSku(
      WRITER,
      supplierId,
      termInput(skuId, { effectiveFrom: '2025-01-01', effectiveTo: '2026-01-01', moq: '10.5' }),
    );
    await createSupplierSku(
      WRITER,
      supplierId,
      termInput(skuId, { effectiveFrom: '2026-01-01', leadTimeDays: 0 }),
    );
    const futureSku = await newSkuId('미래');
    await createSupplierSku(
      WRITER,
      supplierId,
      termInput(futureSku, { effectiveFrom: '2099-01-01' }),
    );

    const result = await listSupplierSkus(READER, supplierId, { page: 1 });

    // ★ 과거·현재·미래 전부 — effectiveTo IS NULL 자동 필터 없음.
    expect(result.total).toBe(3);
    expect(result.pageSize).toBe(50);
    // 정렬 effectiveFrom DESC.
    expect(result.items.map((item) => item.effectiveFrom)).toEqual([
      '2099-01-01',
      '2026-01-01',
      '2025-01-01',
    ]);

    const current = result.items[1]!;
    // SKU lightweight projection 4필드.
    expect(current.sku.skuCode).toContain('TSA-');
    expect(Object.keys(current.sku).sort()).toEqual(['id', 'skuCode', 'skuName', 'status']);
    // Decimal 문자열.
    const past = result.items[2]!;
    expect(past.moq).toBe('10.5');
    // ⛔ 미노출 필드 (D-9·D-30).
    for (const item of result.items) {
      const keys = Object.keys(item);
      expect(keys).not.toContain('destinationWarehouseId');
      expect(keys).not.toContain('price');
      expect(keys).not.toContain('supplier');
    }
  });

  it('47~52. ★ lead-time stored/derived — 0 이 폴백에 삼켜지지 않는다 (G-03)', async () => {
    const supplierId = await newSupplierId({ defaultLeadTimeDays: 30 });

    const own = await newSkuId('자체값');
    await createSupplierSku(WRITER, supplierId, termInput(own, { leadTimeDays: 7 }));
    const zero = await newSkuId('명시적0');
    await createSupplierSku(WRITER, supplierId, termInput(zero, { leadTimeDays: 0 }));
    const inherit = await newSkuId('폴백');
    await createSupplierSku(WRITER, supplierId, termInput(inherit, { leadTimeDays: null }));

    const byId = new Map(
      (await listSupplierSkus(READER, supplierId, { page: 1 })).items.map((item) => [
        item.skuId,
        item,
      ]),
    );
    // 47·48. stored 값 그대로 + effective 는 자체값.
    expect(byId.get(own)).toMatchObject({ leadTimeDays: 7, effectiveLeadTimeDays: 7 });
    // 51. ★ stored 0 이 supplier 기본값 30 을 이긴다 — || 였다면 30 이 됐을 것.
    expect(byId.get(zero)).toMatchObject({ leadTimeDays: 0, effectiveLeadTimeDays: 0 });
    // 49. null → supplier 기본값 폴백.
    expect(byId.get(inherit)).toMatchObject({ leadTimeDays: null, effectiveLeadTimeDays: 30 });

    // 52. ★ supplier 기본값 변경이 즉시 반영된다 — denormalize 없음.
    await updateSupplier(WRITER, supplierId, { defaultLeadTimeDays: 45 });
    const refreshed = await listSupplierSkus(READER, supplierId, { page: 1 });
    expect(refreshed.items.find((item) => item.skuId === inherit)?.effectiveLeadTimeDays).toBe(45);
    expect(refreshed.items.find((item) => item.skuId === zero)?.effectiveLeadTimeDays).toBe(0);

    // 50. 둘 다 null → null (0 대체 금지).
    const bare = await newSupplierId({ defaultLeadTimeDays: null });
    const bareSku = await newSkuId('양쪽 null');
    await createSupplierSku(WRITER, bare, termInput(bareSku));
    const bareList = await listSupplierSkus(READER, bare, { page: 1 });
    expect(bareList.items[0]?.effectiveLeadTimeDays).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// SupplierSku — 생성
// ═══════════════════════════════════════════════════════════════

describe('SupplierSku 생성 (D-12~D-14·D-17·D-19)', () => {
  it('53·57~59·73. 생성 성공 + Audit CREATE', async () => {
    const supplierId = await newSupplierId();
    const skuId = await newSkuId('생성');
    const result = await createSupplierSku(
      WRITER,
      supplierId,
      termInput(skuId, { moq: '100', effectiveTo: '2027-01-01' }),
    );

    expect(result.supplierSku.supplyType).toBe('SELF_SUPPLIED');
    expect(result.supplierSku.effectiveFrom).toBe('2026-01-01');
    expect(result.supplierSku.effectiveTo).toBe('2027-01-01');
    expect(result.supplierSku.moq).toBe('100');
    expect(await auditCount('SupplierSku', result.supplierSku.id)).toBe(1);
  });

  it('54·55. parent·SKU 404 — soft-delete SKU 도 404', async () => {
    const skuId = await newSkuId('부모404');
    await expect(
      createSupplierSku(WRITER, '00000000-0000-4000-8000-000000000000', termInput(skuId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const supplierId = await newSupplierId();
    await expect(
      createSupplierSku(WRITER, supplierId, termInput('00000000-0000-4000-8000-000000000001')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const deleted = await newSkuId('삭제됨');
    await getPrismaClient().sku.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    await expect(createSupplierSku(WRITER, supplierId, termInput(deleted))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('56. ★ SKU status·purchasable 제한 없음 — DRAFT·purchasable=false 도 등록된다', async () => {
    const supplierId = await newSupplierId();
    const skuId = await newSkuId('자격 없음');
    // 기본 생성 SKU 는 DRAFT + purchasable=false 다 — 그대로 통과해야 한다 (D-19).
    const result = await createSupplierSku(WRITER, supplierId, termInput(skuId));
    expect(result.supplierSku.sku.status).toBe('DRAFT');
  });

  it('60·61. 기간 경계 — to > from 유효, to <= from 은 422', async () => {
    const supplierId = await newSupplierId();
    const skuId = await newSkuId('경계');
    await expect(
      createSupplierSku(
        WRITER,
        supplierId,
        termInput(skuId, { effectiveFrom: '2026-01-01', effectiveTo: '2026-01-01' }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_EFFECTIVE_PERIOD_INVALID' });
    await expect(
      createSupplierSku(
        WRITER,
        supplierId,
        termInput(skuId, { effectiveFrom: '2026-02-01', effectiveTo: '2026-01-01' }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_EFFECTIVE_PERIOD_INVALID' });
  });

  it('67·71. ★ 기간 중첩 409 PERIOD_OVERLAP / 경계 접촉은 성공', async () => {
    const supplierId = await newSupplierId();
    const skuId = await newSkuId('중첩');
    await createSupplierSku(
      WRITER,
      supplierId,
      termInput(skuId, { effectiveFrom: '2026-01-01', effectiveTo: '2026-06-01' }),
    );

    // 부분 중첩 — 시작일이 달라 UNIQUE 는 통과하지만 EXCLUDE 가 막는다.
    await expect(
      createSupplierSku(WRITER, supplierId, termInput(skuId, { effectiveFrom: '2026-03-01' })),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_PERIOD_OVERLAP' });

    // ★ [from, to) — 경계가 맞닿는 후속 기간은 허용된다.
    const touching = await createSupplierSku(
      WRITER,
      supplierId,
      termInput(skuId, { effectiveFrom: '2026-06-01' }),
    );
    expect(touching.supplierSku.effectiveFrom).toBe('2026-06-01');
  });

  it('68. 동일 시작일 → 409 EFFECTIVE_FROM_DUPLICATE', async () => {
    const supplierId = await newSupplierId();
    const skuId = await newSkuId('동일 시작');
    await createSupplierSku(
      WRITER,
      supplierId,
      termInput(skuId, { effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01' }),
    );
    await expect(
      createSupplierSku(
        WRITER,
        supplierId,
        termInput(skuId, { effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01' }),
      ),
    ).rejects.toMatchObject({
      // 같은 시작일은 UNIQUE 와 EXCLUDE 에 모두 걸린다 — 어느 409 든 옳지만
      // 먼저 판정되는 제약의 코드가 안정적으로 나와야 한다.
      code: expect.stringMatching(
        /^(SUPPLIER_SKU_EFFECTIVE_FROM_DUPLICATE|SUPPLIER_SKU_PERIOD_OVERLAP)$/,
      ),
    });
  });

  it('69·70. ★ 현행 대표 충돌 409 — 자동 교체 없음 (D-17)', async () => {
    const supplierA = await newSupplierId();
    const supplierB = await newSupplierId();
    const skuId = await newSkuId('대표');

    await createSupplierSku(WRITER, supplierA, termInput(skuId, { isPrimary: true }));
    await expect(
      createSupplierSku(WRITER, supplierB, termInput(skuId, { isPrimary: true })),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_PRIMARY_CONFLICT' });

    // ★ 기존 대표가 자동으로 내려가지 않았다.
    const rows = await getPrismaClient().supplierSku.findMany({
      where: { skuId, isPrimary: true, effectiveTo: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supplierId).toBe(supplierA);
  });

  it('72. ★ 멱등 scope 에 supplierId 포함 — 다른 supplier 의 같은 key 는 독립', async () => {
    const supplierA = await newSupplierId();
    const supplierB = await newSupplierId();
    const skuA = await newSkuId('멱등 A');
    const skuB = await newSkuId('멱등 B');
    const key = `term-key-${RUN}-1`;

    const first = await createSupplierSku(WRITER, supplierA, termInput(skuA), {}, key);
    expect(first.replayed).toBe(false);

    // 같은 supplier + 같은 key + 같은 body → replay.
    const replay = await createSupplierSku(WRITER, supplierA, termInput(skuA), {}, key);
    expect(replay.replayed).toBe(true);
    expect(replay.supplierSku.id).toBe(first.supplierSku.id);

    // ★ 다른 supplier + 같은 key → scope 가 달라 신규 201 이다 (409 아님).
    const other = await createSupplierSku(WRITER, supplierB, termInput(skuB), {}, key);
    expect(other.replayed).toBe(false);
    expect(other.supplierSku.id).not.toBe(first.supplierSku.id);

    // 같은 supplier + 같은 key + 다른 body → 409.
    const skuC = await newSkuId('멱등 C');
    await expect(
      createSupplierSku(WRITER, supplierA, termInput(skuC), {}, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

// ═══════════════════════════════════════════════════════════════
// SupplierSku PATCH — mode A (종료)
// ═══════════════════════════════════════════════════════════════

describe('SupplierSku PATCH mode A — 종료 (D-15·§25)', () => {
  async function newTermId(overrides: Partial<CreateSupplierSkuInput> = {}): Promise<string> {
    const supplierId = await newSupplierId();
    const skuId = await newSkuId('종료 대상');
    const result = await createSupplierSku(WRITER, supplierId, termInput(skuId, overrides));
    return result.supplierSku.id;
  }

  it('74·79. open-ended 종료 성공 + Audit UPDATE 1건', async () => {
    const id = await newTermId();
    const closed = await updateSupplierSku(
      WRITER,
      id,
      parseUpdateSupplierSkuInput({ effectiveTo: '2026-06-01' }),
    );
    expect(closed.effectiveTo).toBe('2026-06-01');

    const logs = await getPrismaClient().auditLog.findMany({
      where: { entityType: 'SupplierSku', entityId: id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(logs.map((log) => log.action)).toEqual(['CREATE', 'UPDATE']);
  });

  it('75·76. 종료일 앞당기기 가능, 연장은 422', async () => {
    const id = await newTermId({ effectiveTo: '2026-12-01' });
    const shortened = await updateSupplierSku(
      WRITER,
      id,
      parseUpdateSupplierSkuInput({ effectiveTo: '2026-06-01' }),
    );
    expect(shortened.effectiveTo).toBe('2026-06-01');

    await expect(
      updateSupplierSku(WRITER, id, parseUpdateSupplierSkuInput({ effectiveTo: '2026-09-01' })),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_VERSION_DATE_INVALID' });
  });

  it('시작일 이하로 닫으면 422 EFFECTIVE_PERIOD_INVALID', async () => {
    const id = await newTermId();
    await expect(
      updateSupplierSku(WRITER, id, parseUpdateSupplierSkuInput({ effectiveTo: '2026-01-01' })),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_EFFECTIVE_PERIOD_INVALID' });
  });

  it('78. business field 를 같이 보내면 mode A 가 아니다 — 400 (DTO)', () => {
    expect(() => parseUpdateSupplierSkuInput({ effectiveTo: '2026-06-01', moq: '10' })).toThrow();
  });

  it('row 가 없으면 404', async () => {
    await expect(
      updateSupplierSku(
        WRITER,
        '00000000-0000-4000-8000-000000000000',
        parseUpdateSupplierSkuInput({ effectiveTo: '2026-06-01' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ═══════════════════════════════════════════════════════════════
// SupplierSku PATCH — mode B (temporal versioning)
// ═══════════════════════════════════════════════════════════════

describe('★ SupplierSku PATCH mode B — 새 버전 (D-15·§26~§30)', () => {
  interface TermSetup {
    readonly supplierId: string;
    readonly skuId: string;
    readonly termId: string;
  }

  async function setup(overrides: Partial<CreateSupplierSkuInput> = {}): Promise<TermSetup> {
    const supplierId = await newSupplierId({ defaultLeadTimeDays: 30 });
    const skuId = await newSkuId('버전 대상');
    const result = await createSupplierSku(
      WRITER,
      supplierId,
      termInput(skuId, { moq: '100', leadTimeDays: 7, purchaseUom: 'BOX', ...overrides }),
    );
    return { supplierId, skuId, termId: result.supplierSku.id };
  }

  it('80~85·91·92. old close → successor insert, omitted 복사·changed 적용·Audit 2건', async () => {
    const { supplierId, skuId, termId } = await setup();

    const successor = await updateSupplierSku(
      WRITER,
      termId,
      parseUpdateSupplierSkuInput({ effectiveFrom: '2026-06-01', moq: '200' }),
    );

    // 92. 응답은 후속 row 다.
    expect(successor.id).not.toBe(termId);
    // 83. identity 동일.
    expect(successor.supplierId).toBe(supplierId);
    expect(successor.skuId).toBe(skuId);
    // 85. 명시한 필드는 새 값.
    expect(successor.moq).toBe('200');
    // 84. omitted 필드는 기존 값 복사.
    expect(successor.leadTimeDays).toBe(7);
    expect(successor.purchaseUom).toBe('BOX');
    expect(successor.supplyType).toBe('SELF_SUPPLIED');
    // 86. 기존 row 가 open-ended 였으므로 successor 도 open-ended 를 상속.
    expect(successor.effectiveFrom).toBe('2026-06-01');
    expect(successor.effectiveTo).toBeNull();

    // 81. 기존 row 는 successor 시작일에 닫혔다.
    const old = await getPrismaClient().supplierSku.findUniqueOrThrow({ where: { id: termId } });
    expect(old.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-06-01');

    // 91. Audit — old UPDATE + new CREATE 정확히 2건.
    expect(await auditCount('SupplierSku', termId)).toBe(2); // CREATE + UPDATE(close)
    expect(await auditCount('SupplierSku', successor.id)).toBe(1); // CREATE
  });

  it('86·87. successor effectiveTo — 원래 상한 상속 / 명시값 우선', async () => {
    // 기존 row 가 finite 종료일을 가진 경우.
    const finite = await setup({ effectiveTo: '2026-12-01' });
    const inherited = await updateSupplierSku(
      WRITER,
      finite.termId,
      parseUpdateSupplierSkuInput({ effectiveFrom: '2026-06-01', moq: '300' }),
    );
    // ★ 기존 row 의 **원래** 종료일 2026-12-01 을 상속한다.
    expect(inherited.effectiveTo).toBe('2026-12-01');

    const explicit = await setup();
    const explicitTo = await updateSupplierSku(
      WRITER,
      explicit.termId,
      parseUpdateSupplierSkuInput({
        effectiveFrom: '2026-06-01',
        effectiveTo: '2027-01-01',
        moq: '300',
      }),
    );
    expect(explicitTo.effectiveTo).toBe('2027-01-01');
  });

  it('88. ★ 버전 경계 위반 422 — 시작일 이하 / finite 종료 경계 이후', async () => {
    const early = await setup();
    await expect(
      updateSupplierSku(
        WRITER,
        early.termId,
        parseUpdateSupplierSkuInput({ effectiveFrom: '2026-01-01', moq: '1' }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_VERSION_DATE_INVALID' });
    await expect(
      updateSupplierSku(
        WRITER,
        early.termId,
        parseUpdateSupplierSkuInput({ effectiveFrom: '2025-06-01', moq: '1' }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_VERSION_DATE_INVALID' });

    const finite = await setup({ effectiveTo: '2026-06-01' });
    await expect(
      updateSupplierSku(
        WRITER,
        finite.termId,
        parseUpdateSupplierSkuInput({ effectiveFrom: '2026-06-01', moq: '1' }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_VERSION_DATE_INVALID' });
  });

  it('94. ★ 현행 대표의 versioning — old-close-before-new-insert 라 자기충돌이 없다', async () => {
    const supplierId = await newSupplierId();
    const skuId = await newSkuId('대표 버전');
    const created = await createSupplierSku(
      WRITER,
      supplierId,
      termInput(skuId, { isPrimary: true }),
    );

    // isPrimary=true 를 유지한 채 새 버전 — new-first 였다면 partial UNIQUE 자기충돌.
    const successor = await updateSupplierSku(
      WRITER,
      created.supplierSku.id,
      parseUpdateSupplierSkuInput({ effectiveFrom: '2026-06-01', moq: '10' }),
    );
    expect(successor.isPrimary).toBe(true);

    // 현행 대표는 후속 row 하나뿐이다.
    const currents = await getPrismaClient().supplierSku.findMany({
      where: { skuId, isPrimary: true, effectiveTo: null },
    });
    expect(currents).toHaveLength(1);
    expect(currents[0]?.id).toBe(successor.id);
  });

  it('93. 버전 생성이 다른 행과 겹치면 EXCLUDE 가 409 로 번역된다', async () => {
    const supplierId = await newSupplierId();
    const skuId = await newSkuId('버전 충돌');
    const first = await createSupplierSku(
      WRITER,
      supplierId,
      termInput(skuId, { effectiveFrom: '2026-01-01', effectiveTo: '2026-06-01' }),
    );
    // 후속 기간이 이미 존재한다.
    await createSupplierSku(WRITER, supplierId, termInput(skuId, { effectiveFrom: '2026-06-01' }));

    // 첫 행을 03-01 에서 쪼개면 successor [03-01, 06-01) 는 문제 없지만,
    // successor 종료일을 명시로 늘려 후속 행과 겹치게 하면 409 다.
    await expect(
      updateSupplierSku(
        WRITER,
        first.supplierSku.id,
        parseUpdateSupplierSkuInput({
          effectiveFrom: '2026-03-01',
          effectiveTo: '2026-09-01',
          moq: '1',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_SKU_PERIOD_OVERLAP' });
  });

  it('95. ★ 동시 versioning — row lock 으로 직렬화되고 둘 다 성공하지는 않는다', async () => {
    const { termId } = await setup();

    const attempt = (from: string) =>
      updateSupplierSku(
        WRITER,
        termId,
        parseUpdateSupplierSkuInput({ effectiveFrom: from, moq: '999' }),
      ).then(
        () => 'ok' as const,
        (error: { code?: string }) => error.code ?? 'unknown',
      );

    const [a, b] = await Promise.all([attempt('2026-06-01'), attempt('2026-07-01')]);
    const outcomes = [a, b].sort();
    // 한쪽은 성공, 다른 쪽은 lock 후 재검증에서 밀려 실패해야 한다 — lost update 없음.
    expect(outcomes).toContain('ok');
    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1);

    // 기간 불변식이 깨지지 않았다 — 남은 행들의 기간이 서로 겹치지 않는다.
    const rows = await getPrismaClient().supplierSku.findMany({ where: { id: termId } });
    expect(rows[0]?.effectiveTo).not.toBeNull();
  });
});
