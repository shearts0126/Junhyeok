import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { deleteTestWarehouses } from './warehouse-fixture';

/**
 * 재고 코어 **DB 제약** 테스트 (T2-2 = legacy `T09-1`) — 실제 PostgreSQL.
 *
 * 근거: `docs/03_ERD와_Prisma스키마_v0.2.md` §Layer 3 재고 코어 ★ ·
 *       `docs/00_요구사항_이해와_충돌검토_v0.2.md` C-09 · C-10 · C-14
 *
 * T2-2 는 schema 단계다. posting service(T2-5)·balance 갱신(T2-9)·현재고
 * 조회(T2-16)가 전부 없으므로 모든 검증은 **PostgreSQL 제약이 직접 거부/허용**
 * 하는지를 본다.
 *
 * ⚠️ `prisma migrate diff` 는 **CHECK · 부분 인덱스 · 트리거를 보지 못한다.**
 *    raw SQL 을 빼먹어도 drift gate 는 통과한다 — 이 파일이 `ck_source_doc` ·
 *    `ck_qty_nonzero` · `ux_txn_idem` · `ux_txn_reversal` · `ix_ledger_channel` ·
 *    `trg_ledger_immutable` 의 **유일한 방어선**이다.
 *
 * ⛔ 재고 3테이블 정리에는 `session_replication_role` 을 **쓰지 않는다** — 마스터를
 *    향한 단방향 참조라 정상 FK 순서(마스터 → 거래 → 원장/잔고)로 만들고 역순으로
 *    지우면 된다. 순환 참조가 없어 T08 과 사정이 다르다. 창고 fixture 정리만
 *    T08-1 의 공용 helper 를 재사용한다 (`cleanup()` 주석 참조).
 */

const RUN = randomBytes(4).toString('hex');
const TAG = `TINV-${RUN}`;

/** 어떤 테이블에도 없는 UUID — FK 위반을 유발하는 데 쓴다. */
const ORPHAN_ID = 'eeeeeeee-0000-4000-8000-0000000c9001';

interface Fixture {
  readonly userId: string;
  readonly skuId: string;
  /** 창고 A 와 그 DEFAULT 로케이션. */
  readonly warehouseA: string;
  readonly locationA: string;
  /** 창고 B 와 그 DEFAULT 로케이션 — cross-warehouse 검증용. */
  readonly warehouseB: string;
  readonly locationB: string;
}

let fx: Fixture;

/** `docs/19 §W-D7` 순서 그대로 창고 + DEFAULT 로케이션을 만든다. */
async function createWarehouse(code: string): Promise<{ warehouseId: string; locationId: string }> {
  const warehouseId = randomUUID();
  const locationId = randomUUID();
  await getPrismaClient().$transaction(async (tx) => {
    await tx.warehouse.create({
      data: {
        id: warehouseId,
        warehouseCode: code,
        warehouseName: `재고테스트 창고 ${code}`,
        warehouseType: 'INTERNAL',
        defaultLocationId: locationId,
      },
    });
    await tx.warehouseLocation.create({
      data: { id: locationId, warehouseId, locationCode: 'DEFAULT', locationName: 'DEFAULT' },
    });
  });
  return { warehouseId, locationId };
}

async function cleanup(): Promise<void> {
  const client = getPrismaClient();

  // ★ 역순 삭제 — FK 검사를 끄지 않는다. 원장은 트리거가 DELETE 를 막으므로
  //   트리거를 잠시 떼고 지운다 (불변성 자체를 검증한 뒤의 정리 경로다).
  await client.$executeRawUnsafe(
    `ALTER TABLE inventory_ledger_entry DISABLE TRIGGER "trg_ledger_immutable"`,
  );
  try {
    await client.$executeRawUnsafe(
      `DELETE FROM inventory_ledger_entry WHERE transaction_id IN
         (SELECT id FROM inventory_transaction WHERE transaction_no LIKE '${TAG}%')`,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM inventory_balance WHERE warehouse_id IN
         (SELECT id FROM warehouse WHERE warehouse_code LIKE '${TAG}%')`,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM inventory_transaction WHERE transaction_no LIKE '${TAG}%'`,
    );
  } finally {
    await client.$executeRawUnsafe(
      `ALTER TABLE inventory_ledger_entry ENABLE TRIGGER "trg_ledger_immutable"`,
    );
  }

  // ★ 창고 ↔ 로케이션 정리는 **T08-1 이 만든 공용 helper 를 그대로 쓴다**.
  //
  //   ⚠️ 직접 순서로 풀리지 않는다 — `warehouse.default_location_id` 가
  //      `DEFERRABLE INITIALLY DEFERRED` 라 해도 **`ON DELETE RESTRICT` 자체는
  //      지연되지 않는다**(PostgreSQL 에서 RESTRICT 는 NO ACTION 과 달리 즉시
  //      검사한다). 실측으로 확인했다: 로케이션을 먼저 지우면 그 자리에서
  //      `23503 ... violates foreign key constraint
  //      "warehouse_id_default_location_id_fkey"` 가 난다.
  //
  //   ⛔ 그래서 **새 우회 경로를 만들지 않고** 이미 리뷰된 helper 를 재사용한다
  //      (`$transaction` + `SET LOCAL` — 커넥션 풀 누출이 없는 형태).
  //      T2-2 가 새로 도입하는 `session_replication_role` 사용은 0 이다.
  await deleteTestWarehouses(TAG);

  await client.sku.deleteMany({ where: { skuCode: { startsWith: TAG } } });
  await client.user.deleteMany({ where: { email: { startsWith: TAG.toLowerCase() } } });
}

