import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  failed,
  type CollectorContext,
  type RawResponse,
  type StageResult,
} from '../src/collector/types';
import { withTx } from '../src/db/client';
import { FsRawStore } from '../src/raw/store';
import { beginAttempt, listAttempts } from '../src/queue/jobs';
import {
  createQueue,
  createRedis,
  enqueueCollection,
  safeId,
  type CollectionJobData,
} from '../src/queue/queue';
import { CollectorRegistry } from '../src/queue/registry';
import { processCollectionJob, type WorkerDeps } from '../src/queue/worker';

import { FixtureCollector, secretsWith, seedAccount, testPool, truncateAll } from './helpers';

/**
 * FIN-02C: 재시도 예정 시각(next_attempt_at) 준수. 큐가 예정 시각 전에 전달해도 DB 시각 기준으로 시작을 거부하고,
 * 예약을 보존한 채 시도 횟수·대기 시각을 바꾸지 않는다. 시간은 sleep 대신 DB 값 설정으로 제어한다.
 */

let pool: pg.Pool;
let redis: IORedis;
let queue: Queue<CollectionJobData>;
let rawDir: string;
let prefix: string;
const TOKEN = 'FAKE-TOKEN-RETRY-SCHED-01';
const items = [{ key: 'TX-1', data: { amount: '1000' } }];
const period = { periodFrom: '2026-09-12', periodTo: '2026-09-12' };

beforeAll(() => {
  pool = testPool();
  const url = process.env['FIN02A_REDIS_URL'];
  if (!url) throw new Error('FIN02A_REDIS_URL 이 필요합니다(전용 Redis)');
  redis = createRedis(url);
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-retry-sched-'));
});
afterAll(async () => {
  await queue?.close();
  await redis.quit();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE fin_job_attempts, fin_collection_jobs, fin_run_leases CASCADE');
  prefix = `fin02a-retry-${process.pid}-${Date.now()}`;
  await queue?.close();
  queue = createQueue(redis, prefix);
});

