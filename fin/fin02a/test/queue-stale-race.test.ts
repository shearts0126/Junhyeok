import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CollectorContext, RawResponse, StageResult } from '../src/collector/types';
import { FsRawStore } from '../src/raw/store';
import { getJob, listAttempts } from '../src/queue/jobs';
import { acquireLease } from '../src/queue/lease';
import {
  createQueue,
  createRedis,
  enqueueCollection,
  type CollectionJobData,
} from '../src/queue/queue';
import { CollectorRegistry } from '../src/queue/registry';
import { processCollectionJob, type WorkerDeps } from '../src/queue/worker';

import { FixtureCollector, secretsWith, seedAccount, testPool, truncateAll } from './helpers';

/**
 * FIN-02C 잔여 확인: 오래된 작업 상태 조회로 들어온 worker 가 다른 worker 의 시작·완료 상태를 훼손하지 않는지.
 * 순서는 sleep 이 아니라 시험용 게이트(잠금 획득 SQL 앞에서 멈추는 풀 래퍼, 요청 단계에서 멈추는 수집기)로 제어한다.
 */

let pool: pg.Pool;
let redis: IORedis;
let queue: Queue<CollectionJobData>;
let rawDir: string;
let prefix: string;
const TOKEN = 'FAKE-TOKEN-STALE-RACE-0001';
const items = [{ key: 'TX-1', data: { amount: '1000' } }];
const period = { periodFrom: '2026-09-12', periodTo: '2026-09-12' };

beforeAll(() => {
  pool = testPool();
  const url = process.env['FIN02A_REDIS_URL'];
  if (!url) throw new Error('FIN02A_REDIS_URL 이 필요합니다(전용 Redis)');
  redis = createRedis(url);
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-stale-race-'));
});
afterAll(async () => {
  await queue?.close();
  await redis.quit();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE fin_job_attempts, fin_collection_jobs, fin_run_leases CASCADE');
  prefix = `fin02a-stale-${process.pid}-${Date.now()}`;
  await queue?.close();
  queue = createQueue(redis, prefix);
});

/** 시험용 게이트: resolve 전까지 대기하는 Promise 와 "도달" 신호. */
function gate(): {
  wait: Promise<void>;
  open: () => void;
  reached: Promise<void>;
  markReached: () => void;
} {
  let open!: () => void;
  let markReached!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (markReached = r));
  return { wait, open, reached, markReached };
}

/** 특정 SQL(정규식) 직전에 게이트에서 멈추는 풀 래퍼. 작업 상태 조회(getJob)는 통과하고 잠금 획득만 멈춘다. */
function gatedPool(base: pg.Pool, match: RegExp, g: ReturnType<typeof gate>): pg.Pool {
  const wrap =
    (target: { query: (...a: unknown[]) => unknown }) =>
    async (...args: unknown[]): Promise<unknown> => {
      const text =
        typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
      if (match.test(text)) {
        g.markReached();
        await g.wait;
      }
      return target.query(...args);
    };
  const proxy = {
    query: wrap(base as unknown as { query: (...a: unknown[]) => unknown }),
    connect: async () => {
      const client = await base.connect();
      const q = wrap(client as unknown as { query: (...a: unknown[]) => unknown });
      return new Proxy(client, { get: (t, p, r) => (p === 'query' ? q : Reflect.get(t, p, r)) });
    },
    end: () => base.end(),
  };
  return proxy as unknown as pg.Pool;
}

/** 요청 단계에서 게이트가 열릴 때까지 멈추고 호출 횟수를 세는 수집기. */
class GatedCountingCollector extends FixtureCollector {
  requests = 0;
  constructor(private readonly g?: ReturnType<typeof gate>) {
    super({ items });
  }
  override async request(
    ctx: CollectorContext,
    auth: { token: string },
  ): Promise<StageResult<RawResponse>> {
    this.requests += 1;
    if (this.g) {
      this.g.markReached();
      await this.g.wait;
    }
    return super.request(ctx, auth);
  }
}

