import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrismaClient } from '@/shared/db';

/**
 * ExternalSystem · SkuExternalMapping 스키마·DB 제약 테스트 (T05-1) — 실제 PostgreSQL.
 *
 * 근거: `docs/12_설계복구_외부상품매핑스키마.md`
 *       (2026-08-10 External Mapping Schema Design Recovery Decision)
 *
 * T05-1 은 스키마·migration 단계다. Application 계층(T05-2)도 SKU 해석 서비스(T05-3)도
 * 화면(T05-4)도 아직 없으므로, 모든 검증은 **PostgreSQL 제약이 직접 거부/허용**하는지를
 * 본다. 인수조건은 같은 문서 §11 의 **TC-SKU-009A~F** 다.
 *
 * ⚠️ `prisma migrate diff` 는 partial index 를 보지 못한다(T04-1·T04-4A 실측).
 *    raw SQL 을 빼먹어도 drift gate 는 통과하므로, PostgreSQL 카탈로그를 직접
 *    조회하는 아래 테스트가 조건부 UNIQUE 2종의 **유일한 방어선**이다.
 */

const RUN = randomBytes(4).toString('hex');
/** `system_code` 는 전역 UNIQUE 이므로 실행마다 유일해야 한다. */
const SYS = (suffix: string) => `TXM-${RUN}-${suffix}`;
const SKU_CODE = (suffix: string) => `TXM-${RUN}-${suffix}`;

let skuSeq = 0;

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.skuExternalMapping.deleteMany({
    where: { externalSystem: { systemCode: { startsWith: 'TXM-' } } },
  });
  await client.skuExternalMapping.deleteMany({
    where: { sku: { skuCode: { startsWith: 'TXM-' } } },
  });
  await client.externalSystem.deleteMany({ where: { systemCode: { startsWith: 'TXM-' } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TXM-' } } });
}

async function newSku(label: string): Promise<string> {
  skuSeq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: SKU_CODE(String(skuSeq).padStart(3, '0')),
      skuName: `외부매핑 테스트 SKU (${label})`,
      itemType: 'FINISHED',
    },
    select: { id: true },
  });
  return row.id;
}

async function newSystem(suffix: string, type = 'ERP'): Promise<string> {
  const row = await getPrismaClient().externalSystem.create({
    data: { systemCode: SYS(suffix), systemName: `테스트 외부시스템 ${suffix}`, systemType: type },
    select: { id: true },
  });
  return row.id;
}

beforeAll(cleanup);

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 스키마 기본 — ExternalSystem
// ═══════════════════════════════════════════════════════════════

