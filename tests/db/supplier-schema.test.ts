import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

/**
 * Supplier · SupplierSku · SupplierSkuPrice 스키마·DB 제약 테스트 (T06-1) — 실제 PostgreSQL.
 *
 * 근거: `docs/17_설계복구_거래처공급조건.md`
 *       (2026-08-12 Supplier Schema Design Recovery Decision — D-1 ~ D-25)
 *
 * T06-1 은 스키마·migration 단계다. 공급조건 API(T06-2)도 가격이력·승인 API(T06-3)도
 * 화면(T06-4)도 없으므로, 모든 검증은 **PostgreSQL 제약이 직접 거부/허용**하는지를 본다.
 *
 * ⚠️ `prisma migrate diff` 는 **partial index·EXCLUDE·extension 을 보지 못한다.**
 *    raw SQL 을 빼먹어도 drift gate 는 통과한다 — 아래 카탈로그 테스트가
 *    `btree_gist` · `supplier_sku_effective_period_excl` ·
 *    `ux_supplier_sku_primary_current` 의 **유일한 방어선**이다.
 *
 * ⚠️ staged scalar 3종(`default_warehouse_id`·`destination_warehouse_id`·
 *    `attachment_id`)에 FK 가 **없는 것**도 함께 고정한다. FK 누락 사고가 아니라
 *    T08-1 / Attachment 를 기다리는 의도된 상태이며, 그쪽이 구현될 때 이 테스트는
 *    **반대 방향으로 바뀌어야 한다**.
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TSP-${RUN}-${suffix}`;

const USER_A = 'dddddddd-0000-4000-8000-0000000d1001';
const USER_B = 'dddddddd-0000-4000-8000-0000000d1002';
const USER_IDS = [USER_A, USER_B];

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

let seq = 0;

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.supplierSkuPrice.deleteMany({
    where: { supplierSku: { supplier: { supplierCode: { startsWith: 'TSP-' } } } },
  });
  await client.supplierSku.deleteMany({
    where: { supplier: { supplierCode: { startsWith: 'TSP-' } } },
  });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TSP-' } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TSP-' } } });
  await client.user.deleteMany({ where: { id: { in: USER_IDS } } });
}

beforeAll(async () => {
  await cleanup();
  await getPrismaClient().user.createMany({
    data: [
      { id: USER_A, email: 'supplier-price-a@deeppoint.test', name: '가격 작성자' },
      { id: USER_B, email: 'supplier-price-b@deeppoint.test', name: '가격 승인자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

async function newSupplier(label: string, data: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().supplier.create({
    data: {
      supplierCode: CODE(`S${String(seq).padStart(3, '0')}`),
      supplierName: `테스트 거래처 (${label})`,
      supplierType: 'MANUFACTURER',
      ...data,
    },
    select: { id: true },
  });
  return row.id;
}

async function newSku(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `공급조건 테스트 SKU (${label})`,
      itemType: 'FINISHED_GOOD',
    },
    select: { id: true },
  });
  return row.id;
}

interface TermInput {
  readonly from: string;
  readonly to?: string | null;
  readonly isPrimary?: boolean;
}

async function newTerm(supplierId: string, skuId: string, input: TermInput): Promise<string> {
  const row = await getPrismaClient().supplierSku.create({
    data: {
      supplierId,
      skuId,
      effectiveFrom: d(input.from),
      effectiveTo: input.to === undefined || input.to === null ? null : d(input.to),
      isPrimary: input.isPrimary ?? false,
    },
    select: { id: true },
  });
  return row.id;
}

/** raw INSERT — Prisma 타입이 막는 값(빈 문자열 등)도 DB 까지 보내기 위해 쓴다. */
async function rawSupplier(column: string, value: string): Promise<void> {
  seq += 1;
  const base: Record<string, string> = {
    supplier_code: CODE(`R${String(seq).padStart(3, '0')}`),
    supplier_name: '원시 INSERT 거래처',
    supplier_type: 'VENDOR',
    status: 'ACTIVE',
  };
  base[column] = value;
  await getPrismaClient().$executeRawUnsafe(
    `INSERT INTO supplier (id, supplier_code, supplier_name, supplier_type, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
    base['supplier_code'],
    base['supplier_name'],
    base['supplier_type'],
    base['status'],
  );
}

// ═══════════════════════════════════════════════════════════════
// Supplier
// ═══════════════════════════════════════════════════════════════

describe('Supplier — 기본·UNIQUE·NOT BLANK', () => {
  it('1·7. 거래처를 만들 수 있고 status 기본값은 ACTIVE 다', async () => {
    const id = await newSupplier('기본');
    const row = await getPrismaClient().supplier.findUniqueOrThrow({ where: { id } });

    expect(row.status).toBe('ACTIVE');
    expect(row.supplierType).toBe('MANUFACTURER');
    expect(row.defaultLeadTimeDays).toBeNull();
    expect(row.defaultWarehouseId).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it('2. ★ supplierCode 는 전역 UNIQUE 다', async () => {
    const client = getPrismaClient();
    seq += 1;
    const code = CODE(`U${String(seq).padStart(3, '0')}`);
    await client.supplier.create({
      data: { supplierCode: code, supplierName: '원본', supplierType: 'VENDOR' },
    });

    await expect(
      client.supplier.create({
        data: { supplierCode: code, supplierName: '중복', supplierType: 'MANUFACTURER' },
      }),
    ).rejects.toThrow();
  });

  it('3·4·5·6. ★ required 문자열 4종은 blank 를 거부한다', async () => {
    for (const column of ['supplier_code', 'supplier_name', 'supplier_type', 'status']) {
      // 빈 문자열과 공백만 있는 값 둘 다 막아야 한다.
      await expect(rawSupplier(column, ''), `${column} 빈 문자열`).rejects.toThrow();
      await expect(rawSupplier(column, '   '), `${column} 공백만`).rejects.toThrow();
    }
  });

  it('★ supplierType·status 는 값 목록을 제한하지 않는다 (enum·allow-list 없음)', async () => {
    // 문서의 4종 예시 밖 값도 저장된다 — closed enum 이 아니다.
    const id = await newSupplier('임의 타입', { supplierType: 'CUSTOM_TYPE', status: 'SUSPENDED' });
    const row = await getPrismaClient().supplier.findUniqueOrThrow({ where: { id } });

    expect(row.supplierType).toBe('CUSTOM_TYPE');
    expect(row.status).toBe('SUSPENDED');
  });

  it('★ businessRegistrationNo 는 UNIQUE 가 아니고 email format CHECK 도 없다', async () => {
    await newSupplier('사업자번호 A', {
      businessRegistrationNo: '000-00-00000',
      contactEmail: 'not-an-email',
    });
    // 같은 사업자번호·형식이 아닌 email 이 또 들어가도 막히지 않는다.
    const id = await newSupplier('사업자번호 B', {
      businessRegistrationNo: '000-00-00000',
      contactEmail: '@@@',
    });

    expect(id).toBeTruthy();
  });
});

describe('Supplier — defaultLeadTimeDays', () => {
  it('8. NULL 이 그대로 보존된다 (0 으로 바뀌지 않는다)', async () => {
    const id = await newSupplier('리드타임 null');
    const row = await getPrismaClient().supplier.findUniqueOrThrow({ where: { id } });

    expect(row.defaultLeadTimeDays).toBeNull();
    expect(row.defaultLeadTimeDays).not.toBe(0);
  });

  it('9. ★ 0 은 유효한 값이다 (명시적 즉시납)', async () => {
    const id = await newSupplier('리드타임 0', { defaultLeadTimeDays: 0 });
    const row = await getPrismaClient().supplier.findUniqueOrThrow({ where: { id } });

    expect(row.defaultLeadTimeDays).toBe(0);
  });

  it('10. 음수는 거부된다', async () => {
    await expect(newSupplier('리드타임 음수', { defaultLeadTimeDays: -1 })).rejects.toThrow();
  });
});

describe('Supplier — defaultWarehouseId (T08-1 FK landing)', () => {
  it('11·12. ★ 임의 UUID 는 이제 FK 가 거부한다 (T08-1 이 staged state 를 supersede)', async () => {
    // ⚠️ **T06-1 staged state 가 T08-1 에서 supersede 되었다.**
    //    원래 이 테스트는 "warehouse 테이블이 없어 참조 무결성이 걸리지 않는다"
    //    를 고정했다. `docs/19_설계복구_Warehouse.md §W-D15 #2` 가 이 컬럼을
    //    real FK 로 landing 시켰으므로 방향이 반대다 (docs/17 §8 예고 · §W-D21).
    const orphan = '99999999-9999-4999-8999-999999999999';

    await expect(newSupplier('창고 orphan', { defaultWarehouseId: orphan })).rejects.toThrow();
  });

  it('★ null 은 계속 허용된다 — T06-2 API 가 이 필드를 받지 않는다', async () => {
    const id = await newSupplier('창고 null');
    const row = await getPrismaClient().supplier.findUniqueOrThrow({ where: { id } });
    expect(row.defaultWarehouseId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// SupplierSku
// ═══════════════════════════════════════════════════════════════

describe('SupplierSku — enum·FK·기본값', () => {
  it('13. ★ SupplyType 은 정확히 SELF_SUPPLIED / TURNKEY 두 값이다', async () => {
    const labels = await getPrismaClient().$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'SupplyType'
       ORDER BY e.enumsortorder
    `;

    expect(labels.map((row) => row.enumlabel)).toEqual(['SELF_SUPPLIED', 'TURNKEY']);
  });

  it('14. supplyType 기본값은 SELF_SUPPLIED 다', async () => {
    const supplierId = await newSupplier('공급유형 기본');
    const skuId = await newSku('공급유형 기본');
    const id = await newTerm(supplierId, skuId, { from: '2026-01-01' });

    const row = await getPrismaClient().supplierSku.findUniqueOrThrow({ where: { id } });
    expect(row.supplyType).toBe('SELF_SUPPLIED');
    expect(row.currency).toBe('KRW');
    expect(row.isPrimary).toBe(false);
  });

  it('15·16. 없는 supplier·SKU 를 참조할 수 없다 (FK)', async () => {
    const client = getPrismaClient();
    const supplierId = await newSupplier('FK');
    const skuId = await newSku('FK');
    const missing = '88888888-8888-4888-8888-888888888888';

    await expect(
      client.supplierSku.create({
        data: { supplierId: missing, skuId, effectiveFrom: d('2026-01-01') },
      }),
    ).rejects.toThrow();
    await expect(
      client.supplierSku.create({
        data: { supplierId, skuId: missing, effectiveFrom: d('2026-01-01') },
      }),
    ).rejects.toThrow();
  });

  it('17. ★ 참조 중인 supplier·SKU 는 물리삭제되지 않는다 (RESTRICT)', async () => {
    const client = getPrismaClient();
    const supplierId = await newSupplier('RESTRICT');
    const skuId = await newSku('RESTRICT');
    await newTerm(supplierId, skuId, { from: '2026-01-01' });

    await expect(client.supplier.delete({ where: { id: supplierId } })).rejects.toThrow();
    await expect(client.sku.delete({ where: { id: skuId } })).rejects.toThrow();
  });
});

describe('SupplierSku — 수량·리드타임·정밀도', () => {
  it('18·19·20. moq — NULL 허용 / 양수 허용 / 0·음수 차단', async () => {
    const supplierId = await newSupplier('moq');
    const client = getPrismaClient();

    const nullSku = await newSku('moq null');
    const nullRow = await client.supplierSku.create({
      data: { supplierId, skuId: nullSku, effectiveFrom: d('2026-01-01') },
    });
    expect(nullRow.moq).toBeNull();

    const okSku = await newSku('moq 양수');
    const okRow = await client.supplierSku.create({
      data: { supplierId, skuId: okSku, effectiveFrom: d('2026-01-01'), moq: '10.5' },
    });
    expect(okRow.moq?.toString()).toBe('10.5');

    for (const bad of ['0', '-1']) {
      const badSku = await newSku(`moq ${bad}`);
      await expect(
        client.supplierSku.create({
          data: { supplierId, skuId: badSku, effectiveFrom: d('2026-01-01'), moq: bad },
        }),
        bad,
      ).rejects.toThrow();
    }
  });

  it('21·22·23. orderMultiple — NULL 허용 / 양수 허용 / 0·음수 차단', async () => {
    const supplierId = await newSupplier('배수');
    const client = getPrismaClient();

    const okSku = await newSku('배수 양수');
    const okRow = await client.supplierSku.create({
      data: { supplierId, skuId: okSku, effectiveFrom: d('2026-01-01'), orderMultiple: '5' },
    });
    expect(okRow.orderMultiple?.toString()).toBe('5');

    for (const bad of ['0', '-2']) {
      const badSku = await newSku(`배수 ${bad}`);
      await expect(
        client.supplierSku.create({
          data: { supplierId, skuId: badSku, effectiveFrom: d('2026-01-01'), orderMultiple: bad },
        }),
        bad,
      ).rejects.toThrow();
    }
  });

  it('24·25·26. leadTimeDays — NULL 보존 / 0 허용 / 음수 차단', async () => {
    const supplierId = await newSupplier('리드타임');
    const client = getPrismaClient();

    const nullSku = await newSku('리드타임 null');
    const nullRow = await client.supplierSku.create({
      data: { supplierId, skuId: nullSku, effectiveFrom: d('2026-01-01') },
    });
    // ★ G-03 — null 이 0 으로 바뀌면 안 된다.
    expect(nullRow.leadTimeDays).toBeNull();

    const zeroSku = await newSku('리드타임 0');
    const zeroRow = await client.supplierSku.create({
      data: { supplierId, skuId: zeroSku, effectiveFrom: d('2026-01-01'), leadTimeDays: 0 },
    });
    expect(zeroRow.leadTimeDays).toBe(0);

    const badSku = await newSku('리드타임 음수');
    await expect(
      client.supplierSku.create({
        data: { supplierId, skuId: badSku, effectiveFrom: d('2026-01-01'), leadTimeDays: -1 },
      }),
    ).rejects.toThrow();
  });

  it('29. ★ Decimal(18,6) 정밀도가 보존된다 (Number 변환 없음)', async () => {
    const supplierId = await newSupplier('정밀도');
    const skuId = await newSku('정밀도');
    const row = await getPrismaClient().supplierSku.create({
      data: {
        supplierId,
        skuId,
        effectiveFrom: d('2026-01-01'),
        moq: '0.000001',
        orderMultiple: '123456789012.123456',
      },
    });

    expect(row.moq).toBeInstanceOf(Prisma.Decimal);
    expect(row.moq?.toString()).toBe('0.000001');
    expect(row.orderMultiple?.toString()).toBe('123456789012.123456');
  });

  it('27·28. ★ destinationWarehouseId 의 임의 UUID 는 FK 가 거부한다 (T08-1 landing)', async () => {
    // ⚠️ T06-1 staged state → T08-1 supersede (docs/19 §W-D15 #3 · §W-D21).
    const orphan = '77777777-7777-4777-8777-777777777777';
    const supplierId = await newSupplier('입고처 orphan');
    const skuId = await newSku('입고처 orphan');

    await expect(
      getPrismaClient().supplierSku.create({
        data: {
          supplierId,
          skuId,
          effectiveFrom: d('2026-01-01'),
          destinationWarehouseId: orphan,
        },
      }),
    ).rejects.toThrow();

    // null 은 계속 허용된다 — T06-2 API 는 이 필드를 받지 않는다.
    const row = await getPrismaClient().supplierSku.create({
      data: { supplierId, skuId, effectiveFrom: d('2026-01-01') },
    });
    expect(row.destinationWarehouseId).toBeNull();
  });

  it('★ purchaseUom 은 free string 이고 currency blank 는 거부된다', async () => {
    const supplierId = await newSupplier('단위');
    const skuId = await newSku('단위');
    const row = await getPrismaClient().supplierSku.create({
      data: { supplierId, skuId, effectiveFrom: d('2026-01-01'), purchaseUom: 'BOX(20)' },
    });
    expect(row.purchaseUom).toBe('BOX(20)');

    const blankSku = await newSku('통화 blank');
    await expect(
      getPrismaClient().supplierSku.create({
        data: { supplierId, skuId: blankSku, effectiveFrom: d('2026-01-01'), currency: '   ' },
      }),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 적용기간 — [from, to) half-open
// ═══════════════════════════════════════════════════════════════

describe('SupplierSku — 적용기간 CHECK', () => {
  it('30. 종료일이 시작일보다 늦으면 저장된다', async () => {
    const supplierId = await newSupplier('기간 정상');
    const skuId = await newSku('기간 정상');
    const id = await newTerm(supplierId, skuId, { from: '2026-01-01', to: '2026-02-01' });

    expect(id).toBeTruthy();
  });

  it('31. ★ 같은 날짜(zero-length 구간)는 거부된다', async () => {
    const supplierId = await newSupplier('기간 동일');
    const skuId = await newSku('기간 동일');

    await expect(
      newTerm(supplierId, skuId, { from: '2026-01-01', to: '2026-01-01' }),
    ).rejects.toThrow();
  });

  it('★ 종료일이 시작일보다 이르면 거부된다', async () => {
    const supplierId = await newSupplier('기간 역전');
    const skuId = await newSku('기간 역전');

    await expect(
      newTerm(supplierId, skuId, { from: '2026-02-01', to: '2026-01-01' }),
    ).rejects.toThrow();
  });
});

describe('★ SupplierSku — 적용기간 중첩 차단 (EXCLUDE)', () => {
  it('32. ★ 경계가 맞닿는 기간은 허용된다 — [from, to) 이므로 겹치지 않는다', async () => {
    const supplierId = await newSupplier('경계 접촉');
    const skuId = await newSku('경계 접촉');

    await newTerm(supplierId, skuId, { from: '2026-01-01', to: '2026-02-01' });
    // 02-01 은 앞 구간에 포함되지 않으므로 그대로 이어붙일 수 있다.
    const second = await newTerm(supplierId, skuId, { from: '2026-02-01', to: '2026-03-01' });
    // 그 뒤를 무기한으로 이어도 된다.
    const third = await newTerm(supplierId, skuId, { from: '2026-03-01' });

    expect(second).toBeTruthy();
    expect(third).toBeTruthy();
  });

  it('33. ★ 부분 중첩은 차단된다', async () => {
    const supplierId = await newSupplier('부분중첩');
    const skuId = await newSku('부분중첩');

    await newTerm(supplierId, skuId, { from: '2026-01-01', to: '2026-03-01' });
    await expect(
      newTerm(supplierId, skuId, { from: '2026-02-01', to: '2026-04-01' }),
    ).rejects.toThrow();
  });

  it('34. ★ 완전 포함도 차단된다', async () => {
    const supplierId = await newSupplier('포함');
    const skuId = await newSku('포함');

    await newTerm(supplierId, skuId, { from: '2026-01-01', to: '2026-12-01' });
    await expect(
      newTerm(supplierId, skuId, { from: '2026-03-01', to: '2026-04-01' }),
    ).rejects.toThrow();
  });

  it('35. ★ open-ended 중첩도 차단된다 (UNIQUE 만으로는 못 막는 경우)', async () => {
    const supplierId = await newSupplier('무기한');
    const skuId = await newSku('무기한');

    await newTerm(supplierId, skuId, { from: '2026-01-01', to: '2026-12-31' });
    // 시작일이 달라 UNIQUE(supplier,sku,from) 는 통과하지만 EXCLUDE 가 막는다.
    await expect(newTerm(supplierId, skuId, { from: '2026-06-01' })).rejects.toThrow();

    // 반대 방향(기존이 무기한, 신규가 그 안쪽)도 마찬가지다.
    const other = await newSku('무기한 역방향');
    await newTerm(supplierId, other, { from: '2026-01-01' });
    await expect(
      newTerm(supplierId, other, { from: '2026-06-01', to: '2026-07-01' }),
    ).rejects.toThrow();
  });

  it('36. 다른 공급업체면 같은 기간을 가질 수 있다', async () => {
    const a = await newSupplier('격리 A');
    const b = await newSupplier('격리 B');
    const skuId = await newSku('공급업체 격리');

    await newTerm(a, skuId, { from: '2026-01-01', to: '2026-06-01' });
    const second = await newTerm(b, skuId, { from: '2026-01-01', to: '2026-06-01' });

    expect(second).toBeTruthy();
  });

  it('37. 다른 SKU 면 같은 기간을 가질 수 있다', async () => {
    const supplierId = await newSupplier('SKU 격리');
    const first = await newSku('SKU 격리 1');
    const second = await newSku('SKU 격리 2');

    await newTerm(supplierId, first, { from: '2026-01-01', to: '2026-06-01' });
    const created = await newTerm(supplierId, second, { from: '2026-01-01', to: '2026-06-01' });

    expect(created).toBeTruthy();
  });

  it('38. 동일 (supplier, sku, effectiveFrom) 복합 UNIQUE 도 그대로 살아 있다', async () => {
    const supplierId = await newSupplier('복합 UNIQUE');
    const skuId = await newSku('복합 UNIQUE');

    await newTerm(supplierId, skuId, { from: '2026-01-01', to: '2026-02-01' });
    // 같은 시작일 → UNIQUE 와 EXCLUDE 양쪽에 걸린다. 어느 쪽이든 거부되어야 한다.
    await expect(
      newTerm(supplierId, skuId, { from: '2026-01-01', to: '2026-01-15' }),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// isPrimary
// ═══════════════════════════════════════════════════════════════

describe('★ SupplierSku — 현행 대표 1개 (partial UNIQUE)', () => {
  it('39. ★ 현재 미종료 대표는 SKU 당 1개다 (공급업체가 달라도)', async () => {
    const a = await newSupplier('대표 A');
    const b = await newSupplier('대표 B');
    const skuId = await newSku('대표 1개');

    await newTerm(a, skuId, { from: '2026-01-01', isPrimary: true });
    // ★ key 가 sku_id 단독이므로 다른 공급업체여도 두 번째 현행 대표는 불가능하다.
    await expect(newTerm(b, skuId, { from: '2026-01-01', isPrimary: true })).rejects.toThrow();
  });

  it('39b. 대표가 아닌 공급조건은 여러 건 있어도 된다', async () => {
    const a = await newSupplier('비대표 A');
    const b = await newSupplier('비대표 B');
    const skuId = await newSku('비대표 다건');

    await newTerm(a, skuId, { from: '2026-01-01' });
    const second = await newTerm(b, skuId, { from: '2026-01-01' });

    expect(second).toBeTruthy();
  });

  it('40. ★ 종료된 과거 대표는 새 대표를 막지 않는다', async () => {
    const a = await newSupplier('대표 교대 A');
    const b = await newSupplier('대표 교대 B');
    const skuId = await newSku('대표 교대');

    // 종료된 대표 — predicate(effective_to IS NULL) 밖이라 UNIQUE 대상이 아니다.
    await newTerm(a, skuId, { from: '2026-01-01', to: '2026-02-01', isPrimary: true });
    const next = await newTerm(b, skuId, { from: '2026-02-01', isPrimary: true });

    expect(next).toBeTruthy();
  });

  it('41. ★ 시작일이 미래여도 effectiveTo 가 NULL 이면 UNIQUE 대상이다 (수용된 한계)', async () => {
    const a = await newSupplier('미래 대표 A');
    const b = await newSupplier('미래 대표 B');
    const skuId = await newSku('미래 대표');

    await newTerm(a, skuId, { from: '2026-01-01', isPrimary: true });
    // predicate 에 `effective_from <= today` 가 없으므로 미래 시작 대표도 막힌다.
    // scheduled primary 가 필요해지면 별도 Recovery 다 (docs/17 §23).
    await expect(newTerm(b, skuId, { from: '2099-01-01', isPrimary: true })).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// SupplierSkuPrice
// ═══════════════════════════════════════════════════════════════

describe('SupplierSkuPrice — 기본·FK·정밀도', () => {
  async function newTermFor(label: string): Promise<string> {
    const supplierId = await newSupplier(label);
    const skuId = await newSku(label);
    return newTerm(supplierId, skuId, { from: '2026-01-01' });
  }

  it('42·46·48. 가격 행 생성 — currency 기본 KRW, vatIncluded 기본 false', async () => {
    const supplierSkuId = await newTermFor('가격 기본');
    const row = await getPrismaClient().supplierSkuPrice.create({
      data: { supplierSkuId, unitPrice: '1000', effectiveFrom: d('2026-01-01') },
    });

    expect(row.currency).toBe('KRW');
    expect(row.vatIncluded).toBe(false);
    expect(row.effectiveTo).toBeNull();
    expect(row.sourceDocument).toBeNull();
  });

  it('43. 없는 SupplierSku 를 참조할 수 없다', async () => {
    await expect(
      getPrismaClient().supplierSkuPrice.create({
        data: {
          supplierSkuId: '66666666-6666-4666-8666-666666666666',
          unitPrice: '1000',
          effectiveFrom: d('2026-01-01'),
        },
      }),
    ).rejects.toThrow();
  });

  it('44. ★ 가격이 달린 공급조건은 물리삭제되지 않는다 (RESTRICT — CASCADE 아님)', async () => {
    const supplierSkuId = await newTermFor('부모 삭제');
    await getPrismaClient().supplierSkuPrice.create({
      data: { supplierSkuId, unitPrice: '1000', effectiveFrom: d('2026-01-01') },
    });

    await expect(
      getPrismaClient().supplierSku.delete({ where: { id: supplierSkuId } }),
    ).rejects.toThrow();
  });

  it('45. ★ Decimal(18,4) 정밀도가 보존된다', async () => {
    const supplierSkuId = await newTermFor('가격 정밀도');
    const row = await getPrismaClient().supplierSkuPrice.create({
      data: { supplierSkuId, unitPrice: '12345678901234.5678', effectiveFrom: d('2026-01-01') },
    });

    expect(row.unitPrice).toBeInstanceOf(Prisma.Decimal);
    expect(row.unitPrice.toString()).toBe('12345678901234.5678');
  });

  it('47. currency blank 는 거부된다', async () => {
    const supplierSkuId = await newTermFor('가격 통화');
    await expect(
      getPrismaClient().supplierSkuPrice.create({
        data: {
          supplierSkuId,
          unitPrice: '1000',
          currency: '  ',
          effectiveFrom: d('2026-01-01'),
        },
      }),
    ).rejects.toThrow();
  });

  it('49. 적용기간 CHECK 가 공급조건과 동일하다 (to > from)', async () => {
    const supplierSkuId = await newTermFor('가격 기간');
    const client = getPrismaClient();

    await expect(
      client.supplierSkuPrice.create({
        data: {
          supplierSkuId,
          unitPrice: '1000',
          effectiveFrom: d('2026-01-01'),
          effectiveTo: d('2026-01-01'),
        },
      }),
    ).rejects.toThrow();

    const ok = await client.supplierSkuPrice.create({
      data: {
        supplierSkuId,
        unitPrice: '1000',
        effectiveFrom: d('2026-01-01'),
        effectiveTo: d('2026-02-01'),
      },
    });
    expect(ok.id).toBeTruthy();
  });

  it('50. 동일 (supplierSkuId, effectiveFrom) 은 중복될 수 없다', async () => {
    const supplierSkuId = await newTermFor('가격 중복');
    const client = getPrismaClient();

    await client.supplierSkuPrice.create({
      data: { supplierSkuId, unitPrice: '1000', effectiveFrom: d('2026-01-01') },
    });
    await expect(
      client.supplierSkuPrice.create({
        data: { supplierSkuId, unitPrice: '2000', effectiveFrom: d('2026-01-01') },
      }),
    ).rejects.toThrow();
  });

  it('51. ★ 시작일이 다르면 기간이 겹쳐도 저장된다 — 가격에는 EXCLUDE 가 없다', async () => {
    const supplierSkuId = await newTermFor('가격 중첩 허용');
    const client = getPrismaClient();

    // 무기한 가격 위에 겹치는 가격을 얹어도 DB 는 막지 않는다.
    // 이전 가격 자동 마감은 T06-3 application transaction 의 몫이다 (docs/17 §21).
    await client.supplierSkuPrice.create({
      data: { supplierSkuId, unitPrice: '1000', effectiveFrom: d('2026-01-01') },
    });
    const overlapping = await client.supplierSkuPrice.create({
      data: { supplierSkuId, unitPrice: '1200', effectiveFrom: d('2026-06-01') },
    });

    expect(overlapping.id).toBeTruthy();
  });

  it('52·53. ★ attachmentId 는 임의 UUID 를 받는다 — FK 없음 (Attachment 미구현)', async () => {
    const supplierSkuId = await newTermFor('첨부 staged');
    const orphan = '55555555-5555-4555-8555-555555555555';
    const row = await getPrismaClient().supplierSkuPrice.create({
      data: {
        supplierSkuId,
        unitPrice: '1000',
        effectiveFrom: d('2026-01-01'),
        attachmentId: orphan,
        sourceDocument: '2026-01 견적서.pdf',
      },
    });

    expect(row.attachmentId).toBe(orphan);
  });
});

describe('★ SupplierSkuPrice — 승인 상태는 approvedBy 로 표현한다', () => {
  async function newTermFor(label: string): Promise<string> {
    const supplierId = await newSupplier(label);
    const skuId = await newSku(label);
    return newTerm(supplierId, skuId, { from: '2026-01-01' });
  }

  it('54·55·58. createdBy·approvedBy 는 nullable 이고 NULL/비NULL 모두 저장된다', async () => {
    const client = getPrismaClient();

    const anonymous = await client.supplierSkuPrice.create({
      data: {
        supplierSkuId: await newTermFor('승인 없음'),
        unitPrice: '1000',
        effectiveFrom: d('2026-01-01'),
      },
    });
    // ★ approvedBy IS NULL = 미승인
    expect(anonymous.createdBy).toBeNull();
    expect(anonymous.approvedBy).toBeNull();

    const approved = await client.supplierSkuPrice.create({
      data: {
        supplierSkuId: await newTermFor('승인 있음'),
        unitPrice: '1000',
        effectiveFrom: d('2026-01-01'),
        createdBy: USER_A,
        approvedBy: USER_B,
      },
    });
    // ★ approvedBy IS NOT NULL = 승인 완료
    expect(approved.createdBy).toBe(USER_A);
    expect(approved.approvedBy).toBe(USER_B);
  });

  it('56·57. ★ actor 는 RESTRICT 다 — 사용자를 지워 승인이 풀리지 않는다', async () => {
    const client = getPrismaClient();
    await client.supplierSkuPrice.create({
      data: {
        supplierSkuId: await newTermFor('actor RESTRICT'),
        unitPrice: '1000',
        effectiveFrom: d('2026-01-01'),
        createdBy: USER_A,
        approvedBy: USER_B,
      },
    });

    // SET NULL 이었다면 승인된 가격이 미승인으로 뒤집혔을 것이다.
    await expect(client.user.delete({ where: { id: USER_A } })).rejects.toThrow();
    await expect(client.user.delete({ where: { id: USER_B } })).rejects.toThrow();
  });

  it('59·60. ★ approvalStatus·approvedAt 컬럼이 없다', async () => {
    const columns = await getPrismaClient().$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_name = 'supplier_sku_price'
       ORDER BY column_name
    `;
    const names = columns.map((row) => row.column_name);

    expect(names).toEqual([
      'approved_by',
      'attachment_id',
      'created_at',
      'created_by',
      'currency',
      'effective_from',
      'effective_to',
      'id',
      'source_document',
      'supplier_sku_id',
      'unit_price',
      'vat_included',
    ]);
    for (const absent of ['approval_status', 'approved_at', 'updated_at', 'deleted_at', 'status']) {
      expect(names, absent).not.toContain(absent);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// PostgreSQL 카탈로그
//
// ★ `prisma migrate diff` 는 EXCLUDE·extension·partial index 를 보지 못한다.
//   아래가 유일한 방어선이다.
// ═══════════════════════════════════════════════════════════════

describe('★ PostgreSQL 카탈로그 — raw SQL 제약의 실제 존재', () => {
  it('61. btree_gist extension 이 설치되어 있다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'btree_gist'
    `;

    expect(rows).toHaveLength(1);
  });

  it('62·63. ★ EXCLUDE 제약이 supplier_id + sku_id + [) daterange 로 정의되어 있다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ conname: string; contype: string; definition: string }>
    >`
      SELECT c.conname,
             c.contype::text                    AS contype,
             pg_get_constraintdef(c.oid)        AS definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'supplier_sku'
         AND c.conname = 'supplier_sku_effective_period_excl'
    `;

    expect(rows).toHaveLength(1);
    // 'x' = EXCLUDE
    expect(rows[0]?.contype).toBe('x');

    const definition = rows[0]?.definition ?? '';
    expect(definition).toContain('EXCLUDE USING gist');
    expect(definition).toContain('supplier_id WITH =');
    expect(definition).toContain('sku_id WITH =');
    expect(definition).toContain('daterange(effective_from, effective_to');
    // ★ half-open 이다 — '[]' 였다면 경계 접촉이 막혔을 것이다.
    expect(definition).toContain(`'[)'`);
    expect(definition).toContain('WITH &&');
  });

  it('64. ★ 현행 대표 partial UNIQUE 의 predicate 가 정확하다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ isunique: boolean; predicate: string | null; columns: string }>
    >`
      SELECT i.indisunique                      AS isunique,
             pg_get_expr(i.indpred, i.indrelid) AS predicate,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a
                  ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'ux_supplier_sku_primary_current'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.isunique).toBe(true);
    // ★ key 는 sku_id 단독 — 공급업체를 포함하지 않는다.
    expect(rows[0]?.columns).toBe('sku_id');

    const predicate = rows[0]?.predicate ?? '';
    expect(predicate).toContain('is_primary');
    // ★ effective_to IS NULL 이 있어야 종료된 대표가 새 대표를 막지 않는다.
    expect(predicate).toContain('effective_to IS NULL');
    // ⛔ 원문에 없는 조건을 덧붙이지 않았다.
    expect(predicate).not.toContain('CURRENT_DATE');
    expect(predicate).not.toContain('status');
  });

  it('65. ★ warehouse scalar 2종은 FK 로 landing 했고 attachment_id 는 여전히 staged 다', async () => {
    // ⚠️ **T08-1 이 warehouse 쪽만 supersede 했다** (docs/19 §W-D15 · §W-D21).
    //    `attachment_id` 는 `Attachment` 모델이 backlog 미배정이라 그대로다
    //    (docs/17 §28 · §19 pointer).
    const rows = await getPrismaClient().$queryRaw<Array<{ table_name: string; column: string }>>`
      SELECT t.relname AS table_name,
             a.attname AS column
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f'
         AND t.relname IN ('supplier', 'supplier_sku', 'supplier_sku_price')
         AND a.attname IN ('default_warehouse_id', 'destination_warehouse_id', 'attachment_id')
       ORDER BY t.relname, a.attname
    `;

    expect(rows).toEqual([
      { table_name: 'supplier', column: 'default_warehouse_id' },
      { table_name: 'supplier_sku', column: 'destination_warehouse_id' },
    ]);

    // 참조 테이블 상태: warehouse 는 생겼고 attachment 는 아직 없다.
    const tables = await getPrismaClient().$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('warehouse', 'attachment')
    `;
    expect(tables.map((row) => row.table_name)).toEqual(['warehouse']);
  });

  it('66. ★ 세 테이블의 index·unique·CHECK·FK 집합이 기대와 정확히 일치한다', async () => {
    const client = getPrismaClient();

    const indexes = await client.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('supplier', 'supplier_sku', 'supplier_sku_price')
       ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      'supplier_pkey',
      'supplier_sku_effective_period_excl',
      'supplier_sku_pkey',
      'supplier_sku_price_pkey',
      'supplier_sku_price_supplier_sku_id_effective_from_idx',
      'supplier_sku_price_supplier_sku_id_effective_from_key',
      'supplier_sku_sku_id_idx',
      'supplier_sku_supplier_id_sku_id_effective_from_key',
      'supplier_supplier_code_key',
      // ⛔ speculative index 를 추가하지 않았다 — supplier_type·status 인덱스 없음.
      'ux_supplier_sku_primary_current',
    ]);

    const checks = await client.$queryRaw<Array<{ conname: string }>>`
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE c.contype = 'c'
         AND t.relname IN ('supplier', 'supplier_sku', 'supplier_sku_price')
       ORDER BY c.conname
    `;
    expect(checks.map((row) => row.conname)).toEqual([
      'supplier_default_lead_time_days_check',
      'supplier_sku_currency_not_blank_check',
      'supplier_sku_effective_period_check',
      'supplier_sku_lead_time_days_check',
      'supplier_sku_moq_positive_check',
      'supplier_sku_order_multiple_positive_check',
      'supplier_sku_price_currency_not_blank_check',
      'supplier_sku_price_effective_period_check',
      'supplier_status_not_blank_check',
      'supplier_supplier_code_not_blank_check',
      'supplier_supplier_name_not_blank_check',
      'supplier_supplier_type_not_blank_check',
    ]);

    const foreignKeys = await client.$queryRaw<Array<{ conname: string; action: string }>>`
      SELECT c.conname, c.confdeltype::text AS action
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE c.contype = 'f'
         AND t.relname IN ('supplier', 'supplier_sku', 'supplier_sku_price')
       ORDER BY c.conname
    `;
    // 'r' = RESTRICT. ⛔ CASCADE('c')·SET NULL('n') 이 하나도 없어야 한다.
    // ✏️ T08-1 이 warehouse FK 2개를 추가했다 (docs/19 §W-D15 #2·#3 · §W-D19).
    //    ⛔ `attachment_id` 는 여전히 FK 가 없다 — `Attachment` 미배정.
    expect(foreignKeys).toEqual([
      { conname: 'supplier_default_warehouse_id_fkey', action: 'r' },
      { conname: 'supplier_sku_destination_warehouse_id_fkey', action: 'r' },
      { conname: 'supplier_sku_price_approved_by_fkey', action: 'r' },
      { conname: 'supplier_sku_price_created_by_fkey', action: 'r' },
      { conname: 'supplier_sku_price_supplier_sku_id_fkey', action: 'r' },
      { conname: 'supplier_sku_sku_id_fkey', action: 'r' },
      { conname: 'supplier_sku_supplier_id_fkey', action: 'r' },
    ]);
  });

  it('★ 세 테이블에 deletedAt·감사 트리거가 없다 (물리삭제 lifecycle 미도입)', async () => {
    const client = getPrismaClient();

    const columns = await client.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('supplier', 'supplier_sku', 'supplier_sku_price')
         AND column_name IN ('deleted_at', 'created_by', 'updated_by', 'approved_by')
       ORDER BY column_name
    `;
    // 가격이력의 created_by·approved_by 만 존재한다.
    expect(columns.map((row) => row.column_name)).toEqual(['approved_by', 'created_by']);

    const triggers = await client.$queryRaw<Array<{ tgname: string }>>`
      SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND c.relname IN ('supplier', 'supplier_sku', 'supplier_sku_price')
    `;
    expect(triggers).toEqual([]);
  });
});