beforeAll(async () => {
  await cleanup();
  const client = getPrismaClient();

  const userId = randomUUID();
  await client.user.create({
    data: { id: userId, email: `${TAG.toLowerCase()}@example.test`, name: '재고테스트' },
  });

  const sku = await client.sku.create({
    data: { skuCode: `${TAG}-SKU`, skuName: '재고테스트 품목', itemType: 'FINISHED' },
  });

  const a = await createWarehouse(`${TAG}-A`);
  const b = await createWarehouse(`${TAG}-B`);

  fx = {
    userId,
    skuId: sku.id,
    warehouseA: a.warehouseId,
    locationA: a.locationId,
    warehouseB: b.warehouseId,
    locationB: b.locationId,
  };
}, 60_000);

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

let txnSeq = 0;

/** 유효한 거래 헤더 1건. `overrides` 로 개별 제약을 깨뜨려 본다. */
async function createTransaction(
  overrides: Partial<Prisma.InventoryTransactionUncheckedCreateInput> = {},
): Promise<string> {
  txnSeq += 1;
  const created = await getPrismaClient().inventoryTransaction.create({
    data: {
      transactionNo: `${TAG}-${String(txnSeq).padStart(4, '0')}`,
      transactionType: 'PURCHASE_RECEIPT',
      occurredAt: new Date('2026-08-26T01:00:00Z'),
      businessDate: new Date('2026-08-26'),
      sourceDocumentType: 'GOODS_RECEIPT',
      createdBy: fx.userId,
      ...overrides,
    },
  });
  return created.id;
}

/** 유효한 원장행 1건. */
function ledgerData(
  transactionId: string,
  overrides: Partial<Prisma.InventoryLedgerEntryUncheckedCreateInput> = {},
): Prisma.InventoryLedgerEntryUncheckedCreateInput {
  return {
    transactionId,
    lineNo: 1,
    skuId: fx.skuId,
    warehouseId: fx.warehouseA,
    locationId: fx.locationA,
    inventoryStatus: 'AVAILABLE',
    quantityDelta: new Prisma.Decimal('10.000000'),
    baseUom: 'EA',
    businessDate: new Date('2026-08-26'),
    occurredAt: new Date('2026-08-26T01:00:00Z'),
    ...overrides,
  };
}

