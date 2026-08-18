import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  explodeBom,
  parseExplodeBomQuery,
  BOM_APPROVE_PERMISSION,
  BOM_CREATE_PERMISSION,
  BOM_READ_PERMISSION,
  BOM_SUBMIT_PERMISSION,
  BOM_UPDATE_PERMISSION,
  type ExplodedNodeView,
} from '@/modules/bom/application';
import { BOM_MAX_LEVEL } from '@/modules/bom/domain';
import { businessDateOf } from '@/shared/business-date';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * BOM 다단계 전개 DB 통합 테스트 (T07-6) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-18 · §D-19 · §D-20 · §D-21 · §D-22 ·
 *    §D-13 · §D-15 · §D-32 test matrix(**TC-BOM-008** 3단계 전개) ·
 *    `★ T07-6 explosion quantity gap closure`(E-1 ~ E-7).
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - **3단계 전개 정확도**(TC-BOM-008) — level 마다 다른 `outputQty`·손실률
 *   - root 는 **요청한 exact header** — 같은 parent 의 다른 ACTIVE 버전이 있어도
 *   - 하위만 `resolveEffectiveBom` — 반열림 `[from, to)` 경계
 *   - **다이아몬드 경로 detail 보존**(전역 visited 부재 증명)
 *   - 손상 graph 의 순환 422 · 깊이 초과 422
 *   - **미확정 수량 null 전파**와 그 아래 구조 전개 계속
 *   - N+1 부재 — level 당 쿼리 2회
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TEX-${RUN}-${suffix}`;

const READER_ID = 'fff00000-0000-4000-8000-0000000e6001';
const NOPERM_ID = 'fff00000-0000-4000-8000-0000000e6002';
const ACTOR_IDS = [READER_ID, NOPERM_ID];

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

/** 전 권한 — 전개는 `bom.read` 만 필요하지만 fixture 를 만들 권한도 함께 준다. */
const READER = actor(
  READER_ID,
  ['SCM_LEADER'],
  [
    BOM_READ_PERMISSION,
    BOM_CREATE_PERMISSION,
    BOM_UPDATE_PERMISSION,
    BOM_SUBMIT_PERMISSION,
    BOM_APPROVE_PERMISSION,
  ],
);
/** EXECUTIVE — `bom.read` 만. ★ D-15 상 전개를 읽을 수 있다. */
const EXECUTIVE = actor(
  'fff00000-0000-4000-8000-0000000e6003',
  ['EXECUTIVE'],
  [BOM_READ_PERMISSION],
);
/** ADMIN role 이지만 permission 데이터가 없다 — bypass 부재 증명. */
const NO_PERMISSION = actor(NOPERM_ID, ['ADMIN'], []);

const query = (init: Record<string, string> = {}) =>
  parseExplodeBomQuery(new URLSearchParams(init));

let seq = 0;

async function newSku(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `전개 SKU (${label})`,
      itemType: 'FINISHED_GOOD',
      status: 'ACTIVE',
      baseUom: 'EA',
    },
    select: { id: true },
  });
  return row.id;
}

interface HeaderOptions {
  readonly status?: string;
  readonly outputQty?: string;
  readonly overallLossRate?: string | null;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
}

/**
 * ★ 헤더를 **Prisma 로 직접** 만든다.
 *
 * 전개는 read-only 이고 여기서 보려는 것은 workflow 가 아니라 **graph 모양**이다.
 * 손상 graph(순환)·10단계 chain 처럼 정상 API 로는 만들 수 없는 fixture 도
 * 필요하므로 상태를 직접 세팅한다.
 */
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
      effectiveFrom: new Date(`${options.effectiveFrom ?? '2020-01-01'}T00:00:00.000Z`),
      effectiveTo:
        options.effectiveTo === undefined || options.effectiveTo === null
          ? null
          : new Date(`${options.effectiveTo}T00:00:00.000Z`),
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
    },
    select: { id: true },
  });
  return row.id;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('예외가 발생하지 않았다');
}

/** `skuCode` 로 node 를 찾는다 — id 비교보다 실패 메시지가 읽힌다. */
const bySku = (nodes: readonly ExplodedNodeView[], skuId: string): ExplodedNodeView[] =>
  nodes.filter((node) => node.componentSkuId === skuId);

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TEX-' } } } },
  });
  await client.bomLine.deleteMany({ where: { componentSku: { skuCode: { startsWith: 'TEX-' } } } });
  await client.bomHeader.deleteMany({
    where: { parentSku: { skuCode: { startsWith: 'TEX-' } } },
  });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TEX-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: '전개 테스트' })),
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 1. TC-BOM-008 — 3단계 전개 정확도
// ═══════════════════════════════════════════════════════════════

describe('★★ TC-BOM-008 — 3단계 전개 (D-18 · D-19)', () => {
  /**
   * ```
   *   A(root, outputQty=10, overall=0.2)
   *     └ L1 → B  quantityPer=3  loss=0.1        [level 1]
   *          B BOM(outputQty=2, overall=0)
   *            └ L1 → C  quantityPer=4          [level 2]
   *                 C BOM(outputQty=5, overall=0)
   *                   └ L1 → D  quantityPer=7   [level 3]
   * ```
   * ★ level 마다 `outputQty` 를 다르게 두어 공식이 실제로 도는지 본다.
   */
  async function threeLevel() {
    const [a, b, c, d] = await Promise.all([
      newSku('tc8-a'),
      newSku('tc8-b'),
      newSku('tc8-c'),
      newSku('tc8-d'),
    ]);
    const rootBom = await newHeader(a, 'TC8R', { outputQty: '10', overallLossRate: '0.2' });
    const bBom = await newHeader(b, 'TC8B', { outputQty: '2' });
    const cBom = await newHeader(c, 'TC8C', { outputQty: '5' });
    await newLine(rootBom, b, { quantityPer: '3', lossRate: '0.1' });
    await newLine(bBom, c, { quantityPer: '4' });
    await newLine(cBom, d, { quantityPer: '7' });
    return { a, b, c, d, rootBom, bBom, cBom };
  }

  it('★★ 3단계가 모두 나오고 level·path 가 정확하다', async () => {
    const { a, b, c, d, rootBom, bBom, cBom } = await threeLevel();
    const result = await explodeBom(READER, rootBom, query({ qty: '20' }));

    expect(result.nodes).toHaveLength(3);
    const [nb, nc, nd] = result.nodes;

    // ★ root header 자체는 node 가 아니다 — 직접 구성품부터 시작한다 (G4).
    expect(result.nodes.map((node) => node.componentSkuId)).toEqual([b, c, d]);

    // ★ root SKU = level 0 이므로 직접 구성품이 level 1 이다 (G2).
    expect([nb?.level, nc?.level, nd?.level]).toEqual([1, 2, 3]);
    // ★ path 는 조상 skuId 배열(자기 제외)이고 언제나 length === level 이다 (G3).
    expect(nb?.path).toEqual([a]);
    expect(nc?.path).toEqual([a, b]);
    expect(nd?.path).toEqual([a, b, c]);
    for (const node of result.nodes) {
      expect(node.path).toHaveLength(node.level);
    }

    // ★ bomHeaderId 는 그 구성품을 **전개한 하위 BOM** 이다.
    expect(nb?.bomHeaderId).toBe(bBom);
    expect(nc?.bomHeaderId).toBe(cBom);
    expect(nd?.bomHeaderId).toBeNull(); // D 에는 BOM 이 없다 → leaf
    expect([nb?.isLeaf, nc?.isLeaf, nd?.isLeaf]).toEqual([false, false, true]);
  });

  it('★★ 수량이 level 마다 정확히 전파된다 — 부모 requiredQty 가 자식의 Q 다', async () => {
    const { rootBom } = await threeLevel();
    const result = await explodeBom(READER, rootBom, query({ qty: '20' }));

    // B = (20/10) × 3 × 1.1 × 1.2 = 7.92
    expect(result.nodes[0]?.requiredQty).toBe('7.92');
    // C = (7.92/2) × 4 × 1 × 1 = 15.84
    expect(result.nodes[1]?.requiredQty).toBe('15.84');
    // D = (15.84/5) × 7 × 1 × 1 = 22.176
    expect(result.nodes[2]?.requiredQty).toBe('22.176');
  });

  it('★★ root qty 를 모든 level 에 다시 쓰지 않는다 — qty 2배면 전부 2배다', async () => {
    const { rootBom } = await threeLevel();
    const single = await explodeBom(READER, rootBom, query({ qty: '20' }));
    const double = await explodeBom(READER, rootBom, query({ qty: '40' }));

    expect(double.nodes.map((node) => node.requiredQty)).toEqual(['15.84', '31.68', '44.352']);
    // 선형이라는 것 자체가 "Q 가 level 마다 갱신된다"는 증거다.
    expect(single.nodes).toHaveLength(double.nodes.length);
  });

  it('★ qty 기본값은 "1" 이다 (D-18)', async () => {
    const { rootBom } = await threeLevel();
    const implicit = await explodeBom(READER, rootBom, query({}));
    const explicit = await explodeBom(READER, rootBom, query({ qty: '1' }));

    expect(implicit.qty).toBe('1');
    expect(implicit.nodes.map((node) => node.requiredQty)).toEqual(
      explicit.nodes.map((node) => node.requiredQty),
    );
    // B = (1/10) × 3 × 1.1 × 1.2 = 0.396
    expect(implicit.nodes[0]?.requiredQty).toBe('0.396');
  });

  it('★★ 중간 반올림이 없다 — 6dp 로 자른 부모 값을 자식에 재사용하지 않는다', async () => {
    // A(outputQty=3) → B ×1  ⇒ B raw = 1/3 = 0.333333333…  public = "0.333333"
    // B BOM(outputQty=1) → C ×3000000
    //   raw 전파:      (1/3) × 3,000,000 = 1,000,000
    //   6dp 재사용 시: 0.333333 × 3,000,000 =   999,999   ← 이 값이 나오면 실패
    const [a, b, c] = await Promise.all([newSku('nr-a'), newSku('nr-b'), newSku('nr-c')]);
    const rootBom = await newHeader(a, 'NR-R', { outputQty: '3' });
    const bBom = await newHeader(b, 'NR-B', { outputQty: '1' });
    await newLine(rootBom, b, { quantityPer: '1' });
    await newLine(bBom, c, { quantityPer: '3000000' });

    const result = await explodeBom(READER, rootBom, query({ qty: '1' }));
    expect(result.nodes[0]?.requiredQty).toBe('0.333333');
    expect(result.nodes[1]?.requiredQty).toBe('1000000');
    expect(result.nodes[1]?.requiredQty).not.toBe('999999');
  });

  it('★★ packQuantity 는 계산에 쓰이지 않는다 — 0.033333 × 30 = 0.99999', async () => {
    const [a, b] = await Promise.all([newSku('pk-a'), newSku('pk-b')]);
    const rootBom = await newHeader(a, 'PK-R');
    const lineId = await newLine(rootBom, b, { quantityPer: '0.033333' });
    // 입수량 30 을 실제로 저장해 둔다 — 그래도 공식에 등장하지 않아야 한다.
    await getPrismaClient().bomLine.update({ where: { id: lineId }, data: { packQuantity: '30' } });

    const result = await explodeBom(READER, rootBom, query({ qty: '30' }));
    // ⛔ 1 로 재정규화하지 않는다. ⛔ ×30 / ÷30 을 추가하지 않는다.
    expect(result.nodes[0]?.requiredQty).toBe('0.99999');
    expect(result.nodes[0]?.quantityPer).toBe('0.033333');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. root 는 재선택하지 않는다
// ═══════════════════════════════════════════════════════════════

describe('★★ root = 요청한 exact header — asOf 로 바꾸지 않는다 (D-18)', () => {
  it('★★ 같은 parent 에 asOf 유효한 다른 ACTIVE 버전이 있어도 root 는 요청한 것이다', async () => {
    const [a, oldChild, newChild] = await Promise.all([
      newSku('root-a'),
      newSku('root-old'),
      newSku('root-new'),
    ]);
    // v1 은 이미 마감됐고, v2 가 오늘 유효한 ACTIVE 다.
    const v1 = await newHeader(a, 'RT-V1', {
      effectiveFrom: '2020-01-01',
      effectiveTo: '2021-01-01',
    });
    const v2 = await newHeader(a, 'RT-V2', { effectiveFrom: '2021-01-01' });
    await newLine(v1, oldChild);
    await newLine(v2, newChild);

    // ★ 오늘 기준인데도 v1 을 요청하면 v1 이 전개된다.
    const explodedV1 = await explodeBom(READER, v1, query({}));
    expect(explodedV1.bomId).toBe(v1);
    expect(explodedV1.nodes.map((node) => node.componentSkuId)).toEqual([oldChild]);

    // v2 를 요청하면 v2 다 — 대칭 확인.
    const explodedV2 = await explodeBom(READER, v2, query({}));
    expect(explodedV2.nodes.map((node) => node.componentSkuId)).toEqual([newChild]);
  });

  it('★★ root 의 status 로 거르지 않는다 — DRAFT·ARCHIVED 도 전개된다', async () => {
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'INACTIVE', 'ARCHIVED']) {
      const [parent, child] = await Promise.all([
        newSku(`st-${status}-p`),
        newSku(`st-${status}-c`),
      ]);
      const bom = await newHeader(parent, `ST${status.slice(0, 3)}`, { status });
      await newLine(bom, child, { quantityPer: '2' });

      const result = await explodeBom(READER, bom, query({ qty: '3' }));
      expect(result.nodes, status).toHaveLength(1);
      expect(result.nodes[0]?.requiredQty, status).toBe('6');
    }
  });

  it('★ 없는 BOM 은 404 다 — 빈 배열로 위장하지 않는다', async () => {
    expect(
      await codeOf(explodeBom(READER, '11111111-1111-4111-8111-111111111111', query({}))),
    ).toBe(ERROR_CODES.BOM_NOT_FOUND);
  });

  it('★ 라인이 0건이면 빈 배열이다 — 오류가 아니다', async () => {
    const parent = await newSku('empty-p');
    const bom = await newHeader(parent, 'EMPTY');
    const result = await explodeBom(READER, bom, query({}));
    expect(result.nodes).toEqual([]);
    expect(result.bomId).toBe(bom);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. 하위 resolver — asOf 반열림 경계
// ═══════════════════════════════════════════════════════════════

describe('★★ 하위만 resolveEffectiveBom — 반열림 [from, to) (D-22)', () => {
  async function twoVersions() {
    const [a, b, viaV1, viaV2] = await Promise.all([
      newSku('as-a'),
      newSku('as-b'),
      newSku('as-c1'),
      newSku('as-c2'),
    ]);
    const rootBom = await newHeader(a, 'AS-R');
    await newLine(rootBom, b);
    // B 의 하위 BOM 두 버전 — 경계가 2026-07-01 에서 맞물린다.
    const v1 = await newHeader(b, 'AS-B1', {
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-07-01',
    });
    const v2 = await newHeader(b, 'AS-B2', { effectiveFrom: '2026-07-01' });
    await newLine(v1, viaV1);
    await newLine(v2, viaV2);
    return { rootBom, b, viaV1, viaV2 };
  }

  it('★★ asOf = to 직전은 v1, to 당일은 v2 다 (상한 미포함)', async () => {
    const { rootBom, viaV1, viaV2 } = await twoVersions();

    const before = await explodeBom(READER, rootBom, query({ asOf: '2026-06-30' }));
    expect(before.nodes.map((node) => node.componentSkuId)).toContain(viaV1);
    expect(before.nodes.map((node) => node.componentSkuId)).not.toContain(viaV2);

    const onBoundary = await explodeBom(READER, rootBom, query({ asOf: '2026-07-01' }));
    expect(onBoundary.nodes.map((node) => node.componentSkuId)).toContain(viaV2);
    expect(onBoundary.nodes.map((node) => node.componentSkuId)).not.toContain(viaV1);
  });

  it('★ from 이전이면 유효 BOM 이 없다 — leaf 다 (오류 아님)', async () => {
    const { rootBom, b } = await twoVersions();
    const result = await explodeBom(READER, rootBom, query({ asOf: '2025-12-31' }));
    expect(result.nodes).toHaveLength(1);
    expect(bySku(result.nodes, b)[0]?.isLeaf).toBe(true);
    expect(bySku(result.nodes, b)[0]?.bomHeaderId).toBeNull();
  });

  it('★★ asOf 기본값은 서버 업무일자(Asia/Seoul)다 (D-21)', async () => {
    const { rootBom } = await twoVersions();
    const result = await explodeBom(READER, rootBom, query({}));
    expect(result.asOf).toBe(businessDateOf(new Date()));
  });

  it('★★ 한 요청 안에서 모든 level 이 같은 asOf 를 쓴다', async () => {
    // 두 level 의 하위 BOM 이 같은 날짜 경계를 갖게 하고, 한쪽만 다른 날짜로
    // 해석되면 결과가 섞이도록 구성한다.
    const [a, b, c, viaOld, viaNew] = await Promise.all([
      newSku('sa-a'),
      newSku('sa-b'),
      newSku('sa-c'),
      newSku('sa-old'),
      newSku('sa-new'),
    ]);
    const rootBom = await newHeader(a, 'SA-R');
    await newLine(rootBom, b);
    const bBom = await newHeader(b, 'SA-B', { effectiveFrom: '2026-01-01' });
    await newLine(bBom, c);
    await newHeader(c, 'SA-C1', { effectiveFrom: '2026-01-01', effectiveTo: '2026-07-01' }).then(
      (id) => newLine(id, viaOld),
    );
    await newHeader(c, 'SA-C2', { effectiveFrom: '2026-07-01' }).then((id) => newLine(id, viaNew));

    const result = await explodeBom(READER, rootBom, query({ asOf: '2026-03-01' }));
    expect(result.asOf).toBe('2026-03-01');
    expect(result.nodes.map((node) => node.componentSkuId)).toEqual([b, c, viaOld]);
  });

  it('★★ 하위 유효 ACTIVE 가 2건이면 409 를 그대로 올린다 — 하나를 골라 숨기지 않는다', async () => {
    // ⚠️ `bom_header_active_period_excl` 이 막으므로 정상 경로로는 겹치는 ACTIVE
    //    2건을 만들 수 없다. `bom-effective-resolver.test.ts` 가 확립한 방식대로
    //    **트랜잭션 안에서만** 제약을 떼고 손상을 심은 뒤 반드시 롤백한다 —
    //    커밋하지 않으므로 다른 DB 테스트 파일의 스키마를 건드리지 않는다.
    const [a, b] = await Promise.all([newSku('cf-a'), newSku('cf-b')]);
    const rootBom = await newHeader(a, 'CF-R');
    await newLine(rootBom, b);

    let observed: string | null = null;
    await getPrismaClient()
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE bom_header DROP CONSTRAINT bom_header_active_period_excl`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO bom_header (id, parent_sku_id, bom_type, version, status, output_qty,
                                   output_uom, effective_from, created_at)
           VALUES (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'cf-dup-1', 'ACTIVE', 1, 'EA',
                   DATE '2020-01-01', now()),
                  (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'cf-dup-2', 'ACTIVE', 1, 'EA',
                   DATE '2020-02-01', now())`,
          b,
        );

        try {
          await explodeBom(READER, rootBom, query({}), { db: tx as never });
        } catch (error) {
          observed = (error as { code: string }).code;
        }
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if ((error as Error).message !== 'rollback') throw error;
      });

    // ⛔ leaf 로 위장하거나 LIMIT 1 로 숨기지 않는다 — 손상은 드러난다.
    expect(observed).toBe(ERROR_CODES.BOM_EFFECTIVE_CONFLICT);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. leaf · 중간 노드 · 라인 필터 부재
// ═══════════════════════════════════════════════════════════════

describe('★★ leaf · 중간 노드 · 구조 라인 (D-18)', () => {
  it('★★ 중간 반제품도 결과에 포함된다 — 펼치기만 하고 지우지 않는다', async () => {
    const [a, b, c] = await Promise.all([newSku('mid-a'), newSku('mid-b'), newSku('mid-c')]);
    const rootBom = await newHeader(a, 'MID-R');
    await newLine(rootBom, b);
    await newHeader(b, 'MID-B').then((id) => newLine(id, c));

    const result = await explodeBom(READER, rootBom, query({}));
    expect(result.nodes.map((node) => node.componentSkuId)).toEqual([b, c]);
    expect(bySku(result.nodes, b)[0]?.isLeaf).toBe(false);
    expect(bySku(result.nodes, c)[0]?.isLeaf).toBe(true);
  });

  it('★★ 라인 속성으로 거르지 않는다 — SERVICE·optional·대체그룹·TURNKEY 전부 남는다', async () => {
    const a = await newSku('flt-a');
    const rootBom = await newHeader(a, 'FLT-R');
    const variants = [
      { label: 'service', componentRole: 'SERVICE' },
      { label: 'optional', isRequired: false },
      { label: 'alt', alternateGroup: 'ALT-A' },
      { label: 'turnkey', supplyType: 'TURNKEY' },
      { label: 'packaging', componentRole: 'PACKAGING' },
    ];
    const componentIds: string[] = [];
    for (const variant of variants) {
      const component = await newSku(`flt-${variant.label}`);
      componentIds.push(component);
      await newLine(rootBom, component, variant);
    }

    const result = await explodeBom(READER, rootBom, query({}));
    expect(result.nodes).toHaveLength(variants.length);
    expect(result.nodes.map((node) => node.componentSkuId)).toEqual(componentIds);
  });

  it('★ 같은 구성품이 대체그룹만 달리해 두 라인이면 node 도 2개다', async () => {
    const [a, b] = await Promise.all([newSku('dup-a'), newSku('dup-b')]);
    const rootBom = await newHeader(a, 'DUP-R');
    await newLine(rootBom, b, { alternateGroup: null, quantityPer: '2' });
    await newLine(rootBom, b, { alternateGroup: 'ALT-B', quantityPer: '5' });

    const result = await explodeBom(READER, rootBom, query({}));
    expect(bySku(result.nodes, b)).toHaveLength(2);
    expect(bySku(result.nodes, b).map((node) => node.requiredQty)).toEqual(['2', '5']);
  });

  it('★ 결과 정렬 — level asc → lineNo 순 (DB 자연 순서에 의존하지 않는다)', async () => {
    const a = await newSku('ord-a');
    const rootBom = await newHeader(a, 'ORD-R');
    const first = await newSku('ord-1');
    const second = await newSku('ord-2');
    // ⚠️ lineNo 를 **역순으로 삽입**한다 — 삽입 순서로 정렬하면 실패한다.
    await newLine(rootBom, second, { lineNo: 2 });
    await newLine(rootBom, first, { lineNo: 1 });

    const result = await explodeBom(READER, rootBom, query({}));
    expect(result.nodes.map((node) => node.componentSkuId)).toEqual([first, second]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. 다이아몬드 — 경로별 detail 보존 (D-20)
// ═══════════════════════════════════════════════════════════════

describe('★★ 다이아몬드는 순환이 아니고 합산도 아니다 (D-13 · D-20)', () => {
  it('★★ D 가 두 경로로 각각 남는다 — 전역 visited 로 두 번째를 지우지 않는다', async () => {
    // A → B → D  /  A → C → D
    const [a, b, c, d] = await Promise.all([
      newSku('dia-a'),
      newSku('dia-b'),
      newSku('dia-c'),
      newSku('dia-d'),
    ]);
    const rootBom = await newHeader(a, 'DIA-R');
    await newLine(rootBom, b, { quantityPer: '2', lineNo: 1 });
    await newLine(rootBom, c, { quantityPer: '5', lineNo: 2 });
    await newHeader(b, 'DIA-B').then((id) => newLine(id, d, { quantityPer: '10' }));
    await newHeader(c, 'DIA-C').then((id) => newLine(id, d, { quantityPer: '100' }));

    const result = await explodeBom(READER, rootBom, query({ qty: '1' }));

    // ★ D 가 **2개** 다 — 하나로 합치지 않는다.
    const ds = bySku(result.nodes, d);
    expect(ds).toHaveLength(2);
    // ★ 경로가 보존된다.
    expect(ds.map((node) => node.path)).toEqual([
      [a, b],
      [a, c],
    ]);
    // ★ 수량은 경로별로 독립 계산된다 — 2×10 = 20, 5×100 = 500.
    expect(ds.map((node) => node.requiredQty)).toEqual(['20', '500']);
    // ⛔ 합산값 520 이 어디에도 없다.
    expect(result.nodes.map((node) => node.requiredQty)).not.toContain('520');
  });

  it('★★ 같은 level 에서 만나는 다이아몬드도 두 번 남는다', async () => {
    // A → B → D · A → C → D 에서 두 D 가 **같은 level 2** 다.
    const [a, b, c, d] = await Promise.all([
      newSku('dl-a'),
      newSku('dl-b'),
      newSku('dl-c'),
      newSku('dl-d'),
    ]);
    const rootBom = await newHeader(a, 'DL-R');
    await newLine(rootBom, b, { lineNo: 1 });
    await newLine(rootBom, c, { lineNo: 2 });
    await newHeader(b, 'DL-B').then((id) => newLine(id, d));
    await newHeader(c, 'DL-C').then((id) => newLine(id, d));

    const result = await explodeBom(READER, rootBom, query({}));
    const ds = bySku(result.nodes, d);
    expect(ds).toHaveLength(2);
    expect(ds.map((node) => node.level)).toEqual([2, 2]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. 순환 — 손상 graph 방어
// ═══════════════════════════════════════════════════════════════

describe('★★ 순환은 422 다 — 무한 재귀하지 않는다 (D-13)', () => {
  it('★★ A → B → C → B 는 BOM_CYCLE_DETECTED 다', async () => {
    const [a, b, c] = await Promise.all([newSku('cyc-a'), newSku('cyc-b'), newSku('cyc-c')]);
    const rootBom = await newHeader(a, 'CY-R');
    await newLine(rootBom, b);
    await newHeader(b, 'CY-B').then((id) => newLine(id, c));
    await newHeader(c, 'CY-C').then((id) => newLine(id, b)); // ← 되돌아온다

    expect(await codeOf(explodeBom(READER, rootBom, query({})))).toBe(
      ERROR_CODES.BOM_CYCLE_DETECTED,
    );
  });

  it('★★ 자기참조 A → A 도 순환이다', async () => {
    const a = await newSku('self-a');
    const rootBom = await newHeader(a, 'SELF-R');
    // ⚠️ D-12 가 입력 단계에서 막으므로 직접 넣는다 — graph 차원 방어 확인.
    await newLine(rootBom, a);

    expect(await codeOf(explodeBom(READER, rootBom, query({})))).toBe(
      ERROR_CODES.BOM_CYCLE_DETECTED,
    );
  });

  it('★ 순환 오류에 경로가 담긴다 — 어느 edge 를 지울지 알려준다', async () => {
    const [a, b] = await Promise.all([newSku('cp-a'), newSku('cp-b')]);
    const rootBom = await newHeader(a, 'CP-R');
    await newLine(rootBom, b);
    await newHeader(b, 'CP-B').then((id) => newLine(id, a)); // A → B → A

    let caught: unknown;
    try {
      await explodeBom(READER, rootBom, query({}));
    } catch (error) {
      caught = error;
    }
    const details = (caught as { publicDetails?: { cyclePath?: string[] } }).publicDetails;
    expect(details?.cyclePath).toEqual([a, b, a]);
  });

  it('★★ 부분 결과를 돌려주지 않는다 — 던지고 끝난다', async () => {
    const [a, b, c] = await Promise.all([newSku('pr-a'), newSku('pr-b'), newSku('pr-c')]);
    const rootBom = await newHeader(a, 'PR-R');
    await newLine(rootBom, b, { lineNo: 1 });
    await newLine(rootBom, c, { lineNo: 2 });
    await newHeader(c, 'PR-C').then((id) => newLine(id, a));

    await expect(explodeBom(READER, rootBom, query({}))).rejects.toMatchObject({
      code: ERROR_CODES.BOM_CYCLE_DETECTED,
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. maxLevel
// ═══════════════════════════════════════════════════════════════

describe('★★ maxLevel — 초과는 422, 절단 아님 (D-18)', () => {
  /** `depth` 단계 chain 을 만든다. 마지막 SKU 에는 BOM 이 없다(leaf). */
  async function chain(label: string, depth: number): Promise<string> {
    const skus = await Promise.all(
      Array.from({ length: depth + 1 }, (_, index) => newSku(`${label}-${index}`)),
    );
    let rootBom = '';
    for (let index = 0; index < depth; index += 1) {
      const header = await newHeader(skus[index] as string, `${label}${index}`.slice(0, 16));
      await newLine(header, skus[index + 1] as string);
      if (index === 0) rootBom = header;
    }
    return rootBom;
  }

  it('★ depth 1 · maxLevel 1 — leaf 면 성공한다', async () => {
    const rootBom = await chain('m1', 1);
    const result = await explodeBom(READER, rootBom, query({ maxLevel: '1' }));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.isLeaf).toBe(true);
  });

  it('★★ depth 2 · maxLevel 1 — 422 다 (조용히 1단계만 주지 않는다)', async () => {
    const rootBom = await chain('m2', 2);
    expect(await codeOf(explodeBom(READER, rootBom, query({ maxLevel: '1' })))).toBe(
      ERROR_CODES.BOM_MAX_LEVEL_EXCEEDED,
    );
  });

  it('★ depth 2 · maxLevel 2 — 성공한다', async () => {
    const rootBom = await chain('m3', 2);
    const result = await explodeBom(READER, rootBom, query({ maxLevel: '2' }));
    expect(result.nodes.map((node) => node.level)).toEqual([1, 2]);
  });

  it('★★ depth = BOM_MAX_LEVEL 은 기본값으로 성공한다', async () => {
    const rootBom = await chain('m4', BOM_MAX_LEVEL);
    const result = await explodeBom(READER, rootBom, query({}));
    expect(result.maxLevel).toBe(BOM_MAX_LEVEL);
    expect(result.nodes).toHaveLength(BOM_MAX_LEVEL);
    expect(result.nodes.at(-1)?.level).toBe(BOM_MAX_LEVEL);
  });

  it('★★ depth = BOM_MAX_LEVEL + 1 은 기본값에서 422 다', async () => {
    const rootBom = await chain('m5', BOM_MAX_LEVEL + 1);
    expect(await codeOf(explodeBom(READER, rootBom, query({})))).toBe(
      ERROR_CODES.BOM_MAX_LEVEL_EXCEEDED,
    );
  });

  it('★ 라인이 0건인 하위 BOM 은 깊이를 소비하지 않는다 — node 기준 판정', async () => {
    // A → B(level 1), B 에 ACTIVE BOM 이 있지만 라인이 0건이다.
    const [a, b] = await Promise.all([newSku('e0-a'), newSku('e0-b')]);
    const rootBom = await newHeader(a, 'E0-R');
    await newLine(rootBom, b);
    await newHeader(b, 'E0-B'); // 라인 없음

    const result = await explodeBom(READER, rootBom, query({ maxLevel: '1' }));
    expect(result.nodes).toHaveLength(1);
    // ★ 유효 BOM 이 있으므로 leaf 는 아니다 — 그래도 level 2 node 가 없어 통과한다.
    expect(result.nodes[0]?.isLeaf).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. 미확정 수량 (E-1 ~ E-5)
// ═══════════════════════════════════════════════════════════════

describe('★★ 미확정 수량 — null 이지 오류가 아니다 (gap closure E-1 ~ E-5)', () => {
  it('★★ CASE N1 — DRAFT root 의 UNKNOWN 라인은 requiredQty = null 이다', async () => {
    const [a, b] = await Promise.all([newSku('n1-a'), newSku('n1-b')]);
    const rootBom = await newHeader(a, 'N1-R', { status: 'DRAFT' });
    await newLine(rootBom, b, { quantityPer: null, quantityStatus: 'UNKNOWN' });

    const result = await explodeBom(READER, rootBom, query({ qty: '10' }));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.requiredQty).toBeNull();
    expect(result.nodes[0]?.quantityPer).toBeNull();
    expect(result.nodes[0]?.quantityStatus).toBe('UNKNOWN');
  });

  it('★★ CASE N2 — ACTIVE root 의 optional UNKNOWN 도 endpoint 를 실패시키지 않는다', async () => {
    const [a, required, optional] = await Promise.all([
      newSku('n2-a'),
      newSku('n2-req'),
      newSku('n2-opt'),
    ]);
    const rootBom = await newHeader(a, 'N2-R', { status: 'ACTIVE' });
    await newLine(rootBom, required, { quantityPer: '2', lineNo: 1 });
    await newLine(rootBom, optional, {
      quantityPer: null,
      quantityStatus: 'UNKNOWN',
      isRequired: false,
      lineNo: 2,
    });

    const result = await explodeBom(READER, rootBom, query({ qty: '3' }));
    // ⛔ BOM_QTY_UNCONFIRMED 422 가 아니다.
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.requiredQty).toBe('6');
    expect(result.nodes[1]?.requiredQty).toBeNull();
  });

  it('★★ CASE N3 — UNKNOWN 중간 노드 아래로도 구조 전개가 계속된다 (E-2 · E-3)', async () => {
    // A → B(UNKNOWN), B 에 ACTIVE BOM 이 있고 B → C(CONFIRMED)
    const [a, b, c] = await Promise.all([newSku('n3-a'), newSku('n3-b'), newSku('n3-c')]);
    const rootBom = await newHeader(a, 'N3-R');
    await newLine(rootBom, b, { quantityPer: null, quantityStatus: 'UNKNOWN' });
    await newHeader(b, 'N3-B').then((id) => newLine(id, c, { quantityPer: '4' }));

    const result = await explodeBom(READER, rootBom, query({ qty: '10' }));

    // ★ 구조는 온전하다 — B 아래를 잘라내지 않았다.
    expect(result.nodes.map((node) => node.componentSkuId)).toEqual([b, c]);
    // ★ B 는 미상이지만 leaf 가 아니다 (E-3 — isLeaf 는 수량과 독립).
    expect(result.nodes[0]?.requiredQty).toBeNull();
    expect(result.nodes[0]?.isLeaf).toBe(false);
    // ★ C 는 CONFIRMED 인데도 부모가 미상이라 null 이다 (E-2).
    expect(result.nodes[1]?.quantityStatus).toBe('CONFIRMED');
    expect(result.nodes[1]?.quantityPer).toBe('4');
    expect(result.nodes[1]?.requiredQty).toBeNull();
  });

  it('★★ CASE N4 — SUGGESTED 는 정상 계산된다 (E-4)', async () => {
    const [a, b] = await Promise.all([newSku('n4-a'), newSku('n4-b')]);
    const rootBom = await newHeader(a, 'N4-R');
    await newLine(rootBom, b, { quantityPer: '0.5', quantityStatus: 'SUGGESTED' });

    const result = await explodeBom(READER, rootBom, query({ qty: '8' }));
    // ⛔ SUGGESTED 라는 이유로 null 처리·422 하지 않는다.
    expect(result.nodes[0]?.quantityStatus).toBe('SUGGESTED');
    expect(result.nodes[0]?.requiredQty).toBe('4');
  });

  it('★★ CASE N5 — 손상 정합은 완화하지 않는다 (E-5)', async () => {
    // ① UNKNOWN 인데 quantityPer 가 있다.
    const [a1, b1] = await Promise.all([newSku('n5a-a'), newSku('n5a-b')]);
    const bom1 = await newHeader(a1, 'N5A-R');
    await newLine(bom1, b1, { quantityPer: '3', quantityStatus: 'UNKNOWN' });
    expect(await codeOf(explodeBom(READER, bom1, query({})))).toBe(
      ERROR_CODES.BOM_QTY_STATUS_MISMATCH,
    );

    // ② CONFIRMED 인데 quantityPer 가 null 이다.
    const [a2, b2] = await Promise.all([newSku('n5b-a'), newSku('n5b-b')]);
    const bom2 = await newHeader(a2, 'N5B-R');
    await newLine(bom2, b2, { quantityPer: null, quantityStatus: 'CONFIRMED' });
    expect(await codeOf(explodeBom(READER, bom2, query({})))).toBe(
      ERROR_CODES.BOM_QTY_STATUS_MISMATCH,
    );

    // ③ quantityPer 가 0 이다.
    const [a3, b3] = await Promise.all([newSku('n5c-a'), newSku('n5c-b')]);
    const bom3 = await newHeader(a3, 'N5C-R');
    await newLine(bom3, b3, { quantityPer: '0', quantityStatus: 'CONFIRMED' });
    expect(await codeOf(explodeBom(READER, bom3, query({})))).toBe(ERROR_CODES.BOM_QTY_INVALID);
  });

  it('★★ 미상 subtree 안에서도 순환·깊이 방어가 살아 있다', async () => {
    const [a, b, c] = await Promise.all([newSku('nc-a'), newSku('nc-b'), newSku('nc-c')]);
    const rootBom = await newHeader(a, 'NC-R');
    await newLine(rootBom, b, { quantityPer: null, quantityStatus: 'UNKNOWN' });
    await newHeader(b, 'NC-B').then((id) => newLine(id, c));
    await newHeader(c, 'NC-C').then((id) => newLine(id, b));

    expect(await codeOf(explodeBom(READER, rootBom, query({})))).toBe(
      ERROR_CODES.BOM_CYCLE_DETECTED,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. 권한 (D-15)
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — bom.read (D-15)', () => {
  it('★★ EXECUTIVE 도 전개를 읽는다', async () => {
    const [a, b] = await Promise.all([newSku('pm-a'), newSku('pm-b')]);
    const rootBom = await newHeader(a, 'PM-R');
    await newLine(rootBom, b);

    const result = await explodeBom(EXECUTIVE, rootBom, query({}));
    expect(result.nodes).toHaveLength(1);
  });

  it('★★ ADMIN role 이어도 permission 데이터가 없으면 403 — bypass 없음', async () => {
    const [a, b] = await Promise.all([newSku('pn-a'), newSku('pn-b')]);
    const rootBom = await newHeader(a, 'PN-R');
    await newLine(rootBom, b);

    expect(await codeOf(explodeBom(NO_PERMISSION, rootBom, query({})))).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ 권한 검사가 존재 확인보다 먼저다 — 없는 BOM 도 403 이다', async () => {
    expect(
      await codeOf(explodeBom(NO_PERMISSION, '22222222-2222-4222-8222-222222222222', query({}))),
    ).toBe(ERROR_CODES.FORBIDDEN);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. read-only · N+1 부재
// ═══════════════════════════════════════════════════════════════

describe('★★ read-only · batch (D-16 · D-28 · 성능 계약)', () => {
  it('★★ write 0 — header·line·audit 이 하나도 바뀌지 않는다', async () => {
    const client = getPrismaClient();
    const [a, b, c] = await Promise.all([newSku('ro-a'), newSku('ro-b'), newSku('ro-c')]);
    const rootBom = await newHeader(a, 'RO-R');
    await newLine(rootBom, b, { quantityPer: null, quantityStatus: 'UNKNOWN' });
    await newHeader(b, 'RO-B').then((id) => newLine(id, c));

    const headersBefore = await client.bomHeader.findMany({
      where: { parentSku: { skuCode: { startsWith: 'TEX-' } } },
      orderBy: { id: 'asc' },
    });
    const linesBefore = await client.bomLine.findMany({
      where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TEX-' } } } },
      orderBy: { id: 'asc' },
    });
    const auditsBefore = await client.auditLog.count({ where: { entityId: rootBom } });

    await explodeBom(READER, rootBom, query({ qty: '5' }));

    expect(
      await client.bomHeader.findMany({
        where: { parentSku: { skuCode: { startsWith: 'TEX-' } } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(headersBefore);
    expect(
      await client.bomLine.findMany({
        where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TEX-' } } } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(linesBefore);
    // ⛔ AuditLog 0 — 조회는 흔적을 남기지 않는다.
    expect(await client.auditLog.count({ where: { entityId: rootBom } })).toBe(auditsBefore);
  });

  it('★★ N+1 이 없다 — level 당 쿼리 2회(라인 batch + resolver batch)', async () => {
    // 한 level 에 구성품 12개를 두고, node 수가 아니라 **level 수**로 쿼리가
    // 결정되는지 본다.
    const a = await newSku('nq-a');
    const rootBom = await newHeader(a, 'NQ-R');
    for (let index = 0; index < 12; index += 1) {
      await newLine(rootBom, await newSku(`nq-c${index}`), { lineNo: index + 1 });
    }

    const calls: string[] = [];
    const client = getPrismaClient();
    const spy = {
      bomHeader: {
        findUnique: (args: never) => {
          calls.push('bomHeader.findUnique');
          return client.bomHeader.findUnique(args);
        },
        findMany: (args: never) => {
          calls.push('bomHeader.findMany');
          return client.bomHeader.findMany(args);
        },
      },
      bomLine: {
        findMany: (args: never) => {
          calls.push('bomLine.findMany');
          return client.bomLine.findMany(args);
        },
      },
      sku: client.sku,
      supplier: client.supplier,
    };

    const result = await explodeBom(READER, rootBom, query({}), {
      db: spy as unknown as Parameters<typeof explodeBom>[3] extends { db?: infer T }
        ? NonNullable<T>
        : never,
    });

    expect(result.nodes).toHaveLength(12);
    // root 1회 + (라인 1 + resolver 1) × 1 level = 3회. ⛔ 12 + n 이 아니다.
    expect(calls).toEqual(['bomHeader.findUnique', 'bomLine.findMany', 'bomHeader.findMany']);
  });

  it('★★ 3단계여도 쿼리는 1 + 2 × level 이다 — node 수와 무관하다', async () => {
    const [a, b, c, d] = await Promise.all([
      newSku('nq3-a'),
      newSku('nq3-b'),
      newSku('nq3-c'),
      newSku('nq3-d'),
    ]);
    const rootBom = await newHeader(a, 'NQ3-R');
    await newLine(rootBom, b);
    await newHeader(b, 'NQ3-B').then((id) => newLine(id, c));
    await newHeader(c, 'NQ3-C').then((id) => newLine(id, d));

    const calls: string[] = [];
    const client = getPrismaClient();
    const spy = {
      bomHeader: {
        findUnique: (args: never) => {
          calls.push('h');
          return client.bomHeader.findUnique(args);
        },
        findMany: (args: never) => {
          calls.push('r');
          return client.bomHeader.findMany(args);
        },
      },
      bomLine: {
        findMany: (args: never) => {
          calls.push('l');
          return client.bomLine.findMany(args);
        },
      },
      sku: client.sku,
      supplier: client.supplier,
    };

    await explodeBom(READER, rootBom, query({}), { db: spy as never });

    // root 1 + level1(l,r) + level2(l,r) + level3(l,r) + 마지막 빈 frontier 없음
    expect(calls.join('')).toBe('hlrlrlr');
  });
});
