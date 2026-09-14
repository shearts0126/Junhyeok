import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runCollection } from '../src/collector/pipeline';
import {
  failed,
  type CollectorContext,
  type RawResponse,
  type StageResult,
} from '../src/collector/types';
import { FsRawStore } from '../src/raw/store';
import { getJob, listAttempts } from '../src/queue/jobs';
import { acquireLease, listLeaseAnomalies, releaseLeaseManually } from '../src/queue/lease';
import type { CollectionJob } from '../src/queue/jobs';
import {
  createQueue,
  createRedis,
  enqueueCollection,
  type CollectionJobData,
  type EnqueueInput,
  type EnqueueResult,
} from '../src/queue/queue';
import { CollectorRegistry } from '../src/queue/registry';
import { decide, DEFAULT_RETRY_POLICY } from '../src/queue/retry';
import { createCollectionWorker, processCollectionJob, type WorkerDeps } from '../src/queue/worker';
import { previewRecovery } from '../src/recovery';
import { startRun } from '../src/runs/repo';

import {
  FixtureCollector,
  secretsWith,
  seedAccount,
  testPool,
  truncateAll,
  type FixtureItem,
} from './helpers';

/**
 * FIN-02C 검증 기준 10건. 시험용 일회용 PostgreSQL + 전용 Redis(FIN02A_REDIS_URL, 시험마다 prefix 분리) + 시험용 수집기.
 * 외부 연동 성공을 뜻하지 않는다. 대기 시간은 시험용으로 짧게 잡는다(운영 기본값은 retry.ts·worker.ts 주석).
 */

let pool: pg.Pool;
let redis: IORedis;
let queue: Queue<CollectionJobData>;
let rawDir: string;
let prefix: string;
const workers: Worker[] = [];
const TOKEN = 'FAKE-TOKEN-QUEUE-000000001';
const items: FixtureItem[] = [
  { key: 'TX-1', data: { amount: '1000' } },
  { key: 'TX-2', data: { amount: '2000' } },
];
const period = { periodFrom: '2026-09-12', periodTo: '2026-09-12' };

beforeAll(() => {
  pool = testPool();
  const url = process.env['FIN02A_REDIS_URL'];
  if (!url) throw new Error('FIN02A_REDIS_URL 이 필요합니다(전용 Redis)');
  redis = createRedis(url);
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-queue-'));
});
afterAll(async () => {
  await queue?.close();
  await redis.quit();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query(
    'TRUNCATE fin_job_attempts, fin_collection_jobs, fin_run_leases, fin_collection_schedules CASCADE',
  );
  prefix = `fin02a-test-${process.pid}-${Date.now()}`;
  await queue?.close();
  queue = createQueue(redis, prefix);
});
afterEach(async () => {
  for (const w of workers.splice(0)) await w.close(true);
});

type EnqueuedOrDuplicate = Extract<EnqueueResult, { job: CollectionJob }>;
/** 시험 편의: 등록 또는 같은 요청 ID 재전송 결과만 기대한다(충돌·등록 실패는 시험 실패). */
async function enq(input: EnqueueInput): Promise<EnqueuedOrDuplicate> {
  const r = await enqueueCollection(pool, queue, input);
  if (!('job' in r)) throw new Error(`unexpected enqueue result: ${r.reason}`);
  return r;
}

function deps(registry: CollectorRegistry, over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    pool,
    rawStore: new FsRawStore(rawDir),
    secrets: secretsWith({ FIN02A_TEST_TOKEN: TOKEN }),
    registry,
    queue,
    connection: redis,
    workerId: over.workerId ?? 'worker-A',
    heartbeatMs: 50,
    lockWaitMs: 100,
    retry: { maxAttempts: 3, delaysMs: [30, 60] },
    concurrency: 2,
    prefix,
    ...over,
  };
}

function startWorker(d: WorkerDeps): Worker {
  const w = createCollectionWorker(d);
  workers.push(w);
  return w;
}

