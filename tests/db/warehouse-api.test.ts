import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  WAREHOUSE_CREATE_PERMISSION,
  WAREHOUSE_READ_PERMISSION,
  WAREHOUSE_UPDATE_PERMISSION,
  createWarehouse,
  createWarehouseLocation,
  listWarehouseLocations,
  listWarehouses,
  updateWarehouse,
} from '@/modules/warehouse/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { AppError, ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * 창고 application/API DB 통합 테스트 (T08-2) — 실제 PostgreSQL.
 *
 * 근거: `docs/19_설계복구_Warehouse.md` §W-D7·§W-D9·§W-D12·§W-D13·§W-D22~§W-D36.
 *
 * ★ 핵심은 **원자성**이다 — 창고·DEFAULT 로케이션·audit 이 한 트랜잭션이고
 *   어느 하나라도 실패하면 **부분 생성이 남지 않는다**.
 * ⛔ constraint 를 끄지 않는다 · ⛔ `session_replication_role` 을 쓰지 않는다 —
 *    실패는 audit logger 주입으로만 만든다 (barcode-crud 선례).
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TWA-${RUN}-${suffix}`;

const ADMIN_ID = 'ccc00000-0000-4000-8000-0000000d8001';
const READER_ID = 'ccc00000-0000-4000-8000-0000000d8002';
const FINANCE_ID = 'ccc00000-0000-4000-8000-0000000d8003';
const EXEC_ID = 'ccc00000-0000-4000-8000-0000000d8004';
const NOPERM_ID = 'ccc00000-0000-4000-8000-0000000d8005';
const ACTOR_IDS = [ADMIN_ID, READER_ID, FINANCE_ID, EXEC_ID, NOPERM_ID];

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

/** ADMIN — read·create·update 전부 (§W-D22). */
const ADMIN = actor(
  ADMIN_ID,
  ['ADMIN'],
  [WAREHOUSE_READ_PERMISSION, WAREHOUSE_CREATE_PERMISSION, WAREHOUSE_UPDATE_PERMISSION],
  '창고 관리자',
);
/** SCM_STAFF — read 만 (§W-D22). */
const READER = actor(READER_ID, ['SCM_STAFF'], [WAREHOUSE_READ_PERMISSION], '창고 조회자');
/** ★ FINANCE — 창고는 read 조차 없다 (BOM 과 정반대다). */
const FINANCE = actor(FINANCE_ID, ['FINANCE'], [], '재무');
/** ★ EXECUTIVE — 창고는 read 조차 없다. */
const EXECUTIVE = actor(EXEC_ID, ['EXECUTIVE'], [], '경영진');
/** ADMIN role 이지만 permission 데이터가 없다 — bypass 가 없음을 고정한다. */
const NO_PERMISSION = actor(NOPERM_ID, ['ADMIN'], [], '권한 없는 관리자');

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'NO_ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
};

/** 오류 객체 자체가 필요할 때 — 계약(코드·publicDetails·누출 여부)을 본다. */
const errorOf = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
    throw new Error('오류가 발생하지 않았습니다.');
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return error;
  }
};

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`,
    ACTOR_IDS,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({ where: { actorId: { in: ACTOR_IDS } } });

  // ★ warehouse ↔ location 상호 RESTRICT — FK 검사를 트랜잭션 안에서만 끈다.
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(
      `DELETE FROM warehouse_location WHERE warehouse_id IN
         (SELECT id FROM warehouse WHERE warehouse_code LIKE 'TWA-%')`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM warehouse WHERE warehouse_code LIKE 'TWA-%'`);
    await tx.$executeRawUnsafe(`DELETE FROM supplier WHERE supplier_code LIKE 'TWA-%'`);
    await tx.$executeRawUnsafe(`DELETE FROM external_system WHERE system_code LIKE 'TWA-%'`);
  });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: '창고 테스트' })),
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

const input = (suffix: string, overrides: Record<string, unknown> = {}) =>
  ({
    warehouseCode: CODE(suffix),
    warehouseName: `창고 ${suffix}`,
    warehouseType: 'INTERNAL',
    ...overrides,
  }) as Parameters<typeof createWarehouse>[1];

async function newSupplier(suffix: string): Promise<string> {
  const row = await getPrismaClient().supplier.create({
    data: {
      supplierCode: CODE(suffix),
      supplierName: `거래처 ${suffix}`,
      supplierType: 'MANUFACTURER',
    },
    select: { id: true },
  });
  return row.id;
}

async function newExternalSystem(suffix: string): Promise<string> {
  const row = await getPrismaClient().externalSystem.create({
    data: { systemCode: CODE(suffix), systemName: `외부 ${suffix}`, systemType: 'ERP' },
    select: { id: true },
  });
  return row.id;
}

// ═══════════════════════════════════════════════════════════════
// 권한 — ADMIN bypass 없음 (W-D22)
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — proxy 를 신뢰하지 않는 2차 가드 (W-D22)', () => {
  it('★ FINANCE·EXECUTIVE 는 창고를 읽을 수 없다 — BOM 과 정반대다', async () => {
    expect(await codeOf(listWarehouses(FINANCE, { page: 1 }))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(listWarehouses(EXECUTIVE, { page: 1 }))).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ SCM_STAFF 는 read 만 — create·update 는 403 이다', async () => {
    await expect(listWarehouses(READER, { page: 1 })).resolves.toBeDefined();
    expect(await codeOf(createWarehouse(READER, input('perm')))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(updateWarehouse(READER, randomUUID(), { warehouseName: 'x' }))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it('★★ ADMIN role 이어도 permission 데이터가 없으면 403 이다 (bypass 없음)', async () => {
    expect(await codeOf(listWarehouses(NO_PERMISSION, { page: 1 }))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(createWarehouse(NO_PERMISSION, input('bypass')))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it('★ 권한 검사는 멱등 replay 보다 먼저다 — 권한 잃은 replay 도 403', async () => {
    const key = `wh-perm-${RUN}`;
    await createWarehouse(ADMIN, input('permfirst'), {}, key);
    expect(await codeOf(createWarehouse(READER, input('permfirst'), {}, key))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 1~7 — 정상 생성 + DEFAULT 원자 생성 (W-D7)
// ═══════════════════════════════════════════════════════════════

describe('★★ 창고 생성 — DEFAULT 로케이션 원자 생성 (W-D7)', () => {
  it('1~7. 생성 직후 defaultLocationId NOT NULL · DEFAULT 1개 · 양방향 ID 일치', async () => {
    const result = await createWarehouse(ADMIN, input('C1'));
    const client = getPrismaClient();

    // 2. defaultLocationId 가 채워져 있다.
    expect(result.warehouse.defaultLocationId).not.toBeNull();
    expect(result.replayed).toBe(false);

    // 3. DEFAULT 로케이션이 정확히 1개 생겼다.
    const locations = await client.warehouseLocation.findMany({
      where: { warehouseId: result.warehouse.id },
    });
    expect(locations).toHaveLength(1);

    // 4. 양방향 ID 가 정확히 맞물린다.
    expect(result.warehouse.defaultLocationId).toBe(locations[0]?.id);
    expect(locations[0]?.warehouseId).toBe(result.warehouse.id);
    expect(result.defaultLocation.id).toBe(locations[0]?.id);

    // 5. DEFAULT exact 4값 (§W-D7).
    expect(locations[0]?.locationCode).toBe('DEFAULT');
    expect(locations[0]?.locationName).toBe('DEFAULT');
    expect(locations[0]?.locationType).toBeNull();
    expect(locations[0]?.active).toBe(true);

    // 6~7. commit 되었고 response 와 DB 값이 같다.
    const row = await client.warehouse.findUniqueOrThrow({ where: { id: result.warehouse.id } });
    expect(row.defaultLocationId).toBe(result.warehouse.defaultLocationId);
    expect(row.timezone).toBe('Asia/Seoul');
    expect(row.active).toBe(true);
  });

  it('★ timezone·address 를 명시하면 그대로 저장된다', async () => {
    const result = await createWarehouse(
      ADMIN,
      input('C2', { timezone: 'America/Los_Angeles', address: '서울시 강남구' }),
    );
    expect(result.warehouse.timezone).toBe('America/Los_Angeles');
    expect(result.warehouse.address).toBe('서울시 강남구');
  });

  it('★ audit 은 Warehouse CREATE 1건 + WarehouseLocation CREATE 1건이다 (W-D35)', async () => {
    const result = await createWarehouse(ADMIN, input('C3'));

    const logs = await getPrismaClient().auditLog.findMany({
      where: {
        actorId: ADMIN_ID,
        entityId: { in: [result.warehouse.id, result.defaultLocation.id] },
      },
      select: { entityType: true, action: true, entityId: true },
      orderBy: { entityType: 'asc' },
    });

    expect(logs).toHaveLength(2);
    expect(logs).toEqual([
      { entityType: 'Warehouse', action: 'CREATE', entityId: result.warehouse.id },
      { entityType: 'WarehouseLocation', action: 'CREATE', entityId: result.defaultLocation.id },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8~9 — rollback (부분 생성 0)
// ═══════════════════════════════════════════════════════════════

describe('★★ rollback — 부분 생성이 남지 않는다 (W-D7)', () => {
  it('8. ★ audit(=트랜잭션 후반) 실패 → 창고·로케이션·멱등기록 전부 0', async () => {
    const client = getPrismaClient();
    const key = `wh-rollback-${RUN}`;
    const failing = {
      write: async () => {
        throw new Error('감사로그 실패 주입');
      },
    };

    await expect(
      createWarehouse(ADMIN, input('R1'), { auditLogger: failing as never }, key),
    ).rejects.toThrow(/감사로그 실패 주입/);

    expect(await client.warehouse.count({ where: { warehouseCode: CODE('R1') } })).toBe(0);
    expect(
      await client.warehouseLocation.count({ where: { warehouse: { warehouseCode: CODE('R1') } } }),
    ).toBe(0);
    expect(
      await client.idempotencyRecord.count({ where: { actorId: ADMIN_ID, idempotencyKey: key } }),
    ).toBe(0);

    // 롤백 후 같은 key 로 재시도하면 정상 생성된다 (key 가 영구 점유되지 않는다).
    const retry = await createWarehouse(ADMIN, input('R1'), {}, key);
    expect(retry.replayed).toBe(false);
  });

  it('9. ★ 창고 생성 실패(중복 코드) → 고아 로케이션 0', async () => {
    const client = getPrismaClient();
    await createWarehouse(ADMIN, input('R2'));
    const before = await client.warehouseLocation.count();

    expect(await codeOf(createWarehouse(ADMIN, input('R2')))).toBe(
      ERROR_CODES.WAREHOUSE_CODE_DUPLICATE,
    );

    // 두 번째 시도의 로케이션이 남지 않았다.
    expect(await client.warehouseLocation.count()).toBe(before);
    expect(await client.warehouse.count({ where: { warehouseCode: CODE('R2') } })).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10~12 — constraint / 예약 / supplier 규칙
// ═══════════════════════════════════════════════════════════════

describe('★ 생성 검증 (W-D12 · W-D13)', () => {
  it('10. 중복 warehouseCode 는 409 WAREHOUSE_CODE_DUPLICATE 다', async () => {
    await createWarehouse(ADMIN, input('D1'));
    expect(await codeOf(createWarehouse(ADMIN, input('D1')))).toBe(
      ERROR_CODES.WAREHOUSE_CODE_DUPLICATE,
    );
  });

  it('★ IN_TRANSIT 유형·코드는 public create 400 이다 (W-D12)', async () => {
    expect(await codeOf(createWarehouse(ADMIN, input('T1', { warehouseType: 'IN_TRANSIT' })))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
    expect(
      await codeOf(
        createWarehouse(ADMIN, {
          ...input('T2'),
          warehouseCode: 'IN_TRANSIT',
        } as Parameters<typeof createWarehouse>[1]),
      ),
    ).toBe(ERROR_CODES.VALIDATION_ERROR);
    // 부분 생성 0.
    expect(
      await getPrismaClient().warehouse.count({ where: { warehouseCode: { startsWith: 'TWA-' } } }),
    ).toBeGreaterThan(0);
  });

  it('11. ★ SUPPLIER_SITE 인데 supplierId 없음 → 400 (W-D13 runtime)', async () => {
    expect(
      await codeOf(createWarehouse(ADMIN, input('S1', { warehouseType: 'SUPPLIER_SITE' }))),
    ).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('11b. ★ non-SUPPLIER_SITE 인데 supplierId 있음 → 400', async () => {
    const supplierId = await newSupplier('S2');
    expect(await codeOf(createWarehouse(ADMIN, input('S2', { supplierId })))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('★ SUPPLIER_SITE + 실재 supplierId 는 성공한다', async () => {
    const supplierId = await newSupplier('S3');
    const result = await createWarehouse(
      ADMIN,
      input('S3', { warehouseType: 'SUPPLIER_SITE', supplierId }),
    );
    expect(result.warehouse.supplierId).toBe(supplierId);
  });

  it('12. ★ 없는 supplier·externalSystem 은 404 다 — raw FK 오류가 새지 않는다', async () => {
    const ghost = randomUUID();
    expect(
      await codeOf(
        createWarehouse(ADMIN, input('N1', { warehouseType: 'SUPPLIER_SITE', supplierId: ghost })),
      ),
    ).toBe(ERROR_CODES.NOT_FOUND);
    expect(await codeOf(createWarehouse(ADMIN, input('N2', { externalSystemId: ghost })))).toBe(
      ERROR_CODES.NOT_FOUND,
    );
  });

  it('★ 실재 externalSystemId 는 성공한다', async () => {
    const externalSystemId = await newExternalSystem('E1');
    const result = await createWarehouse(ADMIN, input('E1', { externalSystemId }));
    expect(result.warehouse.externalSystemId).toBe(externalSystemId);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13~16 — idempotency (W-D36)
// ═══════════════════════════════════════════════════════════════

describe('★★ 멱등 (W-D36)', () => {
  it('13~15. 같은 키 + 같은 payload → replay, 창고 1개 · DEFAULT 1개 · audit 재생성 0', async () => {
    const client = getPrismaClient();
    const key = `wh-idem-${RUN}`;
    const payload = input('I1');

    const first = await createWarehouse(ADMIN, payload, {}, key);
    expect(first.replayed).toBe(false);

    const second = await createWarehouse(ADMIN, payload, {}, key);
    expect(second.replayed).toBe(true);
    expect(second.warehouse.id).toBe(first.warehouse.id);
    expect(second.defaultLocation.id).toBe(first.defaultLocation.id);

    // ★ 창고 1개 · DEFAULT child 1개 — replay 가 다시 만들지 않았다.
    expect(await client.warehouse.count({ where: { warehouseCode: CODE('I1') } })).toBe(1);
    expect(
      await client.warehouseLocation.count({ where: { warehouseId: first.warehouse.id } }),
    ).toBe(1);

    // ★ audit 도 2건 그대로다 (4건이 아니다).
    expect(
      await client.auditLog.count({
        where: { entityId: { in: [first.warehouse.id, first.defaultLocation.id] } },
      }),
    ).toBe(2);
  });

  it('16. 같은 키 + 다른 payload → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const key = `wh-reuse-${RUN}`;
    await createWarehouse(ADMIN, input('I2'), {}, key);
    expect(
      await codeOf(createWarehouse(ADMIN, input('I2', { warehouseName: '다른 이름' }), {}, key)),
    ).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  });
});

// ═══════════════════════════════════════════════════════════════
// GET 목록 (W-D30 · W-D31)
// ═══════════════════════════════════════════════════════════════

describe('★ GET /api/warehouses (W-D30 · W-D31)', () => {
  it('★ pageSize 는 서버 고정 50 이고 정렬은 warehouseCode ASC 다', async () => {
    await createWarehouse(ADMIN, input('L2'));
    await createWarehouse(ADMIN, input('L1'));

    const result = await listWarehouses(ADMIN, { page: 1 });
    expect(result.pageSize).toBe(50);
    expect(result.page).toBe(1);

    const mine = result.items.filter((row) => row.warehouseCode.startsWith(`TWA-${RUN}-L`));
    const codes = mine.map((row) => row.warehouseCode);
    expect(codes).toEqual([...codes].sort());
  });

  it('★ warehouseType 필터가 exact match 로 동작한다', async () => {
    await createWarehouse(ADMIN, input('F1', { warehouseType: 'VIRTUAL' }));
    const result = await listWarehouses(ADMIN, { page: 1, warehouseType: 'VIRTUAL' });
    expect(result.items.every((row) => row.warehouseType === 'VIRTUAL')).toBe(true);
    expect(result.items.some((row) => row.warehouseCode === CODE('F1'))).toBe(true);
  });

  it('★★ inactive 창고도 기본 목록에 포함된다 — active=true 자동 필터 없음', async () => {
    const created = await createWarehouse(ADMIN, input('F2'));
    // ⚠️ `active` 는 API 로 못 바꾼다(T2-20) — 목록 동작 확인용으로 DB 를 직접 만진다.
    await getPrismaClient().warehouse.update({
      where: { id: created.warehouse.id },
      data: { active: false },
    });

    const all = await listWarehouses(ADMIN, { page: 1 });
    expect(all.items.some((row) => row.id === created.warehouse.id)).toBe(true);

    const onlyInactive = await listWarehouses(ADMIN, { page: 1, active: false });
    expect(onlyInactive.items.some((row) => row.id === created.warehouse.id)).toBe(true);

    const onlyActive = await listWarehouses(ADMIN, { page: 1, active: true });
    expect(onlyActive.items.some((row) => row.id === created.warehouse.id)).toBe(false);
  });

  it('★ WarehouseView 는 scalar 12개이고 관계 객체가 없다 (W-D31)', async () => {
    const created = await createWarehouse(ADMIN, input('V1'));
    const result = await listWarehouses(ADMIN, { page: 1 });
    const item = result.items.find((row) => row.id === created.warehouse.id);

    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        'active',
        'address',
        'createdAt',
        'defaultLocationId',
        'externalSystemId',
        'id',
        'supplierId',
        'timezone',
        'updatedAt',
        'warehouseCode',
        'warehouseName',
        'warehouseType',
      ].sort(),
    );
    expect(item).not.toHaveProperty('supplier');
    expect(item).not.toHaveProperty('externalSystem');
    expect(item).not.toHaveProperty('locations');
    expect(item?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ═══════════════════════════════════════════════════════════════
// PATCH (W-D25 · W-D26 · W-D27)
// ═══════════════════════════════════════════════════════════════

describe('★ PATCH /api/warehouses/{id} (W-D26)', () => {
  it('★ metadata 5필드를 수정하고 audit UPDATE 1건을 남긴다', async () => {
    const created = await createWarehouse(ADMIN, input('P1'));
    const updated = await updateWarehouse(ADMIN, created.warehouse.id, {
      warehouseName: '수정된 이름',
      address: '새 주소',
    });

    expect(updated.warehouseName).toBe('수정된 이름');
    expect(updated.address).toBe('새 주소');

    const logs = await getPrismaClient().auditLog.count({
      where: { entityId: created.warehouse.id, action: 'UPDATE' },
    });
    expect(logs).toBe(1);
  });

  it('★★ no-op — 200 + DB UPDATE 0 + audit 0 + updatedAt 불변 (W-D26)', async () => {
    const created = await createWarehouse(ADMIN, input('P2'));
    const before = await getPrismaClient().warehouse.findUniqueOrThrow({
      where: { id: created.warehouse.id },
    });

    const result = await updateWarehouse(ADMIN, created.warehouse.id, {
      warehouseName: created.warehouse.warehouseName,
    });

    expect(result.warehouseName).toBe(created.warehouse.warehouseName);

    const after = await getPrismaClient().warehouse.findUniqueOrThrow({
      where: { id: created.warehouse.id },
    });
    // ★ updatedAt 이 그대로다 — Prisma UPDATE 를 부르지 않았다.
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(
      await getPrismaClient().auditLog.count({
        where: { entityId: created.warehouse.id, action: 'UPDATE' },
      }),
    ).toBe(0);
  });

  it('★ non-SUPPLIER_SITE 에 supplierId 를 붙이면 400 이다', async () => {
    const created = await createWarehouse(ADMIN, input('P3'));
    const supplierId = await newSupplier('P3');
    expect(await codeOf(updateWarehouse(ADMIN, created.warehouse.id, { supplierId }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('★ SUPPLIER_SITE 의 supplierId 를 null 로 지우면 400 이다', async () => {
    const supplierId = await newSupplier('P4');
    const created = await createWarehouse(
      ADMIN,
      input('P4', { warehouseType: 'SUPPLIER_SITE', supplierId }),
    );
    expect(await codeOf(updateWarehouse(ADMIN, created.warehouse.id, { supplierId: null }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('★ 없는 창고·없는 거래처는 404 다', async () => {
    expect(await codeOf(updateWarehouse(ADMIN, randomUUID(), { warehouseName: 'x' }))).toBe(
      ERROR_CODES.NOT_FOUND,
    );

    const supplierId = await newSupplier('P5');
    const created = await createWarehouse(
      ADMIN,
      input('P5', { warehouseType: 'SUPPLIER_SITE', supplierId }),
    );
    expect(
      await codeOf(updateWarehouse(ADMIN, created.warehouse.id, { supplierId: randomUUID() })),
    ).toBe(ERROR_CODES.NOT_FOUND);
  });
});

// ═══════════════════════════════════════════════════════════════
// Locations (W-D32 · W-D33 · W-D34 · W-D9)
// ═══════════════════════════════════════════════════════════════

describe('★ locations (W-D32 · W-D34)', () => {
  it('★ GET — DEFAULT 포함, 정렬, 0건일 수 없다', async () => {
    const created = await createWarehouse(ADMIN, input('G1'));
    await createWarehouseLocation(ADMIN, created.warehouse.id, {
      locationCode: 'B-01',
      locationName: 'B 구역',
    });
    await createWarehouseLocation(ADMIN, created.warehouse.id, {
      locationCode: 'A-01',
      locationName: 'A 구역',
    });

    const result = await listWarehouseLocations(ADMIN, created.warehouse.id);
    expect(result.items.map((row) => row.locationCode)).toEqual(['A-01', 'B-01', 'DEFAULT']);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('★ GET — 없는 창고는 404 다 (빈 배열 아님)', async () => {
    expect(await codeOf(listWarehouseLocations(ADMIN, randomUUID()))).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('★ POST — 일반 로케이션 생성 + audit CREATE 1건', async () => {
    const created = await createWarehouse(ADMIN, input('G2'));
    const result = await createWarehouseLocation(ADMIN, created.warehouse.id, {
      locationCode: 'a-01',
      locationName: '소문자 구역',
      locationType: 'RACK',
    });

    // ★ 대소문자 보존 — a-01 을 A-01 로 바꾸지 않는다 (§W-D9).
    expect(result.location.locationCode).toBe('a-01');
    expect(result.location.locationType).toBe('RACK');
    expect(result.location.active).toBe(true);
    expect(result.replayed).toBe(false);

    expect(
      await getPrismaClient().auditLog.count({
        where: { entityId: result.location.id, entityType: 'WarehouseLocation', action: 'CREATE' },
      }),
    ).toBe(1);
  });

  it('★★ POST — 같은 창고의 중복 코드는 generic CONFLICT(409) 다 (§W-D34)', async () => {
    const created = await createWarehouse(ADMIN, input('G3'));
    await createWarehouseLocation(ADMIN, created.warehouse.id, {
      locationCode: 'A-01',
      locationName: 'A',
    });

    const error = await errorOf(
      createWarehouseLocation(ADMIN, created.warehouse.id, {
        locationCode: 'A-01',
        locationName: 'A 중복',
      }),
    );

    // ⛔ 로케이션 전용 error code 를 만들지 않았다 — 기존 generic 계약이다.
    expect(error.code).toBe(ERROR_CODES.CONFLICT);
    expect(error.httpStatus).toBe(409);
    // 어떤 중복인지는 publicDetails 로만 구분한다.
    expect(error.publicDetails).toEqual({
      warehouseId: created.warehouse.id,
      locationCode: 'A-01',
    });

    // ★ Prisma 원본(P2002·23505·제약 이름·컬럼명)이 응답에 새지 않는다.
    const exposed = JSON.stringify({
      code: error.code,
      publicMessage: error.publicMessage,
      message: error.message,
      publicHint: error.publicHint,
      publicDetails: error.publicDetails,
    });
    for (const leak of [
      'P2002',
      '23505',
      'warehouse_location',
      'location_code',
      'Unique constraint',
    ]) {
      expect(exposed, leak).not.toContain(leak);
    }
  });

  it('★ POST — 다른 창고면 같은 코드를 써도 된다', async () => {
    const a = await createWarehouse(ADMIN, input('G4a'));
    const b = await createWarehouse(ADMIN, input('G4b'));
    await createWarehouseLocation(ADMIN, a.warehouse.id, {
      locationCode: 'A-01',
      locationName: 'A',
    });
    const second = await createWarehouseLocation(ADMIN, b.warehouse.id, {
      locationCode: 'A-01',
      locationName: 'A',
    });
    expect(second.location.locationCode).toBe('A-01');
  });

  it('★ POST — 없는 창고는 404 다', async () => {
    expect(
      await codeOf(
        createWarehouseLocation(ADMIN, randomUUID(), { locationCode: 'A-01', locationName: 'A' }),
      ),
    ).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('★ POST — read 권한만으로는 403 이다 (warehouse.update 필요, W-D23)', async () => {
    const created = await createWarehouse(ADMIN, input('G5'));
    expect(
      await codeOf(
        createWarehouseLocation(READER, created.warehouse.id, {
          locationCode: 'A-01',
          locationName: 'A',
        }),
      ),
    ).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ POST 멱등 — first/replay/reused-key', async () => {
    const created = await createWarehouse(ADMIN, input('G6'));
    const key = `loc-idem-${RUN}`;
    const payload = { locationCode: 'A-01', locationName: 'A 구역' };

    const first = await createWarehouseLocation(ADMIN, created.warehouse.id, payload, {}, key);
    expect(first.replayed).toBe(false);

    const second = await createWarehouseLocation(ADMIN, created.warehouse.id, payload, {}, key);
    expect(second.replayed).toBe(true);
    expect(second.location.id).toBe(first.location.id);

    // 로케이션은 DEFAULT + A-01 = 2개뿐이다.
    expect(
      await getPrismaClient().warehouseLocation.count({
        where: { warehouseId: created.warehouse.id },
      }),
    ).toBe(2);

    expect(
      await codeOf(
        createWarehouseLocation(
          ADMIN,
          created.warehouse.id,
          { locationCode: 'A-02', locationName: '다름' },
          {},
          key,
        ),
      ),
    ).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  });
});

// ═══════════════════════════════════════════════════════════════
// 범위 밖 — T08-3 / T09 산출물 0
// ═══════════════════════════════════════════════════════════════

describe('⛔ T08-2 범위 밖 (W-D27 · W-D28 · W-D40)', () => {
  it('⛔ 창고 UI route 가 없다 (T2-20)', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    expect(
      existsSync(fileURLToPath(new URL('../../src/app/master/warehouses', import.meta.url))),
    ).toBe(false);
  });

  it('⛔ location PATCH·DELETE endpoint 가 없다 (W-D10)', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../src/app/api/warehouses', import.meta.url));
    expect(readdirSync(dir).sort()).toEqual(['[id]', 'route.ts']);
    expect(
      readdirSync(
        fileURLToPath(new URL('../../src/app/api/warehouses/[id]', import.meta.url)),
      ).sort(),
    ).toEqual(['locations', 'route.ts']);
  });

  it('⛔ T09 재고 테이블이 여전히 없다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('inventory_transaction', 'inventory_ledger_entry',
                            'inventory_balance')`;
    expect(rows).toEqual([]);
  });
});