/** 처음 n 회 TRANSIENT 실패(옵션: 공급자 Retry-After), 이후 성공. 요청 횟수를 센다. */
class FlakyCollector extends FixtureCollector {
  requests = 0;
  constructor(
    private readonly failTimes: number,
    private readonly retryAfterMs?: number,
  ) {
    super({ items });
  }
  override async request(
    ctx: CollectorContext,
    auth: { token: string },
  ): Promise<StageResult<RawResponse>> {
    this.requests += 1;
    if (this.requests <= this.failTimes)
      return failed('UPSTREAM_503', 'TRANSIENT', this.retryAfterMs);
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
    retry: { maxAttempts: 3, delaysMs: [60_000, 300_000] }, // 운영 기본값(1분·5분)
    prefix,
    ...over,
  };
}
async function jobState(id: string) {
  return (
    await pool.query<{
      status: string;
      attempt_count: number;
      next_attempt_at: Date | null;
      queued_at: Date | null;
    }>(
      'SELECT status, attempt_count, next_attempt_at, queued_at FROM fin_collection_jobs WHERE id = $1',
      [id],
    )
  ).rows[0]!;
}
async function liveEntries(
  requestId: string,
): Promise<{ id: string; state: string; delay: number }[]> {
  const jobs = await queue.getJobs(['delayed', 'waiting', 'prioritized', 'active']);
  const out = [];
  for (const j of jobs) {
    if (!j.id?.startsWith(`req__${safeId(requestId)}__`)) continue; // 최초 항목(req__<id>) 제외, 예약 항목만
    out.push({ id: j.id, state: await j.getState(), delay: j.opts.delay ?? 0 });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
/** 실제 TRANSIENT 실패 1회를 거쳐 RETRY_SCHEDULED 상태를 만든다(worker 가 __a2 를 정책 대기시간으로 예약). */
async function scheduleViaRealFailure(collector: FlakyCollector, requestId: string) {
  const acc = await seedAccount(pool);
  const registry = new CollectorRegistry().register('fx', collector);
  const r = await enqueueCollection(pool, queue, {
    requestId,
    sourceAccountId: acc.id,
    collectorKey: 'fx',
    ...period,
    mode: 'SCHEDULED',
  });
  const jobId = (r as { job: { id: string } }).job.id;
  const data = { jobId, requestId };
  expect(await processCollectionJob(deps(registry), data)).toMatchObject({
    kind: 'DONE',
    jobStatus: 'RETRY_SCHEDULED',
    retryScheduled: true,
  });
  return { acc, registry, jobId, data };
}

describe('재시도 예정 시각 준수', () => {
  it('A. 예정 시각 이전 재전달: 외부 요청·시도·예정 시각 변경 없이 예약이 유지된다(사전 확인과 최종 방어 모두)', async () => {
    const collector = new FlakyCollector(1);
    const { registry, jobId, data } = await scheduleViaRealFailure(collector, 'req-a');
    const before = await jobState(jobId);
    expect(before).toMatchObject({ status: 'RETRY_SCHEDULED', attempt_count: 1 });
    expect(before.next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(55_000); // 1분 정책
    expect(await liveEntries('req-a')).toMatchObject([{ id: `req__req-a__a2`, state: 'delayed' }]);
    // 사전 확인 경로: 조기 전달 → NOT_DUE, 원래 예약(__a2) 보존
    const early = await processCollectionJob(deps(registry), data);
    expect(early).toMatchObject({
      kind: 'DEFERRED',
      reason: 'NOT_DUE',
      preserved: true,
      nextAttemptAt: before.next_attempt_at,
    });
    expect(collector.requests).toBe(1);
    const after = await jobState(jobId);
    expect(after).toMatchObject({ status: 'RETRY_SCHEDULED', attempt_count: 1 });
    expect(after.next_attempt_at!.getTime()).toBe(before.next_attempt_at!.getTime());
    expect(await listAttempts(pool, jobId)).toHaveLength(1);
    expect(await liveEntries('req-a')).toMatchObject([{ id: `req__req-a__a2`, state: 'delayed' }]); // 예약 하나 그대로
    // 최종 방어 경로: 원래 예약 항목이 사라진 상태(큐 유실)에서 조기 전달 → 남은 대기시간으로 재예약(__t<예정시각>)
    await (await queue.getJob('req__req-a__a2'))!.remove();
    expect(await liveEntries('req-a')).toEqual([]);
    const early2 = await processCollectionJob(deps(registry), data);
    expect(early2).toMatchObject({ kind: 'DEFERRED', reason: 'NOT_DUE', preserved: false });
    const entries = await liveEntries('req-a');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(`req__req-a__t${before.next_attempt_at!.getTime()}`);
    expect(entries[0]!.delay).toBeGreaterThan(50_000);
    expect(entries[0]!.delay).toBeLessThanOrEqual(60_000);
    // 반복 조기 전달은 같은 예약으로 모인다
    expect(
      await processCollectionJob(deps(registry, { workerId: 'worker-B' }), data),
    ).toMatchObject({ kind: 'DEFERRED', reason: 'NOT_DUE', preserved: true });
    expect(await liveEntries('req-a')).toHaveLength(1);
    expect((await jobState(jobId)).next_attempt_at!.getTime()).toBe(
      before.next_attempt_at!.getTime(),
    );
    expect(collector.requests).toBe(1);
    // beginAttempt 직접 호출(잠금 획득 후 상태 변경을 흉내): DB 시각 기준 NOT_DUE, 시도 생성 없음
    const refused = await beginAttempt(pool, { jobId, workerId: 'worker-X', generation: 99 });
    expect(refused).toMatchObject({ ok: false, reason: 'NOT_DUE' });
    expect(await listAttempts(pool, jobId)).toHaveLength(1);
    // RETRY_SCHEDULED 인데 예정 시각이 없으면 잘못된 상태로 거부(즉시 실행 아님)
    await pool.query('UPDATE fin_collection_jobs SET next_attempt_at = NULL WHERE id = $1', [
      jobId,
    ]);
    expect(await beginAttempt(pool, { jobId, workerId: 'worker-X', generation: 99 })).toEqual({
      ok: false,
      reason: 'INVALID_SCHEDULE',
      nextAttemptAt: null,
    });
    expect(await processCollectionJob(deps(registry), data)).toEqual({
      kind: 'SKIPPED',
      jobId,
      reason: 'INVALID_SCHEDULE',
    });
    expect(collector.requests).toBe(1);
  });

  it('B. 예정 시각 도래: 같은 시각 포함 한 번만 시작되고, 중복 전달은 실제 시도를 만들지 않는다', async () => {
    const collector = new FlakyCollector(1);
    const { jobId, data, registry } = await scheduleViaRealFailure(collector, 'req-b');
    // 예정 시각과 정확히 같은 DB 시각: 같은 트랜잭션의 now() 로 설정하고 조건부 시작 → 실행 가능
    const sameInstant = await withTx(pool, async (tx) => {
      await tx.query('UPDATE fin_collection_jobs SET next_attempt_at = now() WHERE id = $1', [
        jobId,
      ]);
      return beginAttempt(tx, { jobId, workerId: 'worker-eq', generation: 7 });
    });
    expect(sameInstant).toMatchObject({ ok: true, attemptNo: 2 });
    // 되돌려서(시험용) 도래한 예정 시각의 정상 경로를 worker 로 확인
    await pool.query(
      "UPDATE fin_collection_jobs SET status = 'RETRY_SCHEDULED', attempt_count = 1, next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [jobId],
    );
    await pool.query('DELETE FROM fin_job_attempts WHERE job_id = $1 AND attempt_no = 2', [jobId]);
    // 중복 전달: 두 worker 가 동시에 처리 → 하나만 시도 2 를 시작하고 다른 하나는 잠금 대기 또는 시작 거부
    const [r1, r2] = await Promise.all([
      processCollectionJob(deps(registry, { workerId: 'worker-A' }), data),
      processCollectionJob(deps(registry, { workerId: 'worker-B' }), data),
    ]);
    expect([r1, r2].filter((r) => r.kind === 'DONE')).toHaveLength(1);
    const other = [r1, r2].find((r) => r.kind !== 'DONE')!;
    expect(['DEFERRED', 'SKIPPED']).toContain(other.kind); // 잠금 대기 또는 조건부 시작 거부(상태가 이미 RUNNING/완료)
    expect([r1, r2].find((r) => r.kind === 'DONE')).toMatchObject({ jobStatus: 'SUCCEEDED' });
    expect(collector.requests).toBe(2); // 실패 1 + 성공 1
    expect(await listAttempts(pool, jobId)).toHaveLength(2);
    expect((await jobState(jobId)).status).toBe('SUCCEEDED');
    // 완료 후 뒤늦은 전달(예약 항목 잔존)은 시작 불가
    expect(await processCollectionJob(deps(registry), data)).toEqual({
      kind: 'SKIPPED',
      jobId,
      reason: 'JOB_NOT_STARTABLE',
    });
    expect(collector.requests).toBe(2);
  });

  it('C. 공급자 Retry-After 가 기본 backoff 보다 길면 그 시각이 보존되고, 반복 조기 전달로 앞당겨지지 않는다', async () => {
    const collector = new FlakyCollector(1, 10 * 60_000); // 공급자 대기 10분 > 정책 1분
    const { jobId, data, registry } = await scheduleViaRealFailure(collector, 'req-c');
    const s0 = await jobState(jobId);
    expect(s0.next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(9.5 * 60_000);
    const entries0 = await liveEntries('req-c');
    expect(entries0).toMatchObject([{ id: 'req__req-c__a2', state: 'delayed' }]);
    expect(entries0[0]!.delay).toBe(10 * 60_000);
    for (const w of ['worker-A', 'worker-B', 'worker-A']) {
      expect(await processCollectionJob(deps(registry, { workerId: w }), data)).toMatchObject({
        kind: 'DEFERRED',
        reason: 'NOT_DUE',
        preserved: true,
      });
    }
    const s1 = await jobState(jobId);
    expect(s1.next_attempt_at!.getTime()).toBe(s0.next_attempt_at!.getTime()); // 앞당김·연장 없음
    expect(s1.attempt_count).toBe(1);
    expect(await listAttempts(pool, jobId)).toHaveLength(1);
    expect(collector.requests).toBe(1);
    expect(await liveEntries('req-c')).toHaveLength(1); // 예약 유실·중복 없음
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM fin_run_leases WHERE released_at IS NULL'))
        .rows[0].n,
    ).toBe(0);
  });
});