/** 유효한 잔고행 1건. */
function balanceData(
  overrides: Partial<Prisma.InventoryBalanceUncheckedCreateInput> = {},
): Prisma.InventoryBalanceUncheckedCreateInput {
  return {
    skuId: fx.skuId,
    warehouseId: fx.warehouseA,
    locationId: fx.locationA,
    inventoryStatus: 'AVAILABLE',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// D1 — 테이블·enum 카탈로그
// ═══════════════════════════════════════════════════════════════

describe('D1. 카탈로그 — 테이블 3개 · enum 4개', () => {
  it('신규 테이블 3개가 존재한다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('inventory_transaction', 'inventory_ledger_entry', 'inventory_balance')
       ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      'inventory_balance',
      'inventory_ledger_entry',
      'inventory_transaction',
    ]);
  });

  it('★★ BalanceRebuildSnapshot 테이블을 만들지 않았다 (T2-19 소유)', async () => {
    const rows = await getPrismaClient().$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('balance_rebuild_snapshot', 'inventory_exception',
                            'opening_balance_batch', 'opening_balance_line')`;
    expect(rows).toEqual([]);
  });

  it('★★ TransactionType DB enum 이 정확히 24 라벨이다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'TransactionType'
       ORDER BY e.enumsortorder`;
    expect(rows).toHaveLength(24);
    expect(rows.map((row) => row.label)).toEqual([
      'OPENING_BALANCE',
      'PURCHASE_RECEIPT',
      'PRODUCTION_RECEIPT',
      'RETURN_RECEIPT',
      'WAREHOUSE_TRANSFER_IN',
      'ASSEMBLY_RECEIPT',
      'DISASSEMBLY_RECEIPT',
      'SALES_SHIPMENT',
      'B2B_SHIPMENT',
      'MARKETING_SHIPMENT',
      'CS_SHIPMENT',
      'SAMPLE_SHIPMENT',
      'EMPLOYEE_USE',
      'VENDOR_RETURN',
      'DISPOSAL',
      'WAREHOUSE_TRANSFER_OUT',
      'ASSEMBLY_CONSUMPTION',
      'DISASSEMBLY_CONSUMPTION',
      'STATUS_CHANGE',
      'STOCK_COUNT_ADJUSTMENT',
      'MANUAL_ADJUSTMENT',
      'REVERSAL',
      'RESERVATION',
      'RESERVATION_RELEASE',
    ]);
  });

  it('나머지 enum 3종의 라벨도 정확하다', async () => {
    const labels = async (typname: string): Promise<string[]> =>
      (
        await getPrismaClient().$queryRawUnsafe<{ label: string }[]>(
          `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = $1 ORDER BY e.enumsortorder`,
          typname,
        )
      ).map((row) => row.label);

    expect(await labels('InventoryStatus')).toEqual([
      'AVAILABLE',
      'RESERVED',
      'OUTBOUND_PENDING',
      'HOLD',
      'INSPECTION',
      'DEFECTIVE',
      'RETURN_PENDING',
      'DISPOSAL_PENDING',
      'IN_TRANSIT',
    ]);
    expect(await labels('TransactionStatus')).toEqual(['POSTED', 'REVERSED']);
    expect(await labels('OutboundPurpose')).toEqual([
      'SALES_B2C',
      'SALES_B2B',
      'WAREHOUSE_REPLENISHMENT',
      'MARKETING',
      'CS',
      'SAMPLE',
      'EMPLOYEE_USE',
      'OTHER',
    ]);
  });

  it('★ InventoryStatus 와 WarehouseType 은 서로 다른 DB 타입이다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ typname: string; oid: number }[]>`
      SELECT typname, oid::int FROM pg_type WHERE typname IN ('InventoryStatus', 'WarehouseType')`;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.oid).not.toBe(rows[1]?.oid);
  });
});

// ═══════════════════════════════════════════════════════════════
// D2 — 센티넬 default (C-09)
// ═══════════════════════════════════════════════════════════════

describe('D2. ★★ 센티넬 정규화 (C-09) — 재고키에 NULL 이 없다', () => {
  it('원장행: lot_no · serial_no · owner_code · expiry_key 가 센티넬로 채워진다', async () => {
    const txnId = await createTransaction();
    const created = await getPrismaClient().inventoryLedgerEntry.create({
      data: ledgerData(txnId),
    });

    expect(created.lotNo).toBe('');
    expect(created.serialNo).toBe('');
    expect(created.ownerCode).toBe('DEEPPOINT');
    expect(created.expiryKey.toISOString().slice(0, 10)).toBe('9999-12-31');
    // 표시용 컬럼은 nullable 을 유지한다.
    expect(created.expiryDate).toBeNull();
  });

  it('잔고행도 같은 센티넬을 쓴다', async () => {
    const created = await getPrismaClient().inventoryBalance.create({
      data: balanceData({ inventoryStatus: 'HOLD' }),
    });
    expect(created.lotNo).toBe('');
    expect(created.serialNo).toBe('');
    expect(created.ownerCode).toBe('DEEPPOINT');
    expect(created.expiryKey.toISOString().slice(0, 10)).toBe('9999-12-31');
    expect(created.quantity.toString()).toBe('0');
    expect(created.lockVersion).toBe(0);
  });

  it('★ DB default 식이 schema 표현과 같다 — drift 없음', async () => {
    const rows = await getPrismaClient().$queryRaw<{ table_name: string; def: string }[]>`
      SELECT c.table_name, c.column_default AS def
        FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name IN ('inventory_ledger_entry', 'inventory_balance')
         AND c.column_name = 'expiry_key'
       ORDER BY c.table_name`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.def, row.table_name).toContain('9999-12-31');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// D3 — stock_key
// ═══════════════════════════════════════════════════════════════

describe('D3. ★★ stock_key 8열 UNIQUE (C-09 핵심)', () => {
  it('동일 재고키 잔고 2행은 거부된다', async () => {
    const client = getPrismaClient();
    await client.inventoryBalance.create({ data: balanceData({ inventoryStatus: 'INSPECTION' }) });

    await expect(
      client.inventoryBalance.create({ data: balanceData({ inventoryStatus: 'INSPECTION' }) }),
    ).rejects.toThrow();
  });

  it('★ 재고키 차원이 하나라도 다르면 별도 행이 된다', async () => {
    const client = getPrismaClient();
    const base = { inventoryStatus: 'DEFECTIVE' } as const;
    await client.inventoryBalance.create({ data: balanceData(base) });

    // lotNo 만 다르다.
    await client.inventoryBalance.create({ data: balanceData({ ...base, lotNo: 'LOT-1' }) });
    // ownerCode 만 다르다.
    await client.inventoryBalance.create({ data: balanceData({ ...base, ownerCode: 'THIRD' }) });
    // locationId(=warehouse) 만 다르다.
    await client.inventoryBalance.create({
      data: balanceData({ ...base, warehouseId: fx.warehouseB, locationId: fx.locationB }),
    });

    expect(
      await client.inventoryBalance.count({
        where: { skuId: fx.skuId, inventoryStatus: 'DEFECTIVE' },
      }),
    ).toBe(4);
  });

  it('★ DB 제약 이름이 stock_key 다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'inventory_balance' AND indexname = 'stock_key'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('UNIQUE');
    for (const column of [
      'sku_id',
      'warehouse_id',
      'location_id',
      'inventory_status',
      'lot_no',
      'expiry_key',
      'serial_no',
      'owner_code',
    ]) {
      expect(rows[0]?.indexdef, column).toContain(column);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// D4 — location composite FK (Option C) ★ 이번 task 의 핵심
// ═══════════════════════════════════════════════════════════════

describe('D4. ★★ (warehouseId, locationId) composite FK — same-warehouse 강제', () => {
  it('같은 창고의 로케이션이면 원장행이 만들어진다', async () => {
    const txnId = await createTransaction();
    const created = await getPrismaClient().inventoryLedgerEntry.create({
      data: ledgerData(txnId, { warehouseId: fx.warehouseB, locationId: fx.locationB }),
    });
    expect(created.warehouseId).toBe(fx.warehouseB);
    expect(created.locationId).toBe(fx.locationB);
  });

  it('★★ 다른 창고의 로케이션은 원장행에서 거부된다', async () => {
    const txnId = await createTransaction();
    // 창고 A + 창고 B 의 로케이션 — 단일 FK 였다면 통과했을 조합이다.
    await expect(
      getPrismaClient().inventoryLedgerEntry.create({
        data: ledgerData(txnId, { warehouseId: fx.warehouseA, locationId: fx.locationB }),
      }),
    ).rejects.toThrow();
  });

  it('★★ 다른 창고의 로케이션은 잔고행에서도 거부된다', async () => {
    await expect(
      getPrismaClient().inventoryBalance.create({
        data: balanceData({ warehouseId: fx.warehouseB, locationId: fx.locationA }),
      }),
    ).rejects.toThrow();
  });

  it('존재하지 않는 로케이션은 양쪽 모두 거부된다', async () => {
    const txnId = await createTransaction();
    await expect(
      getPrismaClient().inventoryLedgerEntry.create({
        data: ledgerData(txnId, { locationId: ORPHAN_ID }),
      }),
    ).rejects.toThrow();
    await expect(
      getPrismaClient().inventoryBalance.create({ data: balanceData({ locationId: ORPHAN_ID }) }),
    ).rejects.toThrow();
  });

  it('존재하지 않는 창고·SKU 도 거부된다', async () => {
    const txnId = await createTransaction();
    await expect(
      getPrismaClient().inventoryLedgerEntry.create({
        data: ledgerData(txnId, { warehouseId: ORPHAN_ID, locationId: ORPHAN_ID }),
      }),
    ).rejects.toThrow();
    await expect(
      getPrismaClient().inventoryLedgerEntry.create({
        data: ledgerData(txnId, { skuId: ORPHAN_ID }),
      }),
    ).rejects.toThrow();
  });

  it('★ 카탈로그: location FK 가 composite 이며 단일 FK 가 없다', async () => {
    // ⚠️ `information_schema` 의 key_column_usage ⋈ constraint_column_usage 는
    //    카테시안 곱이 생겨 컬럼이 중복 집계된다. `pg_constraint.conkey` 의
    //    **순서 있는** 배열을 직접 푼다.
    const rows = await getPrismaClient().$queryRaw<{ table_name: string; columns: string }[]>`
      SELECT t.relname AS table_name,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_class f ON f.oid = c.confrelid
       WHERE c.contype = 'f'
         AND f.relname = 'warehouse_location'
         AND t.relname IN ('inventory_ledger_entry', 'inventory_balance')
       ORDER BY t.relname`;

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // ★ 순서까지 고정 — (warehouse_id, location_id) 다.
      expect(row.columns, row.table_name).toBe('warehouse_id,location_id');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// D5 — CHECK 2종
// ═══════════════════════════════════════════════════════════════

describe('D5. CHECK — ck_source_doc · ck_qty_nonzero', () => {
  it('★ OPENING_BALANCE 는 원인문서 없이 허용된다', async () => {
    const id = await createTransaction({
      transactionType: 'OPENING_BALANCE',
      sourceDocumentType: null,
    });
    expect(id).toBeTruthy();
  });

  it('★ 그 외 유형은 원인문서 없이 거부된다', async () => {
    await expect(
      createTransaction({ transactionType: 'SALES_SHIPMENT', sourceDocumentType: null }),
    ).rejects.toThrow();
  });

  it('원인문서가 있으면 허용된다', async () => {
    const id = await createTransaction({
      transactionType: 'SALES_SHIPMENT',
      sourceDocumentType: 'SHIPMENT',
    });
    expect(id).toBeTruthy();
  });

  it('★★ quantity_delta = 0 인 원장행은 거부된다 (개별 entry 기준)', async () => {
    const txnId = await createTransaction();
    await expect(
      getPrismaClient().inventoryLedgerEntry.create({
        data: ledgerData(txnId, { quantityDelta: new Prisma.Decimal('0') }),
      }),
    ).rejects.toThrow();
  });

  it('양수·음수는 모두 허용된다 (signed quantity)', async () => {
    const txnId = await createTransaction();
    const client = getPrismaClient();
    const plus = await client.inventoryLedgerEntry.create({
      data: ledgerData(txnId, { lineNo: 1, quantityDelta: new Prisma.Decimal('7.5') }),
    });
    const minus = await client.inventoryLedgerEntry.create({
      data: ledgerData(txnId, { lineNo: 2, quantityDelta: new Prisma.Decimal('-7.5') }),
    });
    // ★ 그룹 net 이 0 인 것은 정상이다 — CHECK 는 개별 행만 본다.
    expect(plus.quantityDelta.plus(minus.quantityDelta).toString()).toBe('0');
  });

  it('★ CHECK 는 정확히 이 2종뿐이다 — 음수재고 CHECK 를 만들지 않았다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ conname: string }[]>`
      SELECT c.conname
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE c.contype = 'c'
         AND t.relname IN ('inventory_transaction', 'inventory_ledger_entry', 'inventory_balance')
         AND c.conname NOT LIKE '%_not_null'
       ORDER BY c.conname`;
    expect(rows.map((row) => row.conname)).toEqual(['ck_qty_nonzero', 'ck_source_doc']);
  });
});

// ═══════════════════════════════════════════════════════════════
// D6 — 조건부 UNIQUE 2종
// ═══════════════════════════════════════════════════════════════

describe('D6. 조건부 UNIQUE — ux_txn_idem · ux_txn_reversal', () => {
  it('★ 동일 멱등키는 거부된다', async () => {
    const key = `${TAG}-IDEM-1`;
    await createTransaction({ idempotencyKey: key });
    await expect(createTransaction({ idempotencyKey: key })).rejects.toThrow();
  });

  it('★ NULL 멱등키는 여러 건 허용된다', async () => {
    await createTransaction({ idempotencyKey: null });
    await createTransaction({ idempotencyKey: null });
    const count = await getPrismaClient().inventoryTransaction.count({
      where: { transactionNo: { startsWith: TAG }, idempotencyKey: null },
    });
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('★★ 같은 원거래를 POSTED 로 두 번 취소할 수 없다', async () => {
    const original = await createTransaction();
    await createTransaction({ transactionType: 'REVERSAL', reversalOfId: original });
    await expect(
      createTransaction({ transactionType: 'REVERSAL', reversalOfId: original }),
    ).rejects.toThrow();
  });

  it('★ 앞선 반대거래가 REVERSED 면 자리가 비어 다시 취소할 수 있다', async () => {
    const client = getPrismaClient();
    const original = await createTransaction();
    const firstReversal = await createTransaction({
      transactionType: 'REVERSAL',
      reversalOfId: original,
    });
    await client.inventoryTransaction.update({
      where: { id: firstReversal },
      data: { status: 'REVERSED' },
    });

    const second = await createTransaction({
      transactionType: 'REVERSAL',
      reversalOfId: original,
    });
    expect(second).toBeTruthy();
  });

  it('★ 카탈로그: predicate 원문 확인', async () => {
    const rows = await getPrismaClient().$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN ('ux_txn_idem', 'ux_txn_reversal')
       ORDER BY indexname`;
    expect(rows.map((row) => row.indexname)).toEqual(['ux_txn_idem', 'ux_txn_reversal']);

    const idem = rows.find((row) => row.indexname === 'ux_txn_idem')?.indexdef ?? '';
    expect(idem).toContain('UNIQUE');
    expect(idem).toContain('idempotency_key IS NOT NULL');

    const reversal = rows.find((row) => row.indexname === 'ux_txn_reversal')?.indexdef ?? '';
    expect(reversal).toContain('UNIQUE');
    expect(reversal).toContain('reversal_of_id IS NOT NULL');
    expect(reversal).toContain("'POSTED'");
  });

  it('★★ 재고 3테이블의 조건부 UNIQUE 는 정확히 2개다 (backlog "3종" 은 오기)', async () => {
    const rows = await getPrismaClient().$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('inventory_transaction', 'inventory_ledger_entry', 'inventory_balance')
         AND indexdef LIKE '%UNIQUE%'
         AND indexdef LIKE '%WHERE%'
       ORDER BY indexname`;
    expect(rows.map((row) => row.indexname)).toEqual(['ux_txn_idem', 'ux_txn_reversal']);
  });
});

// ═══════════════════════════════════════════════════════════════
// D7 — 원장 불변성
// ═══════════════════════════════════════════════════════════════

describe('D7. ★★ 원장 불변성 (INSERT only)', () => {
  it('UPDATE 는 DB 예외로 거부된다', async () => {
    const txnId = await createTransaction();
    const entry = await getPrismaClient().inventoryLedgerEntry.create({ data: ledgerData(txnId) });

    await expect(
      getPrismaClient().inventoryLedgerEntry.update({
        where: { id: entry.id },
        data: { note: '수정 시도' },
      }),
    ).rejects.toThrow();
  });

  it('DELETE 도 DB 예외로 거부된다', async () => {
    const txnId = await createTransaction();
    const entry = await getPrismaClient().inventoryLedgerEntry.create({ data: ledgerData(txnId) });

    await expect(
      getPrismaClient().inventoryLedgerEntry.delete({ where: { id: entry.id } }),
    ).rejects.toThrow();
  });

  it('★ 예외 자체가 계약이다 — 메시지는 public API error contract 가 아니다', async () => {
    const txnId = await createTransaction();
    const entry = await getPrismaClient().inventoryLedgerEntry.create({ data: ledgerData(txnId) });

    let message = '';
    try {
      await getPrismaClient().$executeRawUnsafe(
        `UPDATE inventory_ledger_entry SET note = 'x' WHERE id = '${entry.id}'`,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('IMMUTABLE_VIOLATION');
  });

  it('★ 잔고행은 불변이 아니다 — UPDATE 가 허용된다 (원장에서 재구축되는 캐시)', async () => {
    const client = getPrismaClient();
    const created = await client.inventoryBalance.create({
      data: balanceData({ inventoryStatus: 'RETURN_PENDING' }),
    });
    const updated = await client.inventoryBalance.update({
      where: { id: created.id },
      data: { quantity: new Prisma.Decimal('3.250000'), lockVersion: { increment: 1 } },
    });
    expect(updated.quantity.toString()).toBe('3.25');
    expect(updated.lockVersion).toBe(1);
  });

  it('★★ 트리거는 BEFORE UPDATE OR DELETE 하나뿐 — TRUNCATE 트리거 없음', async () => {
    const rows = await getPrismaClient().$queryRaw<{ tgname: string; def: string }[]>`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'inventory_ledger_entry' AND NOT t.tgisinternal
       ORDER BY t.tgname`;
    expect(rows.map((row) => row.tgname)).toEqual(['trg_ledger_immutable']);
    // ⚠️ PostgreSQL 은 이벤트 순서를 정규화해 `BEFORE DELETE OR UPDATE` 로
    //    되돌려 준다 — migration 원문(`BEFORE UPDATE OR DELETE`)과 표기만 다르고
    //    같은 트리거다. 둘 다 걸린 것을 개별로 확인한다.
    expect(rows[0]?.def).toContain('BEFORE DELETE OR UPDATE');
    expect(rows[0]?.def).toContain('FOR EACH ROW');
    expect(rows[0]?.def).not.toContain('TRUNCATE');
    expect(rows[0]?.def).not.toContain('INSERT');
    expect(rows[0]?.def).toContain('raise_immutable_violation');
  });

  it('⛔ audit 전용 함수를 재사용하지 않았다 — 별도 함수다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ proname: string }[]>`
      SELECT proname FROM pg_proc
       WHERE proname IN ('raise_immutable_violation', 'audit_log_prevent_modification')
       ORDER BY proname`;
    // 둘 다 존재하되 서로 다른 함수다. audit 쪽은 T0-7 이 만든 것이 그대로 있다.
    expect(rows.map((row) => row.proname)).toEqual([
      'audit_log_prevent_modification',
      'raise_immutable_violation',
    ]);
  });

  /**
   * ✏️ **2026-08-26 (T2-3)**: 원래는 "재취소 트리거가 **아직** 없다" 를 고정했다.
   *    `T2-3` 가 바로 그 트리거를 landing 시키므로 방향을 뒤집되, ⛔ **원장
   *    트리거와 거래 트리거를 서로 오염시키지 않는다**를 이어서 지킨다.
   */
  it('✏️ 원장 트리거와 거래 트리거는 각자 하나씩이다 (T2-2 · T2-3)', async () => {
    const rows = await getPrismaClient().$queryRaw<{ relname: string; tgname: string }[]>`
      SELECT c.relname, t.tgname
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname IN ('inventory_ledger_entry', 'inventory_transaction', 'inventory_balance')
         AND NOT t.tgisinternal
       ORDER BY c.relname, t.tgname`;

    expect(rows).toEqual([
      { relname: 'inventory_ledger_entry', tgname: 'trg_ledger_immutable' },
      { relname: 'inventory_transaction', tgname: 'trg_no_reversal_of_reversal' },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// D12 — REVERSAL 재취소 차단 (T2-3, C-14, TC-POST-203)
// ═══════════════════════════════════════════════════════════════

/**
 * 5중 방어의 **마지막 층**이다. 앞의 넷(도메인 `reverse()`·Posting 검증 ⑫·
 * API·화면)은 전부 코드 경로이고, 이 트리거만이 **직접 INSERT** 를 막는다 —
 * `TC-POST-203` 이 요구하는 것이 정확히 그것이라 여기서는 서비스가 아니라
 * `prisma.inventoryTransaction.create()` 로 DB 에 바로 넣어 확인한다.
 *
 * ⛔ 트리거를 끄지 않는다 · ⛔ `session_replication_role` 을 쓰지 않는다 —
 *    정상 DB semantics 로만 검증한다.
 */
describe('D12. ★★ REVERSAL 재취소 차단 (T2-3)', () => {
  it('29. reversalOfId 가 NULL 인 정상 거래는 허용된다', async () => {
    const id = await createTransaction({ reversalOfId: null });
    expect(id).toBeTruthy();
  });

  it('30. ★ 정상 거래를 대상으로 한 1차 REVERSAL 은 허용된다', async () => {
    const original = await createTransaction();
    const reversal = await createTransaction({
      transactionType: 'REVERSAL',
      reversalOfId: original,
    });
    expect(reversal).toBeTruthy();
  });

  it('31. ★★ REVERSAL(POSTED)을 대상으로 한 재취소는 DB 가 거부한다', async () => {
    const original = await createTransaction();
    const reversal = await createTransaction({
      transactionType: 'REVERSAL',
      reversalOfId: original,
    });

    await expect(
      createTransaction({ transactionType: 'REVERSAL', reversalOfId: reversal }),
    ).rejects.toThrow();
  });

  it('32. ★★ REVERSAL(REVERSED)을 대상으로 해도 거부한다 — 트리거는 status 를 보지 않는다', async () => {
    const client = getPrismaClient();
    const original = await createTransaction();
    const reversal = await createTransaction({
      transactionType: 'REVERSAL',
      reversalOfId: original,
    });
    await client.inventoryTransaction.update({
      where: { id: reversal },
      data: { status: 'REVERSED' },
    });

    // ★ `ux_txn_reversal` 은 status='POSTED' 조건이라 이 자리를 비워 주지만,
    //   트리거는 **유형**만 보므로 여전히 막는다. 두 제약의 역할 차이가
    //   드러나는 지점이다.
    await expect(
      createTransaction({ transactionType: 'REVERSAL', reversalOfId: reversal }),
    ).rejects.toThrow();
  });

  it('★ 예외 문구가 REVERSAL_OF_REVERSAL_NOT_ALLOWED 다', async () => {
    const original = await createTransaction();
    const reversal = await createTransaction({
      transactionType: 'REVERSAL',
      reversalOfId: original,
    });

    let message = '';
    try {
      await createTransaction({ transactionType: 'REVERSAL', reversalOfId: reversal });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // ⚠️ 이것은 **DB 예외 문자열**이지 public API error contract 가 아니다.
    //    application 오류로의 번역은 runtime task(T2-13) 소유다.
    expect(message).toContain('REVERSAL_OF_REVERSAL_NOT_ALLOWED');
  });

  it('33. ★★ 앞선 반대거래가 REVERSED 여도 **같은 원거래**는 다시 취소할 수 있다', async () => {
    // ⛔ 위 32번과 시나리오가 다르다 — 대상이 원거래(정상 유형)라서 트리거가
    //    관여하지 않는다. T2-2 가 고정한 계약이 그대로 살아 있어야 한다.
    const client = getPrismaClient();
    const original = await createTransaction();
    const first = await createTransaction({ transactionType: 'REVERSAL', reversalOfId: original });
    await client.inventoryTransaction.update({
      where: { id: first },
      data: { status: 'REVERSED' },
    });

    const second = await createTransaction({
      transactionType: 'REVERSAL',
      reversalOfId: original,
    });
    expect(second).toBeTruthy();
  });

  it('34. ⛔ self-reversal · cycle 전용 규칙을 만들지 않았다', async () => {
    // 정본 문서에 규칙이 없다. 트리거가 **유형만** 보므로 정상 유형끼리의
    // 자기참조·순환은 DB 가 막지 않는다 — 그 상태를 사실대로 고정한다.
    const client = getPrismaClient();
    const a = await createTransaction();
    const b = await createTransaction();

    // 정상 거래 A 를 가리키는 정상 유형 거래 — 트리거 무관, 허용된다.
    await client.inventoryTransaction.update({ where: { id: b }, data: { reversalOfId: a } });
    const updated = await client.inventoryTransaction.findUniqueOrThrow({ where: { id: b } });
    expect(updated.reversalOfId).toBe(a);

    // ⛔ non-REVERSAL 이 reversalOfId 를 갖는 것을 막는 CHECK 도 만들지 않았다.
    expect(updated.transactionType).toBe('PURCHASE_RECEIPT');
  });

  it('★ 카탈로그: 함수 계약 (T2-3)', async () => {
    const rows = await getPrismaClient().$queryRaw<
      { proname: string; rettype: string; lang: string; body: string }[]
    >`
      SELECT p.proname,
             p.prorettype::regtype::text AS rettype,
             l.lanname                   AS lang,
             p.prosrc                    AS body
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.proname = 'reject_reversal_of_reversal'`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.rettype).toBe('trigger');
    expect(rows[0]?.lang).toBe('plpgsql');

    const body = rows[0]?.body ?? '';
    for (const token of [
      'NEW.reversal_of_id',
      'transaction_type',
      'REVERSAL',
      'REVERSAL_OF_REVERSAL_NOT_ALLOWED',
      '취소를 되돌리려면 원인문서를 근거로 신규 정상거래를 생성하세요.',
    ]) {
      expect(body, token).toContain(token);
    }

    // ⛔ status 를 보지 않는다 · ⛔ 별도 SQLSTATE/DETAIL 을 만들지 않는다.
    expect(body).not.toContain('status');
    expect(body).not.toContain('SQLSTATE');
    expect(body).not.toContain('DETAIL');
  });

  it('★ 카탈로그: 트리거 계약 (T2-3)', async () => {
    const rows = await getPrismaClient().$queryRaw<
      { tgname: string; def: string; tgtype: number }[]
    >`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgtype::int
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'inventory_transaction' AND NOT t.tgisinternal`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tgname).toBe('trg_no_reversal_of_reversal');

    // ★ 문자열 순서에 기대지 않고 `tgtype` 비트로 semantic 하게 본다.
    //   1=ROW · 2=BEFORE · 4=INSERT · 8=DELETE · 16=UPDATE · 32=TRUNCATE
    const tgtype = rows[0]?.tgtype ?? 0;
    expect(tgtype & 1, 'FOR EACH ROW').toBe(1);
    expect(tgtype & 2, 'BEFORE').toBe(2);
    expect(tgtype & 4, 'INSERT').toBe(4);
    expect(tgtype & 8, 'DELETE 금지').toBe(0);
    expect(tgtype & 16, 'UPDATE 금지').toBe(0);
    expect(tgtype & 32, 'TRUNCATE 금지').toBe(0);

    const def = rows[0]?.def ?? '';
    expect(def).toContain('ON public.inventory_transaction');
    expect(def).toContain('reject_reversal_of_reversal()');
    expect(def).not.toContain('WHEN');
    expect(def).not.toContain('FOR EACH STATEMENT');
  });

  it('⛔ T2-3 는 기존 제약을 하나도 건드리지 않았다', async () => {
    const client = getPrismaClient();

    // ux_txn_reversal predicate 불변
    const idx = await client.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_txn_reversal'`;
    expect(idx[0]?.indexdef).toContain("status = 'POSTED'");

    // FK 12 · CHECK 2 불변
    expect(
      await client.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         WHERE c.contype = 'f'
           AND t.relname IN ('inventory_transaction', 'inventory_ledger_entry', 'inventory_balance')`,
    ).toEqual([{ count: 12n }]);
    expect(
      await client.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         WHERE c.contype = 'c' AND t.relname LIKE 'inventory%'
           AND c.conname NOT LIKE '%not_null'`,
    ).toEqual([{ count: 2n }]);
  });
});

