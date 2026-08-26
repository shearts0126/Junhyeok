import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrismaClient } from '@/shared/db';

/**
 * Warehouse · WarehouseLocation **DB 제약** 테스트 (T08-1 = v0.2 T2-1A) —
 * 실제 PostgreSQL.
 *
 * 근거: `docs/19_설계복구_Warehouse.md`
 *       (2026-08-25 Warehouse Design Recovery Decision — W-D1 ~ W-D42)
 *
 * T08-1 은 스키마·migration 단계다. application service(T08-2)·API·DTO·
 * permission·seed·화면(T2-20)이 전부 없으므로 모든 검증은 **PostgreSQL 제약이
 * 직접 거부/허용**하는지를 본다.
 *
 * ⚠️ `prisma migrate diff` 는 **CHECK · 표현식 partial index · FK 의
 *    deferrability 를 보지 못한다.** raw SQL 을 빼먹어도 drift gate 는 통과한다
 *    — 아래 카탈로그 테스트가 `warehouse_supplier_site_check` ·
 *    `ux_warehouse_in_transit_singleton` · `DEFERRABLE INITIALLY DEFERRED` 의
 *    **유일한 방어선**이다.
 *
 * ── ★ 정리(cleanup)가 까다로운 이유 ────────────────────────────────
 * `warehouse` ↔ `warehouse_location` 은 서로를 **RESTRICT** 로 참조한다
 * (W-D19). 그래서 짝지어진 창고+DEFAULT 로케이션은 일반 DELETE 로 지울 수
 * 없다 — 어느 쪽을 먼저 지워도 상대가 막는다. 이는 사고가 아니라 **물리삭제
 * 금지 정책과 정합**하는 성질이다(운영 경로에 물리삭제가 없다).
 * 테스트 잔여물 정리에는 **트랜잭션 안의 `SET LOCAL session_replication_role`**
 * 로 FK 검사를 잠시 끄는 방식을 쓴다 — `audit_log` 트리거를 DISABLE 하는 기존
 * 정리 선례와 같은 성격이다. `SET LOCAL` 은 COMMIT/ROLLBACK 에서 PostgreSQL 이
 * 스스로 되돌리므로 커넥션 풀에 replica 상태가 **누출될 수 없다**.
 * ⛔ 운영 코드에는 이 경로가 없다.
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TWH-${RUN}-${suffix}`;

/** 어떤 테이블에도 없는 UUID — FK 위반을 유발하는 데 쓴다. */
const ORPHAN_ID = 'eeeeeeee-0000-4000-8000-0000000c8001';

