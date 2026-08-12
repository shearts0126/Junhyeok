import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  approveSupplierSkuPrice,
  createSupplierSkuPrice,
  listSupplierSkuPrices,
  resolveEffectiveSupplierPrice,
  SUPPLIER_PRICE_APPROVE_PERMISSION,
  SUPPLIER_PRICE_CREATE_PERMISSION,
  SUPPLIER_PRICE_READ_PERMISSION,
  parseDateOnly,
  SUPPLIER_SKU_PRICE_ENTITY_TYPE,
  type CreatePriceInput,
} from '@/modules/supplier/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * 가격이력 API DB 통합 테스트 (T06-3) — 실제 PostgreSQL.
 *
 * 근거: `docs/17_설계복구_거래처공급조건.md` §58~ (§55 acceptance 1~81).
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - **가격 등록 ≠ 발효** — POST 는 pending 행만 만들고 기존 승인 가격·asOf
 *     결과를 바꾸지 않는다 (§4)
 *   - approval chain — predecessor close·successor upper bound·historical
 *     insertion·future 선승인이 한 알고리즘으로 수렴하는지 (D-12~D-14)
 *   - parent `FOR UPDATE` lock 이 동시 승인을 직렬화해 일관 chain 으로
 *     수렴하는지 (D-32)
 *   - UNIQUE`(supplier_sku_id, effective_from)` 위반의 오류 번역과
 *     pending 선점 known limitation (D-15)
 *   - 멱등 scope 에 supplierSkuId 가 포함되어 부모별로 독립인지 (D-30)
 *   - AuditLog 건수·action·reason 이 §42 계약 그대로인지
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TPP-${RUN}-${suffix}`;

const CREATOR_ID = 'eeeeeeee-0000-4000-8000-0000000e3001';
const APPROVER_ID = 'eeeeeeee-0000-4000-8000-0000000e3002';
const FINANCE_ID = 'eeeeeeee-0000-4000-8000-0000000e3003';
const NOPERM_ID = 'eeeeeeee-0000-4000-8000-0000000e3004';
const ACTOR_IDS = [CREATOR_ID, APPROVER_ID, FINANCE_ID, NOPERM_ID];

/** SCM_STAFF 상당 — read·create 만. approve 없음 (D-27). */
const CREATOR: ActorContext = createActorContext({
  userId: CREATOR_ID,
  email: 'price-creator@deeppoint.test',
  name: '가격 등록자',
  active: true,
  roles: ['SCM_STAFF'],
  permissions: [SUPPLIER_PRICE_READ_PERMISSION, SUPPLIER_PRICE_CREATE_PERMISSION],
  requestId: 'req-price-creator',
});

/** SCM_LEADER 상당 — 3권한 전부. */
const APPROVER: ActorContext = createActorContext({
  userId: APPROVER_ID,
  email: 'price-approver@deeppoint.test',
  name: '가격 승인자',
  active: true,
  roles: ['SCM_LEADER'],
  permissions: [
    SUPPLIER_PRICE_READ_PERMISSION,
    SUPPLIER_PRICE_CREATE_PERMISSION,
    SUPPLIER_PRICE_APPROVE_PERMISSION,
  ],
  requestId: 'req-price-approver',
});

/** FINANCE — read·create·approve 전부 (D-27 의 핵심 차이). */
const FINANCE: ActorContext = createActorContext({
  userId: FINANCE_ID,
  email: 'price-finance@deeppoint.test',
  name: '재무 담당',
  active: true,
  roles: ['FINANCE'],
  permissions: [
    SUPPLIER_PRICE_READ_PERMISSION,
    SUPPLIER_PRICE_CREATE_PERMISSION,
    SUPPLIER_PRICE_APPROVE_PERMISSION,
  ],
  requestId: 'req-price-finance',
});

/** EXECUTIVE 상당 + ADMIN 역할 — supplier_price.* 없음. bypass 부재 증명용. */
const NO_PERMISSION: ActorContext = createActorContext({
  userId: NOPERM_ID,
  email: 'price-noperm@deeppoint.test',
  name: '권한 없는 관리자',
  active: true,
  roles: ['ADMIN', 'EXECUTIVE'],
  permissions: ['sku.read'],
  requestId: 'req-price-noperm',
});

let seq = 0;

function nextCode(prefix: string): string {
  seq += 1;
  return CODE(`${prefix}${String(seq).padStart(3, '0')}`);
}

/** parent 준비 — 가격 API 대상은 SupplierSku 하나면 충분하다 (직접 생성). */
async function newSupplierSkuId(): Promise<string> {
  const client = getPrismaClient();
  const supplier = await client.supplier.create({
    data: {
      supplierCode: nextCode('S'),
      supplierName: `가격 테스트 거래처 ${seq}`,
      supplierType: 'MANUFACTURER',
    },
    select: { id: true },
  });
  const sku = await client.sku.create({
    data: { skuCode: nextCode('K'), skuName: `가격 SKU ${seq}`, itemType: 'FINISHED_GOOD' },
    select: { id: true },
  });
  const supplierSku = await client.supplierSku.create({
    data: {
      supplierId: supplier.id,
      skuId: sku.id,
      supplyType: 'SELF_SUPPLIED',
      effectiveFrom: parseDateOnly('2026-01-01'),
    },
    select: { id: true },
  });
  return supplierSku.id;
}

function priceInput(overrides: Partial<CreatePriceInput> = {}): CreatePriceInput {
  return {
    unitPrice: '1000.5',
    currency: 'KRW',
    vatIncluded: false,
    effectiveFrom: '2026-01-01',
    sourceDocument: null,
    ...overrides,
  };
}

async function newPriceId(
  supplierSkuId: string,
  overrides: Partial<CreatePriceInput> = {},
): Promise<string> {
  const result = await createSupplierSkuPrice(CREATOR, supplierSkuId, priceInput(overrides));
  return result.price.id;
}

async function priceRow(id: string) {
  return getPrismaClient().supplierSkuPrice.findUniqueOrThrow({ where: { id } });
}

async function auditsOf(entityId: string) {
  return getPrismaClient().auditLog.findMany({
    where: { entityType: SUPPLIER_SKU_PRICE_ENTITY_TYPE, entityId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { action: true, reason: true, approvedBy: true },
  });
}

async function setSelfApprovalSku(value: boolean): Promise<void> {
  await getPrismaClient().systemSetting.update({
    where: { id: 1 },
    data: { allowSelfApprovalSku: value },
  });
}

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`,
    ACTOR_IDS,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({ where: { actorId: { in: ACTOR_IDS } } });
  await client.supplierSkuPrice.deleteMany({
    where: { supplierSku: { supplier: { supplierCode: { startsWith: 'TPP-' } } } },
  });
  await client.supplierSku.deleteMany({
    where: { supplier: { supplierCode: { startsWith: 'TPP-' } } },
  });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TPP-' } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TPP-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
  // 자가승인 설정 원복
  await client.systemSetting.updateMany({
    where: { id: 1 },
    data: { allowSelfApprovalSku: false },
  });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: [
      { id: CREATOR_ID, email: 'price-creator@deeppoint.test', name: '가격 등록자' },
      { id: APPROVER_ID, email: 'price-approver@deeppoint.test', name: '가격 승인자' },
      { id: FINANCE_ID, email: 'price-finance@deeppoint.test', name: '재무 담당' },
      { id: NOPERM_ID, email: 'price-noperm@deeppoint.test', name: '권한 없는 관리자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 권한 · seed matrix (§55-54~57·75~78)
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — proxy 를 신뢰하지 않는 2차 가드 (§35)', () => {
  it('75·78. read — 권한 없는 ADMIN·EXECUTIVE 는 403. bypass 없음', async () => {
    const supplierSkuId = await newSupplierSkuId();
    await expect(listSupplierSkuPrices(CREATOR, supplierSkuId, {})).resolves.toBeDefined();
    await expect(listSupplierSkuPrices(NO_PERMISSION, supplierSkuId, {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('76·77. FINANCE 는 create·approve 전부 가능하다 (D-27)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const created = await createSupplierSkuPrice(FINANCE, supplierSkuId, priceInput());
    expect(created.price.createdBy).toBe(FINANCE_ID);
    // FINANCE 가 타인(CREATOR) 작성 가격을 승인한다.
    const otherId = await newPriceId(supplierSkuId, { effectiveFrom: '2026-02-01' });
    const approved = await approveSupplierSkuPrice(FINANCE, otherId, { note: null });
    expect(approved.approvedBy).toBe(FINANCE_ID);
  });

  it('55~57. approve — SCM_STAFF(create만)·무권한 ADMIN 전부 403', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const priceId = await newPriceId(supplierSkuId);
    await expect(approveSupplierSkuPrice(CREATOR, priceId, { note: null })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      approveSupplierSkuPrice(NO_PERMISSION, priceId, { note: null }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // 두 시도 모두 상태를 바꾸지 못했다.
    expect((await priceRow(priceId)).approvedBy).toBeNull();
  });

  it('★ seed matrix — read/create 는 A·L·S·F, approve 는 A·L·F, EXECUTIVE 0 (D-27·D-28)', async () => {
    const rows = await getPrismaClient().rolePermission.findMany({
      where: { permission: { permissionKey: { startsWith: 'supplier_price.' } } },
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
    expect(byKey.get('supplier_price.read')?.sort()).toEqual([
      'ADMIN',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    expect(byKey.get('supplier_price.create')?.sort()).toEqual([
      'ADMIN',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    expect(byKey.get('supplier_price.approve')?.sort()).toEqual(['ADMIN', 'FINANCE', 'SCM_LEADER']);
    expect(rows.some((row) => row.role.roleCode === 'EXECUTIVE')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// POST — pending 생성 · 등록/발효 분리 (§55-19·29·30·34~39)
// ═══════════════════════════════════════════════════════════════

describe('POST prices — 미승인 제안행 생성 (§4·§37)', () => {
  it('19·34~36. 생성 결과 — createdBy=actor · approvedBy=null · effectiveTo=null', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const { price, replayed } = await createSupplierSkuPrice(
      CREATOR,
      supplierSkuId,
      priceInput({ sourceDocument: '단가계약-08' }),
    );
    expect(replayed).toBe(false);
    expect(price.supplierSkuId).toBe(supplierSkuId);
    expect(price.unitPrice).toBe('1000.5');
    expect(price.createdBy).toBe(CREATOR_ID);
    expect(price.approvedBy).toBeNull();
    expect(price.effectiveTo).toBeNull();
    expect(price.sourceDocument).toBe('단가계약-08');

    // 46. Audit CREATE 정확히 1건.
    const audits = await auditsOf(price.id);
    expect(audits.map((row) => row.action)).toEqual(['CREATE']);
  });

  it('29·30. 과거 backfill·미래 예약 등록 모두 허용된다 (D-10)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    await expect(newPriceId(supplierSkuId, { effectiveFrom: '2000-01-01' })).resolves.toBeDefined();
    await expect(newPriceId(supplierSkuId, { effectiveFrom: '2099-12-31' })).resolves.toBeDefined();
  });

  it('48. parent SupplierSku 가 없으면 404 — GET·POST 동일', async () => {
    const missing = '00000000-0000-4000-8000-00000000dead';
    await expect(createSupplierSkuPrice(CREATOR, missing, priceInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(listSupplierSkuPrices(CREATOR, missing, {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('★ 37·38·64. POST 는 기존 승인 가격도 asOf 결과도 바꾸지 않는다', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const p1 = await newPriceId(supplierSkuId, { unitPrice: '100', effectiveFrom: '2026-01-01' });
    await approveSupplierSkuPrice(APPROVER, p1, { note: null });

    // pending P2 를 8월로 등록 — P1 은 그대로 열려 있어야 한다.
    await newPriceId(supplierSkuId, { unitPrice: '200', effectiveFrom: '2026-08-01' });

    const p1Row = await priceRow(p1);
    expect(p1Row.effectiveTo).toBeNull();

    // asOf 9월(등록일 이후)도 계속 기존 승인 가격이다 (§19 pending 영향 없음).
    const asOf = await listSupplierSkuPrices(CREATOR, supplierSkuId, { asOf: '2026-09-01' });
    expect(asOf.prices).toHaveLength(1);
    expect(asOf.prices[0]?.id).toBe(p1);
    expect(asOf.prices[0]?.unitPrice).toBe('100');
  });

  it('★ 39. 동일 시작일 — 409 PRICE_EFFECTIVE_FROM_DUPLICATE. pending 도 선점한다 (D-15)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    await newPriceId(supplierSkuId, { effectiveFrom: '2026-03-01' });
    // 미승인 행이 이미 시작일을 선점 — 같은 시작일 재등록은 409 다 (known limitation).
    await expect(
      newPriceId(supplierSkuId, { unitPrice: '999', effectiveFrom: '2026-03-01' }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_PRICE_EFFECTIVE_FROM_DUPLICATE', httpStatus: 409 });
  });
});

// ═══════════════════════════════════════════════════════════════
// POST 멱등성 (§55-40~43, D-30)
// ═══════════════════════════════════════════════════════════════

describe('POST 멱등성 — scope 는 실제 supplierSkuId 포함 (D-30)', () => {
  it('40~42. first 201 / replay 200 / 다른 hash 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const key = `idem-${RUN}-a`;
    const input = priceInput({ effectiveFrom: '2026-05-01' });

    const first = await createSupplierSkuPrice(CREATOR, supplierSkuId, input, {}, key);
    expect(first.replayed).toBe(false);

    const replay = await createSupplierSkuPrice(CREATOR, supplierSkuId, input, {}, key);
    expect(replay.replayed).toBe(true);
    expect(replay.price.id).toBe(first.price.id);

    // 실제 행은 1개뿐이다.
    const count = await getPrismaClient().supplierSkuPrice.count({
      where: { supplierSkuId, effectiveFrom: parseDateOnly('2026-05-01') },
    });
    expect(count).toBe(1);

    await expect(
      createSupplierSkuPrice(
        CREATOR,
        supplierSkuId,
        priceInput({ effectiveFrom: '2026-05-02' }),
        {},
        key,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('★ 43. 같은 key 라도 다른 SupplierSku 면 독립 scope 다', async () => {
    const a = await newSupplierSkuId();
    const b = await newSupplierSkuId();
    const key = `idem-${RUN}-b`;
    const input = priceInput({ effectiveFrom: '2026-05-01' });

    const first = await createSupplierSkuPrice(CREATOR, a, input, {}, key);
    const second = await createSupplierSkuPrice(CREATOR, b, input, {}, key);
    expect(second.replayed).toBe(false);
    expect(second.price.id).not.toBe(first.price.id);
    expect(second.price.supplierSkuId).toBe(b);
  });
});

// ═══════════════════════════════════════════════════════════════
// GET — 전체 이력 (§55-1~8)
// ═══════════════════════════════════════════════════════════════

describe('GET prices — 전체 이력 (D-2)', () => {
  it('1. parent 가 없으면 404 — 빈 목록으로 위장하지 않는다', async () => {
    await expect(
      listSupplierSkuPrices(CREATOR, '00000000-0000-4000-8000-00000000beef', {}),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('2~8. 승인+미승인·과거+현재+미래 전부, effectiveFrom DESC·pagination 없음', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const past = await newPriceId(supplierSkuId, { unitPrice: '10', effectiveFrom: '2020-01-01' });
    const current = await newPriceId(supplierSkuId, {
      unitPrice: '20',
      effectiveFrom: '2026-01-01',
    });
    const future = await newPriceId(supplierSkuId, {
      unitPrice: '30',
      effectiveFrom: '2099-01-01',
    });
    await approveSupplierSkuPrice(APPROVER, past, { note: null });

    const result = await listSupplierSkuPrices(CREATOR, supplierSkuId, {});
    // 승인(past) + 미승인(current·future) 전부 — DESC 정렬.
    expect(result.prices.map((view) => view.id)).toEqual([future, current, past]);
    expect(result.prices.map((view) => view.effectiveFrom)).toEqual([
      '2099-01-01',
      '2026-01-01',
      '2020-01-01',
    ]);
    // 5·7·8. PriceView 계약 — Decimal 문자열·date-only·attachmentId 미노출.
    const view = result.prices[2];
    expect(view?.unitPrice).toBe('10');
    expect(view?.approvedBy).toBe(APPROVER_ID);
    expect(view !== undefined && 'attachmentId' in view).toBe(false);
    // envelope 에 page/pageSize/total 이 없다 — pagination 미지원 (D-5).
    expect(Object.keys(result)).toEqual(['prices']);
  });
});

// ═══════════════════════════════════════════════════════════════
// GET asOf (§55-10~18)
// ═══════════════════════════════════════════════════════════════

describe('GET prices?asOf — 승인된 operational 유효가격 (D-2·D-3·D-23)', () => {
  it('10·12. 승인 가격이 없으면(전부 pending 포함) 200 [] — 404·0원 fallback 아님', async () => {
    const supplierSkuId = await newSupplierSkuId();
    await newPriceId(supplierSkuId, { effectiveFrom: '2026-01-01' }); // pending
    const result = await listSupplierSkuPrices(CREATOR, supplierSkuId, { asOf: '2026-06-01' });
    expect(result.prices).toEqual([]);
  });

  it('11·13·14·15. 경계 — 시작일 포함·effectiveTo 미포함·시작 전 제외 (half-open)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const p1 = await newPriceId(supplierSkuId, { unitPrice: '100', effectiveFrom: '2026-02-01' });
    await approveSupplierSkuPrice(APPROVER, p1, { note: null });
    const p2 = await newPriceId(supplierSkuId, { unitPrice: '200', effectiveFrom: '2026-06-01' });
    await approveSupplierSkuPrice(APPROVER, p2, { note: null });

    const at = async (asOf: string) =>
      (await listSupplierSkuPrices(CREATOR, supplierSkuId, { asOf })).prices;

    expect(await at('2026-01-31')).toEqual([]); // 13. 시작 전 — 없음
    expect((await at('2026-02-01'))[0]?.id).toBe(p1); // 14. 시작일 포함
    expect((await at('2026-05-31'))[0]?.id).toBe(p1); // 16. predecessor 경계
    expect((await at('2026-06-01'))[0]?.id).toBe(p2); // 15. effectiveTo 날짜는 후속의 것
    expect((await at('2099-12-31'))[0]?.id).toBe(p2); // open-ended
  });

  it('18. 0원 승인 가격은 정상 반환된다 — "없음" 과 구분 (D-3)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const zero = await newPriceId(supplierSkuId, { unitPrice: '0', effectiveFrom: '2026-01-01' });
    await approveSupplierSkuPrice(APPROVER, zero, { note: null });
    const result = await listSupplierSkuPrices(CREATOR, supplierSkuId, { asOf: '2026-06-01' });
    expect(result.prices).toHaveLength(1);
    expect(result.prices[0]?.unitPrice).toBe('0');
  });

  it('★ 17. 승인 유효가격 2건(손상) — 409 CHAIN_CONFLICT. LIMIT 1 로 숨기지 않는다', async () => {
    const supplierSkuId = await newSupplierSkuId();
    // API 로는 만들 수 없는 손상 상태를 직접 주입한다 — 둘 다 open-ended 승인.
    const client = getPrismaClient();
    await client.supplierSkuPrice.createMany({
      data: [
        {
          supplierSkuId,
          unitPrice: '100',
          currency: 'KRW',
          vatIncluded: false,
          effectiveFrom: parseDateOnly('2026-01-01'),
          effectiveTo: null,
          createdBy: CREATOR_ID,
          approvedBy: APPROVER_ID,
        },
        {
          supplierSkuId,
          unitPrice: '200',
          currency: 'KRW',
          vatIncluded: false,
          effectiveFrom: parseDateOnly('2026-02-01'),
          effectiveTo: null,
          createdBy: CREATOR_ID,
          approvedBy: APPROVER_ID,
        },
      ],
    });
    await expect(
      listSupplierSkuPrices(CREATOR, supplierSkuId, { asOf: '2026-06-01' }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_PRICE_CHAIN_CONFLICT', httpStatus: 409 });
    // 38. reusable resolver 도 같은 판정이다 — route 전용 logic 이 아니다 (D-22).
    await expect(
      resolveEffectiveSupplierPrice(client, {
        supplierSkuId,
        asOf: parseDateOnly('2026-06-01'),
      }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_PRICE_CHAIN_CONFLICT' });
  });
});

// ═══════════════════════════════════════════════════════════════
// 승인 — 기본 · repeat · 자가승인 (§55-44~53)
// ═══════════════════════════════════════════════════════════════

describe('승인 — approvedBy 확정 · repeat no-op · 자가승인 (D-17~D-19)', () => {
  it('44~47·58·68·69. 승인 성공 — approvedBy=actor·APPROVE audit 1건·note→reason', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const priceId = await newPriceId(supplierSkuId);

    const view = await approveSupplierSkuPrice(APPROVER, priceId, { note: '8월 단가 합의' });
    expect(view.approvedBy).toBe(APPROVER_ID);
    // 58. 첫 승인 가격 — successor 없음 → effectiveTo null.
    expect(view.effectiveTo).toBeNull();

    // 68·69. target 의 audit 은 CREATE + APPROVE 정확히 2건 — 별도 UPDATE 없음.
    const audits = await auditsOf(priceId);
    expect(audits.map((row) => row.action)).toEqual(['CREATE', 'APPROVE']);
    expect(audits[1]?.reason).toBe('8월 단가 합의');
    expect(audits[1]?.approvedBy).toBe(APPROVER_ID);
  });

  it('★ 51~53. repeat approve — 200 현재 view·DB write 0·Audit 0 (다른 actor 도 동일)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const priceId = await newPriceId(supplierSkuId);
    const first = await approveSupplierSkuPrice(APPROVER, priceId, { note: null });

    // 다른 승인 권한자(FINANCE)의 repeat — approvedBy 를 덮어쓰지 않는다.
    const repeat = await approveSupplierSkuPrice(FINANCE, priceId, { note: '중복 시도' });
    expect(repeat).toEqual(first);
    expect(repeat.approvedBy).toBe(APPROVER_ID);

    const audits = await auditsOf(priceId);
    expect(audits.map((row) => row.action)).toEqual(['CREATE', 'APPROVE']);
  });

  it('승인 대상이 없으면 404 다 (D-21 eligibility ①)', async () => {
    await expect(
      approveSupplierSkuPrice(APPROVER, '00000000-0000-4000-8000-00000000cafe', { note: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('★ 48·49. 자가승인 — 실 SystemSetting false → 403 / true → 허용 (D-19)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    // FINANCE 가 만들고 FINANCE 가 승인 시도 — 같은 사람.
    const created = await createSupplierSkuPrice(FINANCE, supplierSkuId, priceInput());
    const priceId = created.price.id;

    await setSelfApprovalSku(false);
    await expect(approveSupplierSkuPrice(FINANCE, priceId, { note: null })).rejects.toMatchObject({
      code: 'SELF_APPROVAL_FORBIDDEN',
      httpStatus: 403,
    });
    expect((await priceRow(priceId)).approvedBy).toBeNull();

    await setSelfApprovalSku(true);
    const approved = await approveSupplierSkuPrice(FINANCE, priceId, { note: null });
    expect(approved.approvedBy).toBe(FINANCE_ID);

    await setSelfApprovalSku(false);
  });

  it('50. createdBy null(migration 유래)이면 자가승인 비교를 건너뛴다', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const row = await getPrismaClient().supplierSkuPrice.create({
      data: {
        supplierSkuId,
        unitPrice: '500',
        currency: 'KRW',
        vatIncluded: false,
        effectiveFrom: parseDateOnly('2026-01-01'),
        createdBy: null,
        approvedBy: null,
      },
      select: { id: true },
    });
    await setSelfApprovalSku(false);
    const approved = await approveSupplierSkuPrice(APPROVER, row.id, { note: null });
    expect(approved.approvedBy).toBe(APPROVER_ID);
  });
});

// ═══════════════════════════════════════════════════════════════
// chain (§55-58~70)
// ═══════════════════════════════════════════════════════════════

describe('★ approval chain — predecessor close · successor upper bound (D-12~D-14)', () => {
  it('59·61·65·67. latest insertion — predecessor 가 T 로 닫히고 UPDATE audit 1건', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const p1 = await newPriceId(supplierSkuId, { unitPrice: '100', effectiveFrom: '2026-01-01' });
    await approveSupplierSkuPrice(APPROVER, p1, { note: null });

    const p2 = await newPriceId(supplierSkuId, { unitPrice: '200', effectiveFrom: '2026-06-01' });
    const approvedP2 = await approveSupplierSkuPrice(APPROVER, p2, { note: '인상' });

    expect(approvedP2.effectiveTo).toBeNull();
    const p1Row = await priceRow(p1);
    expect(p1Row.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-06-01');

    // 67. predecessor 는 UPDATE audit — reason 도 승인 note 다 (§42).
    const p1Audits = await auditsOf(p1);
    expect(p1Audits.map((row) => row.action)).toEqual(['CREATE', 'APPROVE', 'UPDATE']);
    expect(p1Audits[2]?.reason).toBe('인상');

    // 65. 승인 후 boundary 전환.
    const at = async (asOf: string) =>
      (await listSupplierSkuPrices(CREATOR, supplierSkuId, { asOf })).prices[0]?.id;
    expect(await at('2026-05-31')).toBe(p1);
    expect(await at('2026-06-01')).toBe(p2);
  });

  it('★ 60·62. historical insertion — P1~P3 사이에 P2 가 정확히 끼어든다 (D-12)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const p1 = await newPriceId(supplierSkuId, { unitPrice: '100', effectiveFrom: '2026-01-01' });
    await approveSupplierSkuPrice(APPROVER, p1, { note: null });
    const p3 = await newPriceId(supplierSkuId, { unitPrice: '300', effectiveFrom: '2026-12-01' });
    await approveSupplierSkuPrice(APPROVER, p3, { note: null });

    const p2 = await newPriceId(supplierSkuId, { unitPrice: '200', effectiveFrom: '2026-06-01' });
    const approvedP2 = await approveSupplierSkuPrice(APPROVER, p2, { note: null });

    // 62. successor upper bound — P2 는 P3 시작일까지다.
    expect(approvedP2.effectiveTo).toBe('2026-12-01');
    expect((await priceRow(p1)).effectiveTo?.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect((await priceRow(p3)).effectiveTo).toBeNull();

    const at = async (asOf: string) =>
      (await listSupplierSkuPrices(CREATOR, supplierSkuId, { asOf })).prices[0]?.id;
    expect(await at('2026-05-31')).toBe(p1);
    expect(await at('2026-06-01')).toBe(p2);
    expect(await at('2026-11-30')).toBe(p2);
    expect(await at('2026-12-01')).toBe(p3);
  });

  it('63. future 선승인 — 미래 가격을 미리 승인해도 경계가 정확하다 (D-24)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const p1 = await newPriceId(supplierSkuId, { unitPrice: '100', effectiveFrom: '2026-01-01' });
    await approveSupplierSkuPrice(APPROVER, p1, { note: null });

    const future = await newPriceId(supplierSkuId, {
      unitPrice: '150',
      effectiveFrom: '2026-10-01',
    });
    const approved = await approveSupplierSkuPrice(APPROVER, future, { note: null });
    expect(approved.effectiveTo).toBeNull();
    expect((await priceRow(p1)).effectiveTo?.toISOString().slice(0, 10)).toBe('2026-10-01');

    const at = async (asOf: string) =>
      (await listSupplierSkuPrices(CREATOR, supplierSkuId, { asOf })).prices[0]?.id;
    expect(await at('2026-09-30')).toBe(p1);
    expect(await at('2026-10-01')).toBe(future);
  });

  it('★ 66. pending 은 chain 계산에서 제외된다 — predecessor 로 잡히지 않는다', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const p1 = await newPriceId(supplierSkuId, { unitPrice: '100', effectiveFrom: '2026-01-01' });
    await approveSupplierSkuPrice(APPROVER, p1, { note: null });
    // pending — 승인하지 않는다.
    const pending = await newPriceId(supplierSkuId, {
      unitPrice: '999',
      effectiveFrom: '2026-03-01',
    });

    const p3 = await newPriceId(supplierSkuId, { unitPrice: '300', effectiveFrom: '2026-06-01' });
    await approveSupplierSkuPrice(APPROVER, p3, { note: null });

    // predecessor 는 승인된 P1 이다 — pending(03-01)이 아니라.
    expect((await priceRow(p1)).effectiveTo?.toISOString().slice(0, 10)).toBe('2026-06-01');
    // pending 은 손대지 않는다 — 여전히 미승인·open.
    const pendingRow = await priceRow(pending);
    expect(pendingRow.approvedBy).toBeNull();
    expect(pendingRow.effectiveTo).toBeNull();
  });

  it('★ 70. 같은 SupplierSku 동시 승인 — parent lock 으로 직렬화·일관 chain 수렴 (D-32)', async () => {
    const supplierSkuId = await newSupplierSkuId();
    const p1 = await newPriceId(supplierSkuId, { unitPrice: '100', effectiveFrom: '2026-01-01' });
    await approveSupplierSkuPrice(APPROVER, p1, { note: null });

    const a = await newPriceId(supplierSkuId, { unitPrice: '200', effectiveFrom: '2026-04-01' });
    const b = await newPriceId(supplierSkuId, { unitPrice: '300', effectiveFrom: '2026-08-01' });

    // 동시 승인 — 어느 쪽이 먼저 커밋되든 결과 chain 은 같아야 한다.
    const [viewA, viewB] = await Promise.all([
      approveSupplierSkuPrice(APPROVER, a, { note: null }),
      approveSupplierSkuPrice(FINANCE, b, { note: null }),
    ]);
    expect(viewA.approvedBy).toBe(APPROVER_ID);
    expect(viewB.approvedBy).toBe(FINANCE_ID);

    const [p1Row, aRow, bRow] = await Promise.all([priceRow(p1), priceRow(a), priceRow(b)]);
    expect(p1Row.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(aRow.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(bRow.effectiveTo).toBeNull();

    // 수렴 검증 — asOf 가 세 구간을 정확히 가른다.
    const at = async (asOf: string) =>
      (await listSupplierSkuPrices(CREATOR, supplierSkuId, { asOf })).prices[0]?.id;
    expect(await at('2026-03-31')).toBe(p1);
    expect(await at('2026-04-01')).toBe(a);
    expect(await at('2026-07-31')).toBe(a);
    expect(await at('2026-08-01')).toBe(b);
  });
});
