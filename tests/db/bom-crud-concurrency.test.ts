import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  createBom,
  createBomLine,
  BOM_CREATE_PERMISSION,
  BOM_LINE_ENTITY_TYPE,
  BOM_READ_PERMISSION,
  BOM_UPDATE_PERMISSION,
  parseDateOnly,
} from '@/modules/bom/application';
import {
  acquireBomCycleGraphLock,
  BOM_CYCLE_GRAPH_LOCK_KEY,
} from '@/modules/bom/infrastructure/cycle-graph-lock';
import { disconnectPrisma, getPrismaClient, withTransaction } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * BOM CRUD **application mutation path** 동시성 DB 테스트 (T07-3).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-28.
 *
 * ## T07-2 concurrency suite 와 무엇이 다른가
 *
 * T07-2 는 `validateBomCandidateInTransaction` 을 **테스트가 직접 조립해서**
 * 잠금 계약 자체를 증명했다. 여기서는 **production service**
 * (`createBomLine`)를 그대로 두 개 동시에 호출한다 — 즉 route 가 실제로 쓰는
 * 경로에 advisory lock 이 **연결돼 있는지**를 증명한다.
 *
 * ⛔ mock 으로 "lock 을 불렀다"를 확인하지 않는다. 실제 두 트랜잭션이 겹쳐야
 *    wiring 이 증명된다.
 * ⚠️ 순차 호출(`await a; await b`)은 동시성 테스트가 아니다. 아래는 두 번째
 *    트랜잭션이 **실제로 advisory lock 을 기다리는 중**임을 `pg_locks` 로
 *    관찰한 뒤에야 첫 번째를 진행시킨다 — lock 을 제거하면 실패한다.
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TCC-${RUN}-${suffix}`;

const STAFF_ID = 'eee00000-0000-4000-8000-0000000e7001';
const STAFF2_ID = 'eee00000-0000-4000-8000-0000000e7002';
const ACTOR_IDS = [STAFF_ID, STAFF2_ID];

const staff = (id: string, name: string): ActorContext =>
  createActorContext({
    userId: id,
    email: `${id}@deeppoint.test`,
    name,
    active: true,
    roles: ['SCM_STAFF'],
    permissions: [BOM_READ_PERMISSION, BOM_CREATE_PERMISSION, BOM_UPDATE_PERMISSION],
    requestId: `req-${id}`,
  });

const STAFF = staff(STAFF_ID, '담당자1');
const STAFF2 = staff(STAFF2_ID, '담당자2');

let seq = 0;

async function newSku(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `동시성 CRUD SKU (${label})`,
      itemType: 'FINISHED_GOOD',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  return row.id;
}

/** 이미 발효된 ACTIVE BOM (기존 그래프). */
async function existingActiveBom(
  parentSkuId: string,
  ...componentSkuIds: readonly string[]
): Promise<void> {
  seq += 1;
  const client = getPrismaClient();
  const header = await client.bomHeader.create({
    data: {
      parentSkuId,
      bomType: 'MANUFACTURING',
      version: `x${String(seq).padStart(4, '0')}`,
      status: 'ACTIVE',
      outputUom: 'EA',
      effectiveFrom: parseDateOnly('2020-01-01'),
    },
    select: { id: true },
  });
  let lineNo = 0;
  for (const componentSkuId of componentSkuIds) {
    lineNo += 1;
    await client.bomLine.create({
      data: {
        bomHeaderId: header.id,
        lineNo,
        componentSkuId,
        uom: 'EA',
        componentRole: 'MATERIAL',
      },
    });
  }
}

/** 검사 대상 DRAFT BOM — production service 로 만든다. */
async function draftBom(parentSkuId: string): Promise<string> {
  seq += 1;
  const { bom } = await createBom(STAFF, {
    parentSkuId,
    bomType: 'MANUFACTURING',
    version: `d${String(seq).padStart(4, '0')}`,
    effectiveFrom: '2026-06-01',
  });
  return bom.id;
}

/**
 * ★ 다른 트랜잭션이 **BOM graph advisory lock 을 대기 중**임을 `pg_locks` 로 본다.
 *
 * ⚠️ lock 이 없으면 대기 자체가 발생하지 않아 이 함수가 던진다 — 그것이 이
 *    파일을 회귀 방지선으로 만드는 지점이다.
 */
async function waitUntilBlockedOnCycleLock(): Promise<void> {
  const objid = Number(BOM_CYCLE_GRAPH_LOCK_KEY & 0xffffffffn);
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const rows = await getPrismaClient().$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${objid} AND granted = false`,
    );
    if (Number(rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('advisory lock 대기가 관찰되지 않았다 — BOM_CYCLE_GRAPH lock 이 동작하지 않는다');
}

/** 결정론적 순서 제어용 barrier — sleep 을 쓰지 않는다. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
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
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TCC-' } } } },
  });
  await client.bomLine.deleteMany({ where: { componentSku: { skuCode: { startsWith: 'TCC-' } } } });
  await client.bomHeader.deleteMany({ where: { parentSku: { skuCode: { startsWith: 'TCC-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TCC-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: '동시성 테스트' })),
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// ★★ disjoint-edge write skew — production service 경로
// ═══════════════════════════════════════════════════════════════

describe('★★ disjoint-edge 시나리오 — T07-3 mutation path 에서의 실제 semantics (D-28·D-13)', () => {
  /**
   * ⚠️ **중요한 발견 — 이 조합은 T07-3 경로에서 "순환"이 아니다.**
   *
   * T07-2 는 `A→B`, `C→D` 에 동시에 `B→C`, `D→A` 를 넣는 disjoint write skew 를
   * `validateBomCandidateInTransaction` 으로 직접 재현해 advisory lock 이 그것을
   * 막는다는 것을 증명했다. 그런데 **T07-3 의 라인 추가 경로**에서는 같은 조합이
   * 애초에 순환을 만들지 않는다:
   *
   *   - 라인 추가는 **`DRAFT`·`REJECTED` BOM 에만** 허용된다 (D-6)
   *   - cycle graph 는 **다른 SKU 의 DRAFT 를 넣지 않는다** (D-13 규칙 ②)
   *
   * 따라서 `B` 의 DRAFT BOM 과 `D` 의 DRAFT BOM 은 **서로의 edge 를 볼 수 없고**,
   * 두 edge 가 모두 커밋돼도 유효(ACTIVE) 그래프에는 순환이 없다. 순환은 두
   * 버전이 **활성화되는 시점**에 비로소 성립하며, 그래서 D-13 이 **activate 에서
   * 최종 `T` 로 재검사**하도록 정한 것이다(T07-5 범위).
   *
   * ⛔ 그러므로 여기서 "하나는 실패해야 한다"고 단언하면 **틀린 계약을 고정**하게
   *    된다. 이 테스트는 실제 semantics 를 고정하고, lock wiring 증명은 아래
   *    별도 describe 가 담당한다.
   */
  it('★ 두 DRAFT candidate 는 서로의 edge 를 보지 않으므로 둘 다 성공한다 (D-13 규칙 ②)', async () => {
    const a = await newSku('A');
    const b = await newSku('B');
    const c = await newSku('C');
    const d = await newSku('D');

    // 기존 유효 그래프: A → B, C → D (둘 다 ACTIVE)
    await existingActiveBom(a, b);
    await existingActiveBom(c, d);

    const bomB = await draftBom(b);
    const bomD = await draftBom(d);

    // ★ 두 production service 호출을 실제로 겹쳐 실행한다.
    const results = await Promise.allSettled([
      createBomLine(STAFF, bomB, { componentSkuId: c, componentRole: 'MATERIAL' }),
      createBomLine(STAFF2, bomD, { componentSkuId: a, componentRole: 'MATERIAL' }),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const client = getPrismaClient();
    expect(await client.bomLine.count({ where: { bomHeaderId: { in: [bomB, bomD] } } })).toBe(2);

    // ★ 유효(ACTIVE) 그래프에는 순환이 없다 — DRAFT edge 는 아직 발효되지 않았다.
    const activeHeaders = await client.bomHeader.findMany({
      where: { parentSkuId: { in: [a, b, c, d] }, status: 'ACTIVE' },
      select: { parentSkuId: true },
    });
    expect(new Set(activeHeaders.map((header) => header.parentSkuId))).toEqual(new Set([a, c]));
  });

  it('★★ 반대로 상대편이 ACTIVE 면 동시 추가 중 하나가 BOM_CYCLE_DETECTED 다', async () => {
    // A → B 가 ACTIVE 인 상태에서, B 의 DRAFT BOM 두 개가 동시에 A 를 넣으려 한다.
    // 두 트랜잭션 모두 ACTIVE edge 를 보므로 순환이 성립한다.
    const a = await newSku('act-A');
    const b = await newSku('act-B');
    await existingActiveBom(a, b);

    const bom1 = await draftBom(b);
    const bom2 = await draftBom(b);

    const results = await Promise.allSettled([
      createBomLine(STAFF, bom1, { componentSkuId: a, componentRole: 'MATERIAL' }),
      createBomLine(STAFF2, bom2, { componentSkuId: a, componentRole: 'MATERIAL' }),
    ]);

    // 둘 다 A→B→A 를 만들므로 둘 다 거부된다 — 부분 통과가 없다.
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of results) {
      expect(codeOf((result as PromiseRejectedResult).reason)).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);
    }
    const client = getPrismaClient();
    expect(await client.bomLine.count({ where: { bomHeaderId: { in: [bom1, bom2] } } })).toBe(0);
  });
});

