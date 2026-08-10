import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

/**
 * SkuBarcode 스키마·DB 제약 테스트 (T04-1) — 실제 PostgreSQL.
 *
 * T04-1 은 스키마·migration 단계다. Application 계층(T04-3)도 정규화(T04-2)도
 * 예외 승인(T04-4)도 아직 없으므로, 모든 검증은 **PostgreSQL 제약이 직접
 * 거부/허용**하는지를 본다 (★ TC-SKU-004 의 DB raw-value 범위).
 *
 * ⚠️ 여기서 `duplicate_exception = true` 행을 직접 INSERT 하는 것은
 *    **partial index predicate 의 실제 DB 동작을 검증하기 위한 fixture** 일 뿐,
 *    예외 승인 업무를 구현한다는 뜻이 아니다 (그것은 T04-4 다).
 */

const RUN = randomBytes(4).toString('hex');
const SKU_CODE = (suffix: string) => `TBC-${RUN}-${suffix}`;
/** 바코드는 ux_barcode_active 가 **전역**이므로 실행마다 유일해야 한다. */
const BC = (suffix: string) => `9${RUN}${suffix}`;

const ACTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let skuSeq = 0;

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.skuBarcode.deleteMany({ where: { sku: { skuCode: { startsWith: 'TBC-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TBC-' } } });
  await client.user.deleteMany({ where: { id: ACTOR_ID } });
}

