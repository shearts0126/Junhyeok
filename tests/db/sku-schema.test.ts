import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedCommonCodes } from '../../prisma/seed/common-codes';

/**
 * Sku 스키마 DB 테스트 (T1-1) — 실제 PostgreSQL.
 *
 * T1-1 은 스키마·migration 단계다. Application 계층이 없으므로 모든 검증은
 * **PostgreSQL 제약이 직접 거부**하는지를 본다 (TC-SKU-001).
 *
 * ⛔ 폐기 설계 고정: `negative_stock_allowed` 컬럼이 **존재하지 않아야** 한다.
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TSK-${RUN}-${suffix}`;

const ACTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TSK-' } } });
  await client.user.deleteMany({ where: { id: ACTOR_ID } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedCommonCodes(tx);
  });
  await cleanup();
  await client.user.create({
    data: { id: ACTOR_ID, email: 'sku-actor@deeppoint.test', name: 'SKU 액터' },
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

describe('★ TC-SKU-001 — sku_code 전역 UNIQUE (실제 PostgreSQL)', () => {
  it('★ 같은 sku_code 첫 INSERT 성공, 두 번째 INSERT 는 DB UNIQUE violation', async () => {
    const client = getPrismaClient();
    const skuCode = CODE('001');

    const first = await client.sku.create({
      data: { skuCode, skuName: '첫 등록', itemType: 'FINISHED' },
    });
    expect(first.id).toBeTruthy();

    // ★ Application validation 이 아니라 **PostgreSQL 제약**이 거부해야 한다.
    //   Prisma P2002 = DB unique constraint 위반의 매핑이다.
    try {
      await client.sku.create({
        data: { skuCode, skuName: '중복 등록 시도', itemType: 'FINISHED' },
      });
      expect.unreachable('두 번째 INSERT 가 성공하면 안 된다');
    } catch (error) {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    }

    // 원시 SQL 로도 동일 — PostgreSQL 23505 (unique_violation)
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO sku (id, sku_code, sku_name, item_type, updated_at)
         VALUES (gen_random_uuid(), $1, '원시 중복', 'FINISHED', now())`,
        skuCode,
      ),
    ).rejects.toThrow(/23505|sku_sku_code_key/);
  });

  it('★ status·deleted_at 과 무관하게 전역 UNIQUE — 조건부 완화 없음', async () => {
    const client = getPrismaClient();
    const skuCode = CODE('002');

    // ARCHIVED + deleted_at 까지 채운 SKU
    await client.sku.create({
      data: {
        skuCode,
        skuName: '보관 처리된 SKU',
        itemType: 'FINISHED',
        status: 'ARCHIVED',
        deletedAt: new Date(),
      },
    });

    // 같은 코드는 어떤 상태로도 재사용 불가
    for (const status of ['DRAFT', 'ACTIVE'] as const) {
      await expect(
        client.sku.create({
          data: { skuCode, skuName: `재사용 시도 (${status})`, itemType: 'FINISHED', status },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    }
  });

  it('UNIQUE 는 sku_sku_code_key 라는 유일 인덱스로 존재한다', async () => {
    // Prisma 의 @unique 는 UNIQUE INDEX 로 생성된다 (제약이 아니라 인덱스).
    const rows = await getPrismaClient().$queryRaw<
      Array<{ indexname: string; indexdef: string }>
    >`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'sku' AND indexname = 'sku_sku_code_key'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('UNIQUE INDEX');
    expect(rows[0]?.indexdef).toContain('(sku_code)');
  });
});

describe('★ Sku 기본값 (실제 PostgreSQL)', () => {
  it('★ 최소 필드 생성 시 승인된 기본값이 전부 적용된다', async () => {
    const row = await getPrismaClient().sku.create({
      data: { skuCode: CODE('DEF'), skuName: '기본값 검증', itemType: 'FINISHED' },
    });

    expect(row.status).toBe('DRAFT');
    expect(row.inventoryManaged).toBe(true);
    expect(row.sellable).toBe(false);
    expect(row.purchasable).toBe(false);
    expect(row.manufacturable).toBe(false);
    // ✏️ D-03 — lot·expiry·serial 은 기본 미관리
    expect(row.lotManaged).toBe(false);
    expect(row.expiryManaged).toBe(false);
    expect(row.serialManaged).toBe(false);
    expect(row.unitConversionQty.toString()).toBe('1');
    expect(row.reconciliationToleranceQty.toString()).toBe('0');
    expect(row.hasTransaction).toBe(false);
    expect(row.baseUom).toBe('EA');
    expect(row.deletedAt).toBeNull();
    expect(row.approvedAt).toBeNull();
  });
});

describe('★ Sku CHECK 제약 (실제 PostgreSQL)', () => {
  const client = () => getPrismaClient();

  it('★ sku_code 빈 값·앞뒤 공백 거부', async () => {
    for (const bad of ['', '  ', ' ABC ', 'ABC ']) {
      await expect(
        client().sku.create({
          data: { skuCode: bad, skuName: '이름', itemType: 'FINISHED' },
        }),
        `sku_code=${JSON.stringify(bad)}`,
      ).rejects.toThrow(/sku_code_not_blank_check/);
    }
  });

  it('★ sku_name·item_type·base_uom 빈 값 거부', async () => {
    await expect(
      client().sku.create({ data: { skuCode: CODE('C1'), skuName: '', itemType: 'FINISHED' } }),
    ).rejects.toThrow(/sku_name_not_blank_check/);

    await expect(
      client().sku.create({ data: { skuCode: CODE('C2'), skuName: '이름', itemType: '  ' } }),
    ).rejects.toThrow(/sku_item_type_not_blank_check/);

    await expect(
      client().sku.create({
        data: { skuCode: CODE('C3'), skuName: '이름', itemType: 'FINISHED', baseUom: '' },
      }),
    ).rejects.toThrow(/sku_base_uom_not_blank_check/);
  });

  it('★ unit_conversion_qty <= 0 거부', async () => {
    for (const bad of ['0', '-1']) {
      await expect(
        client().sku.create({
          data: {
            skuCode: CODE(`Q${bad}`),
            skuName: '이름',
            itemType: 'FINISHED',
            unitConversionQty: new Prisma.Decimal(bad),
          },
        }),
      ).rejects.toThrow(/sku_unit_conversion_qty_positive_check/);
    }
  });

  it('★ 기간·허용오차 음수 거부 (NULL 은 허용)', async () => {
    await expect(
      client().sku.create({
        data: {
          skuCode: CODE('D1'),
          skuName: '이름',
          itemType: 'FINISHED',
          defaultShelfLifeDays: -1,
        },
      }),
    ).rejects.toThrow(/sku_default_shelf_life_days_check/);

    await expect(
      client().sku.create({
        data: {
          skuCode: CODE('D2'),
          skuName: '이름',
          itemType: 'FINISHED',
          minimumRemainingDays: -1,
        },
      }),
    ).rejects.toThrow(/sku_minimum_remaining_days_check/);

    await expect(
      client().sku.create({
        data: {
          skuCode: CODE('D3'),
          skuName: '이름',
          itemType: 'FINISHED',
          reconciliationToleranceQty: new Prisma.Decimal('-0.000001'),
        },
      }),
    ).rejects.toThrow(/sku_reconciliation_tolerance_qty_check/);

    // NULL 은 허용 — 기본 생성이 이미 검증하지만 명시 필드로도 확인
    const ok = await client().sku.create({
      data: {
        skuCode: CODE('D4'),
        skuName: '이름',
        itemType: 'FINISHED',
        defaultShelfLifeDays: null,
        minimumRemainingDays: 0,
      },
    });
    expect(ok.minimumRemainingDays).toBe(0);
  });
});

describe('★ 공통코드 FK — T0-8 RESTRICT 정책의 첫 적용 (실제 PostgreSQL)', () => {
  it('★ 존재하는 BRAND/MAJOR/MINOR 코드 참조는 성공한다', async () => {
    const [brandId, majorId, minorId] = await Promise.all([
      codeId('BRAND', 'FB'),
      codeId('MAJOR_CATEGORY', 'HC'),
      codeId('MINOR_CATEGORY', 'SH'),
    ]);

    const row = await getPrismaClient().sku.create({
      data: {
        skuCode: CODE('FK1'),
        skuName: 'FK 검증',
        itemType: 'FINISHED',
        brandId,
        majorCategoryId: majorId,
        minorCategoryId: minorId,
        createdBy: ACTOR_ID,
        updatedBy: ACTOR_ID,
      },
      include: { brand: true, majorCategory: true, minorCategory: true },
    });
    expect(row.brand?.code).toBe('FB');
    expect(row.majorCategory?.code).toBe('HC');
    expect(row.minorCategory?.code).toBe('SH');
  });

  it('★ 존재하지 않는 UUID 참조는 FK 위반으로 실패한다', async () => {
    await expect(
      getPrismaClient().sku.create({
        data: {
          skuCode: CODE('FK2'),
          skuName: 'FK 실패',
          itemType: 'FINISHED',
          brandId: '00000000-0000-4000-8000-000000000000',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' }); // foreign key constraint
  });

  it('★ SKU 가 참조 중인 CommonCode 는 직접 SQL DELETE 도 RESTRICT 로 차단된다', async () => {
    const brandId = await codeId('BRAND', 'BO');
    await getPrismaClient().sku.create({
      data: { skuCode: CODE('FK3'), skuName: 'RESTRICT 검증', itemType: 'FINISHED', brandId },
    });

    await expect(
      getPrismaClient().$executeRawUnsafe(`DELETE FROM common_code WHERE id = $1::uuid`, brandId),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('actor FK 는 SET NULL — 마스터는 사용자 삭제에 딸려 지워지지 않는다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ conname: string; confdeltype: string }>
    >`SELECT conname, confdeltype::text FROM pg_constraint
      WHERE conrelid = 'sku'::regclass AND contype = 'f' ORDER BY conname`;

    const byName = new Map(rows.map((row) => [row.conname, row.confdeltype]));
    // r = RESTRICT, n = SET NULL
    expect(byName.get('sku_brand_id_fkey')).toBe('r');
    expect(byName.get('sku_major_category_id_fkey')).toBe('r');
    expect(byName.get('sku_minor_category_id_fkey')).toBe('r');
    expect(byName.get('sku_created_by_fkey')).toBe('n');
    expect(byName.get('sku_updated_by_fkey')).toBe('n');
    expect(byName.get('sku_approved_by_fkey')).toBe('n');
  });
});

describe('★ 폐기 설계 고정 (실제 PostgreSQL)', () => {
  it('★ negative_stock_allowed 컬럼이 존재하지 않는다 — SKU 상시 음수재고 허용 없음', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sku'
        AND column_name = 'negative_stock_allowed'`;
    expect(rows[0]?.count).toBe(0);
  });

  it('현재고 숫자 필드가 없다 — 현재고는 원장·잔고 소관', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sku'`;
    const names = rows.map((row) => row.column_name);
    for (const forbidden of [
      'stock',
      'quantity',
      'current_qty',
      'available_qty',
      'inventory_qty',
      'on_hand_qty',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });
});
