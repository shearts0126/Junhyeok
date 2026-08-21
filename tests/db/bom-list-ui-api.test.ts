import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  createBom,
  createBomLine,
  deleteBomLine,
  listBomHistory,
  listBoms,
  parseDateOnly,
  updateBom,
  updateBomLine,
  BOM_CREATE_PERMISSION,
  BOM_READ_PERMISSION,
  BOM_UPDATE_PERMISSION,
  LIST_REFERENCE_COST_INTEGRITY_ERROR_CODES,
  type BomListItemView,
  type BomReferenceCostView,
} from '@/modules/bom/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * T07-8 BOM 관리 UI read-model DB 통합 테스트 — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-14·§D-15·§D-31 ·
 *    `★ T07-8 BOM UI read-model gap closure`(U8-1 ~ U8-19) ·
 *    `★ T07-8 list reference-cost fault isolation remediation`(R8-1 ~ R8-18).
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - `lastModifiedAt` 이 **audit 파생값**이라는 것 — 헤더·라인 양쪽 MAX
 *   - **삭제된 라인의 이력이 살아남는다** (U8-2 — audit snapshot 으로만 가능)
 *   - **F1~F15 fault isolation** — 손상 BOM 이 목록 전체를 죽이지 않는다
 *   - `referenceCost` discriminated union 의 **정확한 키 집합**
 *   - 50건 목록이 **선형 query 를 내지 않는다** (U8-4 batch 1회)
 *   - `GET /api/boms/{id}/history` 페이지네이션·권한·404
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TLU-${RUN}-${suffix}`;

const STAFF_ID = 'aaa00000-0000-4000-8000-0000000d8001';
const READER_ID = 'aaa00000-0000-4000-8000-0000000d8002';
const NOPERM_ID = 'aaa00000-0000-4000-8000-0000000d8003';
const APPROVER_ID = 'aaa00000-0000-4000-8000-0000000d8004';
const ACTOR_IDS = [STAFF_ID, READER_ID, NOPERM_ID, APPROVER_ID];

const actor = (userId: string, roles: string[], permissions: string[]): ActorContext =>
  createActorContext({
    userId,
    email: `${userId}@deeppoint.test`,
    name: userId,
    active: true,
    roles,
    permissions,
    requestId: `req-${userId}`,
  });

const STAFF = actor(
  STAFF_ID,
  ['SCM_STAFF'],
  [BOM_READ_PERMISSION, BOM_CREATE_PERMISSION, BOM_UPDATE_PERMISSION],
);
const READER = actor(READER_ID, ['EXECUTIVE'], [BOM_READ_PERMISSION]);
/** ★ ADMIN role 이지만 permission 데이터가 없다 — bypass 부재 증명. */
const NO_PERMISSION = actor(NOPERM_ID, ['ADMIN'], []);

const ASOF = '2026-06-01';

let seq = 0;

// ═══════════════════════════════════════════════════════════════
// fixture factory
// ═══════════════════════════════════════════════════════════════

async function newSku(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `목록 SKU (${label})`,
      itemType: 'FINISHED_GOOD',
      status: 'ACTIVE',
      baseUom: 'EA',
    },
    select: { id: true },
  });
  return row.id;
}

async function newSupplier(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().supplier.create({
    data: {
      supplierCode: CODE(`S${String(seq).padStart(3, '0')}`),
      supplierName: `목록 거래처 (${label})`,
      supplierType: 'MANUFACTURER',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  return row.id;
}

async function newSupplierSku(supplierId: string, skuId: string, isPrimary = true) {
  const row = await getPrismaClient().supplierSku.create({
    data: {
      supplierId,
      skuId,
      isPrimary,
      effectiveFrom: parseDateOnly('2020-01-01'),
      effectiveTo: null,
      purchaseUom: null,
      currency: 'KRW',
    },
    select: { id: true },
  });
  return row.id;
}

async function newPrice(
  supplierSkuId: string,
  unitPrice: string,
  options: {
    readonly currency?: string;
    readonly vatIncluded?: boolean;
    readonly effectiveFrom?: string;
    readonly effectiveTo?: string | null;
    readonly approved?: boolean;
  } = {},
): Promise<string> {
  const approved = options.approved ?? true;
  const row = await getPrismaClient().supplierSkuPrice.create({
    data: {
      supplierSkuId,
      unitPrice,
      currency: options.currency ?? 'KRW',
      vatIncluded: options.vatIncluded ?? false,
      effectiveFrom: parseDateOnly(options.effectiveFrom ?? '2020-01-01'),
      effectiveTo:
        options.effectiveTo === undefined || options.effectiveTo === null
          ? null
          : parseDateOnly(options.effectiveTo),
      // 승인은 `approvedBy IS NOT NULL` 하나로 표현된다 — ⛔ `approvedAt` 컬럼 없음.
      ...(approved ? { approvedBy: APPROVER_ID } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

/** 대표 공급조건 + 승인 가격이 붙은 구성품 SKU 하나. */
async function pricedSku(
  label: string,
  unitPrice: string,
  options: { readonly currency?: string; readonly vatIncluded?: boolean } = {},
): Promise<string> {
  const sku = await newSku(label);
  const supplierSku = await newSupplierSku(await newSupplier(label), sku);
  await newPrice(supplierSku, unitPrice, options);
  return sku;
}

interface HeaderOptions {
  readonly status?: string;
  readonly outputQty?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
}

/** ⛔ application service 를 우회해 **손상 상태**를 직접 심는 용도다. */
async function newHeader(
  parentSkuId: string,
  label: string,
  options: HeaderOptions = {},
): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().bomHeader.create({
    data: {
      parentSkuId,
      bomType: 'MANUFACTURING',
      version: `${label}-${String(seq).padStart(3, '0')}`.slice(0, 20),
      status: (options.status ?? 'ACTIVE') as 'ACTIVE',
      outputQty: options.outputQty ?? '1',
      outputUom: 'EA',
      effectiveFrom: parseDateOnly(options.effectiveFrom ?? '2020-01-01'),
      effectiveTo:
        options.effectiveTo === undefined || options.effectiveTo === null
          ? null
          : parseDateOnly(options.effectiveTo),
    },
    select: { id: true },
  });
  return row.id;
}

async function newLine(
  bomHeaderId: string,
  componentSkuId: string,
  options: {
    readonly quantityPer?: string | null;
    readonly quantityStatus?: string;
    readonly alternateGroup?: string | null;
  } = {},
): Promise<string> {
  const existing = await getPrismaClient().bomLine.count({ where: { bomHeaderId } });
  const row = await getPrismaClient().bomLine.create({
    data: {
      bomHeaderId,
      componentSkuId,
      lineNo: existing + 1,
      quantityPer: options.quantityPer === undefined ? '1' : options.quantityPer,
      quantityStatus: (options.quantityStatus ?? 'CONFIRMED') as 'CONFIRMED',
      uom: 'EA',
      lossRate: null,
      componentRole: 'MATERIAL',
      isRequired: true,
      alternateGroup: options.alternateGroup ?? null,
      supplyType: null,
      packQuantity: null,
    },
    select: { id: true },
  });
  return row.id;
}

const listOf = async (parentSkuId: string, effectiveOn = ASOF): Promise<BomListItemView[]> => [
  ...(await listBoms(READER, { page: 1, parentSkuId, effectiveOn })).items,
];

const oneOf = async (parentSkuId: string, effectiveOn = ASOF): Promise<BomListItemView> => {
  const items = await listOf(parentSkuId, effectiveOn);
  expect(items).toHaveLength(1);
  return items[0] as BomListItemView;
};

const costOf = async (parentSkuId: string): Promise<BomReferenceCostView> =>
  (await oneOf(parentSkuId)).referenceCost;

/**
 * ★ audit 을 보지 않는 read port.
 *
 * `withBrokenEffectiveBom` 안에서는 손상 행이 **트랜잭션 안에만** 있으므로,
 * 전역 커넥션을 쓰는 기본 port 를 태우면 커넥션이 둘로 갈린다. 이 테스트가
 * 보는 것은 `referenceCost` 뿐이니 `lastModifiedAt` 은 fallback 으로 둔다.
 */
const NO_AUDIT_PORT = {
  readBomAuditHistoryPage: () =>
    Promise.resolve({ items: [], page: 1, pageSize: 50, total: 0, totalPages: 0 }),
  readLatestBomActivityByBomIds: () => Promise.resolve(new Map<string, Date>()),
};

/**
 * ★★ 같은 시점에 유효한 ACTIVE BOM 2건이라는 **손상 상태**를 만든다.
 *
 * ⚠️ `bom_header_active_period_excl` EXCLUDE 제약이 정상 경로로는 이 상태를
 *    허용하지 않는다. 그래서 제약을 내리되 **반드시 트랜잭션 안에서** 하고
 *    끝나면 롤백한다.
 *
 * ⛔ 전역 client 로 raw 를 실행하면 트랜잭션 밖 커넥션이라 제약이 **영구
 *    삭제**되어 다른 테스트 파일을 깨뜨린다 — `bom-effective-resolver.test.ts` ·
 *    `bom-cost-rollup-api.test.ts` 와 같은 기법을 그대로 쓴다.
 */
async function withBrokenEffectiveBom<T>(
  parentSkuId: string,
  body: (tx: never) => Promise<T>,
): Promise<T> {
  const client = getPrismaClient();
  let captured: T | undefined;
  let failure: unknown = null;

  await client
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE bom_header DROP CONSTRAINT bom_header_active_period_excl',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO bom_header (id, parent_sku_id, bom_type, version, status, output_qty,
                                 output_uom, effective_from, created_at)
         VALUES (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'brk-1', 'ACTIVE', 1, 'EA',
                 DATE '2020-01-01', now()),
                (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'brk-2', 'ACTIVE', 1, 'EA',
                 DATE '2021-01-01', now())`,
        parentSkuId,
      );

      try {
        captured = await body(tx as never);
      } catch (error) {
        failure = error;
      }
      // ⚠️ 반드시 롤백한다 — 제약 삭제와 손상 행이 남으면 안 된다.
      throw new Error('rollback');
    })
    .catch((error: unknown) => {
      if ((error as Error).message !== 'rollback') throw error;
    });

  if (failure !== null) throw failure;

  // ★ 롤백됐으므로 제약이 살아 있다 — 같은 손상을 다시 만들 수 없다.
  await expect(
    client.$queryRawUnsafe(
      `SELECT 1 FROM pg_constraint WHERE conname = 'bom_header_active_period_excl'`,
    ),
  ).resolves.toHaveLength(1);

  return captured as T;
}

