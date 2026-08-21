import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  costBom,
  parseDateOnly,
  BOM_READ_PERMISSION,
  type CostComponentView,
  type CostResultView,
} from '@/modules/bom/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * BOM 다단계 원가 roll-up DB 통합 테스트 (T07-7B) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-14 · §D-15 · §D-19~§D-27 ·
 *    `★ T07-7B multi-level roll-up gap closure`(R-1 ~ R-23).
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - **terminal 판정** = asOf 유효 ACTIVE child BOM 존재 여부
 *   - **⛔ 이중계상 부재** — 반제품 매입가 + 하위 재료비 (R-2 CASE A)
 *   - terminal fallback (R-3 CASE B)
 *   - 다이아몬드 1행 + 최소 level (CASE C)
 *   - mixed-null 수량·금액 partial (CASE D·E)
 *   - **경로 QTY_UNCONFIRMED 상속** (CASE F·G)
 *   - 다통화 하위 (CASE H)
 *   - 손상 409 가 provisional 을 이긴다
 *   - N+1 부재 — level 당 2회 + supplier/price 각 1회
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TRB-${RUN}-${suffix}`;

const READER_ID = 'fff00000-0000-4000-8000-0000000e7b01';
const NOPERM_ID = 'fff00000-0000-4000-8000-0000000e7b02';
const APPROVER_ID = 'fff00000-0000-4000-8000-0000000e7b03';
const EXEC_ID = 'fff00000-0000-4000-8000-0000000e7b04';
const ACTOR_IDS = [READER_ID, NOPERM_ID, APPROVER_ID, EXEC_ID];

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

const READER = actor(READER_ID, ['SCM_LEADER'], [BOM_READ_PERMISSION]);
/** ★ EXECUTIVE 도 `bom.read` 로 원가를 읽는다 (D-15). */
const EXECUTIVE = actor(EXEC_ID, ['EXECUTIVE'], [BOM_READ_PERMISSION]);
/** ADMIN role 이지만 permission 데이터가 없다 — bypass 부재 증명. */
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
      skuName: `롤업 SKU (${label})`,
      itemType: 'FINISHED_GOOD',
      status: 'ACTIVE',
      baseUom: 'EA',
    },
    select: { id: true },
  });
  return row.id;
}

/** skuCode 를 명시해 정렬 테스트를 결정적으로 만든다. */
async function newSkuWithCode(code: string, label: string): Promise<string> {
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(code),
      skuName: `롤업 SKU (${label})`,
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
      supplierName: `롤업 거래처 (${label})`,
      supplierType: 'MANUFACTURER',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  return row.id;
}

interface PriceOptions {
  readonly approved?: boolean;
  readonly currency?: string;
  readonly vatIncluded?: boolean;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
}

async function newSupplierSku(
  supplierId: string,
  skuId: string,
  isPrimary = true,
): Promise<string> {
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
  options: PriceOptions = {},
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
      // 승인 상태는 `approvedBy IS NOT NULL` 하나로 표현된다.
      ...(approved ? { approvedBy: APPROVER_ID } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

/** 대표 공급조건 + 승인 가격이 붙은 SKU 하나. */
async function priced(label: string, unitPrice: string, options: PriceOptions = {}) {
  const sku = await newSku(label);
  const supplier = await newSupplier(label);
  const supplierSku = await newSupplierSku(supplier, sku);
  await newPrice(supplierSku, unitPrice, options);
  return sku;
}

/** 기존 SKU 에 대표 공급조건 + 가격을 붙인다. */
async function attachPrice(skuId: string, label: string, unitPrice: string) {
  const supplier = await newSupplier(label);
  const supplierSku = await newSupplierSku(supplier, skuId);
  await newPrice(supplierSku, unitPrice);
  return supplierSku;
}

interface HeaderOptions {
  readonly outputQty?: string;
  readonly overallLossRate?: string | null;
  readonly status?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
}

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
      overallLossRate: options.overallLossRate ?? null,
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

interface LineOptions {
  readonly quantityPer?: string | null;
  readonly quantityStatus?: string;
  readonly lossRate?: string | null;
  readonly lineNo?: number;
  readonly uom?: string;
  readonly componentRole?: string;
  readonly isRequired?: boolean;
  readonly packQuantity?: string | null;
  /** 같은 header 에 같은 구성품을 두 번 넣을 때 필요하다 (D-3 조건부 UNIQUE). */
  readonly alternateGroup?: string | null;
}

async function newLine(
  bomHeaderId: string,
  componentSkuId: string,
  options: LineOptions = {},
): Promise<string> {
  const existing = await getPrismaClient().bomLine.count({ where: { bomHeaderId } });
  const row = await getPrismaClient().bomLine.create({
    data: {
      bomHeaderId,
      componentSkuId,
      lineNo: options.lineNo ?? existing + 1,
      quantityPer: options.quantityPer === undefined ? '1' : options.quantityPer,
      quantityStatus: (options.quantityStatus ?? 'CONFIRMED') as 'CONFIRMED',
      uom: options.uom ?? 'EA',
      lossRate: options.lossRate ?? null,
      componentRole: (options.componentRole ?? 'MATERIAL') as 'MATERIAL',
      isRequired: options.isRequired ?? true,
      alternateGroup: options.alternateGroup ?? null,
      supplyType: null,
      packQuantity: options.packQuantity ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

const cost = (bomId: string, qty = '1', asOf: string = ASOF): Promise<CostResultView> =>
  costBom(READER, bomId, { qty, asOf });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('예외가 발생하지 않았다');
}

const bySku = (result: CostResultView, skuId: string): CostComponentView => {
  const found = result.components.find((row) => row.componentSkuId === skuId);
  expect(found, `component ${skuId}`).toBeDefined();
  return found as CostComponentView;
};

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.supplierSkuPrice.deleteMany({
    where: { supplierSku: { sku: { skuCode: { startsWith: 'TRB-' } } } },
  });
  await client.supplierSku.deleteMany({ where: { sku: { skuCode: { startsWith: 'TRB-' } } } });
  await client.supplierSku.deleteMany({
    where: { supplier: { supplierCode: { startsWith: 'TRB-' } } },
  });
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TRB-' } } } },
  });
  await client.bomLine.deleteMany({ where: { componentSku: { skuCode: { startsWith: 'TRB-' } } } });
  await client.bomHeader.deleteMany({ where: { parentSku: { skuCode: { startsWith: 'TRB-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TRB-' } } });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TRB-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: '롤업 테스트' })),
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 1. ★★ CASE A — 반제품 이중계상 금지 (R-1·R-2) — 핵심 acceptance
// ═══════════════════════════════════════════════════════════════

describe('★★ R-1·R-2 — terminal 만 원가를 낳는다 (⛔ 이중계상)', () => {
  it('★★★ CASE A — P → B → C 에서 B 매입가는 산입되지 않는다', async () => {
    // B 에 매입가 1000 이 **있는데도** B 에 유효 child BOM 이 있으므로
    // B 는 traversal node 다. 최종 원가는 C 의 600 뿐이어야 한다.
    const p = await newSku('a-p');
    const b = await newSku('a-b');
    const c = await priced('a-c', '600');

    await attachPrice(b, 'a-b-supplier', '1000'); // ★ 함정 — 쓰이면 안 된다.

    const pBom = await newHeader(p, 'CASEAP');
    await newLine(pBom, b, { quantityPer: '1' });
    const bBom = await newHeader(b, 'CASEAB');
    await newLine(bBom, c, { quantityPer: '1' });

    const result = await cost(pBom, '1');

    // ★ components 에 B 가 없다 — C 하나뿐이다.
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.componentSkuId).toBe(c);
    expect(result.components.map((row) => row.componentSkuId)).not.toContain(b);

    // ★ 최종 금액은 600 — ⛔ 1600 이 아니다.
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '600' }]);
    expect(result.subtotals[0]?.amount).not.toBe('1600');
    expect(result.subtotals[0]?.amount).not.toBe('1000');
  });

  it('★★ B 의 매입가가 없어도 결과가 같다 — 애초에 보지 않기 때문이다 (R-4)', async () => {
    const p = await newSku('a2-p');
    const b = await newSku('a2-b'); // ⛔ 공급조건·가격 없음
    const c = await priced('a2-c', '600');

    const pBom = await newHeader(p, 'CASEA2P');
    await newLine(pBom, b, { quantityPer: '1' });
    const bBom = await newHeader(b, 'CASEA2B');
    await newLine(bBom, c, { quantityPer: '1' });

    const result = await cost(pBom, '1');

    // ★ B 에 대표 공급처가 없지만 NO_PRIMARY_SUPPLIER 가 **생기지 않는다** —
    //   intermediate 의 공급 사실은 평가 대상이 아니다 (R-4·R-13).
    expect(result.provisionalReasons).toEqual([]);
    expect(result.isProvisional).toBe(false);
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '600' }]);
  });

  it('★★ CASE B — child BOM 이 없으면 그 SKU 자신이 terminal 이다 (R-3)', async () => {
    const p = await newSku('b-p');
    const b = await priced('b-b', '1000'); // ⛔ child BOM 없음 → terminal

    const pBom = await newHeader(p, 'CASEB');
    await newLine(pBom, b, { quantityPer: '1' });

    const result = await cost(pBom, '1');
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.componentSkuId).toBe(b);
    expect(result.components[0]?.lineCost).toBe('1000');
    expect(result.subtotals[0]?.amount).toBe('1000');
  });

  it('★★ terminal 판정은 asOf 에 달려 있다 — 같은 SKU 가 기준일에 따라 갈린다', async () => {
    const p = await newSku('asof-p');
    const b = await newSku('asof-b');
    const c = await priced('asof-c', '600');
    await attachPrice(b, 'asof-b-sup', '1000');

    const pBom = await newHeader(p, 'ASOFP');
    await newLine(pBom, b, { quantityPer: '1' });
    // B 의 child BOM 은 **2026-07-01 부터** 유효하다.
    const bBom = await newHeader(b, 'ASOFB', { effectiveFrom: '2026-07-01' });
    await newLine(bBom, c, { quantityPer: '1' });

    // 2026-06-01 → child BOM 이 아직 없다 → B 가 terminal → 1000
    const before = await cost(pBom, '1', '2026-06-01');
    expect(before.components.map((row) => row.componentSkuId)).toEqual([b]);
    expect(before.subtotals[0]?.amount).toBe('1000');

    // 2026-08-01 → child BOM 유효 → B 는 intermediate → C 만 남고 600
    const after = await cost(pBom, '1', '2026-08-01');
    expect(after.components.map((row) => row.componentSkuId)).toEqual([c]);
    expect(after.subtotals[0]?.amount).toBe('600');
  });

  it('★★ itemType·componentRole 로 terminal 을 정하지 않는다', async () => {
    // SERVICE 역할 라인도 child BOM 이 없으면 terminal 이고 원가에 들어간다.
    const p = await newSku('svc-p');
    const svc = await priced('svc-c', '464');
    const pBom = await newHeader(p, 'SVCP');
    await newLine(pBom, svc, { quantityPer: '1', componentRole: 'SERVICE' });

    const result = await cost(pBom, '1');
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.lineCost).toBe('464');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 다단계 수량 — 3-level raw 정밀도
// ═══════════════════════════════════════════════════════════════

describe('★★ D-19 — 다단계 raw 수량 전파', () => {
  it('★★ 3단계 · outputQty ≠ 1 · 손실률 2종이 정확히 곱해진다', async () => {
    // P(out 2, overall 0.1) --qtyPer 4, loss 0.2--> B
    //   B(out 5, overall 0)  --qtyPer 3--> C
    // Q = 10
    // B 소요 = (10/2) × 4 × 1.2 × 1.1 = 26.4
    // C 소요 = (26.4/5) × 3 × 1 × 1  = 15.84
    const p = await newSku('m3-p');
    const b = await newSku('m3-b');
    const c = await priced('m3-c', '100');

    const pBom = await newHeader(p, 'M3P', { outputQty: '2', overallLossRate: '0.1' });
    await newLine(pBom, b, { quantityPer: '4', lossRate: '0.2' });
    const bBom = await newHeader(b, 'M3B', { outputQty: '5' });
    await newLine(bBom, c, { quantityPer: '3' });

    const result = await cost(pBom, '10');
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.requiredQty).toBe('15.84');
    expect(result.components[0]?.lineCost).toBe('1584');
    expect(result.components[0]?.level).toBe(2);
  });

  it('★★ public 6dp 값을 다음 level 입력으로 재사용하지 않는다 (raw 전파)', async () => {
    // P(out 3) --1--> B ,  B(out 1) --1--> C , Q=1 → C raw = 1/3
    // raw × 3000000 = 1000000. 6dp("0.333333") 경로면 999999 다.
    const p = await newSku('rawp-p');
    const b = await newSku('rawp-b');
    const c = await priced('rawp-c', '3000000');

    const pBom = await newHeader(p, 'RAWPP', { outputQty: '3' });
    await newLine(pBom, b, { quantityPer: '1' });
    const bBom = await newHeader(b, 'RAWPB');
    await newLine(bBom, c, { quantityPer: '1' });

    const result = await cost(pBom, '1');
    expect(result.components[0]?.requiredQty).toBe('0.333333');
    expect(result.components[0]?.lineCost).toBe('1000000');
    expect(result.components[0]?.lineCost).not.toBe('999999');
  });

  it('★★ TC-BOM-009 — packQuantity 는 다단계에서도 operand 가 아니다', async () => {
    const p = await newSku('tc9-p');
    const b = await newSku('tc9-b');
    const c = await priced('tc9-c', '30000');

    const pBom = await newHeader(p, 'TC9P');
    await newLine(pBom, b, { quantityPer: '1' });
    const bBom = await newHeader(b, 'TC9B');
    await newLine(bBom, c, { quantityPer: '0.05', packQuantity: '20' });

    const result = await cost(pBom, '1');
    // 0.05 × 30000 = 1500. ⛔ packQuantity 로 다시 나누면 75 다.
    expect(result.components[0]?.requiredQty).toBe('0.05');
    expect(result.components[0]?.lineCost).toBe('1500');
    expect(result.components[0]?.lineCost).not.toBe('75');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. ★★ CASE C — 다이아몬드 집계 (R-7·R-17)
// ═══════════════════════════════════════════════════════════════

describe('★★ R-7·R-17 — 다이아몬드는 1행으로 합쳐진다', () => {
  it('★★★ CASE C — X 가 두 경로에서 나와도 component 는 1개다', async () => {
    // P → B → X (qty 2) ,  P → C → X (qty 3)  →  X 합계 5
    const p = await newSku('d-p');
    const b = await newSku('d-b');
    const c = await newSku('d-c');
    const x = await priced('d-x', '10');

    const pBom = await newHeader(p, 'DIAP');
    await newLine(pBom, b, { quantityPer: '1', lineNo: 1 });
    await newLine(pBom, c, { quantityPer: '1', lineNo: 2 });
    const bBom = await newHeader(b, 'DIAB');
    await newLine(bBom, x, { quantityPer: '2' });
    const cBom = await newHeader(c, 'DIAC');
    await newLine(cBom, x, { quantityPer: '3' });

    const result = await cost(pBom, '1');
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.componentSkuId).toBe(x);
    expect(result.components[0]?.requiredQty).toBe('5');
    expect(result.components[0]?.lineCost).toBe('50');
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '50' }]);
  });

  it('★★ 합산 행의 level 은 등장한 **최소** level 이다 (R-17)', async () => {
    // P → X (level 1)  그리고  P → B → X (level 2)
    const p = await newSku('lvl-p');
    const b = await newSku('lvl-b');
    const x = await priced('lvl-x', '10');

    const pBom = await newHeader(p, 'LVLP');
    await newLine(pBom, x, { quantityPer: '1', lineNo: 1 });
    await newLine(pBom, b, { quantityPer: '1', lineNo: 2 });
    const bBom = await newHeader(b, 'LVLB');
    await newLine(bBom, x, { quantityPer: '4' });

    const result = await cost(pBom, '1');
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.level).toBe(1);
    expect(result.components[0]?.requiredQty).toBe('5');
  });

  it('★★ uom 이 다르면 합치지 않는다 — 별도 행이다 (D-20 방어 규정)', async () => {
    const p = await newSku('uom-p');
    const x = await priced('uom-x', '10');
    const pBom = await newHeader(p, 'UOMP');
    // 같은 header 에 같은 구성품을 두 번 넣으려면 alternateGroup 이 필요하다 (D-3).
    await newLine(pBom, x, { quantityPer: '2', uom: 'EA', lineNo: 1 });
    await newLine(pBom, x, { quantityPer: '3', uom: 'BOX', lineNo: 2, alternateGroup: 'G2' });

    const result = await cost(pBom, '1');
    expect(result.components).toHaveLength(2);
    // ★ R-18 — uom ASC 로 BOX 가 먼저다 (같은 level·skuCode·skuId).
    expect(result.components.map((row) => row.uom)).toEqual(['BOX', 'EA']);
    expect(result.components[0]?.requiredQty).toBe('3');
    expect(result.components[1]?.requiredQty).toBe('2');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. ★★ CASE F·G — 경로 수량 provisional 상속 (R-12)
// ═══════════════════════════════════════════════════════════════

describe('★★★ R-12 — QTY_UNCONFIRMED 는 경로를 상속한다', () => {
  it('★★★ CASE F — SUGGESTED 조상: 원가는 계산되지만 QTY_UNCONFIRMED 다', async () => {
    // P --SUGGESTED--> B --CONFIRMED--> C
    const p = await newSku('f-p');
    const b = await newSku('f-b');
    const c = await priced('f-c', '100');

    const pBom = await newHeader(p, 'CASEFP');
    await newLine(pBom, b, { quantityPer: '2', quantityStatus: 'SUGGESTED' });
    const bBom = await newHeader(b, 'CASEFB');
    await newLine(bBom, c, { quantityPer: '3', quantityStatus: 'CONFIRMED' });

    const result = await cost(pBom, '1');
    const line = result.components[0] as CostComponentView;

    // ★ 숫자는 나온다 — 2 × 3 = 6, × 100 = 600.
    expect(line.requiredQty).toBe('6');
    expect(line.lineCost).toBe('600');
    // ★ 그럼에도 잠정이다. terminal 라인 자신은 CONFIRMED 인데도.
    expect(line.provisionalReason).toBe('QTY_UNCONFIRMED');
    expect(result.provisionalReasons).toEqual(['QTY_UNCONFIRMED']);
    expect(result.isProvisional).toBe(true);
    // 계산 가능하므로 소계에는 들어간다 (partial known).
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '600' }]);
  });

  it('★★★ CASE G — UNKNOWN 조상: 수량·원가가 null 로 전파된다', async () => {
    // P --UNKNOWN--> B --CONFIRMED--> C
    const p = await newSku('g-p');
    const b = await newSku('g-b');
    const c = await priced('g-c', '100');

    const pBom = await newHeader(p, 'CASEGP');
    await newLine(pBom, b, { quantityPer: null, quantityStatus: 'UNKNOWN' });
    const bBom = await newHeader(b, 'CASEGB');
    await newLine(bBom, c, { quantityPer: '3', quantityStatus: 'CONFIRMED' });

    const result = await cost(pBom, '1');
    const line = result.components[0] as CostComponentView;

    expect(line.requiredQty).toBeNull();
    expect(line.lineCost).toBeNull();
    expect(line.provisionalReason).toBe('QTY_UNCONFIRMED');
    // ⛔ 0 으로 채우지 않는다.
    expect(line.lineCost).not.toBe('0');
    // 계산 가능한 라인이 없으므로 소계는 빈 배열이다.
    expect(result.subtotals).toEqual([]);
    expect(result.isProvisional).toBe(true);
  });

  it('★★ 조상이 CONFIRMED 면 terminal 판정만 따른다', async () => {
    const p = await newSku('conf-p');
    const b = await newSku('conf-b');
    const c = await priced('conf-c', '100');

    const pBom = await newHeader(p, 'CONFP');
    await newLine(pBom, b, { quantityPer: '2', quantityStatus: 'CONFIRMED' });
    const bBom = await newHeader(b, 'CONFB');
    await newLine(bBom, c, { quantityPer: '3', quantityStatus: 'CONFIRMED' });

    const result = await cost(pBom, '1');
    expect(result.components[0]?.provisionalReason).toBeNull();
    expect(result.isProvisional).toBe(false);
    expect(result.provisionalReasons).toEqual([]);
  });

  it('★★ terminal 자신이 SUGGESTED 여도 QTY_UNCONFIRMED 다 (F-12)', async () => {
    const p = await newSku('ts-p');
    const c = await priced('ts-c', '100');
    const pBom = await newHeader(p, 'TSP');
    await newLine(pBom, c, { quantityPer: '2', quantityStatus: 'SUGGESTED' });

    const result = await cost(pBom, '1');
    expect(result.components[0]?.lineCost).toBe('200');
    expect(result.components[0]?.provisionalReason).toBe('QTY_UNCONFIRMED');
  });

  it('★★★ R-13 — intermediate 의 공급처·가격 부재는 전파되지 않는다', async () => {
    // B 에 공급조건이 아예 없지만 B 는 intermediate 이므로 사유가 생기지 않고,
    // C 는 정상 가격이 있으므로 결과 전체가 확정이다.
    const p = await newSku('r13-p');
    const b = await newSku('r13-b'); // 공급조건 0
    const c = await priced('r13-c', '100');

    const pBom = await newHeader(p, 'R13P');
    await newLine(pBom, b, { quantityPer: '1' });
    const bBom = await newHeader(b, 'R13B');
    await newLine(bBom, c, { quantityPer: '1' });

    const result = await cost(pBom, '1');
    expect(result.provisionalReasons).toEqual([]);
    expect(result.components[0]?.provisionalReason).toBeNull();
    expect(result.isProvisional).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. ★★ CASE D·E — mixed-null 집계 (R-8·R-10·R-11)
// ═══════════════════════════════════════════════════════════════

describe('★★★ R-8·R-10 — mixed-null 은 known partial 이다', () => {
  it('★★★ CASE D·E — 한 경로는 known, 한 경로는 UNKNOWN', async () => {
    // P --CONFIRMED--> B --3--> X      (X raw 3, cost 300)
    // P --UNKNOWN-->   C --5--> X      (X raw null, cost null)
    const p = await newSku('de-p');
    const b = await newSku('de-b');
    const c = await newSku('de-c');
    const x = await priced('de-x', '100');

    const pBom = await newHeader(p, 'CASEDEP');
    await newLine(pBom, b, { quantityPer: '1', lineNo: 1 });
    await newLine(pBom, c, { quantityPer: null, quantityStatus: 'UNKNOWN', lineNo: 2 });
    const bBom = await newHeader(b, 'CASEDEB');
    await newLine(bBom, x, { quantityPer: '3' });
    const cBom = await newHeader(c, 'CASEDEC');
    await newLine(cBom, x, { quantityPer: '5' });

    const result = await cost(pBom, '1');
    expect(result.components).toHaveLength(1);
    const line = result.components[0] as CostComponentView;

    // ★ CASE D — known 부분만 더한다. ⛔ null 을 0 으로 보지 않고, ⛔ 전체를
    //   null 로 만들지도 않는다.
    expect(line.requiredQty).toBe('3');
    // ★ CASE E — 금액도 known partial 이다.
    expect(line.lineCost).toBe('300');
    // ★ 동시에 잠정이다.
    expect(line.provisionalReason).toBe('QTY_UNCONFIRMED');
    expect(result.isProvisional).toBe(true);
    // ★ R-11 — 같은 known 금액이 소계에도 들어간다 (component 와 검산 일치).
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '300' }]);
  });

  it('★★ 전 occurrence 가 null 이면 requiredQty·lineCost 가 null 이다', async () => {
    const p = await newSku('alln-p');
    const b = await newSku('alln-b');
    const x = await priced('alln-x', '100');

    const pBom = await newHeader(p, 'ALLNP');
    await newLine(pBom, b, { quantityPer: null, quantityStatus: 'UNKNOWN' });
    const bBom = await newHeader(b, 'ALLNB');
    await newLine(bBom, x, { quantityPer: '3' });

    const result = await cost(pBom, '1');
    expect(result.components[0]?.requiredQty).toBeNull();
    expect(result.components[0]?.lineCost).toBeNull();
    expect(result.subtotals).toEqual([]);
  });

  it('★★ 대표가 없으면 수량은 known 이어도 lineCost 가 null 이다', async () => {
    const p = await newSku('nop-p');
    const x = await newSku('nop-x'); // 공급조건 0 · terminal
    const pBom = await newHeader(p, 'NOPP');
    await newLine(pBom, x, { quantityPer: '2' });

    const result = await cost(pBom, '1');
    const line = result.components[0] as CostComponentView;
    expect(line.requiredQty).toBe('2');
    expect(line.lineCost).toBeNull();
    expect(line.supplierSkuId).toBeNull();
    expect(line.unitPrice).toBeNull();
    expect(line.currency).toBeNull();
    expect(line.vatIncluded).toBeNull();
    expect(line.provisionalReason).toBe('NO_PRIMARY_SUPPLIER');
    // ⛔ 대표가 없으면 NO_EFFECTIVE_PRICE 를 연쇄로 붙이지 않는다.
    expect(result.provisionalReasons).toEqual(['NO_PRIMARY_SUPPLIER']);
  });

  it('★★ 대표는 있고 승인 가격이 없으면 NO_EFFECTIVE_PRICE 다', async () => {
    const p = await newSku('nep-p');
    const x = await newSku('nep-x');
    const supplier = await newSupplier('nep');
    const supplierSku = await newSupplierSku(supplier, x);
    await newPrice(supplierSku, '999', { approved: false }); // pending → 잡히지 않는다

    const pBom = await newHeader(p, 'NEPP');
    await newLine(pBom, x, { quantityPer: '2' });

    const result = await cost(pBom, '1');
    const line = result.components[0] as CostComponentView;
    expect(line.supplierSkuId).toBe(supplierSku);
    expect(line.unitPrice).toBeNull();
    expect(line.lineCost).toBeNull();
    expect(line.provisionalReason).toBe('NO_EFFECTIVE_PRICE');
  });

  it('★★ 0원 가격은 정상 확정 원가다 — null 과 섞이지 않는다', async () => {
    const p = await newSku('zero-p');
    const x = await priced('zero-x', '0');
    const pBom = await newHeader(p, 'ZEROP');
    await newLine(pBom, x, { quantityPer: '5' });

    const result = await cost(pBom, '1');
    expect(result.components[0]?.lineCost).toBe('0');
    expect(result.components[0]?.provisionalReason).toBeNull();
    expect(result.isProvisional).toBe(false);
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '0' }]);
  });

  it('★★ 소계는 raw 합 후 한 번만 반올림한다 (F-8)', async () => {
    // 두 라인 각각 raw 0.00005 → 각 4dp 후 합이면 0.0002, raw 합 후면 0.0001.
    const p = await newSku('sr-p');
    const x = await priced('sr-x', '0.0001');
    const pBom = await newHeader(p, 'SRP');
    await newLine(pBom, x, { quantityPer: '0.5', uom: 'EA', lineNo: 1 });
    await newLine(pBom, x, { quantityPer: '0.5', uom: 'BOX', lineNo: 2, alternateGroup: 'G2' });

    const result = await cost(pBom, '1');
    expect(result.components.map((row) => row.lineCost)).toEqual(['0.0001', '0.0001']);
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '0.0001' }]);
    expect(result.subtotals[0]?.amount).not.toBe('0.0002');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. 다중 사유 union (R-14·R-15)
// ═══════════════════════════════════════════════════════════════

describe('★★ R-14·R-15 — reason union + 단수 projection', () => {
  it('★★★ 세 사유가 top-level 에 전부 우선순위 순으로 모인다', async () => {
    // X: SUGGESTED + 대표 없음 → [QTY_UNCONFIRMED, NO_PRIMARY_SUPPLIER]
    // Y: CONFIRMED + 대표 + 가격 없음 → [NO_EFFECTIVE_PRICE]
    const p = await newSku('un-p');
    const x = await newSku('un-x');
    const y = await newSku('un-y');
    const supplier = await newSupplier('un-y-sup');
    await newSupplierSku(supplier, y); // 대표는 있고 가격 없음

    const pBom = await newHeader(p, 'UNP');
    await newLine(pBom, x, { quantityPer: '1', quantityStatus: 'SUGGESTED', lineNo: 1 });
    await newLine(pBom, y, { quantityPer: '1', lineNo: 2 });

    const result = await cost(pBom, '1');
    expect(result.provisionalReasons).toEqual([
      'QTY_UNCONFIRMED',
      'NO_PRIMARY_SUPPLIER',
      'NO_EFFECTIVE_PRICE',
    ]);
    expect(bySku(result, x).provisionalReason).toBe('QTY_UNCONFIRMED');
    expect(bySku(result, y).provisionalReason).toBe('NO_EFFECTIVE_PRICE');
    expect(result.isProvisional).toBe(true);
  });

  it('★★ 같은 component 의 여러 occurrence 사유가 union 된다 (R-14)', async () => {
    // 경로 1: CONFIRMED → X   /  경로 2: SUGGESTED → X
    // X 는 대표가 없다 → union = [QTY_UNCONFIRMED, NO_PRIMARY_SUPPLIER]
    const p = await newSku('gu-p');
    const b = await newSku('gu-b');
    const c = await newSku('gu-c');
    const x = await newSku('gu-x'); // 대표 없음

    const pBom = await newHeader(p, 'GUP');
    await newLine(pBom, b, { quantityPer: '1', lineNo: 1 });
    await newLine(pBom, c, { quantityPer: '1', quantityStatus: 'SUGGESTED', lineNo: 2 });
    const bBom = await newHeader(b, 'GUB');
    await newLine(bBom, x, { quantityPer: '1' });
    const cBom = await newHeader(c, 'GUC');
    await newLine(cBom, x, { quantityPer: '1' });

    const result = await cost(pBom, '1');
    expect(result.components).toHaveLength(1);
    // 단수 projection 은 우선순위 최상위 하나다.
    expect(result.components[0]?.provisionalReason).toBe('QTY_UNCONFIRMED');
    // top-level 은 **실제 사유 집합**의 union 이다 — 둘 다 나온다.
    expect(result.provisionalReasons).toEqual(['QTY_UNCONFIRMED', 'NO_PRIMARY_SUPPLIER']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. ★★ CASE H — 다통화 · VAT (R-20 · D-26·D-27)
// ═══════════════════════════════════════════════════════════════

describe('★★ D-26·D-27 — 통화/VAT subtotal 분리', () => {
  it('★★★ CASE H — 반제품 하위가 다통화여도 압축하지 않는다', async () => {
    // B(intermediate) → C1(KRW/false) · C2(USD/true)
    const p = await newSku('h-p');
    const b = await newSku('h-b');
    const c1 = await priced('h-c1', '100');
    const c2 = await priced('h-c2', '3', { currency: 'USD', vatIncluded: true });
    await attachPrice(b, 'h-b-sup', '99999'); // ★ 함정 — 쓰이면 안 된다.

    const pBom = await newHeader(p, 'CASEHP');
    await newLine(pBom, b, { quantityPer: '1' });
    const bBom = await newHeader(b, 'CASEHB');
    await newLine(bBom, c1, { quantityPer: '1', lineNo: 1 });
    await newLine(bBom, c2, { quantityPer: '1', lineNo: 2 });

    const result = await cost(pBom, '1');
    // ★ B 는 없고 C1·C2 의 terminal 사실이 그대로 남는다.
    expect(result.components).toHaveLength(2);
    expect(result.components.map((row) => row.componentSkuId).sort()).toEqual([c1, c2].sort());
    expect(result.subtotals).toEqual([
      { currency: 'KRW', vatIncluded: false, amount: '100' },
      { currency: 'USD', vatIncluded: true, amount: '3' },
    ]);
    // ⛔ 단일 총액(99999·103) 이 어디에도 없다.
    expect(result.subtotals.map((row) => row.amount)).not.toContain('103');
    expect(JSON.stringify(result)).not.toContain('99999');
    expect(result).not.toHaveProperty('totalCost');
  });

  it('★★ VAT 별로도 bucket 이 나뉜다 — 10% 가감 없음', async () => {
    const p = await newSku('vat-p');
    const a = await priced('vat-a', '100', { vatIncluded: false });
    const bIncl = await priced('vat-b', '110', { vatIncluded: true });
    const pBom = await newHeader(p, 'VATP');
    await newLine(pBom, a, { quantityPer: '1', lineNo: 1 });
    await newLine(pBom, bIncl, { quantityPer: '1', lineNo: 2 });

    const result = await cost(pBom, '1');
    expect(result.subtotals).toEqual([
      { currency: 'KRW', vatIncluded: false, amount: '100' },
      { currency: 'KRW', vatIncluded: true, amount: '110' },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. 손상은 provisional 을 이긴다 (R-5)
// ═══════════════════════════════════════════════════════════════

describe('★★ R-5 — 데이터 손상은 409 다 (provisional 로 숨기지 않는다)', () => {
  it('★★ 하위 유효 BOM 이 2건이면 409 BOM_EFFECTIVE_CONFLICT', async () => {
    const client = getPrismaClient();
    const p = await newSku('ec-p');
    const b = await newSku('ec-b');
    const c = await priced('ec-c', '100');
    const pBom = await newHeader(p, 'ECP');
    await newLine(pBom, b, { quantityPer: '1' });

    // ⚠️ EXCLUDE 를 내리고 손상을 심되 **트랜잭션 안에서만** 하고 롤백한다.
    //    ⛔ `client` 로 raw 를 실행하면 트랜잭션 밖 커넥션이라 제약이 **영구
    //       삭제**되어 다른 테스트 파일을 깨뜨린다 — 반드시 `tx` 를 쓴다
    //       (`bom-effective-resolver.test.ts` 와 같은 기법).
    let observed: string | null = null;
    await client
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE bom_header DROP CONSTRAINT bom_header_active_period_excl',
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO bom_header (id, parent_sku_id, bom_type, version, status, output_qty,
                                   output_uom, effective_from, created_at)
           VALUES (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'ecb-1', 'ACTIVE', 1, 'EA',
                   DATE '2020-01-01', now()),
                  (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'ecb-2', 'ACTIVE', 1, 'EA',
                   DATE '2021-01-01', now())`,
          b,
        );

        try {
          await costBom(READER, pBom, { qty: '1', asOf: ASOF }, { db: tx as never });
        } catch (error) {
          observed = (error as { code: string }).code;
        }
        // ⚠️ 반드시 롤백한다 — 제약 삭제와 손상 행이 남으면 안 된다.
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if ((error as Error).message !== 'rollback') throw error;
      });

    expect(observed).toBe(ERROR_CODES.BOM_EFFECTIVE_CONFLICT);
    // ★ 롤백됐으므로 제약이 살아 있다 — 같은 손상을 다시 만들 수 없다.
    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO bom_header (id, parent_sku_id, bom_type, version, status, output_qty,
                                 output_uom, effective_from, created_at)
         VALUES (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'ecb-3', 'ACTIVE', 1, 'EA',
                 DATE '2020-01-01', now()),
                (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'ecb-4', 'ACTIVE', 1, 'EA',
                 DATE '2021-01-01', now())`,
        b,
      ),
    ).rejects.toThrow();
    // c 는 이 테스트에서 손상 BOM 의 구성품 역할만 한다.
    expect(c).toBeDefined();
  });

  it('★★ terminal 의 대표 공급조건이 2건이면 409', async () => {
    const client = getPrismaClient();
    const p = await newSku('sc-p');
    const x = await newSku('sc-x');
    const pBom = await newHeader(p, 'SCP');
    await newLine(pBom, x, { quantityPer: '1' });

    const s1 = await newSupplier('sc-1');
    const s2 = await newSupplier('sc-2');
    await client.supplierSku.create({
      data: {
        supplierId: s1,
        skuId: x,
        isPrimary: true,
        effectiveFrom: parseDateOnly('2020-01-01'),
        effectiveTo: parseDateOnly('2027-01-01'),
        currency: 'KRW',
      },
    });
    await client.supplierSku.create({
      data: {
        supplierId: s2,
        skuId: x,
        isPrimary: true,
        effectiveFrom: parseDateOnly('2021-01-01'),
        effectiveTo: parseDateOnly('2028-01-01'),
        currency: 'KRW',
      },
    });

    expect(await codeOf(cost(pBom, '1'))).toBe(ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT);
  });

  it('★★★ 수량이 UNKNOWN 이어도 가격 손상 409 를 건너뛰지 않는다', async () => {
    // "어차피 원가 null" 이라고 resolver 를 skip 하면 손상이 숨는다.
    const p = await newSku('skip-p');
    const x = await newSku('skip-x');
    const supplier = await newSupplier('skip');
    const supplierSku = await newSupplierSku(supplier, x);
    await newPrice(supplierSku, '10', { effectiveFrom: '2020-01-01', effectiveTo: '2027-01-01' });
    await newPrice(supplierSku, '20', { effectiveFrom: '2021-01-01', effectiveTo: '2028-01-01' });

    const pBom = await newHeader(p, 'SKIPP');
    await newLine(pBom, x, { quantityPer: null, quantityStatus: 'UNKNOWN' });

    expect(await codeOf(cost(pBom, '1'))).toBe(ERROR_CODES.SUPPLIER_PRICE_CHAIN_CONFLICT);
  });

  it('★★ 순환은 422 BOM_CYCLE_DETECTED', async () => {
    const p = await newSku('cyc-p');
    const b = await newSku('cyc-b');
    const pBom = await newHeader(p, 'CYCP');
    await newLine(pBom, b, { quantityPer: '1' });
    const bBom = await newHeader(b, 'CYCB');
    await newLine(bBom, p, { quantityPer: '1' });

    expect(await codeOf(cost(pBom, '1'))).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);
  });

  it('★★ 없는 BOM 은 404 다', async () => {
    expect(await codeOf(cost('99999999-9999-4999-8999-999999999999'))).toBe(
      ERROR_CODES.BOM_NOT_FOUND,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. root · exact response (R-23 G1·G11)
// ═══════════════════════════════════════════════════════════════

describe('★★ root 는 요청한 exact header 다 (G11)', () => {
  it('★★ 같은 SKU 에 asOf 유효한 다른 ACTIVE 버전이 있어도 재선택하지 않는다', async () => {
    const p = await newSku('rt-p');
    const cheap = await priced('rt-cheap', '10');
    const pricey = await priced('rt-pricey', '900');

    const v1 = await newHeader(p, 'RTV1', { effectiveTo: '2027-01-01' });
    await newLine(v1, cheap, { quantityPer: '1' });
    // 같은 parent 의 다른 버전 — asOf 에 유효하지 않게 미래로 둔다.
    const v2 = await newHeader(p, 'RTV2', { effectiveFrom: '2027-01-01' });
    await newLine(v2, pricey, { quantityPer: '1' });

    // v2 를 직접 요청하면 v2 가 root 다 — 적용기간과 무관하다.
    const result = await cost(v2, '1');
    expect(result.bomId).toBe(v2);
    expect(result.components[0]?.componentSkuId).toBe(pricey);
  });

  it('★★ BomStatus 7종 전부 원가가 나온다 — root status 제한 없음', async () => {
    const ALL = [
      'DRAFT',
      'PENDING_APPROVAL',
      'REJECTED',
      'APPROVED',
      'ACTIVE',
      'INACTIVE',
      'ARCHIVED',
    ];
    expect(ALL).toHaveLength(7);
    for (const status of ALL) {
      const p = await newSku(`st-${status}`);
      const x = await priced(`stc-${status}`, '100');
      const bom = await newHeader(p, `ST${status.slice(0, 3)}`, { status });
      await newLine(bom, x, { quantityPer: '2' });

      const result = await cost(bom, '1');
      expect(result.components[0]?.lineCost, status).toBe('200');
    }
  });
});

describe('★★ G1 — CostResult exact keys', () => {
  it('★★★ top-level 은 정확히 8키다 (requestId 는 route 가 붙인다)', async () => {
    const p = await newSku('key-p');
    const x = await priced('key-x', '100');
    const bom = await newHeader(p, 'KEYP');
    await newLine(bom, x, { quantityPer: '1' });

    const result = await cost(bom, '1');
    expect(Object.keys(result).sort()).toEqual(
      [
        'bomId',
        'parentSkuId',
        'asOf',
        'requestedQty',
        'isProvisional',
        'provisionalReasons',
        'components',
        'subtotals',
      ].sort(),
    );
    // ⛔ 단일 총액 없음 · ⛔ 내부값 없음.
    for (const forbidden of ['totalCost', 'nodes', 'lines', 'rawLineCost', 'maxLevel']) {
      expect(result, forbidden).not.toHaveProperty(forbidden);
    }
    expect(result.asOf).toBe(ASOF);
    expect(result.requestedQty).toBe('1');
  });

  it('★★★ component 는 정확히 11키 · componentSku 는 3키다', async () => {
    const p = await newSku('ck-p');
    const x = await priced('ck-x', '100');
    const bom = await newHeader(p, 'CKP');
    await newLine(bom, x, { quantityPer: '1' });

    const result = await cost(bom, '1');
    const line = result.components[0] as CostComponentView;
    expect(Object.keys(line).sort()).toEqual(
      [
        'componentSkuId',
        'componentSku',
        'level',
        'requiredQty',
        'uom',
        'supplierSkuId',
        'unitPrice',
        'currency',
        'vatIncluded',
        'lineCost',
        'provisionalReason',
      ].sort(),
    );
    // ★ componentSku 는 3키 — ExplodedNode 와 달리 baseUom 이 없다.
    expect(Object.keys(line.componentSku).sort()).toEqual(['id', 'skuCode', 'skuName']);
    // ⛔ 라인 사실·경로·내부값을 노출하지 않는다.
    for (const forbidden of [
      'bomLineId',
      'lineNo',
      'bomHeaderId',
      'componentRole',
      'quantityStatus',
      'quantityPer',
      'lossRate',
      'path',
      'isLeaf',
      'provisionalReasons',
    ]) {
      expect(line, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it('★ subtotal 은 정확히 3키다', async () => {
    const p = await newSku('sk-p');
    const x = await priced('sk-x', '100');
    const bom = await newHeader(p, 'SKP');
    await newLine(bom, x, { quantityPer: '1' });

    const result = await cost(bom, '1');
    expect(Object.keys(result.subtotals[0] as object).sort()).toEqual([
      'amount',
      'currency',
      'vatIncluded',
    ]);
  });

  it('★ 라인이 0건이면 빈 결과다 — 오류가 아니다', async () => {
    const p = await newSku('empty-p');
    const bom = await newHeader(p, 'EMPTYP');
    const result = await cost(bom, '1');
    expect(result.components).toEqual([]);
    expect(result.subtotals).toEqual([]);
    expect(result.isProvisional).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. 정렬 결정성 (R-18)
// ═══════════════════════════════════════════════════════════════

describe('★★ R-18 — components 정렬은 결정적이다', () => {
  it('★★★ 역순으로 넣어도 level → skuCode 순서가 같다', async () => {
    const p = await newSku('ord-p');
    const mid = await newSku('ord-mid');
    // skuCode 를 명시해 정렬을 판별 가능하게 만든다.
    const aa = await newSkuWithCode('ZORD-AA', 'ord-aa');
    const bb = await newSkuWithCode('ZORD-BB', 'ord-bb');
    const cc = await newSkuWithCode('ZORD-CC', 'ord-cc');
    for (const [sku, label] of [
      [aa, 'aa'],
      [bb, 'bb'],
      [cc, 'cc'],
    ] as const) {
      await attachPrice(sku, `ord-${label}`, '10');
    }

    const pBom = await newHeader(p, 'ORDP');
    // 일부러 역순 lineNo 로 넣는다 — level 1 에 CC, BB.
    await newLine(pBom, cc, { quantityPer: '1', lineNo: 1 });
    await newLine(pBom, bb, { quantityPer: '1', lineNo: 2 });
    await newLine(pBom, mid, { quantityPer: '1', lineNo: 3 });
    const midBom = await newHeader(mid, 'ORDM');
    await newLine(midBom, aa, { quantityPer: '1' }); // level 2

    const result = await cost(pBom, '1');
    // level 1(BB, CC) 이 먼저, 그 안에서 skuCode ASC. level 2(AA) 가 뒤.
    expect(result.components.map((row) => row.componentSku.skuCode)).toEqual([
      CODE('ZORD-BB'),
      CODE('ZORD-CC'),
      CODE('ZORD-AA'),
    ]);
    expect(result.components.map((row) => row.level)).toEqual([1, 1, 2]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. 권한 · read-only · N+1 (D-15 · R-23 §23·§25)
// ═══════════════════════════════════════════════════════════════

describe('★★ D-15 — 권한', () => {
  it('★★ ADMIN role 이어도 permission 이 없으면 403 이다 (bypass 부재)', async () => {
    const p = await newSku('perm-p');
    const bom = await newHeader(p, 'PERMP');
    expect(await codeOf(costBom(NO_PERMISSION, bom, { qty: '1', asOf: ASOF }))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it('★★ EXECUTIVE 도 bom.read 로 원가를 읽는다', async () => {
    const p = await newSku('exec-p');
    const x = await priced('exec-x', '100');
    const bom = await newHeader(p, 'EXECP');
    await newLine(bom, x, { quantityPer: '1' });

    const result = await costBom(EXECUTIVE, bom, { qty: '1', asOf: ASOF });
    expect(result.components[0]?.lineCost).toBe('100');
  });

  it('★★ supplier 계열 permission 이 없어도 원가를 읽는다', async () => {
    const onlyBomRead = actor(
      'fff00000-0000-4000-8000-0000000e7b05',
      ['SCM_STAFF'],
      [BOM_READ_PERMISSION],
    );
    const p = await newSku('sp-p');
    const x = await priced('sp-x', '100');
    const bom = await newHeader(p, 'SPP');
    await newLine(bom, x, { quantityPer: '1' });

    const result = await costBom(onlyBomRead, bom, { qty: '1', asOf: ASOF });
    expect(result.components[0]?.unitPrice).toBe('100');
  });
});

describe('★★ read-only · batch', () => {
  it('★★ 원가 조회는 DB 를 바꾸지 않는다', async () => {
    const client = getPrismaClient();
    const p = await newSku('ro-p');
    const b = await newSku('ro-b');
    const c = await priced('ro-c', '100');
    const pBom = await newHeader(p, 'ROP');
    await newLine(pBom, b, { quantityPer: '1' });
    const bBom = await newHeader(b, 'ROB');
    await newLine(bBom, c, { quantityPer: '1' });

    const before = {
      headers: await client.bomHeader.count(),
      lines: await client.bomLine.count(),
      supplierSkus: await client.supplierSku.count(),
      prices: await client.supplierSkuPrice.count(),
      audits: await client.auditLog.count(),
    };
    await cost(pBom, '1');
    expect({
      headers: await client.bomHeader.count(),
      lines: await client.bomLine.count(),
      supplierSkus: await client.supplierSku.count(),
      prices: await client.supplierSkuPrice.count(),
      audits: await client.auditLog.count(),
    }).toEqual(before);
  });

  it('★★★ node 가 늘어도 supplier·price 쿼리는 각 1회다 (N+1 부재)', async () => {
    const client = getPrismaClient();
    const p = await newSku('n1-p');
    const pBom = await newHeader(p, 'N1P');

    // level 1 에 intermediate 5개, 각 아래 terminal 2개 = terminal 10 occurrence.
    for (let i = 0; i < 5; i += 1) {
      const mid = await newSku(`n1-m${String(i)}`);
      await newLine(pBom, mid, { quantityPer: '1', lineNo: i + 1 });
      const midBom = await newHeader(mid, `N1M${String(i)}`);
      for (let j = 0; j < 2; j += 1) {
        const leaf = await priced(`n1-l${String(i)}${String(j)}`, '10');
        await newLine(midBom, leaf, { quantityPer: '1', lineNo: j + 1 });
      }
    }

    const calls: string[] = [];
    const spy = {
      bomHeader: {
        findUnique: (...args: unknown[]) => {
          calls.push('header');
          return (client.bomHeader.findUnique as never as (...a: unknown[]) => unknown)(...args);
        },
        // ★ `resolveEffectiveBoms` 가 쓰는 batch — level 당 1회여야 한다.
        findMany: (...args: unknown[]) => {
          calls.push('effectiveBom');
          return (client.bomHeader.findMany as never as (...a: unknown[]) => unknown)(...args);
        },
      },
      bomLine: {
        findMany: (...args: unknown[]) => {
          calls.push('lines');
          return (client.bomLine.findMany as never as (...a: unknown[]) => unknown)(...args);
        },
      },
      supplierSku: {
        findMany: (...args: unknown[]) => {
          calls.push('supplierSku');
          return (client.supplierSku.findMany as never as (...a: unknown[]) => unknown)(...args);
        },
      },
      supplierSkuPrice: {
        findMany: (...args: unknown[]) => {
          calls.push('price');
          return (client.supplierSkuPrice.findMany as never as (...a: unknown[]) => unknown)(
            ...args,
          );
        },
      },
    };

    const result = await costBom(
      READER,
      pBom,
      { qty: '1', asOf: ASOF },
      {
        db: spy as never,
      },
    );

    expect(result.components).toHaveLength(10);
    // ★ header 1 · level 2개이므로 lines 2 · supplier 1 · price 1.
    expect(calls.filter((name) => name === 'header')).toHaveLength(1);
    expect(calls.filter((name) => name === 'supplierSku')).toHaveLength(1);
    expect(calls.filter((name) => name === 'price')).toHaveLength(1);
    // ⛔ terminal 10개인데 lines 가 10회면 N+1 이다.
    expect(calls.filter((name) => name === 'lines')).toHaveLength(2);
    // ★ 유효 BOM resolver 도 level 당 1회다 — node 15개와 무관하다.
    expect(calls.filter((name) => name === 'effectiveBom')).toHaveLength(2);
    // 전체 쿼리 = header 1 + (lines + effectiveBom) × 2 level + supplier 1 + price 1 = 7
    expect(calls).toHaveLength(7);
  });

  it('★★ maxLevel 초과는 422 다 — 조용히 절단하지 않는다', async () => {
    // 11 level 짜리 사슬을 만든다 (BOM_MAX_LEVEL = 10).
    const skus: string[] = [];
    for (let i = 0; i <= 11; i += 1) skus.push(await newSku(`ml-${String(i)}`));
    for (let i = 0; i < 11; i += 1) {
      const header = await newHeader(skus[i] as string, `ML${String(i)}`);
      await newLine(header, skus[i + 1] as string, { quantityPer: '1' });
    }
    const rootHeader = await getPrismaClient().bomHeader.findFirst({
      where: { parentSkuId: skus[0] as string },
      select: { id: true },
    });

    expect(await codeOf(cost(rootHeader?.id as string, '1'))).toBe(
      ERROR_CODES.BOM_MAX_LEVEL_EXCEEDED,
    );
  });
});
