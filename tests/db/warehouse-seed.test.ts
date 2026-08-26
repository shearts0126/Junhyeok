import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedWarehouses } from '../../prisma/seed/warehouses';

/**
 * 창고 15종 seed 테스트 (T08-2).
 *
 * 근거: `docs/19_설계복구_Warehouse.md` §W-D37(exact 15행) · §W-D38(supplier
 *       staged link) · §W-D14(externalSystem null) · §W-D35(seed audit 0) ·
 *       §W-D11(IN_TRANSIT singleton).
 *
 * ★ seed 는 **public create service 와 계약이 다르다** — `SUPPLIER_SITE` +
 *   `supplierId=null` 과 `IN_TRANSIT` 생성이 seed 에서만 허용된다. 그 차이가
 *   실제로 성립하는지가 이 파일의 핵심이다.
 */

const SEEDED_CODES = [
  'OLPUN',
  'PUMGO',
  'RODIT',
  'SUP_BOC',
  'SUP_IJC',
  'SUP_CSM',
  'SUP_CLB',
  'SUP_MKM',
  'SUP_EZC',
  'SUP_CTK',
  'SUP_RBM',
  'SUP_JPS',
  'SUP_NNN',
  'SUP_BON',
  'IN_TRANSIT',
] as const;

const SUPPLIER_SITE_CODES = SEEDED_CODES.filter((code) => code.startsWith('SUP_'));

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  // ★ warehouse ↔ location 상호 RESTRICT — 트랜잭션 안에서만 FK 검사를 끈다.
  //   `SET LOCAL` 이라 COMMIT 시 PostgreSQL 이 스스로 되돌린다.
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(
      `DELETE FROM warehouse_location WHERE warehouse_id IN
         (SELECT id FROM warehouse WHERE warehouse_code = ANY($1::text[]))`,
      SEEDED_CODES as unknown as string[],
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM warehouse WHERE warehouse_code = ANY($1::text[])`,
      SEEDED_CODES as unknown as string[],
    );
  });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

describe('★★ 창고 15종 seed (W-D37)', () => {
  it('43 · 44. 창고 15개 · DEFAULT 로케이션 15개를 만든다', async () => {
    const client = getPrismaClient();

    const result = await client.$transaction(async (tx) => seedWarehouses(tx));

    expect(result.total).toBe(15);
    expect(result.created).toBe(15);
    expect(result.skipped).toBe(0);

    const warehouses = await client.warehouse.findMany({
      where: { warehouseCode: { in: [...SEEDED_CODES] } },
      orderBy: { warehouseCode: 'asc' },
    });
    expect(warehouses).toHaveLength(15);

    // 각 창고에 DEFAULT 로케이션 정확히 1개.
    for (const warehouse of warehouses) {
      const locations = await client.warehouseLocation.findMany({
        where: { warehouseId: warehouse.id },
      });
      expect(locations, warehouse.warehouseCode).toHaveLength(1);
      expect(locations[0]?.locationCode).toBe('DEFAULT');
      expect(locations[0]?.locationName).toBe('DEFAULT');
      expect(locations[0]?.locationType).toBeNull();
      expect(locations[0]?.active).toBe(true);
      // ★ default 가 자기 창고의 로케이션을 가리킨다.
      expect(warehouse.defaultLocationId).toBe(locations[0]?.id);
    }
  });

  it('★ exact 15행 — 코드·명칭·유형이 W-D37 표와 정확히 같다', async () => {
    const rows = await getPrismaClient().warehouse.findMany({
      where: { warehouseCode: { in: [...SEEDED_CODES] } },
      select: { warehouseCode: true, warehouseName: true, warehouseType: true },
      orderBy: { warehouseCode: 'asc' },
    });

    expect(rows).toEqual(
      [
        { warehouseCode: 'IN_TRANSIT', warehouseName: '이동중', warehouseType: 'IN_TRANSIT' },
        { warehouseCode: 'OLPUN', warehouseName: '올펀', warehouseType: 'THREE_PL' },
        { warehouseCode: 'PUMGO', warehouseName: '품고', warehouseType: 'THREE_PL' },
        { warehouseCode: 'RODIT', warehouseName: '로딧', warehouseType: 'THREE_PL' },
        {
          warehouseCode: 'SUP_BOC',
          warehouseName: '본코스메틱 (BOC)',
          warehouseType: 'SUPPLIER_SITE',
        },
        {
          warehouseCode: 'SUP_BON',
          warehouseName: '본코스메틱 (BON)',
          warehouseType: 'SUPPLIER_SITE',
        },
        { warehouseCode: 'SUP_CLB', warehouseName: '갈렙이앤씨', warehouseType: 'SUPPLIER_SITE' },
        {
          warehouseCode: 'SUP_CSM',
          warehouseName: '코스메카코리아',
          warehouseType: 'SUPPLIER_SITE',
        },
        { warehouseCode: 'SUP_CTK', warehouseName: '씨티케이', warehouseType: 'SUPPLIER_SITE' },
        { warehouseCode: 'SUP_EZC', warehouseName: '이지코어', warehouseType: 'SUPPLIER_SITE' },
        { warehouseCode: 'SUP_IJC', warehouseName: '일진코스메틱', warehouseType: 'SUPPLIER_SITE' },
        {
          warehouseCode: 'SUP_JPS',
          warehouseName: '제이피에스코스메틱',
          warehouseType: 'SUPPLIER_SITE',
        },
        { warehouseCode: 'SUP_MKM', warehouseName: '마케모', warehouseType: 'SUPPLIER_SITE' },
        { warehouseCode: 'SUP_NNN', warehouseName: '뉴앤뉴', warehouseType: 'SUPPLIER_SITE' },
        { warehouseCode: 'SUP_RBM', warehouseName: '리봄화장품', warehouseType: 'SUPPLIER_SITE' },
      ].sort((a, b) => a.warehouseCode.localeCompare(b.warehouseCode)),
    );

    // ★ BOC 와 BON 은 **별도 2개**다 — 미리 합치지 않는다 (§W-D39).
    expect(rows.filter((row) => row.warehouseName.includes('본코스메틱'))).toHaveLength(2);
  });

  it('45. ★★ SUPPLIER_SITE 11건의 supplierId 가 전부 null 이다 (transitional, W-D38)', async () => {
    const rows = await getPrismaClient().warehouse.findMany({
      where: { warehouseCode: { in: [...SUPPLIER_SITE_CODES] } },
      select: { warehouseCode: true, supplierId: true },
    });

    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row.supplierId, row.warehouseCode).toBeNull();
    }
  });

  it('46. ★ externalSystemId 15건 전부 null 이다 (W-D14)', async () => {
    const rows = await getPrismaClient().warehouse.findMany({
      where: { warehouseCode: { in: [...SEEDED_CODES] } },
      select: {
        warehouseCode: true,
        externalSystemId: true,
        timezone: true,
        active: true,
        address: true,
      },
    });

    expect(rows).toHaveLength(15);
    for (const row of rows) {
      expect(row.externalSystemId, row.warehouseCode).toBeNull();
      expect(row.timezone).toBe('Asia/Seoul');
      expect(row.active).toBe(true);
      expect(row.address).toBeNull();
    }
  });

  it('47. ★★ fake Supplier 를 하나도 만들지 않았다 (W-D38)', async () => {
    // 축약어(BOC·IJC…)를 supplierCode 로 승격하지 않는다.
    const suspicious = await getPrismaClient().supplier.count({
      where: {
        OR: [
          { supplierCode: { in: SUPPLIER_SITE_CODES.map((code) => code.replace('SUP_', '')) } },
          { supplierCode: { in: [...SUPPLIER_SITE_CODES] } },
        ],
      },
    });
    expect(suspicious).toBe(0);
  });

  it('48. ★★ 재실행해도 15/15 그대로다 — 중복 생성 0 (idempotent)', async () => {
    const client = getPrismaClient();

    const second = await client.$transaction(async (tx) => seedWarehouses(tx));
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(15);

    expect(
      await client.warehouse.count({ where: { warehouseCode: { in: [...SEEDED_CODES] } } }),
    ).toBe(15);
    expect(
      await client.warehouseLocation.count({
        where: { warehouse: { warehouseCode: { in: [...SEEDED_CODES] } } },
      }),
    ).toBe(15);
  });

  it('49. ★★ seed 는 AuditLog 를 남기지 않는다 (W-D35)', async () => {
    const ids = (
      await getPrismaClient().warehouse.findMany({
        where: { warehouseCode: { in: [...SEEDED_CODES] } },
        select: { id: true, defaultLocationId: true },
      })
    ).flatMap((row) => [row.id, row.defaultLocationId]);

    const logs = await getPrismaClient().auditLog.count({ where: { entityId: { in: ids } } });
    expect(logs).toBe(0);
  });

  it('★ IN_TRANSIT 은 seed 가 만든 정확히 1개다 (W-D11)', async () => {
    expect(
      await getPrismaClient().warehouse.count({ where: { warehouseType: 'IN_TRANSIT' } }),
    ).toBe(1);
  });
});
