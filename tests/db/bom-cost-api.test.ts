import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  costDirectBom,
  parseDateOnly,
  BOM_READ_PERMISSION,
  type DirectCostLine,
} from '@/modules/bom/application';
import { resolvePrimarySupplierSkus } from '@/modules/supplier/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * BOM direct-line 원가 DB 통합 테스트 (T07-7A) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-19 · §D-23 · §D-24 · §D-25 · §D-26 ·
 *    §D-27 · §D-15 ·
 *    `★ T07-7A cost boundary and quantity gap closure`(C-1 ~ C-9) ·
 *    `★ T07-7A direct cost arithmetic gap closure`(F-1 ~ F-11).
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - 대표 SupplierSku **0 / 1 / 2+** — 특히 historical asOf 의 2건 손상
 *   - `Supplier.status` 로 거르지 않음
 *   - 기존 price resolver 재사용 — pending 제외 · 0원 · chain 2건 409
 *   - 수량이 미확정이어도 selection·손상 검사를 건너뛰지 않음
 *   - direct line 만 본다 (하위 BOM 미전개)
 *   - N+1 부재 — supplier·price 각 batch 1회
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TCS-${RUN}-${suffix}`;

const READER_ID = 'fff00000-0000-4000-8000-0000000e7001';
const NOPERM_ID = 'fff00000-0000-4000-8000-0000000e7002';
const APPROVER_ID = 'fff00000-0000-4000-8000-0000000e7003';
const ACTOR_IDS = [READER_ID, NOPERM_ID, APPROVER_ID];

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
const EXECUTIVE = actor(
  'fff00000-0000-4000-8000-0000000e7004',
  ['EXECUTIVE'],
  [BOM_READ_PERMISSION],
);
/** ADMIN role 이지만 permission 데이터가 없다 — bypass 부재 증명. */
const NO_PERMISSION = actor(NOPERM_ID, ['ADMIN'], []);

const ASOF = parseDateOnly('2026-06-01');

let seq = 0;

async function newSku(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `원가 SKU (${label})`,
      itemType: 'FINISHED_GOOD',
      status: 'ACTIVE',
      baseUom: 'EA',
    },
    select: { id: true },
  });
  return row.id;
}

async function newSupplier(label: string, status = 'ACTIVE'): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().supplier.create({
    data: {
      supplierCode: CODE(`S${String(seq).padStart(3, '0')}`),
      supplierName: `원가 거래처 (${label})`,
      supplierType: 'MANUFACTURER',
      status: status as 'ACTIVE',
    },
    select: { id: true },
  });
  return row.id;
}

interface SupplierSkuOptions {
  readonly isPrimary?: boolean;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly purchaseUom?: string | null;
  readonly currency?: string;
}

async function newSupplierSku(
  supplierId: string,
  skuId: string,
  options: SupplierSkuOptions = {},
): Promise<string> {
  const row = await getPrismaClient().supplierSku.create({
    data: {
      supplierId,
      skuId,
      isPrimary: options.isPrimary ?? true,
      effectiveFrom: parseDateOnly(options.effectiveFrom ?? '2020-01-01'),
      effectiveTo:
        options.effectiveTo === undefined || options.effectiveTo === null
          ? null
          : parseDateOnly(options.effectiveTo),
      purchaseUom: options.purchaseUom ?? null,
      currency: options.currency ?? 'KRW',
    },
    select: { id: true },
  });
  return row.id;
}

interface PriceOptions {
  readonly approved?: boolean;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly currency?: string;
  readonly vatIncluded?: boolean;
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
      // ★ 승인 상태는 `approvedBy IS NOT NULL` 하나로 표현된다 — approvedAt 컬럼이 없다.
      ...(approved ? { approvedBy: APPROVER_ID } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

interface HeaderOptions {
  readonly outputQty?: string;
  readonly overallLossRate?: string | null;
  readonly status?: string;
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
      effectiveFrom: parseDateOnly('2020-01-01'),
    },
    select: { id: true },
  });
  return row.id;
}

interface LineOptions {
  readonly quantityPer?: string | null;
  readonly quantityStatus?: string;
  readonly lossRate?: string | null;
  readonly componentRole?: string;
  readonly isRequired?: boolean;
  readonly lineNo?: number;
  readonly alternateGroup?: string | null;
  readonly supplyType?: string | null;
  readonly packQuantity?: string | null;
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
      uom: 'EA',
      lossRate: options.lossRate ?? null,
      componentRole: (options.componentRole ?? 'MATERIAL') as 'MATERIAL',
      isRequired: options.isRequired ?? true,
      alternateGroup: options.alternateGroup ?? null,
      supplyType: (options.supplyType ?? null) as null,
      packQuantity: options.packQuantity ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/** 대표 공급조건 + 승인 가격이 붙은 구성품 하나를 만든다. */
async function pricedComponent(
  label: string,
  unitPrice: string,
  priceOptions: PriceOptions = {},
): Promise<string> {
  const sku = await newSku(label);
  const supplier = await newSupplier(label);
  const supplierSku = await newSupplierSku(supplier, sku);
  await newPrice(supplierSku, unitPrice, priceOptions);
  return sku;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('예외가 발생하지 않았다');
}

const cost = (bomId: string, requestedQty = '1', asOf: Date = ASOF) =>
  costDirectBom(READER, bomId, { requestedQty, asOf });

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.supplierSkuPrice.deleteMany({
    where: { supplierSku: { sku: { skuCode: { startsWith: 'TCS-' } } } },
  });
  await client.supplierSku.deleteMany({ where: { sku: { skuCode: { startsWith: 'TCS-' } } } });
  await client.supplierSku.deleteMany({
    where: { supplier: { supplierCode: { startsWith: 'TCS-' } } },
  });
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TCS-' } } } },
  });
  await client.bomLine.deleteMany({ where: { componentSku: { skuCode: { startsWith: 'TCS-' } } } });
  await client.bomHeader.deleteMany({
    where: { parentSku: { skuCode: { startsWith: 'TCS-' } } },
  });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TCS-' } } });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TCS-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: '원가 테스트' })),
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 1. 기본 direct-line 원가
// ═══════════════════════════════════════════════════════════════

describe('★★ direct line 원가 (D-19 · F-1)', () => {
  it('★★ Q / outputQty 스케일이 적용된다 — 문서 예시 A', async () => {
    // Q=10, outputQty=5, quantityPer=2 → requiredQty 4, unitPrice 2500 → 10000
    const parent = await newSku('ex-a-p');
    const component = await pricedComponent('ex-a-c', '2500');
    const bom = await newHeader(parent, 'EXA', { outputQty: '5' });
    await newLine(bom, component, { quantityPer: '2' });

    const result = await cost(bom, '10');
    expect(result.requestedQty).toBe('10');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.requiredQty).toBe('4');
    expect(result.lines[0]?.lineCost).toBe('10000');
    // ⛔ Q 를 outputQty(5)로 치환하면 requiredQty 2 · lineCost 5000 이 되어 틀린다.
    expect(result.lines[0]?.lineCost).not.toBe('5000');
  });

  it('★★ 손실률 두 개가 각각 곱해진다', async () => {
    const parent = await newSku('loss-p');
    const component = await pricedComponent('loss-c', '100');
    const bom = await newHeader(parent, 'LOSS', { overallLossRate: '0.2' });
    await newLine(bom, component, { quantityPer: '1', lossRate: '0.1' });

    const result = await cost(bom, '10');
    // 10 × 1 × 1.1 × 1.2 = 13.2 → × 100 = 1320
    expect(result.lines[0]?.requiredQty).toBe('13.2');
    expect(result.lines[0]?.lineCost).toBe('1320');
  });

  it('★★ 금액은 4dp HALF_UP minimal form 이다 — trailing zero 없음', async () => {
    const parent = await newSku('round-p');
    const component = await pricedComponent('round-c', '3');
    const bom = await newHeader(parent, 'RND');
    await newLine(bom, component, { quantityPer: '2' });

    const result = await cost(bom, '1');
    expect(result.lines[0]?.lineCost).toBe('6');
  });

  it('★★ raw 소요량으로 곱한다 — 6dp 표시값을 되쓰지 않는다 (F-1)', async () => {
    // outputQty=3, quantityPer=1, Q=1 → raw 1/3, public "0.333333"
    // unitPrice 3000000 → raw 경로 1000000 · 표시값 경로 999999
    const parent = await newSku('raw-p');
    const component = await pricedComponent('raw-c', '3000000');
    const bom = await newHeader(parent, 'RAW', { outputQty: '3' });
    await newLine(bom, component, { quantityPer: '1' });

    const result = await cost(bom, '1');
    expect(result.lines[0]?.requiredQty).toBe('0.333333');
    expect(result.lines[0]?.lineCost).toBe('1000000');
    expect(result.lines[0]?.lineCost).not.toBe('999999');
  });

  // ═════════════════════════════════════════════════════════════
  // ★ TC-BOM-009 — backlog T07-7 완료조건 "박스 단가 = 가격 ÷ 입수량"
  //
  // Recovery(D-19)가 이 문구의 구현 의미를 확정했다.
  //   ⛔ `unitPrice / packQuantity` 라는 별도 계산을 만들지 않는다.
  //   ★ `quantityPer` 가 이미 입수량 효과를 표현하므로
  //     `rawRequiredQty × unitPrice` 하나만으로 박스 단가 효과가 나와야 한다.
  //   ★ `packQuantity` 는 원가 산술의 operand 가 아니다.
  // ═════════════════════════════════════════════════════════════

  it('★★ TC-BOM-009 — exact division: 입수 20 · quantityPer 0.05 · 30000원 → "1500"', async () => {
    // 박스 30000원 / 입수량 20 = 개당 1500원.
    // 20 은 나누어떨어지므로 precision 논쟁이 전혀 없는 fixture 다.
    const parent = await newSku('tc009-exact-p');
    const component = await pricedComponent('tc009-exact-c', '30000');
    const bom = await newHeader(parent, 'TC9EX', { outputQty: '1' });
    await newLine(bom, component, { quantityPer: '0.05', packQuantity: '20' });

    const result = await cost(bom, '1');

    expect(result.lines[0]?.requiredQty).toBe('0.05');
    // ★ 1500 이 나오는 이유는 **quantityPer = 0.05** 이기 때문이다.
    //   production 어디에도 30000 / 20 을 계산하는 코드가 없다.
    expect(result.lines[0]?.lineCost).toBe('1500');
    // ⛔ packQuantity 로 한 번 더 나눴다면 75 였을 것이다 (이중 환산).
    expect(result.lines[0]?.lineCost).not.toBe('75');
    // packQuantity 는 계산에 들어가지 않는다 — 라인 metadata 로도 노출하지 않는다.
    expect(JSON.stringify(result.lines[0])).not.toContain('packQuantity');
  });

  it('★★ TC-BOM-009 companion — 입수 30 · 0.033333 × 30000 = "999.99" · ⛔ 1000 재정규화 금지', async () => {
    // 30 은 나누어떨어지지 않는다. 저장된 quantityPer 0.033333 을 그대로 쓴다.
    const parent = await newSku('tc009-30-p');
    const component = await pricedComponent('tc009-30-c', '30000');
    const bom = await newHeader(parent, 'TC9NT', { outputQty: '1' });
    await newLine(bom, component, { quantityPer: '0.033333', packQuantity: '30' });

    const result = await cost(bom, '1');

    expect(result.lines[0]?.requiredQty).toBe('0.033333');
    expect(result.lines[0]?.lineCost).toBe('999.99');
    // ⛔ backlog 의 "가격 ÷ 입수량" 문구를 이유로 0.033333 을 정확한 1/30 으로
    //    되돌리는 보정 금지 — 그랬다면 정확히 1000 이 나왔을 것이다 (D-19).
    expect(result.lines[0]?.lineCost).not.toBe('1000');
    // ⛔ packQuantity 로 다시 나누는 것도 금지 — 그랬다면 33.333 이었을 것이다.
    expect(result.lines[0]?.lineCost).not.toBe('33.333');
  });

  it('★★ TC-BOM-009 — packQuantity independence: 20 → 200 이어도 lineCost 가 동일하다', async () => {
    // quantityPer · unitPrice · Q · outputQty 를 전부 고정하고 packQuantity 만 바꾼다.
    const parent = await newSku('tc009-ind-p');
    const componentA = await pricedComponent('tc009-ind-a', '30000');
    const componentB = await pricedComponent('tc009-ind-b', '30000');
    const bom = await newHeader(parent, 'TC9IND', { outputQty: '1' });
    await newLine(bom, componentA, { quantityPer: '0.05', packQuantity: '20', lineNo: 1 });
    await newLine(bom, componentB, { quantityPer: '0.05', packQuantity: '200', lineNo: 2 });

    const result = await cost(bom, '1');

    expect(result.lines).toHaveLength(2);
    // ★ packQuantity 20 과 200 이 **완전히 같은 값**을 낸다.
    expect(result.lines[0]?.lineCost).toBe('1500');
    expect(result.lines[1]?.lineCost).toBe('1500');
    expect(result.lines[0]?.lineCost).toBe(result.lines[1]?.lineCost);
    // ★ packQuantity 가 operand 였다면 200 쪽이 150 이 되어 갈렸을 것이다.
    expect(result.lines[1]?.lineCost).not.toBe('150');
    // 소계도 단순 합이다 — 입수량으로 보정되지 않는다.
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '3000' }]);
  });

  it('★★ packQuantity 는 계산에 쓰이지 않는다 — Q=30 회귀', async () => {
    // 박스 30000원 / 입수량 30 → 개당 1000원. quantityPer 가 이미 1/30 을 담는다.
    const parent = await newSku('pack-p');
    const component = await pricedComponent('pack-c', '30000');
    const bom = await newHeader(parent, 'PACK');
    await newLine(bom, component, { quantityPer: '0.033333', packQuantity: '30' });

    const result = await cost(bom, '30');
    // 30 × 0.033333 = 0.99999 → × 30000 = 29999.7
    expect(result.lines[0]?.requiredQty).toBe('0.99999');
    expect(result.lines[0]?.lineCost).toBe('29999.7');
    // ⛔ 별도로 30000/30 을 먼저 만들면 999.99 가 되어 이중 환산이다.
    expect(result.lines[0]?.lineCost).not.toBe('999.99');
    // ⛔ 0.99999 를 1 로 재정규화하면 30000 이 된다 — 하지 않는다 (D-19).
    expect(result.lines[0]?.lineCost).not.toBe('30000');
  });

  it('★★ purchaseUom 은 무시된다 — BOX 라고 환산하지 않는다', async () => {
    const sku = await newSku('uom-c');
    const supplier = await newSupplier('uom');
    const supplierSku = await newSupplierSku(supplier, sku, { purchaseUom: 'BOX' });
    await newPrice(supplierSku, '1000');
    const parent = await newSku('uom-p');
    const bom = await newHeader(parent, 'UOM');
    await newLine(bom, sku, { quantityPer: '2' });

    const result = await cost(bom, '1');
    expect(result.lines[0]?.lineCost).toBe('2000');
    expect(result.lines[0]?.uom).toBe('EA');
  });

  it('★ 라인이 0건이면 빈 결과다 — 오류가 아니다', async () => {
    const parent = await newSku('empty-p');
    const bom = await newHeader(parent, 'EMPTY');
    const result = await cost(bom);
    expect(result.lines).toEqual([]);
    expect(result.subtotals).toEqual([]);
    expect(result.isProvisional).toBe(false);
  });

  it('★ 없는 BOM 은 404 다', async () => {
    expect(await codeOf(cost('11111111-1111-4111-8111-111111111111'))).toBe(
      ERROR_CODES.BOM_NOT_FOUND,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. direct line only (C-2)
// ═══════════════════════════════════════════════════════════════

describe('★★ C-2 — direct line 만 본다', () => {
  it('★★ 구성품에 ACTIVE BOM 이 있어도 펼치지 않는다 — 그 SKU 자체로 값을 매긴다', async () => {
    // P → B,  B 에 ACTIVE BOM (B → C). T07-7A 는 P → B 까지만.
    const parent = await newSku('dl-p');
    const semi = await pricedComponent('dl-b', '5000');
    const deep = await pricedComponent('dl-c', '999');
    const bom = await newHeader(parent, 'DL');
    await newLine(bom, semi, { quantityPer: '2' });
    // 반제품의 하위 BOM — 존재하지만 T07-7A 가 따라가면 안 된다.
    const semiBom = await newHeader(semi, 'DL-B');
    await newLine(semiBom, deep, { quantityPer: '7' });

    const result = await cost(bom, '1');
    // ★ 라인은 1개뿐 — C 가 등장하지 않는다.
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.componentSkuId).toBe(semi);
    // ★ 반제품 자신의 가격으로 계산한다 — 하위 원가로 대체하지 않는다.
    expect(result.lines[0]?.lineCost).toBe('10000');
    expect(result.lines.map((line) => line.componentSkuId)).not.toContain(deep);
  });

  it('★ 결과 정렬은 lineNo 순이다 — 삽입 순서에 의존하지 않는다', async () => {
    const parent = await newSku('ord-p');
    const first = await pricedComponent('ord-1', '10');
    const second = await pricedComponent('ord-2', '20');
    const bom = await newHeader(parent, 'ORD');
    // ⚠️ 역순 삽입.
    await newLine(bom, second, { lineNo: 2 });
    await newLine(bom, first, { lineNo: 1 });

    const result = await cost(bom, '1');
    expect(result.lines.map((line) => line.componentSkuId)).toEqual([first, second]);
  });

  it('★★ 같은 구성품이 여러 라인이면 각각 유지된다 — D-20 집계 없음 (C-6)', async () => {
    const parent = await newSku('dup-p');
    const component = await pricedComponent('dup-c', '100');
    const bom = await newHeader(parent, 'DUP');
    await newLine(bom, component, { quantityPer: '2', alternateGroup: null, lineNo: 1 });
    await newLine(bom, component, { quantityPer: '5', alternateGroup: 'ALT-B', lineNo: 2 });

    const result = await cost(bom, '1');
    // ⛔ (componentSkuId, uom) 으로 접지 않는다.
    expect(result.lines).toHaveLength(2);
    expect(result.lines.map((line) => line.lineCost)).toEqual(['200', '500']);
    // subtotal 은 monetary grouping 이므로 합쳐진다 — 이것은 D-20 집계가 아니다.
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '700' }]);
  });

  // ⚠️ 여기의 "7종" 은 **`BomStatus`** 7종이다. `QuantityStatus` 는
  //    `CONFIRMED / SUGGESTED / UNKNOWN` **3종**이며 그쪽 매트릭스는 아래
  //    provisional 섹션이 따로 본다. 두 enum 을 혼동하지 않는다.
  it('★★ root BomStatus 로 거르지 않는다 — BomStatus 7종 전부 원가가 나온다', async () => {
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
      const parent = await newSku(`st-${status}-p`);
      const component = await pricedComponent(`st-${status}-c`, '100');
      const bom = await newHeader(parent, `ST${status.slice(0, 3)}`, { status });
      await newLine(bom, component, { quantityPer: '2' });

      const result = await cost(bom, '1');
      expect(result.lines[0]?.lineCost, status).toBe('200');
    }
  });

  it('★★ SERVICE 라인도 원가 대상이다 — 자동 제외하지 않는다', async () => {
    const parent = await newSku('svc-p');
    const service = await pricedComponent('svc-c', '464');
    const bom = await newHeader(parent, 'SVC');
    await newLine(bom, service, { quantityPer: '1', componentRole: 'SERVICE' });

    const result = await cost(bom, '1');
    expect(result.lines[0]?.componentRole).toBe('SERVICE');
    expect(result.lines[0]?.lineCost).toBe('464');
  });

  it('★★ supplyType·alternateGroup 으로 분기하지 않는다', async () => {
    const parent = await newSku('flt-p');
    const turnkey = await pricedComponent('flt-t', '300');
    const selfSupplied = await pricedComponent('flt-s', '400');
    const bom = await newHeader(parent, 'FLT');
    await newLine(bom, turnkey, { supplyType: 'TURNKEY', alternateGroup: 'G1', lineNo: 1 });
    await newLine(bom, selfSupplied, { supplyType: 'SELF_SUPPLIED', lineNo: 2 });

    const result = await cost(bom, '1');
    expect(result.lines.map((line) => line.lineCost)).toEqual(['300', '400']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. 대표 SupplierSku 선택 (D-23)
// ═══════════════════════════════════════════════════════════════

describe('★★ 대표 SupplierSku 0 / 1 / 2+ (D-23)', () => {
  it('★ 대표 1건이면 선택된다', async () => {
    const parent = await newSku('p1-p');
    const component = await pricedComponent('p1-c', '100');
    const bom = await newHeader(parent, 'P1');
    await newLine(bom, component);

    const result = await cost(bom, '1');
    expect(result.lines[0]?.supplierSkuId).not.toBeNull();
    expect(result.lines[0]?.provisionalReasons).toEqual([]);
  });

  it('★★ 비대표가 여러 건 있어도 대표만 고른다 — 최저가 선택 없음', async () => {
    const sku = await newSku('p2-c');
    const cheap = await newSupplier('p2-cheap');
    const primary = await newSupplier('p2-primary');
    await newSupplierSku(cheap, sku, { isPrimary: false }).then((id) => newPrice(id, '1'));
    const primarySku = await newSupplierSku(primary, sku, { isPrimary: true });
    await newPrice(primarySku, '9999');

    const parent = await newSku('p2-p');
    const bom = await newHeader(parent, 'P2');
    await newLine(bom, sku);

    const result = await cost(bom, '1');
    expect(result.lines[0]?.supplierSkuId).toBe(primarySku);
    // ⛔ 최저가(1)를 고르지 않는다.
    expect(result.lines[0]?.lineCost).toBe('9999');
  });

  it('★★ 대표 0건이면 NO_PRIMARY_SUPPLIER 이고 lineCost 는 null 이다 — 0 아님', async () => {
    const parent = await newSku('p0-p');
    const orphan = await newSku('p0-c');
    const bom = await newHeader(parent, 'P0');
    await newLine(bom, orphan, { quantityPer: '3' });

    const result = await cost(bom, '1');
    const line = result.lines[0] as DirectCostLine;
    expect(line.supplierSkuId).toBeNull();
    expect(line.unitPrice).toBeNull();
    expect(line.currency).toBeNull();
    expect(line.vatIncluded).toBeNull();
    expect(line.lineCost).toBeNull();
    // ★ 수량 자체는 계산된다.
    expect(line.requiredQty).toBe('3');
    expect(line.provisionalReasons).toEqual(['NO_PRIMARY_SUPPLIER']);
    expect(result.isProvisional).toBe(true);
  });

  it('★★ 비대표만 있어도 fallback 하지 않는다', async () => {
    const sku = await newSku('pn-c');
    const supplier = await newSupplier('pn');
    await newSupplierSku(supplier, sku, { isPrimary: false }).then((id) => newPrice(id, '500'));

    const parent = await newSku('pn-p');
    const bom = await newHeader(parent, 'PN');
    await newLine(bom, sku);

    const result = await cost(bom, '1');
    expect(result.lines[0]?.supplierSkuId).toBeNull();
    expect(result.lines[0]?.provisionalReasons).toEqual(['NO_PRIMARY_SUPPLIER']);
  });

  it('★★ historical asOf 에 대표가 2건이면 409 다 — 하나를 고르지 않는다', async () => {
    // partial UNIQUE 는 `effective_to IS NULL` 만 덮으므로 **종료된** 대표 두 건은
    // 정상 경로로 만들 수 있다. 과거 asOf 로 조회하면 둘 다 걸린다.
    const sku = await newSku('cf-c');
    const a = await newSupplier('cf-a');
    const b = await newSupplier('cf-b');
    await newSupplierSku(a, sku, {
      isPrimary: true,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-01',
    });
    await newSupplierSku(b, sku, {
      isPrimary: true,
      effectiveFrom: '2026-02-01',
      effectiveTo: '2026-12-01',
    });

    const parent = await newSku('cf-p');
    const bom = await newHeader(parent, 'CF');
    await newLine(bom, sku);

    expect(await codeOf(cost(bom, '1'))).toBe(ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT);
  });

  it('★★ Supplier.status 로 자동 필터링하지 않는다 — INACTIVE 거래처도 선택된다', async () => {
    const sku = await newSku('st-c');
    const supplier = await newSupplier('st-inactive', 'INACTIVE');
    const supplierSku = await newSupplierSku(supplier, sku);
    await newPrice(supplierSku, '700');

    const parent = await newSku('st-p');
    const bom = await newHeader(parent, 'STI');
    await newLine(bom, sku);

    const result = await cost(bom, '1');
    expect(result.lines[0]?.supplierSkuId).toBe(supplierSku);
    expect(result.lines[0]?.lineCost).toBe('700');
  });
});

describe('★★ 대표 선택 기간 경계 — 반열림 [from, to)', () => {
  async function withPeriod(label: string, from: string, to: string | null): Promise<string> {
    const sku = await newSku(label);
    const supplier = await newSupplier(label);
    const supplierSku = await newSupplierSku(supplier, sku, {
      effectiveFrom: from,
      effectiveTo: to,
    });
    await newPrice(supplierSku, '100');
    return sku;
  }

  const resolved = async (skuId: string, asOf: string) =>
    (
      await resolvePrimarySupplierSkus(getPrismaClient(), {
        skuIds: [skuId],
        asOf: parseDateOnly(asOf),
      })
    ).get(skuId);

  it('★★ effectiveFrom == asOf 는 포함된다', async () => {
    const sku = await withPeriod('b-from', '2026-06-01', null);
    expect(await resolved(sku, '2026-06-01')).not.toBeNull();
    expect(await resolved(sku, '2026-05-31')).toBeNull();
  });

  it('★★ effectiveTo == asOf 는 제외된다', async () => {
    const sku = await withPeriod('b-to', '2026-01-01', '2026-06-01');
    expect(await resolved(sku, '2026-05-31')).not.toBeNull();
    expect(await resolved(sku, '2026-06-01')).toBeNull();
  });

  it('★ 미래 시작은 아직 선택되지 않는다', async () => {
    const sku = await withPeriod('b-future', '2099-01-01', null);
    expect(await resolved(sku, '2026-06-01')).toBeNull();
  });

  it('★ historical asOf 에서는 과거 대표가 선택된다', async () => {
    const sku = await withPeriod('b-hist', '2020-01-01', '2021-01-01');
    expect(await resolved(sku, '2020-06-01')).not.toBeNull();
    expect(await resolved(sku, '2026-06-01')).toBeNull();
  });

  it('★ 입력 id 를 dedupe 해도 전부 key 로 돌아온다', async () => {
    const sku = await withPeriod('b-dedupe', '2020-01-01', null);
    const map = await resolvePrimarySupplierSkus(getPrismaClient(), {
      skuIds: [sku, sku, sku],
      asOf: ASOF,
    });
    expect(map.size).toBe(1);
    expect(map.get(sku)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. 가격 resolver 재사용 (D-24)
// ═══════════════════════════════════════════════════════════════

describe('★★ 유효 승인 가격 (D-24)', () => {
  async function bomWith(label: string, prices: PriceOptions[], unit = '100') {
    const sku = await newSku(`${label}-c`);
    const supplier = await newSupplier(label);
    const supplierSku = await newSupplierSku(supplier, sku);
    for (const options of prices) await newPrice(supplierSku, unit, options);
    const parent = await newSku(`${label}-p`);
    const bom = await newHeader(parent, label.slice(0, 12).toUpperCase());
    await newLine(bom, sku);
    return { bom, sku, supplierSku };
  }

  it('★★ 미승인(pending) 가격은 잡히지 않는다 — NO_EFFECTIVE_PRICE', async () => {
    const { bom } = await bomWith('pend', [{ approved: false }]);
    const result = await cost(bom, '1');
    expect(result.lines[0]?.unitPrice).toBeNull();
    expect(result.lines[0]?.lineCost).toBeNull();
    expect(result.lines[0]?.provisionalReasons).toEqual(['NO_EFFECTIVE_PRICE']);
    // ★ 대표는 선택돼 있다 — 사유가 NO_PRIMARY_SUPPLIER 가 아니다.
    expect(result.lines[0]?.supplierSkuId).not.toBeNull();
  });

  it('★★ 승인 + 미승인이 함께 있으면 승인만 쓴다', async () => {
    const sku = await newSku('mix-c');
    const supplier = await newSupplier('mix');
    const supplierSku = await newSupplierSku(supplier, sku);
    await newPrice(supplierSku, '1000', { approved: true, effectiveFrom: '2020-01-01' });
    await newPrice(supplierSku, '9999', { approved: false, effectiveFrom: '2021-01-01' });

    const parent = await newSku('mix-p');
    const bom = await newHeader(parent, 'MIX');
    await newLine(bom, sku);

    const result = await cost(bom, '1');
    expect(result.lines[0]?.unitPrice).toBe('1000');
  });

  it('★★ 가격 0원은 정상 가격이다 — provisional 이 아니다', async () => {
    const { bom } = await bomWith('zero', [{}], '0');
    const result = await cost(bom, '1');
    expect(result.lines[0]?.unitPrice).toBe('0');
    expect(result.lines[0]?.lineCost).toBe('0');
    expect(result.lines[0]?.provisionalReasons).toEqual([]);
    expect(result.isProvisional).toBe(false);
    // ★ subtotal 에도 들어간다.
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '0' }]);
  });

  it('★★ 유효 승인 가격이 2건이면 409 다 — provisional 로 낮추지 않는다', async () => {
    const { bom } = await bomWith('chain', [
      { effectiveFrom: '2026-01-01' },
      { effectiveFrom: '2026-02-01' },
    ]);
    expect(await codeOf(cost(bom, '1'))).toBe(ERROR_CODES.SUPPLIER_PRICE_CHAIN_CONFLICT);
  });

  it('★ 가격 기간 경계 — from 포함 · to 제외', async () => {
    const { bom } = await bomWith('pb', [{ effectiveFrom: '2026-06-01', effectiveTo: null }]);
    expect((await cost(bom, '1', parseDateOnly('2026-06-01'))).lines[0]?.unitPrice).toBe('100');
    expect((await cost(bom, '1', parseDateOnly('2026-05-31'))).lines[0]?.unitPrice).toBeNull();
  });

  it('★★ price row 의 currency·vatIncluded 를 그대로 쓴다', async () => {
    const sku = await newSku('cur-c');
    const supplier = await newSupplier('cur');
    // ⚠️ SupplierSku.currency 는 KRW 인데 가격 행은 USD 다 — 덮어쓰지 않는다.
    const supplierSku = await newSupplierSku(supplier, sku, { currency: 'KRW' });
    await newPrice(supplierSku, '12.34', { currency: 'USD', vatIncluded: true });

    const parent = await newSku('cur-p');
    const bom = await newHeader(parent, 'CUR');
    await newLine(bom, sku);

    const result = await cost(bom, '1');
    expect(result.lines[0]?.currency).toBe('USD');
    expect(result.lines[0]?.vatIncluded).toBe(true);
    // ★ VAT 10% 를 가감하지 않는다.
    expect(result.lines[0]?.lineCost).toBe('12.34');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. provisional matrix (F-5 · F-6 · F-7)
// ═══════════════════════════════════════════════════════════════

describe('★★ 수량 × 공급처 × 가격 provisional matrix', () => {
  /** 한 라인짜리 BOM 을 만든다. `supplier`/`price` 로 결핍을 조립한다. */
  async function scenario(
    label: string,
    quantityStatus: string,
    hasPrimary: boolean,
    hasPrice: boolean,
  ): Promise<DirectCostLine> {
    const sku = await newSku(`${label}-c`);
    if (hasPrimary) {
      const supplier = await newSupplier(label);
      const supplierSku = await newSupplierSku(supplier, sku);
      if (hasPrice) await newPrice(supplierSku, '100');
    }
    const parent = await newSku(`${label}-p`);
    const bom = await newHeader(parent, label.slice(0, 12).toUpperCase());
    await newLine(bom, sku, {
      quantityStatus,
      quantityPer: quantityStatus === 'UNKNOWN' ? null : '2',
    });
    const result = await cost(bom, '1');
    return result.lines[0] as DirectCostLine;
  }

  it('★★ QuantityStatus 는 정확히 3종이다 — CONFIRMED / SUGGESTED / UNKNOWN', async () => {
    // ⛔ 가짜 status 를 만들거나 enum 의미를 확장하지 않는다. 아래 9조합 매트릭스는
    //    이 3종 × (대표·가격) 3상태를 전부 덮는다.
    const rows = await getPrismaClient().$queryRawUnsafe<{ label: string }[]>(
      `SELECT unnest(enum_range(NULL::"QuantityStatus"))::text AS label`,
    );
    expect(rows.map((row) => row.label).sort()).toEqual(['CONFIRMED', 'SUGGESTED', 'UNKNOWN']);
  });

  it('★ CONFIRMED + 대표 + 가격 → 사유 없음, 원가 계산', async () => {
    const line = await scenario('m-cc', 'CONFIRMED', true, true);
    expect(line.provisionalReasons).toEqual([]);
    expect(line.provisionalReason).toBeNull();
    expect(line.lineCost).toBe('200');
  });

  it('★★ SUGGESTED + 대표 + 가격 → QTY_UNCONFIRMED 인데 원가는 계산된다', async () => {
    const line = await scenario('m-sc', 'SUGGESTED', true, true);
    // ★ "계산 가능" ≠ "수량 확정"
    expect(line.lineCost).toBe('200');
    expect(line.provisionalReasons).toEqual(['QTY_UNCONFIRMED']);
    expect(line.provisionalReason).toBe('QTY_UNCONFIRMED');
  });

  it('★★ UNKNOWN + 대표 + 가격 → QTY_UNCONFIRMED, lineCost null', async () => {
    const line = await scenario('m-uc', 'UNKNOWN', true, true);
    expect(line.requiredQty).toBeNull();
    expect(line.lineCost).toBeNull();
    expect(line.provisionalReasons).toEqual(['QTY_UNCONFIRMED']);
    // ★ 가격 metadata 는 그대로 보존된다.
    expect(line.supplierSkuId).not.toBeNull();
    expect(line.unitPrice).toBe('100');
  });

  it('★★ CONFIRMED + 대표 없음 → NO_PRIMARY_SUPPLIER', async () => {
    const line = await scenario('m-cn', 'CONFIRMED', false, false);
    expect(line.provisionalReasons).toEqual(['NO_PRIMARY_SUPPLIER']);
    expect(line.provisionalReason).toBe('NO_PRIMARY_SUPPLIER');
  });

  it('★★ SUGGESTED + 대표 없음 → 사유 2개, 표시값은 QTY_UNCONFIRMED', async () => {
    const line = await scenario('m-sn', 'SUGGESTED', false, false);
    expect(line.provisionalReasons).toEqual(['QTY_UNCONFIRMED', 'NO_PRIMARY_SUPPLIER']);
    expect(line.provisionalReason).toBe('QTY_UNCONFIRMED');
    expect(line.lineCost).toBeNull();
  });

  it('★★ UNKNOWN + 대표 없음 → 사유 2개, 표시값은 QTY_UNCONFIRMED', async () => {
    const line = await scenario('m-un', 'UNKNOWN', false, false);
    expect(line.provisionalReasons).toEqual(['QTY_UNCONFIRMED', 'NO_PRIMARY_SUPPLIER']);
    expect(line.provisionalReason).toBe('QTY_UNCONFIRMED');
  });

  it('★★ CONFIRMED + 대표 + 가격 없음 → NO_EFFECTIVE_PRICE', async () => {
    const line = await scenario('m-cp', 'CONFIRMED', true, false);
    expect(line.provisionalReasons).toEqual(['NO_EFFECTIVE_PRICE']);
    expect(line.provisionalReason).toBe('NO_EFFECTIVE_PRICE');
  });

  it('★★ SUGGESTED + 대표 + 가격 없음 → 사유 2개, 표시값은 QTY_UNCONFIRMED', async () => {
    const line = await scenario('m-sp', 'SUGGESTED', true, false);
    expect(line.provisionalReasons).toEqual(['QTY_UNCONFIRMED', 'NO_EFFECTIVE_PRICE']);
    expect(line.provisionalReason).toBe('QTY_UNCONFIRMED');
  });

  it('★★ UNKNOWN + 대표 + 가격 없음 → 사유 2개', async () => {
    const line = await scenario('m-up', 'UNKNOWN', true, false);
    expect(line.provisionalReasons).toEqual(['QTY_UNCONFIRMED', 'NO_EFFECTIVE_PRICE']);
  });

  it('★★ optional 라인이어도 미확정이면 QTY_UNCONFIRMED 다 — isRequired 무관', async () => {
    const parent = await newSku('opt-p');
    const component = await pricedComponent('opt-c', '100');
    const bom = await newHeader(parent, 'OPT');
    await newLine(bom, component, {
      quantityStatus: 'SUGGESTED',
      quantityPer: '1',
      isRequired: false,
    });

    const result = await cost(bom, '1');
    expect(result.lines[0]?.provisionalReasons).toEqual(['QTY_UNCONFIRMED']);
  });

  it('★★ top-level 은 union 이다 — 라인 표시값의 수집이 아니다 (F-7)', async () => {
    const parent = await newSku('un-p');
    const noPrimary = await newSku('un-np');
    const priced = await pricedComponent('un-ok', '100');
    const bom = await newHeader(parent, 'UNION');
    // 라인 1: SUGGESTED + 대표 없음 → 실제 사유 2개, 표시값 QTY_UNCONFIRMED
    await newLine(bom, noPrimary, { quantityStatus: 'SUGGESTED', quantityPer: '1', lineNo: 1 });
    // 라인 2: CONFIRMED + 정상
    await newLine(bom, priced, { lineNo: 2 });

    const result = await cost(bom, '1');
    expect(result.lines[0]?.provisionalReason).toBe('QTY_UNCONFIRMED');
    // ★ 숨은 NO_PRIMARY_SUPPLIER 도 top-level 에 올라온다.
    expect(result.provisionalReasons).toEqual(['QTY_UNCONFIRMED', 'NO_PRIMARY_SUPPLIER']);
    expect(result.isProvisional).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. 손상은 provisional 을 이긴다
// ═══════════════════════════════════════════════════════════════

describe('★★ 데이터 손상은 수량 상태와 무관하게 409 다', () => {
  it('★★ UNKNOWN 라인 + 대표 2건 → 409 (검사를 건너뛰지 않는다)', async () => {
    const sku = await newSku('cu-c');
    for (const label of ['cu-a', 'cu-b']) {
      const supplier = await newSupplier(label);
      await newSupplierSku(supplier, sku, {
        isPrimary: true,
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-12-01',
      });
    }
    const parent = await newSku('cu-p');
    const bom = await newHeader(parent, 'CU');
    await newLine(bom, sku, { quantityStatus: 'UNKNOWN', quantityPer: null });

    expect(await codeOf(cost(bom, '1'))).toBe(ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT);
  });

  it('★★ SUGGESTED 라인 + 가격 chain 2건 → 409', async () => {
    const sku = await newSku('cs-c');
    const supplier = await newSupplier('cs');
    const supplierSku = await newSupplierSku(supplier, sku);
    await newPrice(supplierSku, '100', { effectiveFrom: '2026-01-01' });
    await newPrice(supplierSku, '200', { effectiveFrom: '2026-02-01' });

    const parent = await newSku('cs-p');
    const bom = await newHeader(parent, 'CS');
    await newLine(bom, sku, { quantityStatus: 'SUGGESTED', quantityPer: '1' });

    expect(await codeOf(cost(bom, '1'))).toBe(ERROR_CODES.SUPPLIER_PRICE_CHAIN_CONFLICT);
  });

  it('★★ 손상 정합(UNKNOWN + quantityPer 값)은 422 로 드러난다', async () => {
    const parent = await newSku('mm-p');
    const component = await pricedComponent('mm-c', '100');
    const bom = await newHeader(parent, 'MM');
    await newLine(bom, component, { quantityStatus: 'UNKNOWN', quantityPer: '3' });

    expect(await codeOf(cost(bom, '1'))).toBe(ERROR_CODES.BOM_QTY_STATUS_MISMATCH);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. subtotal (F-8 · F-9 · D-26 · D-27)
// ═══════════════════════════════════════════════════════════════

describe('★★ subtotal — raw 합계 후 4dp · partial', () => {
  it('★★ 반올림된 lineCost 를 재합산하지 않는다 — 0.0001 vs 0.0002', async () => {
    // 각 라인 raw = 0.5 × 0.0001 = 0.00005 → public "0.0001"
    // raw 합 0.0001 → "0.0001".  ⛔ public 합이면 "0.0002".
    const parent = await newSku('sr-p');
    const component = await pricedComponent('sr-c', '0.0001');
    const bom = await newHeader(parent, 'SR');
    await newLine(bom, component, { quantityPer: '0.5', lineNo: 1 });
    await newLine(bom, component, { quantityPer: '0.5', alternateGroup: 'G2', lineNo: 2 });

    const result = await cost(bom, '1');
    expect(result.lines.map((line) => line.lineCost)).toEqual(['0.0001', '0.0001']);
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '0.0001' }]);
    expect(result.subtotals[0]?.amount).not.toBe('0.0002');
  });

  // ⚠️ 이 회귀는 **TC-BOM-009 가 아니다.** TC-BOM-009 는 backlog 상 "박스 단가 =
  //    가격 ÷ 입수량" acceptance 이며 위 전용 fixture 3종이 담당한다. 이쪽은
  //    D-26·D-27 통화/VAT subtotal 분리 회귀로 별도 유지한다 (삭제하지 않는다).
  it('★★ 통화·VAT 별로 나뉜다 — 환산하지 않는다 (D-26·D-27)', async () => {
    const parent = await newSku('cx-p');
    const krw = await pricedComponent('cx-krw', '100');
    const krwVat = await pricedComponent('cx-krwv', '200', { vatIncluded: true });
    const usd = await pricedComponent('cx-usd', '3', { currency: 'USD' });
    const bom = await newHeader(parent, 'CX');
    await newLine(bom, krw, { lineNo: 1 });
    await newLine(bom, krwVat, { lineNo: 2 });
    await newLine(bom, usd, { lineNo: 3 });

    const result = await cost(bom, '1');
    expect(result.subtotals).toEqual([
      { currency: 'KRW', vatIncluded: false, amount: '100' },
      { currency: 'KRW', vatIncluded: true, amount: '200' },
      { currency: 'USD', vatIncluded: false, amount: '3' },
    ]);
    // ⛔ 단일 총액(303)이 없다.
    expect(result.subtotals.map((row) => row.amount)).not.toContain('303');
  });

  it('★★ 산정 불가 라인은 subtotal 에서 제외된다 — 0 으로 더하지 않는다', async () => {
    const parent = await newSku('ps-p');
    const priced = await pricedComponent('ps-ok', '100');
    const orphan = await newSku('ps-no');
    const bom = await newHeader(parent, 'PS');
    await newLine(bom, priced, { lineNo: 1 });
    await newLine(bom, orphan, { lineNo: 2 });

    const result = await cost(bom, '1');
    expect(result.subtotals).toEqual([{ currency: 'KRW', vatIncluded: false, amount: '100' }]);
    expect(result.isProvisional).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. 권한 (D-15)
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — bom.read (D-15)', () => {
  it('★★ EXECUTIVE 도 원가를 읽는다', async () => {
    const parent = await newSku('pm-p');
    const component = await pricedComponent('pm-c', '100');
    const bom = await newHeader(parent, 'PM');
    await newLine(bom, component);

    const result = await costDirectBom(EXECUTIVE, bom, { requestedQty: '1', asOf: ASOF });
    expect(result.lines[0]?.lineCost).toBe('100');
  });

  it('★★ ADMIN role 이어도 permission 데이터가 없으면 403 — bypass 없음', async () => {
    const parent = await newSku('pn2-p');
    const bom = await newHeader(parent, 'PN2');

    expect(await codeOf(costDirectBom(NO_PERMISSION, bom, { requestedQty: '1', asOf: ASOF }))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it('★★ supplier 권한을 추가로 요구하지 않는다 — bom.read 하나면 된다', async () => {
    const parent = await newSku('pv-p');
    const component = await pricedComponent('pv-c', '100');
    const bom = await newHeader(parent, 'PV');
    await newLine(bom, component);

    // READER 는 `bom.read` 만 갖는다 — supplier.read·supplier_price.read 없음.
    expect(READER.permissions).toEqual([BOM_READ_PERMISSION]);
    const result = await cost(bom, '1');
    expect(result.lines[0]?.supplierSkuId).not.toBeNull();
  });

  it('★ 권한 검사가 존재 확인보다 먼저다 — 없는 BOM 도 403 이다', async () => {
    expect(
      await codeOf(
        costDirectBom(NO_PERMISSION, '22222222-2222-4222-8222-222222222222', {
          requestedQty: '1',
          asOf: ASOF,
        }),
      ),
    ).toBe(ERROR_CODES.FORBIDDEN);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. read-only · N+1 부재
// ═══════════════════════════════════════════════════════════════

describe('★★ read-only · batch', () => {
  it('★★ write 0 — BOM·SupplierSku·가격·Audit 이 하나도 바뀌지 않는다', async () => {
    const client = getPrismaClient();
    const parent = await newSku('ro-p');
    const priced = await pricedComponent('ro-c', '100');
    const orphan = await newSku('ro-n');
    const bom = await newHeader(parent, 'RO');
    await newLine(bom, priced, { lineNo: 1 });
    await newLine(bom, orphan, { quantityStatus: 'UNKNOWN', quantityPer: null, lineNo: 2 });

    const before = {
      headers: await client.bomHeader.findMany({
        where: { parentSku: { skuCode: { startsWith: 'TCS-' } } },
        orderBy: { id: 'asc' },
      }),
      lines: await client.bomLine.findMany({
        where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TCS-' } } } },
        orderBy: { id: 'asc' },
      }),
      supplierSkus: await client.supplierSku.findMany({
        where: { sku: { skuCode: { startsWith: 'TCS-' } } },
        orderBy: { id: 'asc' },
      }),
      prices: await client.supplierSkuPrice.findMany({
        where: { supplierSku: { sku: { skuCode: { startsWith: 'TCS-' } } } },
        orderBy: { id: 'asc' },
      }),
      audits: await client.auditLog.count({ where: { entityId: bom } }),
    };

    await cost(bom, '7');

    expect(
      await client.bomHeader.findMany({
        where: { parentSku: { skuCode: { startsWith: 'TCS-' } } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before.headers);
    expect(
      await client.bomLine.findMany({
        where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TCS-' } } } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before.lines);
    expect(
      await client.supplierSku.findMany({
        where: { sku: { skuCode: { startsWith: 'TCS-' } } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before.supplierSkus);
    expect(
      await client.supplierSkuPrice.findMany({
        where: { supplierSku: { sku: { skuCode: { startsWith: 'TCS-' } } } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before.prices);
    // ⛔ AuditLog 0 — 조회는 흔적을 남기지 않는다.
    expect(await client.auditLog.count({ where: { entityId: bom } })).toBe(before.audits);
  });

  it('★★ N+1 이 없다 — 라인 12개여도 쿼리는 정확히 4회', async () => {
    const parent = await newSku('nq-p');
    const bom = await newHeader(parent, 'NQ');
    for (let index = 0; index < 12; index += 1) {
      await newLine(bom, await pricedComponent(`nq-c${index}`, '10'), { lineNo: index + 1 });
    }

    const calls: string[] = [];
    const client = getPrismaClient();
    const spy = {
      bomHeader: {
        findUnique: (args: never) => {
          calls.push('header');
          return client.bomHeader.findUnique(args);
        },
      },
      bomLine: {
        findMany: (args: never) => {
          calls.push('lines');
          return client.bomLine.findMany(args);
        },
      },
      supplierSku: {
        findMany: (args: never) => {
          calls.push('supplierSku');
          return client.supplierSku.findMany(args);
        },
      },
      supplierSkuPrice: {
        findMany: (args: never) => {
          calls.push('price');
          return client.supplierSkuPrice.findMany(args);
        },
      },
      sku: client.sku,
      supplier: client.supplier,
    };

    const result = await costDirectBom(
      READER,
      bom,
      { requestedQty: '1', asOf: ASOF },
      { db: spy as never },
    );

    expect(result.lines).toHaveLength(12);
    // ⛔ 12 + n 이 아니다 — 라인 수와 무관하게 4회다.
    expect(calls).toEqual(['header', 'lines', 'supplierSku', 'price']);
  });

  it('★★ 같은 구성품이 10 라인이어도 supplier·price 쿼리는 각 1회다', async () => {
    const parent = await newSku('nd-p');
    const component = await pricedComponent('nd-c', '10');
    const bom = await newHeader(parent, 'ND');
    for (let index = 0; index < 10; index += 1) {
      await newLine(bom, component, {
        lineNo: index + 1,
        alternateGroup: `G${index}`,
      });
    }

    const calls: string[] = [];
    const client = getPrismaClient();
    const spy = {
      bomHeader: { findUnique: (a: never) => client.bomHeader.findUnique(a) },
      bomLine: { findMany: (a: never) => client.bomLine.findMany(a) },
      supplierSku: {
        findMany: (a: never) => {
          calls.push('supplierSku');
          return client.supplierSku.findMany(a);
        },
      },
      supplierSkuPrice: {
        findMany: (a: never) => {
          calls.push('price');
          return client.supplierSkuPrice.findMany(a);
        },
      },
      sku: client.sku,
      supplier: client.supplier,
    };

    const result = await costDirectBom(
      READER,
      bom,
      { requestedQty: '1', asOf: ASOF },
      { db: spy as never },
    );

    // ★ selection 은 dedupe 되지만 business 라인 10개는 그대로 남는다.
    expect(result.lines).toHaveLength(10);
    expect(calls).toEqual(['supplierSku', 'price']);
  });
});