interface CallRecord {
  readonly total: number;
  readonly byName: Record<string, number>;
}

/**
 * ★ 발행된 Prisma 호출을 **모델.메서드 단위로 센다**.
 *
 * `$on('query')` 는 driver adapter 경로에서 이벤트를 주지 않으므로,
 * `bom-cost-rollup-api.test.ts` 의 spy-client 기법을 일반화해 쓴다.
 */
async function recordCalls(body: (db: never) => Promise<unknown>): Promise<CallRecord> {
  const client = getPrismaClient();
  const byName: Record<string, number> = {};

  const spy = new Proxy(client as unknown as Record<string, unknown>, {
    get(target, model: string) {
      const delegate = target[model];
      // `$transaction` 같은 함수·심볼은 그대로 흘린다.
      if (typeof delegate !== 'object' || delegate === null) return delegate;
      return new Proxy(delegate as Record<string, unknown>, {
        get(modelTarget, method: string) {
          const fn = modelTarget[method];
          if (typeof fn !== 'function') return fn;
          return (...args: unknown[]) => {
            const key = `${model}.${method}`;
            byName[key] = (byName[key] ?? 0) + 1;
            return (fn as (...a: unknown[]) => unknown).apply(modelTarget, args);
          };
        },
      });
    },
  });

  await body(spy as never);

  const total = Object.values(byName).reduce((sum, count) => sum + count, 0);
  return { total, byName };
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
  // ⚠️ AuditLog 는 append-only 이고 `actor_id` FK 는 RESTRICT 다. 테스트 배우를
  //    지우려면 감사 trigger 를 잠깐 내리는 수밖에 없다 —
  //    `bom-crud-api.test.ts` 의 정리 기법을 그대로 쓴다.
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`,
    ACTOR_IDS,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({ where: { actorId: { in: ACTOR_IDS } } });
  await client.supplierSkuPrice.deleteMany({
    where: { supplierSku: { sku: { skuCode: { startsWith: 'TLU-' } } } },
  });
  await client.supplierSku.deleteMany({ where: { sku: { skuCode: { startsWith: 'TLU-' } } } });
  await client.supplierSku.deleteMany({
    where: { supplier: { supplierCode: { startsWith: 'TLU-' } } },
  });
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TLU-' } } } },
  });
  await client.bomLine.deleteMany({ where: { componentSku: { skuCode: { startsWith: 'TLU-' } } } });
  await client.bomHeader.deleteMany({ where: { parentSku: { skuCode: { startsWith: 'TLU-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TLU-' } } });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TLU-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: '목록 테스트' })),
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma();
});

// ═══════════════════════════════════════════════════════════════
// 1. referenceCost union — 정확한 키 집합 (R8-3 · §33)
// ═══════════════════════════════════════════════════════════════

describe('1. referenceCost discriminated union (R8-3)', () => {
  it('★★ AVAILABLE 은 정확히 5개 키다 — ⛔ 그 이상도 이하도 아니다', async () => {
    const parent = await newSku('avail');
    const bom = await newHeader(parent, 'AV');
    await newLine(bom, await pricedSku('avail-c', '1000'));

    const cost = await costOf(parent);
    expect(cost.status).toBe('AVAILABLE');
    expect(Object.keys(cost).sort()).toEqual([
      'asOf',
      'hasOtherCurrency',
      'isProvisional',
      'krwSubtotals',
      'status',
    ]);
    // ⛔ UNAVAILABLE 전용 키가 새어 들어오지 않는다.
    expect(cost).not.toHaveProperty('errorCode');
  });

  it('★★ UNAVAILABLE 은 정확히 3개 키다', async () => {
    const parent = await newSku('unavail');
    const bom = await newHeader(parent, 'UN');
    // 자기 자신을 구성품으로 넣어 순환을 만든다 — service 를 우회한 손상 상태다.
    await newLine(bom, parent);

    const cost = await costOf(parent);
    expect(cost.status).toBe('UNAVAILABLE');
    expect(Object.keys(cost).sort()).toEqual(['asOf', 'errorCode', 'status']);
    // ⛔ 금액·잠정 키가 남아 있지 않다 — `0원`·`잠정` 으로 위장할 여지가 없다.
    expect(cost).not.toHaveProperty('krwSubtotals');
    expect(cost).not.toHaveProperty('isProvisional');
  });

  it('★ asOf 는 effectiveOn 을 그대로 쓴다 (U8-7) — ⛔ 8번째 query 없음', async () => {
    const parent = await newSku('asof');
    const bom = await newHeader(parent, 'AS');
    await newLine(bom, await pricedSku('asof-c', '10'));
    expect((await costOf(parent)).asOf).toBe(ASOF);
    expect((await oneOf(parent, '2026-07-15')).referenceCost.asOf).toBe('2026-07-15');
  });

  it('★ whitelist 는 정확히 7종이다 (R8-6)', () => {
    expect([...LIST_REFERENCE_COST_INTEGRITY_ERROR_CODES].sort()).toEqual([
      ERROR_CODES.BOM_CYCLE_DETECTED,
      ERROR_CODES.BOM_EFFECTIVE_CONFLICT,
      ERROR_CODES.BOM_MAX_LEVEL_EXCEEDED,
      ERROR_CODES.BOM_QTY_INVALID,
      ERROR_CODES.BOM_QTY_STATUS_MISMATCH,
      ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT,
      ERROR_CODES.SUPPLIER_PRICE_CHAIN_CONFLICT,
    ]);
    expect(LIST_REFERENCE_COST_INTEGRITY_ERROR_CODES).toHaveLength(7);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. F1~F15 — fault isolation (R8-7·R8-8 · §32)
// ═══════════════════════════════════════════════════════════════

describe('2. fault isolation 매트릭스 (F1~F15)', () => {
  it('F1 — 정상 BOM 은 AVAILABLE 이고 KRW subtotal 을 낸다', async () => {
    const parent = await newSku('f1');
    const bom = await newHeader(parent, 'F1');
    await newLine(bom, await pricedSku('f1-c', '1500'));

    const cost = await costOf(parent);
    expect(cost).toMatchObject({ status: 'AVAILABLE', isProvisional: false });
    if (cost.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(cost.krwSubtotals).toEqual([{ vatIncluded: false, amount: '1500' }]);
  });

  it('★★ F2 — 순환 BOM 은 UNAVAILABLE 이며 목록 전체를 죽이지 않는다', async () => {
    const parent = await newSku('f2');
    const healthy = await newSku('f2-ok');

    const broken = await newHeader(parent, 'F2X');
    await newLine(broken, parent); // self-cycle

    const good = await newHeader(healthy, 'F2G');
    await newLine(good, await pricedSku('f2-c', '700'));

    // ★ 두 BOM 을 **한 번의 목록 호출**로 함께 읽는다.
    const result = await listBoms(READER, { page: 1, q: CODE(''), effectiveOn: ASOF });
    const brokenRow = result.items.find((row) => row.id === broken);
    const goodRow = result.items.find((row) => row.id === good);

    expect(brokenRow?.referenceCost).toMatchObject({
      status: 'UNAVAILABLE',
      errorCode: ERROR_CODES.BOM_CYCLE_DETECTED,
    });
    // ⛔ 손상 1건이 건강한 행의 원가를 앗아가지 않는다 (R8-8 fault scope).
    expect(goodRow?.referenceCost).toMatchObject({ status: 'AVAILABLE' });
  });

  it('★★ F3 — 목록 응답 자체는 200 이다 (§17 T07-3 cycle fixture 회귀)', async () => {
    const parent = await newSku('f3');
    const bom = await newHeader(parent, 'F3');
    await newLine(bom, parent);
    // ⛔ throw 하지 않는다 — resolves 로 확인한다.
    await expect(listBoms(READER, { page: 1, parentSkuId: parent })).resolves.toBeDefined();
  });

  it('★ F4 — 전건이 손상이어도 목록은 200 이다 (§18)', async () => {
    const p1 = await newSku('f4a');
    const p2 = await newSku('f4b');
    await newLine(await newHeader(p1, 'F4A'), p1);
    await newLine(await newHeader(p2, 'F4B'), p2);

    const result = await listBoms(READER, { page: 1, q: CODE('') });
    const rows = result.items.filter((row) => [p1, p2].includes(row.parentSkuId));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.referenceCost.status).toBe('UNAVAILABLE');
  });

  it('★★ F5 — 대표 공급조건 충돌은 SUPPLIER_SELECTION_CONFLICT 로 격리된다', async () => {
    const parent = await newSku('f5');
    const component = await newSku('f5-c');
    // 같은 SKU 에 **기간이 겹치는** 대표 공급조건이 둘 — 대표를 특정할 수 없다.
    // ⚠️ 기간을 어긋나게 두어야 T06-* 조건부 UNIQUE 에 걸리지 않는다.
    await getPrismaClient().supplierSku.create({
      data: {
        supplierId: await newSupplier('f5-1'),
        skuId: component,
        isPrimary: true,
        effectiveFrom: parseDateOnly('2020-01-01'),
        effectiveTo: parseDateOnly('2027-01-01'),
        currency: 'KRW',
      },
    });
    await getPrismaClient().supplierSku.create({
      data: {
        supplierId: await newSupplier('f5-2'),
        skuId: component,
        isPrimary: true,
        effectiveFrom: parseDateOnly('2021-01-01'),
        effectiveTo: parseDateOnly('2028-01-01'),
        currency: 'KRW',
      },
    });

    const bom = await newHeader(parent, 'F5');
    await newLine(bom, component);

    expect(await costOf(parent)).toMatchObject({
      status: 'UNAVAILABLE',
      errorCode: ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT,
    });
  });

  it('★★ F6 — 가격이력 충돌은 SUPPLIER_PRICE_CHAIN_CONFLICT 로 격리된다', async () => {
    const parent = await newSku('f6');
    const component = await newSku('f6-c');
    const supplierSku = await newSupplierSku(await newSupplier('f6'), component);
    // 같은 시점에 유효한 승인 가격이 둘이다 (기간이 겹친다).
    await newPrice(supplierSku, '100', { effectiveFrom: '2020-01-01', effectiveTo: '2027-01-01' });
    await newPrice(supplierSku, '200', { effectiveFrom: '2021-01-01', effectiveTo: '2028-01-01' });

    const bom = await newHeader(parent, 'F6');
    await newLine(bom, component);

    expect(await costOf(parent)).toMatchObject({
      status: 'UNAVAILABLE',
      errorCode: ERROR_CODES.SUPPLIER_PRICE_CHAIN_CONFLICT,
    });
  });

  it('★★ F7 — 유효 BOM 충돌은 EFFECTIVE_CONFLICT 로 격리된다', async () => {
    const parent = await newSku('f7');
    const semi = await newSku('f7-semi');
    const root = await newHeader(parent, 'F7R');
    await newLine(root, semi);

    const cost = await withBrokenEffectiveBom(semi, async (tx) => {
      const result = await listBoms(
        READER,
        { page: 1, parentSkuId: parent, effectiveOn: ASOF },
        { db: tx, auditPort: NO_AUDIT_PORT },
      );
      return result.items[0]?.referenceCost;
    });

    expect(cost).toMatchObject({
      status: 'UNAVAILABLE',
      errorCode: ERROR_CODES.BOM_EFFECTIVE_CONFLICT,
    });
  });

  it('★★ F8 — 손상 의존을 **공유하는 root 만** 실패한다 (R8-8 fan-out scope)', async () => {
    const brokenSemi = await newSku('f8-semi');

    // root1 은 손상 반제품을 쓴다. root2 는 쓰지 않는다.
    const p1 = await newSku('f8-r1');
    const p2 = await newSku('f8-r2');
    const r1 = await newHeader(p1, 'F8R1');
    await newLine(r1, brokenSemi);
    const r2 = await newHeader(p2, 'F8R2');
    await newLine(r2, await pricedSku('f8-clean', '999'));

    const rows = await withBrokenEffectiveBom(brokenSemi, async (tx) => {
      const result = await listBoms(
        READER,
        { page: 1, q: CODE(''), effectiveOn: ASOF },
        { db: tx, auditPort: NO_AUDIT_PORT },
      );
      return {
        broken: result.items.find((row) => row.id === r1)?.referenceCost,
        clean: result.items.find((row) => row.id === r2)?.referenceCost,
      };
    });

    expect(rows.broken).toMatchObject({
      status: 'UNAVAILABLE',
      errorCode: ERROR_CODES.BOM_EFFECTIVE_CONFLICT,
    });
    // ★★ 같은 batch 안의 무관한 root 는 온전하다 — 이것이 R8-8 의 전부다.
    expect(rows.clean).toMatchObject({ status: 'AVAILABLE' });
  });

  it('★★ F9 — 가격 없음은 손상이 아니라 **잠정**이다 (§19 AVAILABLE 유지)', async () => {
    const parent = await newSku('f9');
    const bom = await newHeader(parent, 'F9');
    await newLine(bom, await newSku('f9-nopricing')); // 공급조건 자체가 없다

    const cost = await costOf(parent);
    expect(cost.status).toBe('AVAILABLE');
    if (cost.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(cost.isProvisional).toBe(true);
  });

  it('★★ F10 — 일부만 가격이 있으면 알려진 합계 + 잠정이다 (partial)', async () => {
    const parent = await newSku('f10');
    const bom = await newHeader(parent, 'F10');
    await newLine(bom, await pricedSku('f10-known', '400'));
    await newLine(bom, await newSku('f10-unknown'));

    const cost = await costOf(parent);
    if (cost.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(cost.isProvisional).toBe(true);
    // ★ 아는 만큼은 보여 준다 — ⛔ 전부 숨기지 않는다.
    expect(cost.krwSubtotals).toEqual([{ vatIncluded: false, amount: '400' }]);
  });

  it('★★ F11 — 소요량 UNKNOWN 도 손상이 아니라 잠정이다', async () => {
    const parent = await newSku('f11');
    const bom = await newHeader(parent, 'F11');
    await newLine(bom, await pricedSku('f11-c', '100'), {
      quantityPer: null,
      quantityStatus: 'UNKNOWN',
    });

    const cost = await costOf(parent);
    expect(cost.status).toBe('AVAILABLE');
    if (cost.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(cost.isProvisional).toBe(true);
  });

  it('★★ F12 — 원가 0 은 AVAILABLE + 금액 0 이다 (§20 — null 과 구분)', async () => {
    const parent = await newSku('f12');
    const bom = await newHeader(parent, 'F12');
    await newLine(bom, await pricedSku('f12-c', '0'));

    const cost = await costOf(parent);
    if (cost.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(cost.krwSubtotals).toEqual([{ vatIncluded: false, amount: '0' }]);
    expect(cost.isProvisional).toBe(false);
  });

  it('★★ F13 — KRW subtotal 은 vatIncluded 별로 분리된다 (D-27)', async () => {
    const parent = await newSku('f13');
    const bom = await newHeader(parent, 'F13');
    await newLine(bom, await pricedSku('f13-excl', '1000', { vatIncluded: false }));
    await newLine(bom, await pricedSku('f13-incl', '1100', { vatIncluded: true }));

    const cost = await costOf(parent);
    if (cost.status !== 'AVAILABLE') throw new Error('unreachable');
    // ⛔ 2100 으로 합치지 않는다.
    expect([...cost.krwSubtotals].sort((a, b) => a.amount.localeCompare(b.amount))).toEqual([
      { vatIncluded: false, amount: '1000' },
      { vatIncluded: true, amount: '1100' },
    ]);
  });

  it('★★ F14 — 비KRW 는 marker 만 세우고 환산하지 않는다 (D-26)', async () => {
    const parent = await newSku('f14');
    const bom = await newHeader(parent, 'F14');
    await newLine(bom, await pricedSku('f14-krw', '500'));
    await newLine(bom, await pricedSku('f14-usd', '7', { currency: 'USD' }));

    const cost = await costOf(parent);
    if (cost.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(cost.hasOtherCurrency).toBe(true);
    // ★ KRW 금액은 USD 가 섞이지 않은 순수 합계다.
    expect(cost.krwSubtotals).toEqual([{ vatIncluded: false, amount: '500' }]);
  });

  it('★★ F15 — 구성품이 없으면 금액도 없지만 AVAILABLE 이다', async () => {
    const parent = await newSku('f15');
    await newHeader(parent, 'F15');

    const cost = await costOf(parent);
    expect(cost.status).toBe('AVAILABLE');
    if (cost.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(cost.krwSubtotals).toEqual([]);
    expect(cost.hasOtherCurrency).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. lastModifiedAt — audit 파생값 (U8-1 ~ U8-3)
// ═══════════════════════════════════════════════════════════════

describe('3. lastModifiedAt (U8-1 ~ U8-3)', () => {
  it('★★ audit 이 없으면 createdAt 으로 떨어진다 (U8-3)', async () => {
    const parent = await newSku('lm-fallback');
    const bom = await newHeader(parent, 'LMF');
    const row = await getPrismaClient().bomHeader.findUniqueOrThrow({
      where: { id: bom },
      select: { createdAt: true },
    });

    const item = await oneOf(parent);
    expect(item.lastModifiedAt).toBe(row.createdAt.toISOString());
  });

  it('★★ 헤더 수정이 lastModifiedAt 을 밀어 올린다', async () => {
    const parent = await newSku('lm-header');
    const { bom } = await createBom(STAFF, {
      parentSkuId: parent,
      bomType: 'MANUFACTURING',
      version: 'LMH-1',
      effectiveFrom: '2020-01-01',
    });
    const created = (await listOf(parent))[0]?.lastModifiedAt;

    await updateBom(STAFF, bom.id, { changeReason: '수정' });
    const after = (await listOf(parent))[0]?.lastModifiedAt;

    expect(after).toBeDefined();
    expect(new Date(after as string).getTime()).toBeGreaterThan(
      new Date(created as string).getTime(),
    );
  });

  it('★★ **라인** 변경도 헤더의 lastModifiedAt 을 밀어 올린다 (U8-1)', async () => {
    const parent = await newSku('lm-line');
    const component = await newSku('lm-line-c');
    const { bom } = await createBom(STAFF, {
      parentSkuId: parent,
      bomType: 'MANUFACTURING',
      version: 'LML-1',
      effectiveFrom: '2020-01-01',
    });
    const before = (await listOf(parent))[0]?.lastModifiedAt;

    const { line } = await createBomLine(STAFF, bom.id, {
      componentSkuId: component,
      componentRole: 'MATERIAL',
    });
    const afterCreate = (await listOf(parent))[0]?.lastModifiedAt;
    expect(new Date(afterCreate as string).getTime()).toBeGreaterThan(
      new Date(before as string).getTime(),
    );

    await updateBomLine(STAFF, bom.id, line.id, { quantityPer: '3', quantityStatus: 'CONFIRMED' });
    const afterUpdate = (await listOf(parent))[0]?.lastModifiedAt;
    expect(new Date(afterUpdate as string).getTime()).toBeGreaterThanOrEqual(
      new Date(afterCreate as string).getTime(),
    );
  });

  it('★★★ U8-2 — **삭제된** 라인의 변경도 lastModifiedAt 에 남는다', async () => {
    const parent = await newSku('lm-deleted');
    const component = await newSku('lm-deleted-c');
    const { bom } = await createBom(STAFF, {
      parentSkuId: parent,
      bomType: 'MANUFACTURING',
      version: 'LMD-1',
      effectiveFrom: '2020-01-01',
    });
    const { line } = await createBomLine(STAFF, bom.id, {
      componentSkuId: component,
      componentRole: 'MATERIAL',
    });
    await deleteBomLine(STAFF, bom.id, line.id);

    // ⛔ 현재 라인 id 로 `IN` 을 만들었다면 이 이력은 사라졌을 것이다.
    expect(await getPrismaClient().bomLine.count({ where: { bomHeaderId: bom.id } })).toBe(0);

    const deletedAt = await getPrismaClient().auditLog.findFirstOrThrow({
      where: { entityId: line.id, action: 'DELETE' },
      select: { occurredAt: true },
    });
    const item = await oneOf(parent);
    expect(item.lastModifiedAt).toBe(deletedAt.occurredAt.toISOString());
  });

  it('★ lastModifiedAt 은 ISO 문자열이다 — ⛔ Date 객체를 그대로 흘리지 않는다', async () => {
    const parent = await newSku('lm-iso');
    await newHeader(parent, 'LMI');
    const item = await oneOf(parent);
    expect(typeof item.lastModifiedAt).toBe('string');
    expect(item.lastModifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('★★ ⛔ BomHeader 에 updatedAt 컬럼을 만들지 않았다 (U8-1 schema diff 0)', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'bom_header'`,
    );
    const names = rows.map((row) => row.column_name);
    expect(names).toContain('created_at');
    expect(names).not.toContain('updated_at');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. batch 성능 — 선형 query 부재 (U8-4 · §21)