async function waitForJob(
  jobId: string,
  until: (s: string, attempts: number) => boolean,
  timeoutMs = 8000,
): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const j = await getJob(pool, jobId);
    const attempts = (await listAttempts(pool, jobId)).length;
    if (j && until(j.status, attempts)) return j.status;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`timeout: job ${jobId} status=${j?.status} attempts=${attempts}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const terminal = (s: string): boolean =>
  ['SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED', 'NEEDS_REVIEW'].includes(s);

/** 요청 단계에서 지정 시간만큼 멈추는 시험 수집기(동시성·소유권 시험용). */
class SlowCollector extends FixtureCollector {
  started: number[] = [];
  finished: number[] = [];
  constructor(
    private readonly delayMs: number,
    private readonly gate?: Promise<void>,
  ) {
    super({ items });
  }
  override async request(
    ctx: CollectorContext,
    auth: { token: string },
  ): Promise<StageResult<RawResponse>> {
    this.started.push(Date.now());
    if (this.gate) await this.gate;
    await new Promise((r) => setTimeout(r, this.delayMs));
    const r = await super.request(ctx, auth);
    this.finished.push(Date.now());
    return r;
  }
}

/** 처음 n 회는 TRANSIENT 실패, 이후 성공. */
class FlakyCollector extends FixtureCollector {
  calls = 0;
  constructor(
    private readonly failTimes: number,
    private readonly kind: 'TRANSIENT' | 'PERMANENT' = 'TRANSIENT',
    private readonly retryAfterMs?: number,
  ) {
    super({ items });
  }
  override async request(
    ctx: CollectorContext,
    auth: { token: string },
  ): Promise<StageResult<RawResponse>> {
    this.calls += 1;
    if (this.calls <= this.failTimes) return failed('UPSTREAM_503', this.kind, this.retryAfterMs);
    return super.request(ctx, auth);
  }
}

describe('FIN-02C 검증 기준', () => {
  it('1. 같은 요청 ID 를 두 번 넣어도 중복 처리되지 않는다', async () => {
    const acc = await seedAccount(pool);
    const registry = new CollectorRegistry().register('fx', new FixtureCollector({ items }));
    const a = await enq({
      requestId: 'req-1',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    const b = await enq({
      requestId: 'req-1',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    expect(a.enqueued).toBe(true);
    expect(b).toMatchObject({ enqueued: false, reason: 'DUPLICATE_REQUEST_ID' });
    expect(b.job.id).toBe(a.job.id);
    startWorker(deps(registry));
    await waitForJob(a.job.id, terminal);
    // 완료 후 같은 큐 데이터가 다시 전달돼도(중복 전달 가정) 시작 불가로 건너뛴다
    const dup = await processCollectionJob(deps(registry), { jobId: a.job.id, requestId: 'req-1' });
    expect(dup).toMatchObject({ kind: 'SKIPPED', reason: 'JOB_NOT_STARTABLE' });
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_collection_jobs')).rows[0].n).toBe(
      1,
    );
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_source_runs')).rows[0].n).toBe(1);
    expect(await listAttempts(pool, a.job.id)).toHaveLength(1);
  });

  it('2. 새 요청 ID 를 사용한 의도적 재수집은 허용된다', async () => {
    const acc = await seedAccount(pool);
    const registry = new CollectorRegistry().register('fx', new FixtureCollector({ items }));
    const a = await enq({
      requestId: 'req-2a',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    const b = await enq({
      requestId: 'req-2b',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    expect(a.enqueued && b.enqueued).toBe(true);
    startWorker(deps(registry));
    await waitForJob(a.job.id, terminal);
    await waitForJob(b.job.id, terminal);
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_source_runs')).rows[0].n).toBe(2);
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_source_records')).rows[0].n).toBe(
      2,
    ); // 업무 데이터 중복은 관측 처리로 방지
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM fin_source_record_observations')).rows[0].n,
    ).toBe(4); // 실행별 연결은 2회
  });

  it('3. 같은 계정의 두 작업은 동시에 관측을 갱신하지 않는다(계정 잠금으로 직렬화)', async () => {
    const acc = await seedAccount(pool);
    const slow = new SlowCollector(250);
    const registry = new CollectorRegistry().register('slow', slow);
    const a = await enq({
      requestId: 'req-3a',
      sourceAccountId: acc.id,
      collectorKey: 'slow',
      ...period,
      mode: 'SCHEDULED',
    });
    const b = await enq({
      requestId: 'req-3b',
      sourceAccountId: acc.id,
      collectorKey: 'slow',
      ...period,
      mode: 'SCHEDULED',
    });
    startWorker(deps(registry, { concurrency: 2 }));
    await waitForJob(a.job.id, terminal, 10_000);
    await waitForJob(b.job.id, terminal, 10_000);
    expect(slow.started).toHaveLength(2);
    expect(slow.started[1]!).toBeGreaterThanOrEqual(slow.finished[0]!); // 두 번째 외부 요청은 첫 실행 종료 후
    const runs = await pool.query<{ started_at: Date; finished_at: Date }>(
      'SELECT started_at, finished_at FROM fin_source_runs ORDER BY started_at',
    );
    expect(runs.rows[1]!.started_at.getTime()).toBeGreaterThanOrEqual(
      runs.rows[0]!.finished_at.getTime(),
    );
    const leases = await pool.query<{ generation: string; released_at: Date | null }>(
      'SELECT generation::text, released_at FROM fin_run_leases WHERE source_account_id = $1',
      [acc.id],
    );
    expect(leases.rows[0]).toMatchObject({ generation: '2' }); // 잠금 세대 2회
    expect(leases.rows[0]!.released_at).not.toBeNull();
  });

  it('4. 다른 계정의 작업은 독립 실행된다(동시 실행)', async () => {
    const a = await seedAccount(pool, { entity: 'TEST_ENTITY_A', alias: 'A' });
    const b = await seedAccount(pool, { entity: 'TEST_ENTITY_B', alias: 'B' });
    const slow = new SlowCollector(300);
    const registry = new CollectorRegistry().register('slow', slow);
    const ja = await enq({
      requestId: 'req-4a',
      sourceAccountId: a.id,
      collectorKey: 'slow',
      ...period,
      mode: 'SCHEDULED',
    });
    const jb = await enq({
      requestId: 'req-4b',
      sourceAccountId: b.id,
      collectorKey: 'slow',
      ...period,
      mode: 'SCHEDULED',
    });
    startWorker(deps(registry, { concurrency: 2 }));
    await waitForJob(ja.job.id, terminal, 10_000);
    await waitForJob(jb.job.id, terminal, 10_000);
    expect(slow.started).toHaveLength(2);
    expect(Math.abs(slow.started[1]! - slow.started[0]!)).toBeLessThan(250); // 두 요청이 겹쳐서 시작(직렬화 없음)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM fin_source_runs WHERE status = 'SUCCEEDED'",
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it('5. worker 중단 시 heartbeat 이상 후보가 식별되고 자동 마감·탈취되지 않는다', async () => {
    const acc = await seedAccount(pool);
    const jobRow = await pool.query<{ id: string }>(
      "INSERT INTO fin_collection_jobs (request_id, source_account_id, collector_key, period_from, period_to, mode, status) VALUES ('req-5', $1, 'fx', '2026-09-12', '2026-09-12', 'SCHEDULED', 'RUNNING') RETURNING id",
      [acc.id],
    );
    const lease = await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'worker-dead',
      jobId: jobRow.rows[0]!.id,
    });
    const run = await startRun(pool, {
      sourceAccountId: acc.id,
      ...period,
      workerId: 'worker-dead',
      leaseGeneration: lease!.generation,
    });
    await pool.query(
      "UPDATE fin_run_leases SET heartbeat_at = now() - interval '5 minutes', run_id = $2 WHERE source_account_id = $1",
      [acc.id, run.id],
    );
    const anomalies = await listLeaseAnomalies(pool);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      sourceAccountId: acc.id,
      workerId: 'worker-dead',
      generation: 1,
      runId: run.id,
    });
    expect(anomalies[0]!.staleSeconds).toBeGreaterThanOrEqual(290);
    const preview = await previewRecovery(pool, new FsRawStore(rawDir));
    expect(preview.leaseAnomalies.map((x) => x.sourceAccountId)).toEqual([acc.id]);
    // 조회는 상태를 바꾸지 않는다: 실행 RUNNING, 잠금 미해제, 새 작업은 잠금 때문에 대기
    expect(
      (await pool.query('SELECT status FROM fin_source_runs WHERE id = $1', [run.id])).rows[0]
        .status,
    ).toBe('RUNNING');
    expect(
      (
        await pool.query('SELECT released_at FROM fin_run_leases WHERE source_account_id = $1', [
          acc.id,
        ])
      ).rows[0].released_at,
    ).toBeNull();
    const registry = new CollectorRegistry().register('fx', new FixtureCollector({ items }));
    const j = await enq({
      requestId: 'req-5b',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    const r = await processCollectionJob(deps(registry), { jobId: j.job.id, requestId: 'req-5b' });
    expect(r).toMatchObject({ kind: 'DEFERRED', reason: 'LOCK_HELD' });
    expect((await getJob(pool, j.job.id))!.status).toBe('QUEUED');
  });

  it('6. 오래된 worker 의 관측 커밋·종료 결과가 거부되고 새 실행 결과를 덮어쓰지 않는다', async () => {
    const acc = await seedAccount(pool);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const oldCollector = new SlowCollector(0, gate);
    const jobA = await pool.query<{ id: string }>(
      "INSERT INTO fin_collection_jobs (request_id, source_account_id, collector_key, period_from, period_to, mode, status) VALUES ('req-6a', $1, 'slow', '2026-09-12', '2026-09-12', 'SCHEDULED', 'RUNNING') RETURNING id",
      [acc.id],
    );
    const leaseA = (await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'worker-old',
      jobId: jobA.rows[0]!.id,
    }))!;
    const base = {
      pool,
      rawStore: new FsRawStore(rawDir),
      secrets: secretsWith({ FIN02A_TEST_TOKEN: TOKEN }),
    };
    // 이전 worker 가 요청 단계에서 멈춘 상태
    const oldRun = runCollection(base, oldCollector, {
      sourceAccountId: acc.id,
      ...period,
      lease: leaseA,
      jobId: jobA.rows[0]!.id,
    });
    await new Promise((r) => setTimeout(r, 50));
    // 담당자가 이전 worker 사망(heartbeat 정지)을 확인하고 잠금을 수동 해제 → 새 worker 가 세대 2 로 획득해 정상 처리
    await pool.query(
      "UPDATE fin_run_leases SET heartbeat_at = now() - interval '10 minutes' WHERE source_account_id = $1",
      [acc.id],
    );
    expect(
      await releaseLeaseManually(pool, {
        sourceAccountId: acc.id,
        expectedGeneration: 1,
        actor: 'ops',
        reason: 'dead',
        verified: 'OWNER_TERMINATED',
      }),
    ).toMatchObject({ applied: true, generation: 1 });
    const registry = new CollectorRegistry().register(
      'fx',
      new FixtureCollector({ items: [{ key: 'TX-1', data: { amount: 'NEW' } }] }),
    );
    const jobB = await enq({
      requestId: 'req-6b',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    const rB = await processCollectionJob(deps(registry, { workerId: 'worker-new' }), {
      jobId: jobB.job.id,
      requestId: 'req-6b',
    });
    expect(rB).toMatchObject({ kind: 'DONE', jobStatus: 'SUCCEEDED' });
    // 이전 worker 복귀: 대조까지 통과하지만 커밋 펜스에서 거부
    release();
    const outA = await oldRun;
    expect(outA.run.status).toBe('FAILED');
    expect(outA.run.errorCode).toBe('OWNERSHIP_LOST');
    expect(outA.observations).toBeNull();
    const rec = await pool.query<{ payload: { amount: string } }>(
      "SELECT v.payload FROM fin_source_record_versions v JOIN fin_source_records r ON r.id = v.source_record_id WHERE r.source_key = 'TX-1'",
    );
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0]!.payload.amount).toBe('NEW'); // 새 소유자의 관측만 존재
    const jobBRow = await getJob(pool, jobB.job.id);
    expect(jobBRow!.status).toBe('SUCCEEDED');
    expect(
      (
        await pool.query('SELECT status FROM fin_source_runs WHERE id = $1', [
          rB.kind === 'DONE' ? rB.runId : '',
        ])
      ).rows[0].status,
    ).toBe('SUCCEEDED');
    expect(
      (
        await pool.query(
          'SELECT generation::text, worker_id FROM fin_run_leases WHERE source_account_id = $1',
          [acc.id],
        )
      ).rows[0],
    ).toMatchObject({ generation: '2', worker_id: 'worker-new' });
  });

  it('7. 임시 장애만 정해진 횟수(최초 포함 3회)로 재시도되고 시도마다 새 실행 ID 가 연결된다', async () => {
    const acc = await seedAccount(pool);
    const flaky = new FlakyCollector(2);
    const registry = new CollectorRegistry().register('flaky', flaky);
    const j = await enq({
      requestId: 'req-7',
      sourceAccountId: acc.id,
      collectorKey: 'flaky',
      ...period,
      mode: 'SCHEDULED',
    });
    startWorker(deps(registry));
    await waitForJob(j.job.id, (s) => s === 'SUCCEEDED', 10_000);
    const attempts = await listAttempts(pool, j.job.id);
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2, 3]);
    expect(attempts.map((a) => a.outcome)).toEqual(['FAILED', 'FAILED', 'SUCCEEDED']);
    expect(attempts.map((a) => a.retryScheduled)).toEqual([true, true, false]);
    expect(new Set(attempts.map((a) => a.runId)).size).toBe(3); // 시도마다 새 실행 ID
    expect(flaky.calls).toBe(3);
    // 4회 실패면 3회에서 멈춘다
    const always = new FlakyCollector(99);
    registry.register('always', always);
    const j2 = await enq({
      requestId: 'req-7b',
      sourceAccountId: acc.id,
      collectorKey: 'always',
      ...period,
      mode: 'SCHEDULED',
    });
    await waitForJob(j2.job.id, terminal, 10_000);
    expect((await getJob(pool, j2.job.id))!.status).toBe('FAILED');
    expect(await listAttempts(pool, j2.job.id)).toHaveLength(3);
    expect(always.calls).toBe(3);
    // Retry-After 우선, 영구 실패는 재시도 없음(정책 단위 검증)
    expect(
      decide(
        DEFAULT_RETRY_POLICY,
        { status: 'FAILED', failureKind: 'TRANSIENT', errorCode: 'X' },
        1,
        7000,
      ),
    ).toEqual({ action: 'RETRY', delayMs: 7000, jobStatus: 'RETRY_SCHEDULED' });
    expect(
      decide(
        DEFAULT_RETRY_POLICY,
        { status: 'FAILED', failureKind: 'TRANSIENT', errorCode: 'X' },
        2,
      ),
    ).toEqual({ action: 'RETRY', delayMs: 300_000, jobStatus: 'RETRY_SCHEDULED' });
    expect(
      decide(
        DEFAULT_RETRY_POLICY,
        { status: 'FAILED', failureKind: 'PERMANENT', errorCode: 'X' },
        1,
      ),
    ).toEqual({ action: 'STOP', jobStatus: 'FAILED' });
    expect(
      decide(DEFAULT_RETRY_POLICY, { status: 'FAILED', failureKind: 'STORAGE', errorCode: 'X' }, 1),
    ).toEqual({ action: 'STOP', jobStatus: 'NEEDS_REVIEW' });
    expect(
      decide(DEFAULT_RETRY_POLICY, { status: 'FAILED', failureKind: 'UNKNOWN', errorCode: 'X' }, 1),
    ).toEqual({ action: 'STOP', jobStatus: 'NEEDS_REVIEW' });
  });

  it('8. 자격 부족·미구현은 반복 요청하지 않는다', async () => {
    const acc = await seedAccount(pool);
    const counting = new FlakyCollector(0);
    const registry = new CollectorRegistry()
      .register('fx', counting)
      .register('ni', new FixtureCollector({ items, validateNotImplemented: true }));
    const d = deps(registry, { secrets: secretsWith({}) }); // 자격 없음
    const j1 = await enq({
      requestId: 'req-8a',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    expect(await processCollectionJob(d, { jobId: j1.job.id, requestId: 'req-8a' })).toMatchObject({
      kind: 'DONE',
      jobStatus: 'BLOCKED',
      retryScheduled: false,
    });
    expect(await listAttempts(pool, j1.job.id)).toHaveLength(1);
    expect(counting.calls).toBe(0); // 외부 요청 없음
    const j2 = await enq({
      requestId: 'req-8b',
      sourceAccountId: acc.id,
      collectorKey: 'ni',
      ...period,
      mode: 'VERIFICATION',
    });
    expect(
      await processCollectionJob(deps(registry), { jobId: j2.job.id, requestId: 'req-8b' }),
    ).toMatchObject({ kind: 'DONE', jobStatus: 'PARTIAL', retryScheduled: false });
    expect(await listAttempts(pool, j2.job.id)).toHaveLength(1);
    expect(await queue.getDelayedCount()).toBe(0); // 재시도 큐 항목 없음
  });

  it('9. 로그 장애가 작업 성공 결과를 변경하지 않는다', async () => {
    const acc = await seedAccount(pool);
    const registry = new CollectorRegistry().register('fx', new FixtureCollector({ items }));
    const j = await enq({
      requestId: 'req-9',
      sourceAccountId: acc.id,
      collectorKey: 'fx',
      ...period,
      mode: 'SCHEDULED',
    });
    const r = await processCollectionJob(
      deps(registry, {
        log: () => {
          throw new Error('log sink down');
        },
      }),
      { jobId: j.job.id, requestId: 'req-9' },
    );
    expect(r).toMatchObject({ kind: 'DONE', jobStatus: 'SUCCEEDED', logFailed: true });
    expect((await getJob(pool, j.job.id))!.status).toBe('SUCCEEDED');
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM fin_source_runs WHERE status = 'SUCCEEDED'",
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('10. 미구현 수집기는 정기 실행에서 외부 요청 전에 거부된다', async () => {
    const acc = await seedAccount(pool);
    const partial = new FlakyCollector(0);
    Object.assign(partial, {
      implementedStages: ['authenticate', 'request', 'validate', 'normalize'],
    }); // 대조 미구현 선언
    const registry = new CollectorRegistry().register('partial', partial);
    const j = await enq({
      requestId: 'req-10',
      sourceAccountId: acc.id,
      collectorKey: 'partial',
      ...period,
      mode: 'SCHEDULED',
    });
    const r = await processCollectionJob(deps(registry), { jobId: j.job.id, requestId: 'req-10' });
    expect(r).toMatchObject({ kind: 'DONE', jobStatus: 'PARTIAL' });
    expect(partial.calls).toBe(0); // 외부 요청 없음
    const run = await pool.query<{
      error_code: string;
      stages: Record<string, { outcome: string }>;
    }>('SELECT error_code, stages FROM fin_source_runs');
    expect(run.rows[0]!.error_code).toBe('SCHEDULED_REQUIRES_COMPLETE_COLLECTOR');
    expect(run.rows[0]!.stages['request']!.outcome).toBe('SKIPPED');
    // 등록되지 않은 수집기 키도 외부 요청 없이 거부
    const j2 = await enq({
      requestId: 'req-10b',
      sourceAccountId: acc.id,
      collectorKey: 'nope',
      ...period,
      mode: 'SCHEDULED',
    });
    expect(
      await processCollectionJob(deps(registry), { jobId: j2.job.id, requestId: 'req-10b' }),
    ).toMatchObject({ kind: 'SKIPPED', reason: 'COLLECTOR_NOT_REGISTERED' });
    expect((await getJob(pool, j2.job.id))!.status).toBe('FAILED');
    // 정기 실행 설정 구조: 활성화된 스케줄 없음
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM fin_collection_schedules WHERE enabled'))
        .rows[0].n,
    ).toBe(0);
  });
});