// ═══════════════════════════════════════════════════════════════
// D8 — FK action 카탈로그
// ═══════════════════════════════════════════════════════════════

describe('D8. FK 12종 — 전부 RESTRICT / CASCADE', () => {
  it('★★ 12개이며 delete_rule=RESTRICT · update_rule=CASCADE 다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      { constraint_name: string; delete_rule: string; update_rule: string }[]
    >`
      SELECT rc.constraint_name, rc.delete_rule, rc.update_rule
        FROM information_schema.referential_constraints rc
        JOIN information_schema.table_constraints tc
          ON tc.constraint_name = rc.constraint_name
       WHERE tc.table_name IN ('inventory_transaction', 'inventory_ledger_entry', 'inventory_balance')
       ORDER BY rc.constraint_name`;

    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.delete_rule, row.constraint_name).toBe('RESTRICT');
      expect(row.update_rule, row.constraint_name).toBe('CASCADE');
    }
  });

  it('★ RESTRICT 가 실제로 동작한다 — 참조된 거래는 지울 수 없다', async () => {
    const txnId = await createTransaction();
    await getPrismaClient().inventoryLedgerEntry.create({ data: ledgerData(txnId) });

    await expect(
      getPrismaClient().inventoryTransaction.delete({ where: { id: txnId } }),
    ).rejects.toThrow();
  });

  it('★ 원거래는 반대거래에 의해 보호된다 (감사 추적 보존)', async () => {
    const original = await createTransaction();
    await createTransaction({ transactionType: 'REVERSAL', reversalOfId: original });

    await expect(
      getPrismaClient().inventoryTransaction.delete({ where: { id: original } }),
    ).rejects.toThrow();
  });

  it('★★ scalar-only 3종에 FK 가 없다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ column_name: string }[]>`
      SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_name IN ('inventory_transaction', 'inventory_ledger_entry', 'inventory_balance')
         AND kcu.column_name IN ('source_document_id', 'attachment_group_id', 'channel_id')`;
    expect(rows).toEqual([]);
  });

  it('★ 임의 UUID 를 scalar-only 컬럼에 넣어도 통과한다 (generic reference)', async () => {
    const id = await createTransaction({
      sourceDocumentId: ORPHAN_ID,
      attachmentGroupId: ORPHAN_ID,
    });
    const txnId = await createTransaction();
    const entry = await getPrismaClient().inventoryLedgerEntry.create({
      data: ledgerData(txnId, { channelId: ORPHAN_ID, outboundPurpose: 'SALES_B2C' }),
    });
    expect(id).toBeTruthy();
    expect(entry.channelId).toBe(ORPHAN_ID);
  });
});

// ═══════════════════════════════════════════════════════════════
// D9 — index 카탈로그
// ═══════════════════════════════════════════════════════════════

describe('D9. index 카탈로그', () => {
  it('★★ inventory_balance 에 (sku_id, warehouse_id) 중복 index 가 없다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'inventory_balance'
       ORDER BY indexname`;

    // PK + stock_key + @@index 2개 = 4개.
    expect(rows.map((row) => row.indexname).sort()).toEqual([
      'inventory_balance_pkey',
      'inventory_balance_sku_id_idx',
      'inventory_balance_warehouse_id_inventory_status_idx',
      'stock_key',
    ]);

    // `stock_key` 는 (sku_id, warehouse_id, ...) prefix 를 이미 제공한다 —
    // 그것을 별도 index 로 오인해 세지 않는다.
    const skuOnly = rows.find((row) => row.indexname === 'inventory_balance_sku_id_idx');
    expect(skuOnly?.indexdef).toMatch(/\(sku_id\)$/);
  });

  it('ix_ledger_channel — 부분 인덱스이며 UNIQUE 가 아니다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'ix_ledger_channel'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).not.toContain('UNIQUE');
    expect(rows[0]?.indexdef).toContain('channel_id IS NOT NULL');
  });

  it('★ 재고키 집계 index 에 location_id 가 없다', async () => {
    const rows = await getPrismaClient().$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'inventory_ledger_entry'
         AND indexdef LIKE '%owner_code%' AND indexdef LIKE '%business_date%'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).not.toContain('location_id');
  });
});