function deps(registry: CollectorRegistry, over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    pool,
    rawStore: new FsRawStore(rawDir),
    secrets: secretsWith({ FIN02A_TEST_TOKEN: TOKEN }),
    registry,
    queue,
    connection: redis,
    workerId: 'worker-A',
    heartbeatMs: 50,
    lockWaitMs: 100,
    retry: { maxAttempts: 3, delaysMs: [30, 60] },
    prefix,
    ...over,
  };
}

async function jobRow(id: string) {
  return (
    await pool.query<{ status: string; attempt_count: number; queued_at: Date | null }>(
      'SELECT status, attempt_count, queued_at FROM fin_collection_jobs WHERE id = $1',
      [id],
    )
  ).rows[0]!;
}

describe('오래된 작업 상태 조회와 큐 상태 전환 경합', () => {
  it('A. 같은 작업 동시 전달: 한 worker 만 RUNNING 으로 전환·실제 요청하고, 오래된 조회를 가진 worker 의 defer 는 RUNNING 을 건드리지 않는다', async () => {
    const acc = await seedAccount(pool);
    const collector = new GatedCountingCollector(gate());
    const registry = new CollectorRegistry().register('fx', collector);
    const r = await enqueueCollection(pool, queue, {
      requestId: 'req-a',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    const jobId = (r as { job: { id: string } }).job.id;
    const data = { jobId, requestId: 'req-a' };

    // worker-B: 작업을 QUEUED 로 읽은 뒤 잠금 획득 SQL 직전에서 멈춘다(오래된 조회 보유).
    const leaseGate = gate();
    const pB = processCollectionJob(
      deps(registry, {
        workerId: 'worker-B',
        pool: gatedPool(pool, /INSERT INTO fin_run_leases/, leaseGate),
      }),
      data,
    );
    await leaseGate.reached;

    // worker-A: 같은 작업을 읽고 잠금 획득 → 조건부 RUNNING 전환 → 실행 시작 → 요청 단계에서 멈춤.
    const pA = processCollectionJob(deps(registry, { workerId: 'worker-A' }), data);
    await collector['g']!.reached;
    expect(await jobRow(jobId)).toMatchObject({ status: 'RUNNING', attempt_count: 1 });

    // worker-B 재개: 잠금은 A 가 보유 → DEFERRED. 상태는 RUNNING 그대로, 시도·요청 증가 없음.
    leaseGate.open();
    expect(await pB).toEqual({ kind: 'DEFERRED', jobId, reason: 'LOCK_HELD' });
    expect(await jobRow(jobId)).toMatchObject({ status: 'RUNNING', attempt_count: 1 });
    expect(collector.requests).toBe(1);
    expect(await listAttempts(pool, jobId)).toHaveLength(1);

    // worker-A 완료.
    collector['g']!.open();
    expect(await pA).toMatchObject({ kind: 'DONE', jobStatus: 'SUCCEEDED' });
    expect((await getJob(pool, jobId))!.status).toBe('SUCCEEDED');
    expect(collector.requests).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_source_runs')).rows[0].n).toBe(1);
  });

  it('B. 오래된 defer 와 정상 완료: 완료된 작업을 QUEUED 로 되돌리지 않고, 잠금을 얻어도 조건부 시작에 실패하면 자기 잠금만 해제한다', async () => {
    const acc = await seedAccount(pool);
    const collector = new GatedCountingCollector();
    const registry = new CollectorRegistry().register('fx', collector);
    const r = await enqueueCollection(pool, queue, {
      requestId: 'req-b',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    const jobId = (r as { job: { id: string } }).job.id;
    const data = { jobId, requestId: 'req-b' };

    // worker-B: QUEUED 로 읽고 잠금 획득 직전에서 대기.
    const leaseGate = gate();
    const pB = processCollectionJob(
      deps(registry, {
        workerId: 'worker-B',
        pool: gatedPool(pool, /INSERT INTO fin_run_leases/, leaseGate),
      }),
      data,
    );
    await leaseGate.reached;

    // worker-A 가 작업을 끝까지 완료.
    expect(
      await processCollectionJob(deps(registry, { workerId: 'worker-A' }), data),
    ).toMatchObject({ kind: 'DONE', jobStatus: 'SUCCEEDED' });
    const done = await jobRow(jobId);
    expect(done.status).toBe('SUCCEEDED');
    expect(collector.requests).toBe(1);

    // 다른 작업이 같은 계정 잠금을 잡고 있는 상황에서 worker-B 재개 → DEFERRED. 완료 상태·queued_at 불변.
    const otherJob = await pool.query<{ id: string }>(
      "INSERT INTO fin_collection_jobs (request_id, source_account_id, collector_key, period_from, period_to, mode, status) VALUES ('req-b-other', $1, 'fx', '2026-09-12', '2026-09-12', 'SCHEDULED', 'QUEUED') RETURNING id",
      [acc.id],
    );
    const other = (await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'worker-other',
      jobId: otherJob.rows[0]!.id,
    }))!;
    expect(other.generation).toBe(2);
    leaseGate.open();
    expect(await pB).toEqual({ kind: 'DEFERRED', jobId, reason: 'LOCK_HELD' });
    const after = await jobRow(jobId);
    expect(after.status).toBe('SUCCEEDED');
    expect(after.queued_at?.getTime()).toBe(done.queued_at?.getTime());
    expect(await listAttempts(pool, jobId)).toHaveLength(1);
    expect(collector.requests).toBe(1);

    // B2. 잠금이 비어 있을 때 오래된 조회를 가진 worker: 잠금은 얻지만 조건부 시작(QUEUED/RETRY_SCHEDULED 만)에 실패 →
    //     자기 잠금만 해제하고 외부 요청 없이 SKIPPED. 완료 상태·시도 이력 불변.
    const r2 = await enqueueCollection(pool, queue, {
      requestId: 'req-b2',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    const jobId2 = (r2 as { job: { id: string } }).job.id;
    const data2 = { jobId: jobId2, requestId: 'req-b2' };
    await pool.query(
      "UPDATE fin_run_leases SET released_at = now(), release_reason = 'test' WHERE source_account_id = $1 AND released_at IS NULL",
      [acc.id],
    );
    const leaseGate2 = gate();
    const pB2 = processCollectionJob(
      deps(registry, {
        workerId: 'worker-B',
        pool: gatedPool(pool, /INSERT INTO fin_run_leases/, leaseGate2),
      }),
      data2,
    );
    await leaseGate2.reached; // B 는 QUEUED 로 읽었다
    expect(
      await processCollectionJob(deps(registry, { workerId: 'worker-A' }), data2),
    ).toMatchObject({ kind: 'DONE', jobStatus: 'SUCCEEDED' });
    expect(collector.requests).toBe(2);
    leaseGate2.open();
    expect(await pB2).toEqual({ kind: 'SKIPPED', jobId: jobId2, reason: 'JOB_NOT_STARTABLE' });
    expect(await jobRow(jobId2)).toMatchObject({ status: 'SUCCEEDED', attempt_count: 1 });
    expect(await listAttempts(pool, jobId2)).toHaveLength(1);
    expect(collector.requests).toBe(2); // 외부 요청 없음
    const lease = (
      await pool.query(
        'SELECT generation::text, worker_id, released_at, release_reason FROM fin_run_leases WHERE source_account_id = $1',
        [acc.id],
      )
    ).rows[0];
    expect(lease).toMatchObject({ worker_id: 'worker-B', release_reason: 'not-startable' }); // 자기 잠금만 해제
    expect(lease.released_at).not.toBeNull();
  });
});
