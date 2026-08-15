import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateBomCandidateInTransaction } from '@/modules/bom/application';
import {
  acquireBomCycleGraphLock,
  BOM_CYCLE_GRAPH_LOCK_KEY,
} from '@/modules/bom/infrastructure/cycle-graph-lock';
import { parseBusinessDate } from '@/shared/business-date';
import { disconnectPrisma, getPrismaClient, withTransaction } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

/**
 * BOM 순환 동시성 DB 테스트 (T07-2) — **실제 동시 트랜잭션**.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-28.
 *
 * ## 이 파일이 존재하는 이유
 *
 * 순환 판정은 **그래프 전역 속성**이라 국소(행) 잠금으로 직렬화되지 않는다.
 * "edge 양 끝 SKU 만 잠그면 된다"는 계약은 아래 반례에서 **둘 다 통과**한다.
 *
 * ```
 *   기존:  A → B          C → D
 *   TX1:   B → C 추가     (구 계약의 lock set {B, C})
 *   TX2:   D → A 추가     (구 계약의 lock set {D, A})
 *   ⇒ disjoint → 서로 대기하지 않음 → 둘 다 commit → A→B→C→D→A
 * ```
 *
 * `BOM_CYCLE_GRAPH` **transaction advisory lock** 이 이것을 막는다.
 *
 * ⚠️ 순차 호출(`await tx1; await tx2`)은 동시성 테스트가 아니다. 아래는 두
 *    트랜잭션을 **실제로 겹쳐** 실행하며, sleep 이 아니라 deferred promise
 *    barrier 로 순서를 결정론적으로 만든다.
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TBC-${RUN}-${suffix}`;
const asOf = (iso: string) => parseBusinessDate(iso);
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const EVAL_DATE = asOf('2026-06-01');

let seq = 0;

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TBC-' } } } },
  });
  await client.bomHeader.deleteMany({
    where: { parentSku: { skuCode: { startsWith: 'TBC-' } } },
  });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TBC-' } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

async function newSku(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `동시성 SKU (${label})`,
      itemType: 'FINISHED_GOOD',
    },
    select: { id: true },
  });
  return row.id;
}

/** parent SKU 에 ACTIVE BOM 하나를 만들고 구성품을 붙인다. 헤더 id 를 준다. */
async function newActiveBom(parentSkuId: string, components: readonly string[]): Promise<string> {
  seq += 1;
  const client = getPrismaClient();
  const header = await client.bomHeader.create({
    data: {
      parentSkuId,
      bomType: 'MANUFACTURING',
      version: `v${String(seq).padStart(4, '0')}`,
      status: 'ACTIVE',
      outputUom: 'EA',
      effectiveFrom: d('2020-01-01'),
    },
    select: { id: true },
  });
  let lineNo = 0;
  for (const componentSkuId of components) {
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
  return header.id;
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

/**
 * ★ 다른 트랜잭션이 **BOM graph advisory lock 을 기다리는 중**임을 DB 카탈로그로
 *   확인한다. sleep 으로 "아마 됐겠지" 하지 않고 `pg_locks` 의 실제 상태를 본다.
 *
 * bigint key 는 `classid = key >> 32`, `objid = key & 0xffffffff` 로 인코딩된다.
 * 우리 key 는 2^32 미만이라 `classid = 0` 이다.
 *
 * ⚠️ advisory lock 이 없으면 대기가 발생하지 않아 이 함수가 실패한다 —
 *    그것이 이 테스트를 **회귀 방지선**으로 만드는 지점이다.
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

/**
 * "라인 추가 → 검사" 를 한 트랜잭션에서 수행한다 (§D-45 A안).
 *
 * advisory lock → tentative write → graph read → DFS 순서다. 실패하면 예외가
 * 나고 트랜잭션 전체가 롤백되므로 라인이 남지 않는다.
 *
 * ⚠️ T07-3 의 `POST /lines` 가 하게 될 일을 테스트가 직접 조립한 것이다 —
 *    production endpoint 를 미리 만들지 않는다.
 */
async function addLineWithCycleCheck(input: {
  readonly bomHeaderId: string;
  readonly parentSkuId: string;
  readonly componentSkuId: string;
  readonly beforeValidate?: () => Promise<void>;
  readonly afterLock?: () => void;
}): Promise<void> {
  await withTransaction(
    async (tx) => {
      await validateBomCandidateInTransaction(tx, {
        candidate: { parentSkuId: input.parentSkuId, componentSkuIds: [] },
        evaluationDate: EVAL_DATE,
        beforeGraphRead: async () => {
          // lock 을 잡은 직후 신호를 준다 — 상대 트랜잭션이 여기서 대기 중이어야 한다.
          input.afterLock?.();
          if (input.beforeValidate !== undefined) await input.beforeValidate();

          const max = await tx.bomLine.aggregate({
            where: { bomHeaderId: input.bomHeaderId },
            _max: { lineNo: true },
          });
          await tx.bomLine.create({
            data: {
              bomHeaderId: input.bomHeaderId,
              lineNo: (max._max.lineNo ?? 0) + 1,
              componentSkuId: input.componentSkuId,
              uom: 'EA',
              componentRole: 'MATERIAL',
            },
          });
        },
      });

      // ★ tentative write 이후의 실제 상태로 다시 검사한다 (§D-13 규칙 5).
      const lines = await tx.bomLine.findMany({
        where: { bomHeaderId: input.bomHeaderId },
        select: { componentSkuId: true },
        orderBy: { lineNo: 'asc' },
      });
      await validateBomCandidateInTransaction(tx, {
        candidate: {
          parentSkuId: input.parentSkuId,
          componentSkuIds: lines.map((line) => line.componentSkuId),
        },
        evaluationDate: EVAL_DATE,
      });
    },
    { timeout: 15_000 },
  );
}

// ═══════════════════════════════════════════════════════════════
// advisory lock 자체
// ═══════════════════════════════════════════════════════════════

describe('★ pg_advisory_xact_lock 동작 (D-28)', () => {
  it('lock key 는 고정 상수다', () => {
    expect(BOM_CYCLE_GRAPH_LOCK_KEY).toBe(70_218_001n);
  });

  it('★ 두 번째 트랜잭션은 첫 번째가 commit 할 때까지 대기한다', async () => {
    const order: string[] = [];
    const firstLocked = deferred();
    const releaseFirst = deferred();

    const tx1 = withTransaction(
      async (tx) => {
        await acquireBomCycleGraphLock(tx);
        order.push('tx1:locked');
        firstLocked.resolve();
        await releaseFirst.promise;
        order.push('tx1:commit');
      },
      { timeout: 15_000 },
    );

    await firstLocked.promise;

    let tx2Locked = false;
    const tx2 = withTransaction(
      async (tx) => {
        await acquireBomCycleGraphLock(tx);
        tx2Locked = true;
        order.push('tx2:locked');
      },
      { timeout: 15_000 },
    );

    // tx1 이 아직 잡고 있는 동안 tx2 는 진입하지 못한다.
    await new Promise((resolve) => setImmediate(resolve));
    expect(tx2Locked).toBe(false);

    releaseFirst.resolve();
    await tx1;
    await tx2;

    expect(tx2Locked).toBe(true);
    // ★ tx2 의 lock 획득은 반드시 tx1 commit 이후다.
    expect(order).toEqual(['tx1:locked', 'tx1:commit', 'tx2:locked']);
  });

  it('트랜잭션이 롤백돼도 lock 이 해제된다 — 명시적 unlock 이 없다', async () => {
    await expect(
      withTransaction(async (tx) => {
        await acquireBomCycleGraphLock(tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // 누수됐다면 여기서 영원히 대기한다.
    await withTransaction(async (tx) => {
      await acquireBomCycleGraphLock(tx);
    });

    const held = await getPrismaClient().$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${BOM_CYCLE_GRAPH_LOCK_KEY & 0xffffffffn}`,
    );
    expect(Number(held[0]?.count ?? 0)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// ①  공유 노드 2-edge 직접 순환
// ═══════════════════════════════════════════════════════════════

describe('★ ① 공유 노드 순환 — A→B 와 B→A 를 동시에 추가 (D-28)', () => {
  it('하나만 성공하고 다른 하나는 BOM_CYCLE_DETECTED 다', async () => {
    const a = await newSku('공유A');
    const b = await newSku('공유B');
    // 시작 상태에는 edge 가 없다 — 각각은 정상이고 **합쳐질 때만** 순환이다.
    const bomA = await newActiveBom(a, []);
    const bomB = await newActiveBom(b, []);

    const tx1Locked = deferred();
    const tx2Blocked = deferred();

    const tx1 = addLineWithCycleCheck({
      bomHeaderId: bomA,
      parentSkuId: a,
      componentSkuId: b, // A → B
      afterLock: () => tx1Locked.resolve(),
      beforeValidate: async () => {
        await tx2Blocked.promise;
      },
    });

    await tx1Locked.promise;

    const tx2 = addLineWithCycleCheck({
      bomHeaderId: bomB,
      parentSkuId: b,
      componentSkuId: a, // B → A
    });
    await waitUntilBlockedOnCycleLock();
    tx2Blocked.resolve();

    const results = await Promise.allSettled([tx1, tx2]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(codeOf(rejected[0]?.reason)).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);

    // ★ 최종 그래프에 순환이 없다 — 한 방향만 남는다.
    const client = getPrismaClient();
    const aHasB =
      (await client.bomLine.count({
        where: { bomHeaderId: bomA, componentSkuId: b },
      })) > 0;
    const bHasA =
      (await client.bomLine.count({
        where: { bomHeaderId: bomB, componentSkuId: a },
      })) > 0;
    expect(aHasB && bHasA).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// ②★ disjoint-lock 장주기 순환 — T07-2 최중요 acceptance
// ═══════════════════════════════════════════════════════════════

describe('★★ ② disjoint-lock 장주기 순환 (D-28 필수 acceptance)', () => {
  it('★★ A→B, C→D 에 B→C 와 D→A 를 동시에 추가하면 하나가 BOM_CYCLE_DETECTED 로 실패한다', async () => {
    const a = await newSku('장주기A');
    const b = await newSku('장주기B');
    const c = await newSku('장주기C');
    const dSku = await newSku('장주기D');

    await newActiveBom(a, [b]); // A → B
    const bomB = await newActiveBom(b, []); // B
    await newActiveBom(c, [dSku]); // C → D
    const bomD = await newActiveBom(dSku, []); // D

    const tx1Locked = deferred();
    const tx2Blocked = deferred();

    // TX1: B → C   (구 계약의 lock set {B, C})
    const tx1 = addLineWithCycleCheck({
      bomHeaderId: bomB,
      parentSkuId: b,
      componentSkuId: c,
      afterLock: () => tx1Locked.resolve(),
      // ★ TX2 가 **실제로 advisory lock 에서 대기 중**임을 확인한 뒤에야 진행한다.
      //   lock 이 없으면 대기가 관찰되지 않아 여기서 실패한다.
      beforeValidate: async () => {
        await tx2Blocked.promise;
      },
    });

    await tx1Locked.promise;

    // TX2: D → A   (구 계약의 lock set {D, A}) — TX1 과 **완전히 disjoint** 하다.
    const tx2 = addLineWithCycleCheck({
      bomHeaderId: bomD,
      parentSkuId: dSku,
      componentSkuId: a,
    });

    // ★ 여기가 핵심 관찰이다 — TX2 는 advisory lock 에서 blocked 여야 한다.
    //   구 계약(endpoint row lock)이라면 lock set 이 disjoint 라 대기하지 않는다.
    await waitUntilBlockedOnCycleLock();
    tx2Blocked.resolve();

    const results = await Promise.allSettled([tx1, tx2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    // ★★ 정확히 하나만 성공한다.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // ★ 실패 사유는 순환 감지다 — lock timeout 이나 다른 오류가 아니다.
    expect(codeOf(rejected[0]?.reason)).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);

    // ★★ 최종 DB 그래프에 순환이 0 이다.
    const client = getPrismaClient();
    const bHasC =
      (await client.bomLine.count({ where: { bomHeaderId: bomB, componentSkuId: c } })) > 0;
    const dHasA =
      (await client.bomLine.count({ where: { bomHeaderId: bomD, componentSkuId: a } })) > 0;
    // 둘 다 커밋되면 A→B→C→D→A 가 된다. 하나만 남아야 한다.
    expect(bHasC && dHasA).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// ③ 다이아몬드 동시 mutation — false positive 금지
// ═══════════════════════════════════════════════════════════════

describe('★ ③ 다이아몬드 동시 mutation 은 둘 다 성공한다 (D-28)', () => {
  it('A→B, A→C 에 B→D 와 C→D 를 동시에 추가해도 순환이 아니다', async () => {
    const a = await newSku('다이아A');
    const b = await newSku('다이아B');
    const c = await newSku('다이아C');
    const dSku = await newSku('다이아D');

    await newActiveBom(a, [b, c]); // A → B, A → C
    const bomB = await newActiveBom(b, []);
    const bomC = await newActiveBom(c, []);
    await newActiveBom(dSku, []);

    const results = await Promise.allSettled([
      addLineWithCycleCheck({ bomHeaderId: bomB, parentSkuId: b, componentSkuId: dSku }),
      addLineWithCycleCheck({ bomHeaderId: bomC, parentSkuId: c, componentSkuId: dSku }),
    ]);

    // ★ 직렬화되더라도 정상 DAG mutation 은 둘 다 성공해야 한다.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => codeOf(r.reason))).toEqual([]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

    const client = getPrismaClient();
    const bChildren = await client.bomLine.findMany({
      where: { bomHeader: { parentSkuId: b } },
      select: { componentSkuId: true },
    });
    const cChildren = await client.bomLine.findMany({
      where: { bomHeader: { parentSkuId: c } },
      select: { componentSkuId: true },
    });
    expect(bChildren.map((l) => l.componentSkuId)).toContain(dSku);
    expect(cChildren.map((l) => l.componentSkuId)).toContain(dSku);
  });
});

// ═══════════════════════════════════════════════════════════════
// rollback — 실패한 검사는 흔적을 남기지 않는다
// ═══════════════════════════════════════════════════════════════

describe('★ 검사 실패는 tentative write 를 롤백한다 (D-45 A안)', () => {
  it('순환이면 추가하려던 라인이 DB 에 남지 않는다', async () => {
    const a = await newSku('롤백A');
    const b = await newSku('롤백B');
    await newActiveBom(a, [b]); // A → B
    const bomB = await newActiveBom(b, []);

    await expect(
      addLineWithCycleCheck({ bomHeaderId: bomB, parentSkuId: b, componentSkuId: a }),
    ).rejects.toThrow(/순환/);

    const lines = await getPrismaClient().bomLine.count({ where: { bomHeaderId: bomB } });
    expect(lines).toBe(0);
  });
});