// ═══════════════════════════════════════════════════════════════
// D10 — Decimal 정밀도
// ═══════════════════════════════════════════════════════════════

describe('D10. Decimal(18,6) 정밀도', () => {
  it('★ 소수 6자리가 보존된다 — Number() 로 비교하지 않는다', async () => {
    const txnId = await createTransaction();
    const created = await getPrismaClient().inventoryLedgerEntry.create({
      data: ledgerData(txnId, {
        quantityDelta: new Prisma.Decimal('12.345678'),
        originalQuantity: new Prisma.Decimal('0.000001'),
        conversionFactor: new Prisma.Decimal('1000000.000000'),
      }),
    });

    expect(created.quantityDelta.toString()).toBe('12.345678');
    expect(created.originalQuantity?.toString()).toBe('0.000001');
    expect(created.conversionFactor?.toString()).toBe('1000000');
  });

  it('★ 잔고 수량도 6자리를 보존한다', async () => {
    const created = await getPrismaClient().inventoryBalance.create({
      data: balanceData({
        inventoryStatus: 'DISPOSAL_PENDING',
        quantity: new Prisma.Decimal('-0.500001'),
      }),
    });
    // ★ 음수 잔고 자체는 DB 가 막지 않는다 — 판정은 posting runtime 이다.
    expect(created.quantity.toString()).toBe('-0.500001');
  });

  it('카탈로그: numeric(18,6) 이다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      {
        table_name: string;
        column_name: string;
        numeric_precision: number;
        numeric_scale: number;
      }[]
    >`
      SELECT table_name, column_name, numeric_precision, numeric_scale
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'inventory_ledger_entry'
               AND column_name IN ('quantity_delta', 'original_quantity', 'conversion_factor'))
           OR (table_name = 'inventory_balance' AND column_name = 'quantity'))
       ORDER BY table_name, column_name`;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.numeric_precision, `${row.table_name}.${row.column_name}`).toBe(18);
      expect(row.numeric_scale, `${row.table_name}.${row.column_name}`).toBe(6);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// D11 — 기타 UNIQUE · 기존 테이블 무변경
// ═══════════════════════════════════════════════════════════════

describe('D11. 나머지 계약', () => {
  it('transaction_no 는 전역 UNIQUE 다', async () => {
    const no = `${TAG}-DUP`;
    await createTransaction({ transactionNo: no });
    await expect(createTransaction({ transactionNo: no })).rejects.toThrow();
  });

  it('(transaction_id, line_no) 는 UNIQUE 다', async () => {
    const txnId = await createTransaction();
    const client = getPrismaClient();
    await client.inventoryLedgerEntry.create({ data: ledgerData(txnId, { lineNo: 9 }) });
    await expect(
      client.inventoryLedgerEntry.create({ data: ledgerData(txnId, { lineNo: 9 }) }),
    ).rejects.toThrow();
  });

  it('★ status 기본값은 POSTED 다 (C-10 — 집계 필터용이 아니다)', async () => {
    const id = await createTransaction();
    const row = await getPrismaClient().inventoryTransaction.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('POSTED');
  });

  it('★★ 기존 warehouse·warehouse_location 제약이 그대로다 (T08 무변경)', async () => {
    const rows = await getPrismaClient().$queryRaw<{ conname: string }[]>`
      SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname IN ('warehouse', 'warehouse_location')
         AND c.conname IN ('warehouse_supplier_site_check',
                           'warehouse_id_default_location_id_fkey')
       ORDER BY c.conname`;
    expect(rows.map((row) => row.conname)).toEqual([
      'warehouse_id_default_location_id_fkey',
      'warehouse_supplier_site_check',
    ]);
  });

  it('★ default FK 의 DEFERRABLE INITIALLY DEFERRED 도 그대로다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      { condeferrable: boolean; condeferred: boolean }[]
    >`
      SELECT c.condeferrable, c.condeferred
        FROM pg_constraint c
       WHERE c.conname = 'warehouse_id_default_location_id_fkey'`;
    expect(rows[0]?.condeferrable).toBe(true);
    expect(rows[0]?.condeferred).toBe(true);
  });
});