async function cleanup(): Promise<void> {
  // ★ 상호 RESTRICT 때문에 순서로는 풀 수 없다 — 파일 상단 주석 참조.
  //   이 파일이 만드는 행은 전부 `TWH-` prefix 를 갖는 다섯 마스터에 매달려
  //   있으므로 FK 검사만 잠시 끄고 한 번에 지운다.
  //
  // ★ `$transaction` + `SET LOCAL` 인 이유는 `warehouse-fixture.ts` 주석과 같다 —
  //   커넥션 풀에서 평범한 `SET` 은 복구가 다른 커넥션에 갈 수 있어
  //   **replica 인 채로 남은 커넥션**이 이후 DB 테스트의 FK 검사를 무력화한다.
  //   `SET LOCAL` 은 COMMIT/ROLLBACK 에서 PostgreSQL 이 스스로 되돌린다.
  await getPrismaClient().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(
      `DELETE FROM bom_line WHERE bom_header_id IN
         (SELECT h.id FROM bom_header h JOIN sku s ON s.id = h.parent_sku_id
           WHERE s.sku_code LIKE 'TWH-%')`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM bom_header WHERE parent_sku_id IN
         (SELECT id FROM sku WHERE sku_code LIKE 'TWH-%')`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM supplier_sku WHERE sku_id IN
         (SELECT id FROM sku WHERE sku_code LIKE 'TWH-%')`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM sku_external_mapping WHERE sku_id IN
         (SELECT id FROM sku WHERE sku_code LIKE 'TWH-%')`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM warehouse_location WHERE warehouse_id IN
         (SELECT id FROM warehouse WHERE warehouse_code LIKE 'TWH-%')`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM warehouse WHERE warehouse_code LIKE 'TWH-%'`);
    await tx.$executeRawUnsafe(`DELETE FROM supplier WHERE supplier_code LIKE 'TWH-%'`);
    await tx.$executeRawUnsafe(`DELETE FROM external_system WHERE system_code LIKE 'TWH-%'`);
    await tx.$executeRawUnsafe(`DELETE FROM sku WHERE sku_code LIKE 'TWH-%'`);
  });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await disconnectPrisma();
});

/**
 * W-D7 의 정확한 생성 순서로 창고 1개 + DEFAULT 로케이션 1개를 만든다.
 *
 * ① location UUID 를 **미리** 만든다 → ② warehouse INSERT → ③ location INSERT
 * → ④ COMMIT 에서 deferred FK 검증. ⛔ 사후 UPDATE 문이 없다.
 */
async function createWarehouseWithDefault(
  suffix: string,
  overrides: {
    warehouseType?:
      'INTERNAL' | 'THREE_PL' | 'SUPPLIER_SITE' | 'OVERSEAS' | 'VIRTUAL' | 'IN_TRANSIT';
    supplierId?: string | null;
    externalSystemId?: string | null;
    warehouseId?: string;
    defaultLocationId?: string;
    locationWarehouseId?: string;
  } = {},
): Promise<{ warehouseId: string; locationId: string }> {
  const warehouseId = overrides.warehouseId ?? randomUUID();
  const locationId = overrides.defaultLocationId ?? randomUUID();

  await getPrismaClient().$transaction(async (tx) => {
    await tx.warehouse.create({
      data: {
        id: warehouseId,
        warehouseCode: CODE(suffix),
        warehouseName: `창고 ${suffix}`,
        warehouseType: overrides.warehouseType ?? 'INTERNAL',
        defaultLocationId: locationId,
        ...(overrides.supplierId !== undefined ? { supplierId: overrides.supplierId } : {}),
        ...(overrides.externalSystemId !== undefined
          ? { externalSystemId: overrides.externalSystemId }
          : {}),
      },
    });
    await tx.warehouseLocation.create({
      data: {
        id: locationId,
        warehouseId: overrides.locationWarehouseId ?? warehouseId,
        locationCode: 'DEFAULT',
        locationName: 'DEFAULT',
      },
    });
  });

  return { warehouseId, locationId };
}

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
// D1 ~ D5 — DEFAULT 로케이션 불변식
// ═══════════════════════════════════════════════════════════════

describe('★ D1~D5. DEFAULT 로케이션 — same-warehouse composite FK (W-D6 · W-D7)', () => {
  it('D1. 같은 창고의 DEFAULT 로케이션을 한 트랜잭션에서 만들면 commit 된다', async () => {
    const { warehouseId, locationId } = await createWarehouseWithDefault('D1');

    const row = await getPrismaClient().warehouse.findUniqueOrThrow({
      where: { id: warehouseId },
      select: { defaultLocationId: true, defaultLocation: { select: { locationCode: true } } },
    });

    expect(row.defaultLocationId).toBe(locationId);
    expect(row.defaultLocation.locationCode).toBe('DEFAULT');
  });

  it('D2. ★ defaultLocationId 를 NULL 로 넣을 수 없다 (W-D5)', async () => {
    // Prisma 타입이 이미 막으므로 raw SQL 로 DB 계층을 직접 친다.
    await expect(
      getPrismaClient().$executeRawUnsafe(
        `INSERT INTO warehouse
           (id, warehouse_code, warehouse_name, warehouse_type, default_location_id, updated_at)
         VALUES ($1, $2, '널기본', 'INTERNAL', NULL, now())`,
        randomUUID(),
        CODE('D2'),
      ),
    ).rejects.toThrow(/null value in column "default_location_id"|not-null/i);
  });

  it('D3. ★ 다른 창고의 로케이션을 default 로 지정하면 거부된다', async () => {
    const other = await createWarehouseWithDefault('D3-other');

    // 창고 B 를 만들면서 default 를 **창고 A 의** 로케이션으로 가리킨다.
    await expect(
      getPrismaClient().warehouse.create({
        data: {
          warehouseCode: CODE('D3'),
          warehouseName: '남의 로케이션',
          warehouseType: 'INTERNAL',
          defaultLocationId: other.locationId,
        },
      }),
    ).rejects.toThrow();

    // ⛔ 부분 생성이 남지 않는다.
    const leftover = await getPrismaClient().warehouse.count({
      where: { warehouseCode: CODE('D3') },
    });
    expect(leftover).toBe(0);
  });

  it('D3b. ★ 로케이션이 아예 없는 UUID 도 거부된다', async () => {
    await expect(
      getPrismaClient().warehouse.create({
        data: {
          warehouseCode: CODE('D3b'),
          warehouseName: '없는 로케이션',
          warehouseType: 'INTERNAL',
          defaultLocationId: ORPHAN_ID,
        },
      }),
    ).rejects.toThrow();
  });

  it('D4 · D5. ★ composite FK 는 DEFERRABLE INITIALLY DEFERRED 다 (카탈로그)', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ conname: string; condeferrable: boolean; condeferred: boolean; def: string }>
    >`
      SELECT conname, condeferrable, condeferred, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'warehouse'::regclass
         AND contype = 'f'
         AND conname = 'warehouse_id_default_location_id_fkey'`;

    expect(rows).toHaveLength(1);
    const fk = rows[0]!;
    // D4 — 지연 가능해야 순환 참조를 한 트랜잭션에서 만들 수 있다.
    expect(fk.condeferrable).toBe(true);
    // D5 — 기본이 지연이어야 애플리케이션이 SET CONSTRAINTS 를 부르지 않아도 된다.
    expect(fk.condeferred).toBe(true);
    // 컬럼·참조 대상이 정확히 W-D6 대로다.
    expect(fk.def).toContain('FOREIGN KEY (id, default_location_id)');
    expect(fk.def).toContain('REFERENCES warehouse_location(warehouse_id, id)');
    expect(fk.def).toContain('ON DELETE RESTRICT');
    expect(fk.def).toContain('ON UPDATE CASCADE');
  });

  it('★ 반대 방향(warehouse_location.warehouse_id)은 즉시 검사다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ condeferrable: boolean; condeferred: boolean }>
    >`
      SELECT condeferrable, condeferred FROM pg_constraint
       WHERE conrelid = 'warehouse_location'::regclass
         AND conname = 'warehouse_location_warehouse_id_fkey'`;

    expect(rows[0]?.condeferrable).toBe(false);
    expect(rows[0]?.condeferred).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// R1 ~ R7 — default location 1:1 remediation
//
// ★ Prisma 가 multi-field 1:1 을 인정하려면 source 쪽 relation scalar 집합에
//   UNIQUE 가 있어야 한다. 그 UNIQUE 가 실제로 DB 에 있는지, 그리고 그것을
//   추가하면서 기존 제약을 **하나도 건드리지 않았는지**를 함께 고정한다.
// ═══════════════════════════════════════════════════════════════

describe('★ R1~R7. default location 1:1 — source UNIQUE 추가 · 나머지 불변', () => {
  it('R1. ★ warehouse (id, default_location_id) UNIQUE 가 카탈로그에 있다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'warehouse'
         AND indexname = 'warehouse_id_default_location_id_key'`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('UNIQUE');
    // 열 순서까지 relation 의 `fields: [id, defaultLocationId]` 와 같다.
    expect(rows[0]?.indexdef).toMatch(/\(id, default_location_id\)/);
    // ⛔ partial 이 아니다 — 모든 행에 적용된다.
    expect(rows[0]?.indexdef).not.toContain('WHERE');
  });

  it('R2. ★ warehouse_location (warehouse_id, id) UNIQUE 가 그대로 있다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'warehouse_location'
         AND indexname = 'warehouse_location_warehouse_id_id_key'`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('UNIQUE');
    expect(rows[0]?.indexdef).toMatch(/\(warehouse_id, id\)/);
  });

  it('R3 · R4 · R5. ★ default composite FK 가 remediation 으로 바뀌지 않았다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ condeferrable: boolean; condeferred: boolean; def: string }>
    >`
      SELECT condeferrable, condeferred, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'warehouse'::regclass
         AND conname = 'warehouse_id_default_location_id_fkey'`;

    expect(rows).toHaveLength(1);
    // R3 — 컬럼·참조 대상·동작 전부 T08-1 원본 그대로다.
    expect(rows[0]?.def).toBe(
      'FOREIGN KEY (id, default_location_id) REFERENCES warehouse_location(warehouse_id, id) ' +
        'ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED',
    );
    // R4 · R5 — deferrability 도 그대로다 (drop/recreate 하지 않았다).
    expect(rows[0]?.condeferrable).toBe(true);
    expect(rows[0]?.condeferred).toBe(true);
  });

  it('R6. ★ 다른 창고의 로케이션을 default 로 지정하면 여전히 거부된다', async () => {
    const other = await createWarehouseWithDefault('R6-other');

    await expect(
      getPrismaClient().warehouse.create({
        data: {
          warehouseCode: CODE('R6'),
          warehouseName: '남의 로케이션 (remediation 후)',
          warehouseType: 'INTERNAL',
          defaultLocationId: other.locationId,
        },
      }),
    ).rejects.toThrow();
  });

  it('R7. ★ 올바른 창고/DEFAULT 쌍은 여전히 한 트랜잭션에서 commit 된다', async () => {
    const { warehouseId, locationId } = await createWarehouseWithDefault('R7');

    const row = await getPrismaClient().warehouse.findUniqueOrThrow({
      where: { id: warehouseId },
      select: { defaultLocationId: true, defaultLocation: { select: { warehouseId: true } } },
    });

    expect(row.defaultLocationId).toBe(locationId);
    // ★ composite FK 가 보장하는 것 — default 로케이션의 소속 창고 = 자기 자신.
    expect(row.defaultLocation.warehouseId).toBe(warehouseId);
  });

  it('★ 새 UNIQUE 는 정상 데이터를 막지 않는다 — 창고 2개가 각자 default 를 갖는다', async () => {
    const a = await createWarehouseWithDefault('R7-a');
    const b = await createWarehouseWithDefault('R7-b');

    expect(a.warehouseId).not.toBe(b.warehouseId);
    expect(a.locationId).not.toBe(b.locationId);
    expect(
      await getPrismaClient().warehouse.count({
        where: { warehouseCode: { startsWith: `TWH-${RUN}-R7-` } },
      }),
    ).toBe(2);
  });

  it('★ inverse 를 singular 로 조회할 수 있다 — Prisma 1:1 이 실동작한다', async () => {
    const { warehouseId, locationId } = await createWarehouseWithDefault('R7-inv');

    const location = await getPrismaClient().warehouseLocation.findUniqueOrThrow({
      where: { id: locationId },
      select: { defaultForWarehouse: { select: { id: true } } },
    });

    // ★ 배열이 아니라 단일 객체다 — `Warehouse[]` 였다면 여기서 타입이 깨진다.
    expect(location.defaultForWarehouse?.id).toBe(warehouseId);
  });

  it('★ DEFAULT 가 아닌 로케이션의 inverse 는 null 이다 (optional 이 옳다)', async () => {
    const { warehouseId } = await createWarehouseWithDefault('R7-plain');
    const plain = await getPrismaClient().warehouseLocation.create({
      data: { warehouseId, locationCode: 'A-01', locationName: 'A 구역' },
      select: { id: true },
    });

    const row = await getPrismaClient().warehouseLocation.findUniqueOrThrow({
      where: { id: plain.id },
      select: { defaultForWarehouse: { select: { id: true } } },
    });

    expect(row.defaultForWarehouse).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// D6 ~ D8 — UNIQUE
// ═══════════════════════════════════════════════════════════════

describe('★ D6~D8. UNIQUE', () => {
  it('D6. warehouseCode 중복은 거부된다 (전역 UNIQUE)', async () => {
    await createWarehouseWithDefault('D6');

    await expect(
      getPrismaClient().warehouse.create({
        data: {
          warehouseCode: CODE('D6'),
          warehouseName: '중복 코드',
          warehouseType: 'INTERNAL',
          defaultLocationId: randomUUID(),
        },
      }),
    ).rejects.toThrow();
  });

  it('D7. 같은 창고 안의 locationCode 중복은 거부된다', async () => {
    const { warehouseId } = await createWarehouseWithDefault('D7');

    await expect(
      getPrismaClient().warehouseLocation.create({
        data: { warehouseId, locationCode: 'DEFAULT', locationName: '두 번째 기본' },
      }),
    ).rejects.toThrow();
  });

  it('D8. 다른 창고라면 같은 locationCode 를 써도 된다', async () => {
    const a = await createWarehouseWithDefault('D8-a');
    const b = await createWarehouseWithDefault('D8-b');

    const client = getPrismaClient();
    await client.warehouseLocation.create({
      data: { warehouseId: a.warehouseId, locationCode: 'A-01', locationName: 'A 구역' },
    });
    const second = await client.warehouseLocation.create({
      data: { warehouseId: b.warehouseId, locationCode: 'A-01', locationName: 'A 구역' },
    });

    expect(second.locationCode).toBe('A-01');
  });
});

// ═══════════════════════════════════════════════════════════════
// D9 ~ D12 — Supplier staged link (one-way CHECK)
// ═══════════════════════════════════════════════════════════════

describe('★ D9~D12. Supplier staged-link — one-way CHECK 만 (W-D13)', () => {
  it('D9. ★ SUPPLIER_SITE + supplierId null 은 허용된다 (transitional state)', async () => {
    // 이것이 허용되지 않으면 T08-2 의 SUPPLIER_SITE 11종 seed 가 실행 불가다.
    const { warehouseId } = await createWarehouseWithDefault('D9', {
      warehouseType: 'SUPPLIER_SITE',
      supplierId: null,
    });

    const row = await getPrismaClient().warehouse.findUniqueOrThrow({
      where: { id: warehouseId },
      select: { warehouseType: true, supplierId: true },
    });
    expect(row.warehouseType).toBe('SUPPLIER_SITE');
    expect(row.supplierId).toBeNull();
  });

  it('D10. SUPPLIER_SITE + 실재하는 supplierId 는 허용된다', async () => {
    const supplierId = await newSupplier('D10');
    const { warehouseId } = await createWarehouseWithDefault('D10', {
      warehouseType: 'SUPPLIER_SITE',
      supplierId,
    });

    const row = await getPrismaClient().warehouse.findUniqueOrThrow({
      where: { id: warehouseId },
      select: { supplierId: true },
    });
    expect(row.supplierId).toBe(supplierId);
  });

  it('D11. ★ non-SUPPLIER_SITE + supplierId 는 CHECK 가 거부한다', async () => {
    const supplierId = await newSupplier('D11');

    await expect(
      createWarehouseWithDefault('D11', { warehouseType: 'THREE_PL', supplierId }),
    ).rejects.toThrow(/warehouse_supplier_site_check|check constraint/i);
  });

  it('D12. 존재하지 않는 supplierId 는 FK 가 거부한다', async () => {
    await expect(
      createWarehouseWithDefault('D12', {
        warehouseType: 'SUPPLIER_SITE',
        supplierId: ORPHAN_ID,
      }),
    ).rejects.toThrow();
  });

  it('⛔ 역방향 IFF CHECK 가 존재하지 않는다 (W-D13 · T08 금지사항)', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ conname: string; def: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'warehouse'::regclass AND contype = 'c'`;

    // 있어야 하는 것: supplier_id 가 있으면 SUPPLIER_SITE 여야 한다.
    const oneWay = rows.find((row) => row.conname === 'warehouse_supplier_site_check');
    expect(oneWay?.def).toContain('supplier_id IS NULL');

    // ⛔ 없어야 하는 것: SUPPLIER_SITE 면 supplier_id 가 있어야 한다.
    //    이것이 생기면 T08-2 seed 11건이 즉시 실패한다.
    for (const row of rows) {
      expect(row.def, row.conname).not.toMatch(/supplier_id IS NOT NULL/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// D13 · D14 — externalSystem FK
// ═══════════════════════════════════════════════════════════════

describe('★ D13~D14. externalSystemId (W-D14)', () => {
  it('D13. 실재하는 externalSystemId 는 허용된다', async () => {
    const externalSystemId = await newExternalSystem('D13');
    const { warehouseId } = await createWarehouseWithDefault('D13', {
      warehouseType: 'THREE_PL',
      externalSystemId,
    });

    const row = await getPrismaClient().warehouse.findUniqueOrThrow({
      where: { id: warehouseId },
      select: { externalSystemId: true },
    });
    expect(row.externalSystemId).toBe(externalSystemId);
  });

  it('D14. 존재하지 않는 externalSystemId 는 FK 가 거부한다', async () => {
    await expect(
      createWarehouseWithDefault('D14', {
        warehouseType: 'THREE_PL',
        externalSystemId: ORPHAN_ID,
      }),
    ).rejects.toThrow();
  });

  it('★ 어떤 유형에서도 externalSystemId 는 optional 이다 (⛔ required 아님)', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ is_nullable: string }>>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'warehouse'
         AND column_name = 'external_system_id'`;
    expect(rows[0]?.is_nullable).toBe('YES');
  });
});

// ═══════════════════════════════════════════════════════════════
// D15 · D16 — IN_TRANSIT singleton
// ═══════════════════════════════════════════════════════════════

describe('★ D15~D16. IN_TRANSIT 은 전 시스템에 1개다 (W-D11)', () => {
  it('D15 · D16. 첫 IN_TRANSIT 은 성공하고 두 번째는 partial UNIQUE 가 거부한다', async () => {
    // ⚠️ 이 테스트는 전역 singleton 을 점유하므로 한 케이스에서 둘 다 본다.
    const existing = await getPrismaClient().warehouse.count({
      where: { warehouseType: 'IN_TRANSIT' },
    });
    expect(existing, 'T08-1 은 seed 를 만들지 않는다').toBe(0);

    await createWarehouseWithDefault('D15', { warehouseType: 'IN_TRANSIT' });

    await expect(
      createWarehouseWithDefault('D16', { warehouseType: 'IN_TRANSIT' }),
    ).rejects.toThrow(/ux_warehouse_in_transit_singleton|unique/i);

    expect(
      await getPrismaClient().warehouse.count({ where: { warehouseType: 'IN_TRANSIT' } }),
    ).toBe(1);
  });

  it('★ 다른 유형은 개수 제한이 없다', async () => {
    await createWarehouseWithDefault('MULTI-1', { warehouseType: 'VIRTUAL' });
    await createWarehouseWithDefault('MULTI-2', { warehouseType: 'VIRTUAL' });

    expect(
      await getPrismaClient().warehouse.count({
        where: { warehouseType: 'VIRTUAL', warehouseCode: { startsWith: `TWH-${RUN}-MULTI` } },
      }),
    ).toBe(2);
  });

  it('★ partial UNIQUE 인덱스가 카탈로그에 실재한다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'warehouse' AND indexname = 'ux_warehouse_in_transit_singleton'`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('UNIQUE');
    expect(rows[0]?.indexdef).toMatch(/WHERE \(warehouse_type = 'IN_TRANSIT'/);
  });
});

// ═══════════════════════════════════════════════════════════════
// NOT-BLANK CHECK
// ═══════════════════════════════════════════════════════════════

describe('★ NOT-BLANK CHECK (기존 convention)', () => {
  it('warehouseCode · warehouseName · timezone 의 공백-only 는 거부된다', async () => {
    for (const patch of [
      { warehouseCode: '   ' },
      { warehouseName: '  ' },
      { timezone: ' ' },
    ] as const) {
      await expect(
        getPrismaClient().warehouse.create({
          data: {
            warehouseCode: CODE(`blank-${Object.keys(patch)[0] ?? ''}`),
            warehouseName: '공백',
            warehouseType: 'INTERNAL',
            defaultLocationId: randomUUID(),
            ...patch,
          },
        }),
        Object.keys(patch)[0],
      ).rejects.toThrow();
    }
  });

  it('locationCode · locationName 의 공백-only 는 거부된다', async () => {
    const { warehouseId } = await createWarehouseWithDefault('blank-loc');

    await expect(
      getPrismaClient().warehouseLocation.create({
        data: { warehouseId, locationCode: '  ', locationName: '이름' },
      }),
    ).rejects.toThrow();

    await expect(
      getPrismaClient().warehouseLocation.create({
        data: { warehouseId, locationCode: 'L-01', locationName: '   ' },
      }),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// staged scalar 5종 — FK enforced (W-D15)
// ═══════════════════════════════════════════════════════════════

describe('★ staged warehouse scalar 5종 — 이제 FK 가 강제된다 (W-D15)', () => {
  let warehouseId = '';
  let supplierId = '';
  let skuId = '';

  beforeAll(async () => {
    const client = getPrismaClient();
    warehouseId = (await createWarehouseWithDefault('FK-target')).warehouseId;
    supplierId = await newSupplier('FK');
    const sku = await client.sku.create({
      data: { skuCode: CODE('FK'), skuName: 'FK용 SKU', itemType: 'FINISHED', baseUom: 'EA' },
      select: { id: true },
    });
    skuId = sku.id;
  });

  it('1. SkuExternalMapping.warehouseId — 실재 UUID 허용 / 유령 UUID 거부', async () => {
    const client = getPrismaClient();
    const externalSystemId = await newExternalSystem('FK1');

    const ok = await client.skuExternalMapping.create({
      data: { skuId, externalSystemId, warehouseId },
      select: { warehouseId: true },
    });
    expect(ok.warehouseId).toBe(warehouseId);

    await expect(
      client.skuExternalMapping.create({
        data: { skuId, externalSystemId, warehouseId: ORPHAN_ID },
      }),
    ).rejects.toThrow();
  });

  it('2. Supplier.defaultWarehouseId — 실재 UUID 허용 / 유령 UUID 거부', async () => {
    const client = getPrismaClient();

    const ok = await client.supplier.create({
      data: {
        supplierCode: CODE('FK2'),
        supplierName: '기본창고',
        supplierType: 'VENDOR',
        defaultWarehouseId: warehouseId,
      },
      select: { defaultWarehouseId: true },
    });
    expect(ok.defaultWarehouseId).toBe(warehouseId);

    await expect(
      client.supplier.create({
        data: {
          supplierCode: CODE('FK2x'),
          supplierName: '유령창고',
          supplierType: 'VENDOR',
          defaultWarehouseId: ORPHAN_ID,
        },
      }),
    ).rejects.toThrow();
  });

  it('3. SupplierSku.destinationWarehouseId — 실재 UUID 허용 / 유령 UUID 거부', async () => {
    const client = getPrismaClient();
    const from = new Date('2026-01-01T00:00:00.000Z');

    const ok = await client.supplierSku.create({
      data: { supplierId, skuId, effectiveFrom: from, destinationWarehouseId: warehouseId },
      select: { destinationWarehouseId: true },
    });
    expect(ok.destinationWarehouseId).toBe(warehouseId);

    await expect(
      client.supplierSku.create({
        data: {
          supplierId,
          skuId,
          effectiveFrom: new Date('2027-01-01T00:00:00.000Z'),
          destinationWarehouseId: ORPHAN_ID,
        },
      }),
    ).rejects.toThrow();
  });

  it('4 · 5. BomHeader.destinationWarehouseId · BomLine.issueWarehouseId', async () => {
    const client = getPrismaClient();
    const component = await client.sku.create({
      data: { skuCode: CODE('FK5'), skuName: '구성품', itemType: 'MATERIAL', baseUom: 'EA' },
      select: { id: true },
    });

    const header = await client.bomHeader.create({
      data: {
        parentSkuId: skuId,
        bomType: 'MANUFACTURING',
        version: '1.0',
        outputUom: 'EA',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        destinationWarehouseId: warehouseId,
      },
      select: { id: true, destinationWarehouseId: true },
    });
    expect(header.destinationWarehouseId).toBe(warehouseId);

    const line = await client.bomLine.create({
      data: {
        bomHeaderId: header.id,
        lineNo: 1,
        componentSkuId: component.id,
        uom: 'EA',
        componentRole: 'MATERIAL',
        issueWarehouseId: warehouseId,
      },
      select: { issueWarehouseId: true },
    });
    expect(line.issueWarehouseId).toBe(warehouseId);

    await expect(
      client.bomHeader.create({
        data: {
          parentSkuId: skuId,
          bomType: 'MANUFACTURING',
          version: '2.0',
          outputUom: 'EA',
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          destinationWarehouseId: ORPHAN_ID,
        },
      }),
    ).rejects.toThrow();

    // ⚠️ 같은 componentSku 를 다시 쓰면 `ux_bom_line_component_group` 이 먼저
    //    걸려 **FK 가 아닌 이유로** 실패한다 — 다른 구성품을 쓴다.
    const other = await client.sku.create({
      data: { skuCode: CODE('FK5b'), skuName: '구성품2', itemType: 'MATERIAL', baseUom: 'EA' },
      select: { id: true },
    });
    await expect(
      client.bomLine.create({
        data: {
          bomHeaderId: header.id,
          lineNo: 2,
          componentSkuId: other.id,
          uom: 'EA',
          componentRole: 'MATERIAL',
          issueWarehouseId: ORPHAN_ID,
        },
      }),
    ).rejects.toThrow(/foreign key|issue_warehouse_id/i);
  });

  it('★ 5종 모두 nullable 은 그대로다 — null 은 계속 허용된다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ table_name: string; column_name: string; is_nullable: string }>
    >`
      SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (
           ('sku_external_mapping', 'warehouse_id'),
           ('supplier',             'default_warehouse_id'),
           ('supplier_sku',         'destination_warehouse_id'),
           ('bom_header',           'destination_warehouse_id'),
           ('bom_line',             'issue_warehouse_id'))
       ORDER BY table_name, column_name`;

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.is_nullable, `${row.table_name}.${row.column_name}`).toBe('YES');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// FK action matrix — 9종 (W-D19)
// ═══════════════════════════════════════════════════════════════

describe('★ Warehouse 관련 FK 의 delete/update action (W-D19)', () => {
  /**
   * T08-1 이 landing 한 FK 9개 — 이름은 Prisma 생성 규칙 그대로다.
   *
   * ✏️ **2026-08-26 (T2-2)**: 재고 코어가 `warehouse` · `warehouse_location` 을
   *    참조하는 FK 4개를 추가했다. W-D19 의 계약(**전부 RESTRICT/CASCADE**)은
   *    그대로이며, 이 목록이 **늘어난 것까지 정확히** 고정한다 —
   *    ⛔ 개수 검사를 느슨하게 바꾸지 않는다.
   */
  const EXPECTED = [
    ['bom_header', 'bom_header_destination_warehouse_id_fkey'],
    ['bom_line', 'bom_line_issue_warehouse_id_fkey'],
    ['inventory_balance', 'inventory_balance_warehouse_id_fkey'],
    ['inventory_balance', 'inventory_balance_warehouse_id_location_id_fkey'],
    ['inventory_ledger_entry', 'inventory_ledger_entry_warehouse_id_fkey'],
    ['inventory_ledger_entry', 'inventory_ledger_entry_warehouse_id_location_id_fkey'],
    ['sku_external_mapping', 'sku_external_mapping_warehouse_id_fkey'],
    ['supplier', 'supplier_default_warehouse_id_fkey'],
    ['supplier_sku', 'supplier_sku_destination_warehouse_id_fkey'],
    ['warehouse', 'warehouse_external_system_id_fkey'],
    ['warehouse', 'warehouse_id_default_location_id_fkey'],
    ['warehouse', 'warehouse_supplier_id_fkey'],
    ['warehouse_location', 'warehouse_location_warehouse_id_fkey'],
  ] as const;

  it('정확히 13개이며 전부 ON DELETE RESTRICT · ON UPDATE CASCADE 다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ table_name: string; conname: string; def: string }>
    >`
      SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE c.contype = 'f'
         AND (c.confrelid IN ('warehouse'::regclass, 'warehouse_location'::regclass)
              OR t.relname = 'warehouse')
       ORDER BY t.relname, c.conname`;

    expect(rows.map((row) => [row.table_name, row.conname])).toEqual(
      EXPECTED.map((pair) => [...pair]),
    );

    for (const row of rows) {
      expect(row.def, `${row.conname} delete`).toContain('ON DELETE RESTRICT');
      expect(row.def, `${row.conname} update`).toContain('ON UPDATE CASCADE');
      // ⛔ CASCADE delete · SET NULL 이 하나도 없다.
      expect(row.def, `${row.conname}`).not.toContain('ON DELETE CASCADE');
      expect(row.def, `${row.conname}`).not.toContain('ON DELETE SET NULL');
    }
  });

  it('★ 참조되고 있는 창고는 물리삭제되지 않는다 (RESTRICT 실동작)', async () => {
    const client = getPrismaClient();
    const { warehouseId } = await createWarehouseWithDefault('RESTRICT');

    // DEFAULT 로케이션이 이미 이 창고를 참조하므로 삭제가 막힌다.
    await expect(client.warehouse.delete({ where: { id: warehouseId } })).rejects.toThrow();

    expect(await client.warehouse.count({ where: { id: warehouseId } })).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 범위 밖 — T09 테이블 0 · seed row 0
// ═══════════════════════════════════════════════════════════════

describe('⛔ T08-1 범위 밖 (W-D18 · W-D37)', () => {
  /**
   * ✏️ **2026-08-26 (T2-2)**: 원래는 "재고 테이블이 **아직** 없다" 를 고정했다.
   *    `T2-2`(= legacy `T09-1`)가 그 3테이블을 landing 시켰으므로 방향을 뒤집되,
   *    ⛔ **그 다음 단계(T2-19 재구축 스냅샷 등)는 여전히 없다**를 이어서 지킨다.
   */
  it('✏️ T09 재고 테이블 3개는 T2-2 가 만들었다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('inventory_transaction', 'inventory_ledger_entry',
                            'inventory_balance')
       ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      'inventory_balance',
      'inventory_ledger_entry',
      'inventory_transaction',
    ]);
  });

  it('⛔ 그 다음 단계 테이블은 여전히 없다 (T2-14 · T2-19 · T11-1)', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('balance_rebuild_snapshot', 'inventory_exception',
                            'opening_balance_batch')`;
    expect(rows).toEqual([]);
  });

  it('⛔ seed 창고가 하나도 없다 — 15종은 T08-2 다', async () => {
    const seeded = await getPrismaClient().warehouse.count({
      where: { warehouseCode: { in: ['OLPUN', 'PUMGO', 'RODIT', 'IN_TRANSIT', 'SUP_BOC'] } },
    });
    expect(seeded).toBe(0);
  });
});