describe('★ ExternalSystem 스키마 (실제 PostgreSQL)', () => {
  it('정상 insert — active 기본값 true', async () => {
    const row = await getPrismaClient().externalSystem.create({
      data: { systemCode: SYS('ES01'), systemName: '이카운트 ERP', systemType: 'ERP' },
    });

    expect(row.id).toBeTruthy();
    expect(row.systemCode).toBe(SYS('ES01'));
    expect(row.systemName).toBe('이카운트 ERP');
    expect(row.systemType).toBe('ERP');
    expect(row.active).toBe(true);
  });

  it('★ systemName 은 길이 제한이 없는 TEXT 다 — 임의 VARCHAR 를 붙이지 않았다', async () => {
    const columns = await getPrismaClient().$queryRaw<
      Array<{ data_type: string; character_maximum_length: number | null }>
    >`SELECT data_type, character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'external_system' AND column_name = 'system_name'`;

    expect(columns[0]?.data_type).toBe('text');
    expect(columns[0]?.character_maximum_length).toBeNull();

    // 실제로 500자를 넘겨도 잘리지 않는다.
    const long = '가'.repeat(1000);
    const row = await getPrismaClient().externalSystem.create({
      data: { systemCode: SYS('ES02'), systemName: long, systemType: 'WMS' },
    });
    expect(row.systemName).toHaveLength(1000);
  });

  it('★ systemType 은 VARCHAR(30) String 이다 — enum 이 아니다', async () => {
    const columns = await getPrismaClient().$queryRaw<
      Array<{ data_type: string; character_maximum_length: number | null; udt_name: string }>
    >`SELECT data_type, character_maximum_length, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'external_system' AND column_name = 'system_type'`;

    expect(columns[0]?.data_type).toBe('character varying');
    expect(columns[0]?.character_maximum_length).toBe(30);
    // udt_name 이 enum 타입명이면 안 된다 — 주석의 ERP/WMS/THREE_PL/CHANNEL 은 예시다.
    expect(columns[0]?.udt_name).toBe('varchar');

    // 문서 주석에 없는 값도 저장된다 (allowlist 가 아니다).
    const row = await getPrismaClient().externalSystem.create({
      data: { systemCode: SYS('ES03'), systemName: '오픈마켓', systemType: 'MARKETPLACE' },
    });
    expect(row.systemType).toBe('MARKETPLACE');
  });

  it('★ TC-SKU-009A — 동일 systemCode 재삽입은 UNIQUE 위반, 다른 코드는 허용', async () => {
    const client = getPrismaClient();
    await client.externalSystem.create({
      data: { systemCode: SYS('LEGACY_ERP'), systemName: '기존 ERP', systemType: 'ERP' },
    });

    await expect(
      client.externalSystem.create({
        data: { systemCode: SYS('LEGACY_ERP'), systemName: '중복 시도', systemType: 'ERP' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // 다른 systemCode 는 허용된다.
    const other = await client.externalSystem.create({
      data: { systemCode: SYS('EBUT_MANAGER'), systemName: '이벗매니저', systemType: 'WMS' },
    });
    expect(other.systemCode).toBe(SYS('EBUT_MANAGER'));
  });

  it('⛔ 감사 컬럼이 없다 — created_at/created_by/updated_at/updated_by/deleted_at 모두 미존재', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'external_system' ORDER BY column_name`;

    // 모델별 명시 선언이 §공통 규약의 일반 감사 컬럼 규약보다 우선한다 (T04-1 과 동일 원칙).
    expect(rows.map((r) => r.column_name)).toEqual([
      'active',
      'id',
      'system_code',
      'system_name',
      'system_type',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 스키마 기본 — SkuExternalMapping
// ═══════════════════════════════════════════════════════════════

describe('★ SkuExternalMapping 스키마 (실제 PostgreSQL)', () => {
  it('정상 insert — 기본값 mapping_status=REVIEW_REQUIRED / is_primary=false', async () => {
    const row = await getPrismaClient().skuExternalMapping.create({
      data: { skuId: await newSku('기본값'), externalSystemId: await newSystem('M01') },
    });

    expect(row.id).toBeTruthy();
    expect(row.mappingStatus).toBe('REVIEW_REQUIRED');
    expect(row.isPrimary).toBe(false);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('nullable 필드는 기본 NULL 이며 값 지정도 정상 동작한다', async () => {
    const client = getPrismaClient();

    const bare = await client.skuExternalMapping.create({
      data: { skuId: await newSku('nullable 기본'), externalSystemId: await newSystem('M02') },
    });
    expect(bare.warehouseId).toBeNull();
    expect(bare.externalProductCode).toBeNull();
    expect(bare.externalProductName).toBeNull();
    expect(bare.externalBarcode).toBeNull();
    expect(bare.effectiveFrom).toBeNull();
    expect(bare.effectiveTo).toBeNull();
    expect(bare.note).toBeNull();

    const filled = await client.skuExternalMapping.create({
      data: {
        skuId: await newSku('nullable 지정'),
        externalSystemId: await newSystem('M03'),
        externalProductCode: 'P-0001',
        externalProductName: '외부 원문 상품명',
        externalBarcode: '8809619961373',
        mappingStatus: 'MATCHED',
        isPrimary: true,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: new Date('2026-12-31T00:00:00Z'),
        note: '수기 확인 완료',
      },
    });
    expect(filled.externalProductCode).toBe('P-0001');
    expect(filled.externalProductName).toBe('외부 원문 상품명');
    expect(filled.externalBarcode).toBe('8809619961373');
    expect(filled.mappingStatus).toBe('MATCHED');
    expect(filled.isPrimary).toBe(true);
    expect(filled.effectiveFrom?.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(filled.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(filled.note).toBe('수기 확인 완료');
  });

  it('컬럼 길이 — external_product_code 150 / external_product_name 500 / external_barcode 100', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ column_name: string; data_type: string; character_maximum_length: number | null }>
    >`SELECT column_name, data_type, character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sku_external_mapping'
        AND column_name IN ('external_product_code', 'external_product_name', 'external_barcode')
      ORDER BY column_name`;

    expect(rows).toEqual([
      {
        column_name: 'external_barcode',
        data_type: 'character varying',
        character_maximum_length: 100,
      },
      {
        column_name: 'external_product_code',
        data_type: 'character varying',
        character_maximum_length: 150,
      },
      {
        column_name: 'external_product_name',
        data_type: 'character varying',
        character_maximum_length: 500,
      },
    ]);
  });

  it('MappingStatus 는 MATCHED/UNMATCHED/REVIEW_REQUIRED 3종뿐이다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ label: string }>>`
      SELECT e.enumlabel AS label FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'MappingStatus' ORDER BY e.enumsortorder`;

    expect(rows.map((r) => r.label)).toEqual(['MATCHED', 'UNMATCHED', 'REVIEW_REQUIRED']);
  });

  it('⛔ 감사 컬럼은 created_at 하나뿐이다 — created_by/updated_at/updated_by/deleted_at 미존재', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sku_external_mapping' ORDER BY column_name`;

    expect(rows.map((r) => r.column_name)).toEqual([
      'created_at',
      'effective_from',
      'effective_to',
      'external_barcode',
      'external_product_code',
      'external_product_name',
      'external_system_id',
      'id',
      'is_primary',
      'mapping_status',
      'note',
      'sku_id',
      'warehouse_id',
    ]);
  });

  it('⛔ CHECK 제약이 하나도 없다 — not-blank·기간 비교 CHECK 를 임의로 만들지 않았다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ conname: string; def: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'sku_external_mapping'::regclass AND contype = 'c' ORDER BY conname`;

    // external_product_code 에 not-blank CHECK 를 걸면 ux_external_mapping_code 의
    // `<> ''` predicate(빈 문자열을 명시적으로 제외 대상으로 삼음)와 모순된다.
    expect(rows).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// FK
// ═══════════════════════════════════════════════════════════════

describe('★ 외래키', () => {
  it('sku FK 유효 — 양방향 relation 으로 되읽을 수 있다', async () => {
    const skuId = await newSku('FK 유효');
    const systemId = await newSystem('FK1');

    const row = await getPrismaClient().skuExternalMapping.create({
      data: { skuId, externalSystemId: systemId, externalProductCode: 'FK-P001' },
      include: { sku: true, externalSystem: true },
    });
    expect(row.sku.id).toBe(skuId);
    expect(row.externalSystem.id).toBe(systemId);

    const sku = await getPrismaClient().sku.findUniqueOrThrow({
      where: { id: skuId },
      include: { externalMappings: true },
    });
    expect(sku.externalMappings.map((m) => m.externalProductCode)).toEqual(['FK-P001']);
  });

  it('존재하지 않는 skuId 는 FK 위반으로 실패한다', async () => {
    await expect(
      getPrismaClient().skuExternalMapping.create({
        data: {
          skuId: '00000000-0000-4000-8000-000000000000',
          externalSystemId: await newSystem('FK2'),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('존재하지 않는 externalSystemId 는 FK 위반으로 실패한다', async () => {
    await expect(
      getPrismaClient().skuExternalMapping.create({
        data: {
          skuId: await newSku('시스템 FK 위반'),
          externalSystemId: '00000000-0000-4000-8000-000000000000',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('두 FK 모두 RESTRICT 다 — 참조 중인 SKU·외부시스템을 물리삭제할 수 없다', async () => {
    const client = getPrismaClient();
    const skuId = await newSku('RESTRICT');
    const systemId = await newSystem('FK3');
    await client.skuExternalMapping.create({ data: { skuId, externalSystemId: systemId } });

    await expect(client.sku.delete({ where: { id: skuId } })).rejects.toMatchObject({
      code: 'P2003',
    });
    await expect(client.externalSystem.delete({ where: { id: systemId } })).rejects.toMatchObject({
      code: 'P2003',
    });

    const constraints = await client.$queryRaw<Array<{ conname: string; def: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'sku_external_mapping'::regclass AND contype = 'f' ORDER BY conname`;
    for (const row of constraints) {
      expect(row.def, row.conname).toContain('ON DELETE RESTRICT');
      expect(row.def, row.conname).toContain('ON UPDATE CASCADE');
    }
  });

  it('★ warehouse_id 는 이제 FK 로 강제된다 — 임의 UUID 는 거부된다 (T08-1 landing)', async () => {
    // ⚠️ **T05-1 staged state 가 T08-1 에서 supersede 되었다.**
    //    원래 이 테스트는 "`Warehouse` 모델이 없어 임의 UUID 도 저장된다" 를
    //    고정했다. `docs/19_설계복구_Warehouse.md §W-D15` 가 이 컬럼을
    //    **real FK 로 landing** 시켰으므로 방향이 반대로 바뀐다
    //    (docs/12 §3 이 예고한 그대로다 — §W-D21).
    //    ⛔ 컬럼 자체는 여전히 삭제하지 않는다(아래 별도 테스트).
    const orphanWarehouseId = '11111111-1111-4111-8111-111111111111';

    await expect(
      getPrismaClient().skuExternalMapping.create({
        data: {
          skuId: await newSku('warehouse orphan'),
          externalSystemId: await newSystem('WH0'),
          warehouseId: orphanWarehouseId,
        },
      }),
    ).rejects.toThrow();

    // 카탈로그에 warehouse_id FK 가 **있어야** 한다 (RESTRICT · CASCADE).
    const fks = await getPrismaClient().$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'sku_external_mapping'::regclass AND contype = 'f'`;
    const warehouseFk = fks.find((f) => f.def.includes('warehouse_id'));
    expect(warehouseFk).toBeDefined();
    expect(warehouseFk?.def).toContain('REFERENCES warehouse(id)');
    expect(warehouseFk?.def).toContain('ON DELETE RESTRICT');
    expect(warehouseFk?.def).toContain('ON UPDATE CASCADE');
  });

  it('★ warehouse_id 는 여전히 nullable 이고 null 저장이 정상이다', async () => {
    // T05-2 public API 는 이 필드를 받지 않으므로 실제 값은 항상 null 이다
    // (docs/13 §5). FK landing 이 그 계약을 바꾸지 않는다.
    const row = await getPrismaClient().skuExternalMapping.create({
      data: {
        skuId: await newSku('warehouse null'),
        externalSystemId: await newSystem('WH1'),
      },
    });
    expect(row.warehouseId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// TC-SKU-009B~F — 조건부 UNIQUE 실제 동작
// ═══════════════════════════════════════════════════════════════

describe('★ TC-SKU-009B~E — ux_external_mapping_code', () => {
  it('B. 동일 system + 동일 코드 + effectiveTo=NULL 2건은 거부된다', async () => {
    const client = getPrismaClient();
    const systemId = await newSystem('B1');

    await client.skuExternalMapping.create({
      data: {
        skuId: await newSku('B 첫 매핑'),
        externalSystemId: systemId,
        externalProductCode: 'P001',
      },
    });

    await expect(
      client.skuExternalMapping.create({
        data: {
          skuId: await newSku('B 중복 매핑'),
          externalSystemId: systemId,
          externalProductCode: 'P001',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('C. 시스템이 다르면 동일 코드가 각각 허용된다 (ERP·WMS·3PL 별칭 분리)', async () => {
    const client = getPrismaClient();
    const systemA = await newSystem('C1', 'ERP');
    const systemB = await newSystem('C2', 'WMS');
    const skuId = await newSku('C 동일 SKU');

    const a = await client.skuExternalMapping.create({
      data: { skuId, externalSystemId: systemA, externalProductCode: 'P001' },
    });
    const b = await client.skuExternalMapping.create({
      data: { skuId, externalSystemId: systemB, externalProductCode: 'P001' },
    });

    expect(a.externalProductCode).toBe('P001');
    expect(b.externalProductCode).toBe('P001');
    expect(a.externalSystemId).not.toBe(b.externalSystemId);
  });

  it('D. 종료된 매핑(effectiveTo != NULL)과 현행 매핑은 동일 코드로 공존한다', async () => {
    const client = getPrismaClient();
    const systemId = await newSystem('D1');

    const historical = await client.skuExternalMapping.create({
      data: {
        skuId: await newSku('D 과거'),
        externalSystemId: systemId,
        externalProductCode: 'P001',
        effectiveTo: new Date('2026-06-30T00:00:00Z'),
      },
    });
    const current = await client.skuExternalMapping.create({
      data: {
        skuId: await newSku('D 현행'),
        externalSystemId: systemId,
        externalProductCode: 'P001',
      },
    });

    expect(historical.effectiveTo).not.toBeNull();
    expect(current.effectiveTo).toBeNull();

    // 종료된 매핑끼리도 여러 건 공존한다 — predicate 밖이다.
    const another = await client.skuExternalMapping.create({
      data: {
        skuId: await newSku('D 과거2'),
        externalSystemId: systemId,
        externalProductCode: 'P001',
        effectiveTo: new Date('2026-03-31T00:00:00Z'),
      },
    });
    expect(another.id).toBeTruthy();
  });

  it('E. 동일 system 에서 코드 NULL 여러 건이 허용된다 (IS NOT NULL 을 붙이지 않았다)', async () => {
    const client = getPrismaClient();
    const systemId = await newSystem('E1');

    const first = await client.skuExternalMapping.create({
      data: { skuId: await newSku('E NULL 1'), externalSystemId: systemId },
    });
    const second = await client.skuExternalMapping.create({
      data: { skuId: await newSku('E NULL 2'), externalSystemId: systemId },
    });

    expect(first.externalProductCode).toBeNull();
    expect(second.externalProductCode).toBeNull();
  });

  it("E. 동일 system 에서 코드 '' 여러 건이 허용된다 (predicate `<> ''` 밖)", async () => {
    const client = getPrismaClient();
    const systemId = await newSystem('E2');

    const first = await client.skuExternalMapping.create({
      data: {
        skuId: await newSku('E 빈값 1'),
        externalSystemId: systemId,
        externalProductCode: '',
      },
    });
    const second = await client.skuExternalMapping.create({
      data: {
        skuId: await newSku('E 빈값 2'),
        externalSystemId: systemId,
        externalProductCode: '',
      },
    });

    // not-blank CHECK 가 없으므로 빈 문자열이 그대로 저장된다.
    expect(first.externalProductCode).toBe('');
    expect(second.externalProductCode).toBe('');
  });
});

describe('★ TC-SKU-009F — ux_external_mapping_primary', () => {
  it('F. 동일 (SKU, 외부시스템) 에서 isPrimary=true 2건은 거부된다', async () => {
    const client = getPrismaClient();
    const skuId = await newSku('F 대표');
    const systemId = await newSystem('F1');

    await client.skuExternalMapping.create({
      data: { skuId, externalSystemId: systemId, externalProductCode: 'F-A', isPrimary: true },
    });

    await expect(
      client.skuExternalMapping.create({
        data: { skuId, externalSystemId: systemId, externalProductCode: 'F-B', isPrimary: true },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('F. ★ effectiveTo 가 있어도 동일하다 — 종료된 대표가 새 대표를 막는다', async () => {
    const client = getPrismaClient();
    const skuId = await newSku('F 종료 대표');
    const systemId = await newSystem('F2');

    // 이미 종료된 과거 대표 매핑.
    await client.skuExternalMapping.create({
      data: {
        skuId,
        externalSystemId: systemId,
        externalProductCode: 'F-OLD',
        isPrimary: true,
        effectiveTo: new Date('2026-01-31T00:00:00Z'),
      },
    });

    // predicate 에 effective_to 조건이 없으므로 새 대표는 거부된다.
    // ⚠️ UX 상 불편해 보여도 T05-1 스키마에서 고치지 않는다 — 매핑 종료·대표 변경
    //    semantics 는 T05-2 설계의 몫이다 (docs/12 §7).
    await expect(
      client.skuExternalMapping.create({
        data: { skuId, externalSystemId: systemId, externalProductCode: 'F-NEW', isPrimary: true },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('F. isPrimary=false 는 몇 건이든 허용된다', async () => {
    const client = getPrismaClient();
    const skuId = await newSku('F 비대표');
    const systemId = await newSystem('F3');

    await client.skuExternalMapping.create({
      data: { skuId, externalSystemId: systemId, externalProductCode: 'F-N1' },
    });
    const second = await client.skuExternalMapping.create({
      data: { skuId, externalSystemId: systemId, externalProductCode: 'F-N2' },
    });
    expect(second.isPrimary).toBe(false);
  });

  it('F. 외부시스템이 다르면 각각 대표 1개씩 허용된다', async () => {
    const client = getPrismaClient();
    const skuId = await newSku('F 시스템별 대표');

    const a = await client.skuExternalMapping.create({
      data: {
        skuId,
        externalSystemId: await newSystem('F4', 'ERP'),
        externalProductCode: 'F-S1',
        isPrimary: true,
      },
    });
    const b = await client.skuExternalMapping.create({
      data: {
        skuId,
        externalSystemId: await newSystem('F5', 'WMS'),
        externalProductCode: 'F-S2',
        isPrimary: true,
      },
    });

    expect(a.isPrimary).toBe(true);
    expect(b.isPrimary).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// PostgreSQL 카탈로그 — 조건부 UNIQUE 2종의 정확한 정의
//
// ★ `prisma migrate diff` 는 partial index 를 보지 못한다. 아래가 유일한 방어선이다.
// ═══════════════════════════════════════════════════════════════

interface IndexRow {
  readonly indexname: string;
  readonly isunique: boolean;
  readonly ispartial: boolean;
  readonly predicate: string | null;
  readonly columns: string;
}

async function partialUniqueIndexes(): Promise<IndexRow[]> {
  return getPrismaClient().$queryRaw<IndexRow[]>`
    SELECT c.relname                                   AS indexname,
           i.indisunique                               AS isunique,
           (i.indpred IS NOT NULL)                     AS ispartial,
           pg_get_expr(i.indpred, i.indrelid)          AS predicate,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'sku_external_mapping'::regclass
       AND i.indpred IS NOT NULL
     ORDER BY c.relname`;
}

/** PostgreSQL 이 되돌려주는 predicate 표기 차이를 흡수한다 (공백·괄호·캐스트). */
function normalizePredicate(raw: string): string {
  return raw
    .replace(/\(|\)/g, ' ')
    .replace(/::text/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('★ PostgreSQL catalog — 조건부 UNIQUE 2종이 실제로 존재한다', () => {
  it('두 partial UNIQUE 가 이름 그대로 존재한다', async () => {
    const rows = await partialUniqueIndexes();
    expect(rows.map((r) => r.indexname)).toEqual([
      'ux_external_mapping_code',
      'ux_external_mapping_primary',
    ]);
    for (const row of rows) {
      expect(row.isunique, row.indexname).toBe(true);
      expect(row.ispartial, row.indexname).toBe(true);
    }
  });

  it("★ ux_external_mapping_code — (external_system_id, external_product_code) WHERE code <> '' AND effective_to IS NULL", async () => {
    const index = (await partialUniqueIndexes()).find(
      (r) => r.indexname === 'ux_external_mapping_code',
    );
    expect(index, 'ux_external_mapping_code 가 존재해야 한다').toBeDefined();
    expect(index?.columns).toBe('external_system_id,external_product_code');
    expect(normalizePredicate(index?.predicate ?? '')).toBe(
      "external_product_code <> '' AND effective_to IS NULL",
    );
    // ⛔ `IS NOT NULL` 을 덧붙이지 않았다 — NULL 은 predicate 가 NULL 이라 이미 제외된다.
    expect(index?.predicate).not.toMatch(/external_product_code IS NOT NULL/);
  });

  it('★ ux_external_mapping_primary — (sku_id, external_system_id) WHERE is_primary = true', async () => {
    const index = (await partialUniqueIndexes()).find(
      (r) => r.indexname === 'ux_external_mapping_primary',
    );
    expect(index, 'ux_external_mapping_primary 가 존재해야 한다').toBeDefined();
    expect(index?.columns).toBe('sku_id,external_system_id');
    expect(normalizePredicate(index?.predicate ?? '')).toBe('is_primary = true');
  });

  it('★ primary predicate 에 effective_to 가 없다 — Barcode 의 predicate 를 복사하지 않았다', async () => {
    const index = (await partialUniqueIndexes()).find(
      (r) => r.indexname === 'ux_external_mapping_primary',
    );
    expect(index?.predicate).not.toMatch(/effective_to/);
    expect(index?.predicate).not.toMatch(/status/);
  });

  it('두 규칙이 하나의 composite UNIQUE 로 합쳐져 있지 않다', async () => {
    const byName = new Map((await partialUniqueIndexes()).map((row) => [row.indexname, row]));
    expect(byName.get('ux_external_mapping_code')?.columns).toBe(
      'external_system_id,external_product_code',
    );
    expect(byName.get('ux_external_mapping_primary')?.columns).toBe('sku_id,external_system_id');
  });

  it('일반(비조건부) 조회 인덱스와 systemCode 전역 UNIQUE 가 함께 존재한다', async () => {
    const client = getPrismaClient();

    const mappingIndexes = await client.$queryRaw<
      Array<{ indexname: string; indexdef: string }>
    >`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'sku_external_mapping' ORDER BY indexname`;
    const names = mappingIndexes.map((r) => r.indexname);
    expect(names).toContain('sku_external_mapping_sku_id_idx');
    expect(names).toContain('sku_external_mapping_external_system_id_mapping_status_idx');

    const skuIdIdx = mappingIndexes.find((r) => r.indexname === 'sku_external_mapping_sku_id_idx');
    expect(skuIdIdx?.indexdef).not.toContain('UNIQUE');
    expect(skuIdIdx?.indexdef).not.toContain('WHERE');

    // ★ 백로그 완료조건 "동일 시스템 코드 중복 차단" 은 이 전역 UNIQUE 가 담당한다.
    //   조건부 UNIQUE 2종과 혼동하지 않는다.
    const systemIndexes = await client.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'external_system' ORDER BY indexname`;
    const systemCodeIdx = systemIndexes.find(
      (r) => r.indexname === 'external_system_system_code_key',
    );
    expect(systemCodeIdx?.indexdef).toContain('UNIQUE');
    expect(systemCodeIdx?.indexdef).not.toContain('WHERE');
  });
});

// ═══════════════════════════════════════════════════════════════
// T05-1 범위 고정 — 후속 Task 선구현 금지
// ═══════════════════════════════════════════════════════════════

const SCHEMA_SOURCE = readFileSync(
  fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)),
  'utf8',
);

describe('★ T05-1 범위 고정', () => {
  it('⛔ ExternalInventorySnapshot 모델이 아직 없다 — T17-1 로 연기 (선행조건이 T05-1)', () => {
    // T17-1 의 선행조건이 T05-1 이므로 여기서 stub 을 만들면 의존이 역전된다.
    // T17-1 에서 `ExternalSystem.snapshots` 와 `ExternalInventorySnapshot.externalSystem`
    // 양쪽 relation 을 **함께** 추가한다 (docs/12 §3).
    expect(SCHEMA_SOURCE).not.toMatch(/^\s*model\s+ExternalInventorySnapshot\b/m);
    expect(SCHEMA_SOURCE).not.toMatch(/^\s*model\s+ExternalInventorySnapshotLine\b/m);
    expect(SCHEMA_SOURCE).not.toMatch(/^\s*snapshots\s+ExternalInventorySnapshot\[\]/m);
  });

  it('★ Warehouse 모델·relation 이 landing 했다 (T08-1)', () => {
    // ⚠️ T05-1 이 "T08-1 로 연기" 로 고정했던 단언의 **반대 방향**이다
    //    (docs/19 §W-D15 · §W-D21).
    expect(SCHEMA_SOURCE).toMatch(/^\s*model\s+Warehouse\b/m);
    expect(SCHEMA_SOURCE).toMatch(/^\s*model\s+WarehouseLocation\b/m);
    expect(SCHEMA_SOURCE).toMatch(/^\s*warehouse\s+Warehouse\?\s/m);
  });

  it('⛔ ExternalInventorySnapshot 은 여전히 없다 — T17-1 이다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('external_inventory_snapshot', 'external_inventory_snapshot_line')`;
    expect(rows).toEqual([]);
  });

  it('★ warehouse · warehouse_location 테이블이 DB 에 있다 (T08-1)', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('warehouse', 'warehouse_location')
      ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual(['warehouse', 'warehouse_location']);
  });

  it('★ warehouse_id 컬럼 자체는 존재한다 — 삭제하지 않았다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ data_type: string; is_nullable: string }>
    >`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sku_external_mapping'
        AND column_name = 'warehouse_id'`;

    expect(rows[0]?.data_type).toBe('uuid');
    expect(rows[0]?.is_nullable).toBe('YES');
  });
});