/** 테스트마다 독립 SKU — 대표 바코드 규칙이 테스트 간에 간섭하지 않게 한다. */
async function newSku(label: string): Promise<string> {
  skuSeq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: SKU_CODE(`${String(skuSeq).padStart(3, '0')}`),
      skuName: `바코드 테스트 SKU (${label})`,
      itemType: 'FINISHED',
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  await cleanup();
  await getPrismaClient().user.create({
    data: { id: ACTOR_ID, email: 'barcode-actor@deeppoint.test', name: '바코드 액터' },
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// §15 — 스키마 기본
// ═══════════════════════════════════════════════════════════════

describe('★ SkuBarcode 스키마 (실제 PostgreSQL)', () => {
  it('1. 정상 barcode insert', async () => {
    const skuId = await newSku('정상 insert');
    const row = await getPrismaClient().skuBarcode.create({
      data: { skuId, barcode: BC('01') },
    });

    expect(row.id).toBeTruthy();
    expect(row.skuId).toBe(skuId);
    expect(row.barcode).toBe(BC('01'));
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('2. ★ barcode 는 문자열 — 앞자리 0 이 보존된다 (숫자 타입 금지)', async () => {
    const skuId = await newSku('앞자리 0');
    // 앞자리 0 + 13자리. 숫자 타입이면 소실되는 값이다.
    const leadingZero = `0000${BC('02')}`;

    const row = await getPrismaClient().skuBarcode.create({
      data: { skuId, barcode: leadingZero },
    });
    expect(row.barcode).toBe(leadingZero);
    expect(typeof row.barcode).toBe('string');

    // 다시 읽어도 동일 — DB 왕복에서 정규화·형변환이 일어나지 않는다.
    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({ where: { id: row.id } });
    expect(reread.barcode).toBe(leadingZero);

    // ★ 컬럼 타입 자체가 문자열이어야 한다 — Int/BigInt/Decimal/Float 금지.
    const columns = await getPrismaClient().$queryRaw<
      Array<{ data_type: string; character_maximum_length: number | null }>
    >`SELECT data_type, character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sku_barcode' AND column_name = 'barcode'`;
    expect(columns[0]?.data_type).toBe('character varying');
    expect(columns[0]?.character_maximum_length).toBe(100);
  });

  it('3. VARCHAR(100) 경계 — 100자 성공, 101자 거부', async () => {
    const skuId = await newSku('길이 경계');
    const client = getPrismaClient();

    const exactly100 = BC('03').padEnd(100, '7').slice(0, 100);
    expect(exactly100).toHaveLength(100);
    const ok = await client.skuBarcode.create({ data: { skuId, barcode: exactly100 } });
    expect(ok.barcode).toHaveLength(100);

    const tooLong = `${exactly100}7`;
    expect(tooLong).toHaveLength(101);
    // 22001 = string_data_right_truncation. 조용히 잘리면 안 된다.
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO sku_barcode (id, sku_id, barcode) VALUES (gen_random_uuid(), $1::uuid, $2)`,
        skuId,
        tooLong,
      ),
    ).rejects.toThrow(/22001|too long/i);
  });

  it('4. sku FK 유효 — relation 으로 되읽을 수 있다', async () => {
    const skuId = await newSku('FK 유효');
    const row = await getPrismaClient().skuBarcode.create({
      data: { skuId, barcode: BC('04') },
      include: { sku: true },
    });
    expect(row.sku.id).toBe(skuId);

    const sku = await getPrismaClient().sku.findUniqueOrThrow({
      where: { id: skuId },
      include: { barcodes: true },
    });
    expect(sku.barcodes.map((b) => b.barcode)).toEqual([BC('04')]);
  });

  it('5. 존재하지 않는 skuId 는 FK 위반으로 실패한다', async () => {
    await expect(
      getPrismaClient().skuBarcode.create({
        data: { skuId: '00000000-0000-4000-8000-000000000000', barcode: BC('05') },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('6~9. 기본값 — barcode_type=UNIT / is_primary=false / status=ACTIVE / duplicate_exception=false', async () => {
    const skuId = await newSku('기본값');
    const row = await getPrismaClient().skuBarcode.create({
      data: { skuId, barcode: BC('06') },
    });

    expect(row.barcodeType).toBe('UNIT'); // 6
    expect(row.isPrimary).toBe(false); // 7
    expect(row.status).toBe('ACTIVE'); // 8
    expect(row.duplicateException).toBe(false); // 9
  });

  it('10. nullable 필드는 기본 NULL 이며 값 지정도 정상 동작한다', async () => {
    const client = getPrismaClient();

    const bare = await client.skuBarcode.create({
      data: { skuId: await newSku('nullable 기본'), barcode: BC('10A') },
    });
    expect(bare.countryCode).toBeNull();
    expect(bare.channelCode).toBeNull();
    expect(bare.exceptionReason).toBeNull();
    expect(bare.approvedBy).toBeNull();
    expect(bare.effectiveFrom).toBeNull();
    expect(bare.effectiveTo).toBeNull();

    const filled = await client.skuBarcode.create({
      data: {
        skuId: await newSku('nullable 지정'),
        barcode: BC('10B'),
        barcodeType: 'OUTER_BOX',
        countryCode: 'KR',
        channelCode: 'SMARTSTORE',
        // ⚠️ DB 제약 검증용 fixture 다 — 예외 승인 업무(T04-4)를 구현하는 것이 아니다.
        duplicateException: true,
        exceptionReason: '원본 중복 이관',
        approvedBy: ACTOR_ID,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: new Date('2026-12-31T00:00:00Z'),
      },
    });
    expect(filled.barcodeType).toBe('OUTER_BOX');
    expect(filled.countryCode).toBe('KR');
    expect(filled.channelCode).toBe('SMARTSTORE');
    expect(filled.exceptionReason).toBe('원본 중복 이관');
    expect(filled.approvedBy).toBe(ACTOR_ID);
    expect(filled.effectiveFrom?.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(filled.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  it('BarcodeType 은 UNIT/INNER_BOX/OUTER_BOX/CHANNEL/LEGACY 5종뿐이다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ label: string }>>`
      SELECT e.enumlabel AS label FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'BarcodeType' ORDER BY e.enumsortorder`;
    expect(rows.map((r) => r.label)).toEqual([
      'UNIT',
      'INNER_BOX',
      'OUTER_BOX',
      'CHANNEL',
      'LEGACY',
    ]);
  });

  it('★ FK onDelete 정책 — sku_id = RESTRICT, approved_by = SET NULL (CASCADE 없음)', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ conname: string; confdeltype: string }>>`
      SELECT conname, confdeltype::text FROM pg_constraint
      WHERE conrelid = 'sku_barcode'::regclass AND contype = 'f' ORDER BY conname`;

    const byName = new Map(rows.map((row) => [row.conname, row.confdeltype]));
    // r = RESTRICT, n = SET NULL, c = CASCADE
    expect(byName.get('sku_barcode_sku_id_fkey')).toBe('r');
    expect(byName.get('sku_barcode_approved_by_fkey')).toBe('n');
    expect([...byName.values()]).not.toContain('c');
  });

  it('★ SKU 물리삭제는 RESTRICT 로 차단된다 — 바코드가 딸려 지워지지 않는다', async () => {
    const skuId = await newSku('SKU 물리삭제');
    await getPrismaClient().skuBarcode.create({ data: { skuId, barcode: BC('FK') } });

    await expect(
      getPrismaClient().$executeRawUnsafe(`DELETE FROM sku WHERE id = $1::uuid`, skuId),
    ).rejects.toThrow(/foreign key|violates/i);

    // 바코드도 그대로 남아 있다.
    const remaining = await getPrismaClient().skuBarcode.count({ where: { skuId } });
    expect(remaining).toBe(1);
  });

  it('★ deleted_at 컬럼이 없다 — 삭제 대신 status=INACTIVE 다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sku_barcode' AND column_name = 'deleted_at'`;
    expect(rows[0]?.count).toBe(0);
  });

  it('NOT NULL 문자열 not-blank CHECK — barcode·status 의 빈 값·앞뒤 공백 거부', async () => {
    const skuId = await newSku('not blank');
    const client = getPrismaClient();

    for (const bad of ['', '  ', ' 8809 ', '8809 ']) {
      await expect(
        client.skuBarcode.create({ data: { skuId, barcode: bad } }),
        `barcode=${JSON.stringify(bad)}`,
      ).rejects.toThrow(/sku_barcode_barcode_not_blank_check/);
    }

    await expect(
      client.skuBarcode.create({ data: { skuId, barcode: BC('NB'), status: ' ACTIVE' } }),
    ).rejects.toThrow(/sku_barcode_status_not_blank_check/);
  });
});

// ═══════════════════════════════════════════════════════════════
// §16 — 조건부 UNIQUE #1 `ux_barcode_active`
//        UNIQUE(barcode) WHERE status='ACTIVE' AND duplicate_exception=false
//
// ⚠️ 여기서는 업무적으로 중복 예외 승인 여부를 판단하지 않는다.
//    **partial index predicate 의 실제 DB 동작**만 검증한다.
// ═══════════════════════════════════════════════════════════════

describe('★ TC-SKU-004 — ux_barcode_active (활성 일반 바코드 전역 중복 차단)', () => {
  it('11. SKU A 의 ACTIVE + 일반(예외 아님) 바코드 X insert 성공', async () => {
    const skuA = await newSku('active-11');
    const row = await getPrismaClient().skuBarcode.create({
      data: { skuId: skuA, barcode: BC('11') },
    });
    expect(row.status).toBe('ACTIVE');
    expect(row.duplicateException).toBe(false);
  });

  it('12. ★ 다른 SKU B 가 같은 ACTIVE 일반 바코드 X → UNIQUE 실패', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('active-12a');
    const skuB = await newSku('active-12b');
    const barcode = BC('12');

    await client.skuBarcode.create({ data: { skuId: skuA, barcode } });

    await expect(
      client.skuBarcode.create({ data: { skuId: skuB, barcode } }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // 원시 SQL 로도 동일 — 23505 (unique_violation), 위반 인덱스는 ux_barcode_active
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO sku_barcode (id, sku_id, barcode) VALUES (gen_random_uuid(), $1::uuid, $2)`,
        skuB,
        barcode,
      ),
    ).rejects.toThrow(/23505|ux_barcode_active/);
  });

  it('13. ★ 같은 SKU 안에서 동일 ACTIVE 일반 바코드 X 두 번 → UNIQUE 실패', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('active-13');
    const barcode = BC('13');

    await client.skuBarcode.create({ data: { skuId: skuA, barcode } });
    await expect(
      client.skuBarcode.create({ data: { skuId: skuA, barcode, barcodeType: 'INNER_BOX' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('14. 기존 X 가 INACTIVE 면 ACTIVE X 를 새로 넣을 수 있다 (predicate 밖)', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('active-14a');
    const skuB = await newSku('active-14b');
    const barcode = BC('14');

    await client.skuBarcode.create({ data: { skuId: skuA, barcode, status: 'INACTIVE' } });
    const active = await client.skuBarcode.create({ data: { skuId: skuB, barcode } });
    expect(active.status).toBe('ACTIVE');

    // INACTIVE 이력은 여러 건이어도 무방하다 — predicate 밖이다.
    const another = await client.skuBarcode.create({
      data: { skuId: skuA, barcode, status: 'INACTIVE' },
    });
    expect(another.status).toBe('INACTIVE');

    // 반면 ACTIVE 일반은 이미 1건이므로 두 번째는 거부된다.
    await expect(
      client.skuBarcode.create({ data: { skuId: skuA, barcode } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('15. ★ 기존 X 가 duplicate_exception=true 면 ACTIVE 일반 X 는 여전히 1건까지 허용된다', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('active-15a');
    const skuB = await newSku('active-15b');
    const skuC = await newSku('active-15c');
    const barcode = BC('15');

    // 예외 행은 ACTIVE 여도 predicate 밖이다 (duplicate_exception = true).
    await client.skuBarcode.create({
      data: { skuId: skuA, barcode, duplicateException: true, exceptionReason: '원본 중복' },
    });

    // 따라서 일반(예외 아님) ACTIVE X 를 넣을 수 있다.
    const normal = await client.skuBarcode.create({ data: { skuId: skuB, barcode } });
    expect(normal.duplicateException).toBe(false);

    // 그러나 일반 ACTIVE X 의 **두 번째**는 예외 행 존재와 무관하게 거부된다.
    await expect(
      client.skuBarcode.create({ data: { skuId: skuC, barcode } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('16. duplicate_exception=true 행끼리는 동일 X 를 여러 건 가질 수 있다', async () => {
    const client = getPrismaClient();
    const barcode = BC('16');

    for (const label of ['16a', '16b', '16c']) {
      const skuId = await newSku(`active-${label}`);
      await client.skuBarcode.create({
        data: { skuId, barcode, duplicateException: true, exceptionReason: `이관 ${label}` },
      });
    }

    const count = await client.skuBarcode.count({ where: { barcode, duplicateException: true } });
    expect(count).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// §17 — 조건부 UNIQUE #2 `ux_barcode_primary`
//        UNIQUE(sku_id) WHERE is_primary=true AND status='ACTIVE'
// ═══════════════════════════════════════════════════════════════

describe('★ ux_barcode_primary (SKU 당 활성 대표 1개)', () => {
  it('17. SKU A 의 ACTIVE 대표 1개 성공', async () => {
    const skuA = await newSku('primary-17');
    const row = await getPrismaClient().skuBarcode.create({
      data: { skuId: skuA, barcode: BC('17'), isPrimary: true },
    });
    expect(row.isPrimary).toBe(true);
    expect(row.status).toBe('ACTIVE');
  });

  it('18. ★ SKU A 의 ACTIVE 대표 두 번째 → UNIQUE 실패', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('primary-18');

    await client.skuBarcode.create({ data: { skuId: skuA, barcode: BC('18A'), isPrimary: true } });

    await expect(
      client.skuBarcode.create({ data: { skuId: skuA, barcode: BC('18B'), isPrimary: true } }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // 원시 SQL 로도 동일 — 위반 인덱스는 ux_barcode_primary
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO sku_barcode (id, sku_id, barcode, is_primary)
         VALUES (gen_random_uuid(), $1::uuid, $2, true)`,
        skuA,
        BC('18C'),
      ),
    ).rejects.toThrow(/23505|ux_barcode_primary/);
  });

  it('19. SKU A 의 ACTIVE 대표 + ACTIVE 비대표는 함께 존재할 수 있다', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('primary-19');

    await client.skuBarcode.create({ data: { skuId: skuA, barcode: BC('19A'), isPrimary: true } });
    const secondary = await client.skuBarcode.create({
      data: { skuId: skuA, barcode: BC('19B'), barcodeType: 'INNER_BOX' },
    });
    expect(secondary.isPrimary).toBe(false);

    expect(await client.skuBarcode.count({ where: { skuId: skuA } })).toBe(2);
  });

  it('20. SKU A 의 INACTIVE 대표 이력 + ACTIVE 대표는 함께 존재할 수 있다', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('primary-20');

    await client.skuBarcode.create({
      data: { skuId: skuA, barcode: BC('20A'), isPrimary: true, status: 'INACTIVE' },
    });
    await client.skuBarcode.create({
      data: { skuId: skuA, barcode: BC('20B'), isPrimary: true, status: 'INACTIVE' },
    });
    const active = await client.skuBarcode.create({
      data: { skuId: skuA, barcode: BC('20C'), isPrimary: true },
    });
    expect(active.status).toBe('ACTIVE');

    expect(
      await client.skuBarcode.count({ where: { skuId: skuA, isPrimary: true, status: 'ACTIVE' } }),
    ).toBe(1);
  });

  it('21. 서로 다른 SKU 는 각각 ACTIVE 대표를 가질 수 있다', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('primary-21a');
    const skuB = await newSku('primary-21b');

    await client.skuBarcode.create({ data: { skuId: skuA, barcode: BC('21A'), isPrimary: true } });
    await client.skuBarcode.create({ data: { skuId: skuB, barcode: BC('21B'), isPrimary: true } });

    expect(
      await client.skuBarcode.count({
        where: { skuId: { in: [skuA, skuB] }, isPrimary: true, status: 'ACTIVE' },
      }),
    ).toBe(2);
  });

  it('★ 두 규칙은 독립이다 — 대표 여부는 값 중복 판정에 관여하지 않는다', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('independent-a');
    const skuB = await newSku('independent-b');
    const barcode = BC('IND');

    // SKU A 의 **대표** 바코드 X
    await client.skuBarcode.create({ data: { skuId: skuA, barcode, isPrimary: true } });

    // SKU B 는 대표가 비어 있지만, 값 X 가 이미 활성 일반으로 점유되어 거부된다.
    await expect(
      client.skuBarcode.create({ data: { skuId: skuB, barcode, isPrimary: true } }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // 값이 다르면 SKU B 도 자기 대표를 가질 수 있다.
    const ok = await client.skuBarcode.create({
      data: { skuId: skuB, barcode: BC('IND2'), isPrimary: true },
    });
    expect(ok.isPrimary).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// §18 — PostgreSQL catalog 검증
//
// ★ Prisma 스키마만 반영되고 raw SQL partial index 가 빠진 상태를
//   **테스트가 놓치면 안 된다.** 동작 테스트와 별개로 카탈로그에서
//   이름·유일성·partial 여부·predicate 를 직접 확인한다.
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
     WHERE i.indrelid = 'sku_barcode'::regclass
       AND i.indpred IS NOT NULL
     ORDER BY c.relname`;
}

/** PostgreSQL 이 되돌려주는 predicate 표기 차이를 흡수한다 (공백·따옴표·캐스트). */
function normalizePredicate(raw: string): string {
  return raw
    .replace(/\(|\)/g, ' ')
    .replace(/::text/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('★ PostgreSQL catalog — 조건부 UNIQUE 2종이 실제로 존재한다', () => {
  it('T04-1 의 두 partial UNIQUE 가 이름 그대로 존재한다', async () => {
    const rows = await partialUniqueIndexes();
    // ✏️ T04-4A 에서 `ux_barcode_pending_duplicate`(승인 대기 후보)가 추가됐다.
    //    T04-1 의 두 index 는 이름·규칙 그대로여야 한다.
    expect(rows.map((r) => r.indexname)).toEqual([
      'ux_barcode_active',
      'ux_barcode_pending_duplicate',
      'ux_barcode_primary',
    ]);
    for (const row of rows) {
      expect(row.isunique, row.indexname).toBe(true);
      expect(row.ispartial, row.indexname).toBe(true);
    }
  });

  it("★ ux_barcode_active — UNIQUE(barcode) WHERE status='ACTIVE' AND duplicate_exception=false", async () => {
    const rows = await partialUniqueIndexes();
    const index = rows.find((r) => r.indexname === 'ux_barcode_active');
    expect(index, 'ux_barcode_active 가 존재해야 한다').toBeDefined();
    expect(index?.columns).toBe('barcode');
    expect(normalizePredicate(index?.predicate ?? '')).toBe(
      "status = 'ACTIVE' AND duplicate_exception = false",
    );
  });

  it("★ ux_barcode_primary — UNIQUE(sku_id) WHERE is_primary=true AND status='ACTIVE'", async () => {
    const rows = await partialUniqueIndexes();
    const index = rows.find((r) => r.indexname === 'ux_barcode_primary');
    expect(index, 'ux_barcode_primary 가 존재해야 한다').toBeDefined();
    expect(index?.columns).toBe('sku_id');
    expect(normalizePredicate(index?.predicate ?? '')).toBe(
      "is_primary = true AND status = 'ACTIVE'",
    );
  });

  it('T04-1 의 두 규칙이 하나의 composite UNIQUE 로 합쳐져 있지 않다', async () => {
    const rows = await partialUniqueIndexes();
    const byName = new Map(rows.map((row) => [row.indexname, row]));
    // T04-1 의 두 index 는 각각 단일 컬럼이다 — (barcode, sku_id) 복합 UNIQUE 가 아니다.
    expect(byName.get('ux_barcode_active')?.columns).toBe('barcode');
    expect(byName.get('ux_barcode_primary')?.columns).toBe('sku_id');
    // ✏️ T04-4A 의 `ux_barcode_pending_duplicate` 는 **다른 규칙**이라 2컬럼이며,
    //    위 두 규칙과 합쳐진 것이 아니다 (predicate 가 PENDING_DUPLICATE 로 서로 배타적).
    expect(byName.get('ux_barcode_pending_duplicate')?.columns).toBe('sku_id,barcode');
  });

  it('일반(비조건부) 조회 인덱스 (sku_id) · (barcode) 도 함께 존재한다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'sku_barcode' ORDER BY indexname`;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('sku_barcode_sku_id_idx');
    expect(names).toContain('sku_barcode_barcode_idx');

    const skuIdIdx = rows.find((r) => r.indexname === 'sku_barcode_sku_id_idx');
    expect(skuIdIdx?.indexdef).not.toContain('UNIQUE');
    expect(skuIdIdx?.indexdef).not.toContain('WHERE');
  });

  it('CHECK 제약은 not-blank 2건뿐이다 — status allowlist·기간 CHECK 를 임의로 만들지 않았다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ conname: string; def: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'sku_barcode'::regclass AND contype = 'c' ORDER BY conname`;

    expect(rows.map((r) => r.conname)).toEqual([
      'sku_barcode_barcode_not_blank_check',
      'sku_barcode_status_not_blank_check',
    ]);
    // status 열거값 allowlist·기간 비교 CHECK 는 authoritative 근거가 없어 두지 않았다.
    for (const row of rows) {
      expect(row.def).not.toMatch(/INACTIVE/);
      expect(row.def).not.toMatch(/effective_/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 후속 Task 미착수 고정
// ═══════════════════════════════════════════════════════════════

describe('★ T04-1 범위 고정', () => {
  it('Prisma 오류 타입이 실제 DB 제약 위반에서 온다 (application 검증이 아니다)', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('scope-a');
    const skuB = await newSku('scope-b');
    const barcode = BC('SCOPE');

    await client.skuBarcode.create({ data: { skuId: skuA, barcode } });
    try {
      await client.skuBarcode.create({ data: { skuId: skuB, barcode } });
      expect.unreachable('두 번째 INSERT 가 성공하면 안 된다');
    } catch (error) {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    }
  });

  it('sku 테이블은 T04-1 로 바뀌지 않았다 — negative_stock_allowed 는 여전히 없다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sku'
        AND column_name = 'negative_stock_allowed'`;
    expect(rows[0]?.count).toBe(0);
  });
});