// ═══════════════════════════════════════════════════════════════

describe('4. 목록 batch (U8-4 · §21)', () => {
  it('★★★ root 를 10배로 늘려도 query 수가 **그대로**다 (U8-8 batch 1회)', async () => {
    const shared = await pricedSku('perf-shared', '100');

    const makeRoots = async (count: number, label: string): Promise<string> => {
      const marker = await newSku(`perf-${label}`);
      for (let index = 0; index < count; index += 1) {
        // 같은 parent 에 **기간이 겹치지 않는** BOM 을 여러 개 만든다
        // (EXCLUDE 제약을 건드리지 않으면서 root 수를 늘리는 방법).
        const year = 2000 + index;
        const bom = await newHeader(marker, `P${label}${index}`, {
          status: 'DRAFT',
          effectiveFrom: `${year}-01-01`,
          effectiveTo: `${year}-12-31`,
        });
        await newLine(bom, shared);
      }
      return marker;
    };

    const small = await makeRoots(5, 'S');
    const large = await makeRoots(50, 'L');

    const smallCalls = await recordCalls((db) =>
      listBoms(READER, { page: 1, parentSkuId: small }, { db }),
    );
    const largeCalls = await recordCalls((db) =>
      listBoms(READER, { page: 1, parentSkuId: large }, { db }),
    );

    // ★★ root 가 5 → 50 으로 늘어도 **발행 query 수가 같다**.
    // ⛔ `for (bom) costBom()` 이었다면 50배로 늘었을 것이다.
    expect(largeCalls.total).toBe(smallCalls.total);

    // 구성품 가격 조회는 root 수와 무관하게 각 1회다.
    expect(largeCalls.byName['supplierSku.findMany']).toBe(1);
    expect(largeCalls.byName['supplierSkuPrice.findMany']).toBe(1);
  });

  it('★ 목록 50건도 한 페이지로 200 을 낸다', async () => {
    const result = await listBoms(READER, { page: 1, q: CODE('') });
    expect(result.pageSize).toBe(50);
    expect(result.items.length).toBeLessThanOrEqual(50);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. 변경이력 API (U8-13 · §27)
// ═══════════════════════════════════════════════════════════════

describe('5. 변경이력 (U8-13)', () => {
  it('★★ 헤더와 라인 이력이 한 타임라인에 occurredAt DESC 로 나온다', async () => {
    const parent = await newSku('hist');
    const component = await newSku('hist-c');
    const { bom } = await createBom(STAFF, {
      parentSkuId: parent,
      bomType: 'MANUFACTURING',
      version: 'HIS-1',
      effectiveFrom: '2020-01-01',
    });
    const { line } = await createBomLine(STAFF, bom.id, {
      componentSkuId: component,
      componentRole: 'MATERIAL',
    });
    await deleteBomLine(STAFF, bom.id, line.id);

    const page = await listBomHistory(READER, bom.id, { page: 1 });
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.pageSize).toBe(50);

    const times = page.items.map((item) => new Date(item.occurredAt).getTime());
    // ⛔ 오름차순이 섞이지 않는다.
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // ★★ 삭제된 라인의 이력이 그대로 남아 있다 (U8-2).
    expect(page.items.some((item) => item.entityId === line.id && item.action === 'DELETE')).toBe(
      true,
    );
  });

  it('★ actorId 는 UUID 원문이다 — ⛔ 사용자 조회를 하지 않는다', async () => {
    const parent = await newSku('hist-actor');
    const { bom } = await createBom(STAFF, {
      parentSkuId: parent,
      bomType: 'MANUFACTURING',
      version: 'HIA-1',
      effectiveFrom: '2020-01-01',
    });
    const page = await listBomHistory(READER, bom.id, { page: 1 });
    expect(page.items[0]?.actorId).toBe(STAFF_ID);
    expect(page.items[0]).not.toHaveProperty('actorName');
    expect(page.items[0]).not.toHaveProperty('actorEmail');
  });

  it('★ 페이지네이션 — 2페이지째는 1페이지와 겹치지 않는다', async () => {
    const parent = await newSku('hist-page');
    const { bom } = await createBom(STAFF, {
      parentSkuId: parent,
      bomType: 'MANUFACTURING',
      version: 'HIP-1',
      effectiveFrom: '2020-01-01',
    });
    // 51건 이상을 만들어 2페이지를 확보한다.
    for (let index = 0; index < 55; index += 1) {
      await updateBom(STAFF, bom.id, { changeReason: `변경 ${index}` });
    }

    const first = await listBomHistory(READER, bom.id, { page: 1 });
    const second = await listBomHistory(READER, bom.id, { page: 2 });
    expect(first.items).toHaveLength(50);
    expect(first.totalPages).toBeGreaterThanOrEqual(2);

    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.every((item) => !firstIds.has(item.id))).toBe(true);
  });

  it('★ 없는 BOM 의 이력은 404 다 — ⛔ 빈 목록으로 위장하지 않는다', async () => {
    expect(
      await codeOf(listBomHistory(READER, '99999999-9999-4999-8999-999999999999', { page: 1 })),
    ).toBe(ERROR_CODES.BOM_NOT_FOUND);
  });

  it('★★ 권한이 없으면 403 이다 — ADMIN role 도 bypass 하지 못한다', async () => {
    const parent = await newSku('hist-perm');
    const bom = await newHeader(parent, 'HIP');
    expect(await codeOf(listBomHistory(NO_PERMISSION, bom, { page: 1 }))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it('★ 이력 조회는 AuditLog 를 만들지 않는다 (read)', async () => {
    const parent = await newSku('hist-noaudit');
    const bom = await newHeader(parent, 'HIN');
    const before = await getPrismaClient().auditLog.count({ where: { actorId: READER_ID } });
    await listBomHistory(READER, bom, { page: 1 });
    expect(await getPrismaClient().auditLog.count({ where: { actorId: READER_ID } })).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. 권한 — 목록 read (D-15)
// ═══════════════════════════════════════════════════════════════

describe('6. 목록 권한 (D-15)', () => {
  it('★ EXECUTIVE 는 bom.read 로 목록을 읽는다', async () => {
    await expect(listBoms(READER, { page: 1 })).resolves.toBeDefined();
  });

  it('★★ ADMIN role 이어도 permission 데이터가 없으면 403 이다', async () => {
    expect(await codeOf(listBoms(NO_PERMISSION, { page: 1 }))).toBe(ERROR_CODES.FORBIDDEN);
  });
});