describe('★★ createBomLine 은 실제로 BOM_CYCLE_GRAPH lock 을 잡는다 (wiring 증명)', () => {
  /**
   * ⚠️ 두 서비스 호출을 동시에 던져 놓고 "겹치겠지" 하고 기대하면 **경쟁적**이다 —
   *    먼저 시작한 쪽이 상대가 lock 을 요청하기도 전에 커밋해 버리면 대기가
   *    관찰되지 않는다(CI 에서 실제로 그렇게 실패했다).
   *
   * ★ 그래서 **테스트가 직접 lock 을 잡고 붙들고 있는 상태**에서 production
   *   서비스를 호출한다. lock 이 연결돼 있다면 서비스는 **반드시** 대기하므로
   *   관찰이 결정론적이다. 연결돼 있지 않으면 서비스가 그냥 끝나 버려
   *   `waitUntilBlockedOnCycleLock` 이 던진다 — 회귀 방지선은 그대로다.
   */
  it('★ 외부 트랜잭션이 lock 을 쥐고 있으면 createBomLine 이 대기한다', async () => {
    const parent = await newSku('lock-parent');
    const component = await newSku('lock-comp');
    const bom = await draftBom(parent);

    const release = deferred();
    const holderDone = deferred();

    // ① 테스트가 advisory lock 을 잡고 `release` 까지 붙든다.
    const holder = withTransaction(
      async (tx) => {
        await acquireBomCycleGraphLock(tx);
        holderDone.resolve();
        await release.promise;
      },
      { timeout: 30_000 },
    );
    await holderDone.promise;

    // ② production 서비스를 호출한다 — lock 이 연결돼 있으면 여기서 멈춘다.
    const call = createBomLine(STAFF, bom, {
      componentSkuId: component,
      componentRole: 'MATERIAL',
    });

    // ③ 실제 대기 상태를 pg_locks 로 확인한다. ⛔ sleep 으로 가정하지 않는다.
    await waitUntilBlockedOnCycleLock();

    // ④ 놓아 주면 서비스가 진행된다.
    release.resolve();
    await holder;

    const { line } = await call;
    expect(line.bomHeaderId).toBe(bom);
    expect(line.lineNo).toBe(1);
  });

  it('★ lock 이 풀린 뒤에는 정상 속도로 처리된다 — 영구 점유가 아니다', async () => {
    const parent = await newSku('lock-after');
    const component = await newSku('lock-after-c');
    const bom = await draftBom(parent);
    const { line } = await createBomLine(STAFF, bom, {
      componentSkuId: component,
      componentRole: 'MATERIAL',
    });
    expect(line.id).toBeDefined();

    // transaction advisory lock 이므로 커밋과 함께 해제됐다 — 잔량 0.
    const objid = Number(BOM_CYCLE_GRAPH_LOCK_KEY & 0xffffffffn);
    const rows = await getPrismaClient().$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${objid}`,
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });
});

describe('★ 다이아몬드 동시 추가는 둘 다 성공한다 — 과잉 차단이 아니다', () => {
  it('A→B, A→C 에 B→D 와 C→D 를 동시에 추가해도 순환이 아니다', async () => {
    const a = await newSku('dia-A');
    const b = await newSku('dia-B');
    const c = await newSku('dia-C');
    const d = await newSku('dia-D');

    // ★ 같은 parent 에 ACTIVE 2건은 EXCLUDE 위반이다 — 한 BOM 에 두 라인으로 만든다.
    await existingActiveBom(a, b, c);

    const bomB = await draftBom(b);
    const bomC = await draftBom(c);

    const results = await Promise.allSettled([
      createBomLine(STAFF, bomB, { componentSkuId: d, componentRole: 'MATERIAL' }),
      createBomLine(STAFF2, bomC, { componentSkuId: d, componentRole: 'MATERIAL' }),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const client = getPrismaClient();
    expect(await client.bomLine.count({ where: { bomHeaderId: { in: [bomB, bomC] } } })).toBe(2);
  });
});

describe('★ 동시 순환 실패는 audit 도 남기지 않는다', () => {
  it('거부된 쪽의 BomLine audit 이 0건이다', async () => {
    const a = await newSku('aud-A');
    const b = await newSku('aud-B');
    await existingActiveBom(a, b);
    const bomB = await draftBom(b);

    const client = getPrismaClient();
    const before = await client.auditLog.count({
      where: { entityType: BOM_LINE_ENTITY_TYPE, actorId: { in: ACTOR_IDS } },
    });

    const results = await Promise.allSettled([
      createBomLine(STAFF, bomB, { componentSkuId: a, componentRole: 'MATERIAL' }),
      createBomLine(STAFF2, bomB, { componentSkuId: a, componentRole: 'MATERIAL' }),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);

    const after = await client.auditLog.count({
      where: { entityType: BOM_LINE_ENTITY_TYPE, actorId: { in: ACTOR_IDS } },
    });
    expect(after).toBe(before);
    expect(await client.bomLine.count({ where: { bomHeaderId: bomB } })).toBe(0);
  });
});
