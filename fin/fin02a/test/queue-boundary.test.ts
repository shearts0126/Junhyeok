import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CollectorContext, RawResponse, StageResult } from '../src/collector/types';
import { FsRawStore } from '../src/raw/store';
import { bindAttemptRun, getJob, listAttempts, listUnqueuedJobs } from '../src/queue/jobs';
import {
  acquireLease,
  bindLeaseRun,
  heartbeat,
  releaseLease,
  releaseLeaseManually,
} from '../src/queue/lease';
import {
  createQueue,
  createRedis,
  enqueueCollection,
  resyncUnqueuedJobs,
  safeId,
  type CollectionJobData,
} from '../src/queue/queue';
import { CollectorRegistry } from '../src/queue/registry';
import { processCollectionJob, type WorkerDeps } from '../src/queue/worker';
import { closeStaleRunManually, previewRecovery } from '../src/recovery';
import { startRun } from '../src/runs/repo';

import {
  FixtureCollector,
  mustBegin,
  secretsWith,
  seedAccount,
  testPool,
  truncateAll,
} from './helpers';

/**
 * 큐 전달 ↔ DB 작업 기록의 실패 경계(FIN-02C 보완). 시험용 DB + 전용 Redis. 큐의 "정확히 한 번" 을 전제하지 않고
 * 실패 경로(등록 실패·응답 유실·완료 후 재전달·시도 저장 후 중단·잠금 대기·이전 소유자 해제·요청 ID 충돌)를 직접 만든다.
 */

let pool: pg.Pool;
let redis: IORedis;
let queue: Queue<CollectionJobData>;
let rawDir: string;
let prefix: string;
const TOKEN = 'FAKE-TOKEN-BOUNDARY-000001';
const items = [{ key: 'TX-1', data: { amount: '1000' } }];
const period = { periodFrom: '2026-09-12', periodTo: '2026-09-12' };

beforeAll(() => {
  pool = testPool();
  const url = process.env['FIN02A_REDIS_URL'];
  if (!url) throw new Error('FIN02A_REDIS_URL 이 필요합니다(전용 Redis)');
  redis = createRedis(url);
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-boundary-'));
});
afterAll(async () => {
  await queue?.close();
  await redis.quit();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE fin_job_attempts, fin_collection_jobs, fin_run_leases CASCADE');
  prefix = `fin02a-boundary-${process.pid}-${Date.now()}`;
  await queue?.close();
  queue = createQueue(redis, prefix);
});

/** 외부 요청 호출 횟수를 세는 시험 수집기(재전달이 새 외부 수집을 시작하는지 확인용). */
class CountingCollector extends FixtureCollector {
  requests = 0;
  constructor() {
    super({ items });
  }
  override async request(
    ctx: CollectorContext,
    auth: { token: string },
  ): Promise<StageResult<RawResponse>> {
    this.requests += 1;
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
const input = (acc: string, requestId: string) => ({
  requestId,
  sourceAccountId: acc,
  collectorKey: 'fx',
  ...period,
  mode: 'SCHEDULED' as const,
});
async function waitingCount(): Promise<number> {
  const c = await queue.getJobCounts('waiting', 'delayed', 'prioritized');
  return (c['waiting'] ?? 0) + (c['delayed'] ?? 0) + (c['prioritized'] ?? 0);
}

describe('큐 전달과 DB 작업 기록의 실패 경계', () => {
  it('1. DB 작업 생성 후 큐 등록 실패: 작업은 queued_at 없이 남고, resync 가 같은 jobId 로 재등록해 정상 처리된다', async () => {
    const acc = await seedAccount(pool);
    const brokenQueue = {
      add: async () => {
        throw new Error('ECONNRESET (injected)');
      },
    } as unknown as Queue<CollectionJobData>;
    const r = await enqueueCollection(pool, brokenQueue, input(acc.id, 'req-1'));
    expect(r).toMatchObject({
      enqueued: false,
      reason: 'QUEUE_REGISTRATION_FAILED',
      errorClass: 'Error',
    });
    const job = (await getJob(pool, (r as { job: { id: string } }).job.id))!;
    expect(job).toMatchObject({ status: 'QUEUED', queuedAt: null });
    expect((await listUnqueuedJobs(pool)).map((j) => j.id)).toEqual([job.id]);
    expect(await waitingCount()).toBe(0);
    const resynced = await resyncUnqueuedJobs(pool, queue);
    expect(resynced).toEqual([{ jobId: job.id, requestId: 'req-1', status: 'QUEUED' }]);
    expect(await waitingCount()).toBe(1);
    expect((await getJob(pool, job.id))!.queuedAt).not.toBeNull();
    expect(await resyncUnqueuedJobs(pool, queue)).toEqual([]); // 두 번째 resync 는 할 일 없음
    const registry = new CollectorRegistry().register('fx', new CountingCollector());
    const done = await processCollectionJob(deps(registry), { jobId: job.id, requestId: 'req-1' });
    expect(done).toMatchObject({ kind: 'DONE', jobStatus: 'SUCCEEDED' });
  });

  it('2. 큐 등록 성공 후 응답 유실 → 같은 요청 재전송: 새 작업 없이 같은 jobId 로 재등록되고 큐 항목은 하나다', async () => {
    const acc = await seedAccount(pool);
    const first = await enqueueCollection(pool, queue, input(acc.id, 'req-2'));
    expect(first.enqueued).toBe(true);
    const jobId = (first as { job: { id: string } }).job.id;
    // 등록 응답 유실 흉내: queued_at 기록 전에 클라이언트가 죽음
    await pool.query('UPDATE fin_collection_jobs SET queued_at = NULL WHERE id = $1', [jobId]);
    const again = await enqueueCollection(pool, queue, input(acc.id, 'req-2'));
    expect(again).toMatchObject({
      enqueued: false,
      reason: 'DUPLICATE_REQUEST_ID',
      requeued: true,
    });
    expect((again as { job: { id: string } }).job.id).toBe(jobId);
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_collection_jobs')).rows[0].n).toBe(
      1,
    );
    expect(await waitingCount()).toBe(1); // BullMQ 같은 jobId → 중복 추가 없음
    expect((await queue.getJob(`req__${safeId('req-2')}`))?.data.jobId).toBe(jobId);
    const third = await enqueueCollection(pool, queue, input(acc.id, 'req-2'));
    expect(third).toMatchObject({
      enqueued: false,
      reason: 'DUPLICATE_REQUEST_ID',
      requeued: false,
    });
  });

  it('3. 완료된 작업이 다시 전달돼도 새로운 외부 수집·실행·시도가 생기지 않는다', async () => {
    const acc = await seedAccount(pool);
    const c = new CountingCollector();
    const registry = new CollectorRegistry().register('fx', c);
    const r = await enqueueCollection(pool, queue, input(acc.id, 'req-3'));
    const jobId = (r as { job: { id: string } }).job.id;
    const data = { jobId, requestId: 'req-3' };
    expect(await processCollectionJob(deps(registry), data)).toMatchObject({
      kind: 'DONE',
      jobStatus: 'SUCCEEDED',
    });
    expect(c.requests).toBe(1);
    // 큐 재전달(중복 전달·stalled 복귀 흉내): 같은 데이터로 다시 처리
    for (let i = 0; i < 2; i += 1)
      expect(await processCollectionJob(deps(registry, { workerId: `worker-${i}` }), data)).toEqual(
        {
          kind: 'SKIPPED',
          jobId,
          reason: 'JOB_NOT_STARTABLE',
        },
      );
    expect(c.requests).toBe(1); // 외부 요청 없음
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_source_runs')).rows[0].n).toBe(1);
    expect(await listAttempts(pool, jobId)).toHaveLength(1);
    expect((await getJob(pool, jobId))!.status).toBe('SUCCEEDED');
    // 같은 jobId 로 큐에 다시 넣어도 BullMQ 는 새 항목을 만들지 않는다
    await queue.add('collect', data, { jobId: `req__${safeId('req-3')}` });
    expect(await waitingCount()).toBe(1); // 처리되지 않은 원래 항목 하나(시험은 worker 없이 직접 호출했으므로 waiting 유지)
  });

  it('4. 시도 저장 후 worker 중단: 자동 정리 없이 후보로만 남고, 담당자 확인 복구가 실행·잠금·작업·시도를 함께 닫으며 재전달은 SKIPPED', async () => {
    const acc = await seedAccount(pool);
    const c = new CountingCollector();
    const registry = new CollectorRegistry().register('fx', c);
    const r = await enqueueCollection(pool, queue, input(acc.id, 'req-4'));
    const jobId = (r as { job: { id: string } }).job.id;
    // worker 가 잠금 획득·시도 저장·실행 시작까지 하고 죽음
    const lease = (await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'worker-dead',
      jobId,
    }))!;
    const attempt = await mustBegin(pool, {
      jobId,
      workerId: 'worker-dead',
      generation: lease.generation,
    });
    const run = await startRun(pool, {
      sourceAccountId: acc.id,
      ...period,
      workerId: 'worker-dead',
      leaseGeneration: 1,
      jobId,
    });
    await bindAttemptRun(pool, { jobId, attemptId: attempt.attemptId, runId: run.id });
    await bindLeaseRun(pool, lease, run.id);
    await pool.query(
      "UPDATE fin_source_runs SET started_at = now() - interval '2 hours' WHERE id = $1",
      [run.id],
    );
    await pool.query(
      "UPDATE fin_run_leases SET heartbeat_at = now() - interval '10 minutes' WHERE source_account_id = $1",
      [acc.id],
    );
    // 큐가 같은 작업을 다시 전달(stalled 복귀): RUNNING 이므로 시작하지 않는다. 잠금도 잡혀 있어 외부 요청 없음
    expect(
      await processCollectionJob(deps(registry, { workerId: 'worker-B' }), {
        jobId,
        requestId: 'req-4',
      }),
    ).toEqual({
      kind: 'SKIPPED',
      jobId,
      reason: 'JOB_NOT_STARTABLE',
    });
    expect(c.requests).toBe(0);
    const preview = await previewRecovery(pool, new FsRawStore(rawDir));
    const cand = preview.staleRunCandidates.find((x) => x.runId === run.id)!;
    expect(cand.owner).toEqual({ workerId: 'worker-dead', leaseGeneration: 1, jobId });
    expect((await getJob(pool, jobId))!.status).toBe('RUNNING'); // 자동 정리 없음
    const closed = await closeStaleRunManually(pool, {
      runId: run.id,
      expectedStartedAt: new Date(cand.startedAt),
      expectedGeneration: cand.closeArgs.generation,
      actor: 'ops',
      reason: '프로세스 종료 확인',
      verified: 'OWNER_TERMINATED',
    });
    expect(closed).toMatchObject({ applied: true, leaseReleased: true, jobStatus: 'NEEDS_REVIEW' });
    expect((await listAttempts(pool, jobId))[0]).toMatchObject({
      attemptNo: 1,
      outcome: 'MANUAL_CLOSE',
    });
    expect(await heartbeat(pool, lease)).toBe(false);
    // 복구 후 재전달: NEEDS_REVIEW 는 시작 가능 상태가 아니므로 여전히 SKIPPED(새 수집은 새 요청 ID 로만)
    expect(
      await processCollectionJob(deps(registry, { workerId: 'worker-B' }), {
        jobId,
        requestId: 'req-4',
      }),
    ).toMatchObject({
      kind: 'SKIPPED',
      reason: 'JOB_NOT_STARTABLE',
    });
    expect(c.requests).toBe(0);
  });

  it('5. 잠금 대기(DEFERRED)는 시도를 시작하지 않으므로 재시도 횟수를 소진하지 않는다', async () => {
    const acc = await seedAccount(pool);
    const c = new CountingCollector();
    const registry = new CollectorRegistry().register('fx', c);
    const r = await enqueueCollection(pool, queue, input(acc.id, 'req-5'));
    const jobId = (r as { job: { id: string } }).job.id;
    const other = (await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'worker-other',
      jobId,
    }))!;
    // 1회차: 잠금 보유 → LOCK_HELD(다음 시도 시각 = 잠금 대기). 2·3회차: 그 시각 전 조기 전달 → NOT_DUE. 모두 시도 없음.
    expect(await processCollectionJob(deps(registry), { jobId, requestId: 'req-5' })).toEqual({
      kind: 'DEFERRED',
      jobId,
      reason: 'LOCK_HELD',
    });
    for (let i = 0; i < 2; i += 1) {
      expect(
        await processCollectionJob(deps(registry), { jobId, requestId: 'req-5' }),
      ).toMatchObject({
        kind: 'DEFERRED',
        reason: 'NOT_DUE',
      });
    }
    const j = (await getJob(pool, jobId))!;
    expect(j).toMatchObject({ status: 'QUEUED', attemptCount: 0 });
    expect(j.queuedAt).not.toBeNull(); // 지연 재투입 등록 기록
    expect(await listAttempts(pool, jobId)).toEqual([]);
    expect(c.requests).toBe(0);
    expect(await releaseLease(pool, other, 'done')).toBe(true);
    // 잠금 대기로 설정된 미래 next_attempt_at 은 잠금이 풀려도 존중된다. 시험은 DB 시각을 도래시켜 진행한다.
    expect(await processCollectionJob(deps(registry), { jobId, requestId: 'req-5' })).toMatchObject(
      {
        kind: 'DEFERRED',
        reason: 'NOT_DUE',
      },
    );
    await pool.query('UPDATE fin_collection_jobs SET next_attempt_at = now() WHERE id = $1', [
      jobId,
    ]);
    expect(await processCollectionJob(deps(registry), { jobId, requestId: 'req-5' })).toMatchObject(
      {
        kind: 'DONE',
        jobStatus: 'SUCCEEDED',
      },
    );
    expect((await getJob(pool, jobId))!.attemptCount).toBe(1); // 세 번의 대기는 시도로 세지 않았다
    expect(await listAttempts(pool, jobId)).toHaveLength(1);
  });

  it('6. 이전 소유자의 잠금 해제·heartbeat 는 새 소유자의 잠금에 영향을 주지 않는다', async () => {
    const acc = await seedAccount(pool);
    const job = await pool.query<{ id: string }>(
      "INSERT INTO fin_collection_jobs (request_id, source_account_id, collector_key, period_from, period_to, mode, status) VALUES ('req-6', $1, 'fx', '2026-09-12', '2026-09-12', 'SCHEDULED', 'QUEUED') RETURNING id",
      [acc.id],
    );
    const jobId = job.rows[0]!.id;
    const old = (await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'worker-old',
      jobId,
    }))!;
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
    ).toMatchObject({ applied: true });
    const fresh = (await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'worker-new',
      jobId,
    }))!;
    expect(fresh.generation).toBe(2);
    // 이전 소유자 복귀: 해제·heartbeat·펜스 모두 0행
    expect(await releaseLease(pool, old, 'late-release')).toBe(false);
    expect(await heartbeat(pool, old)).toBe(false);
    const row = (
      await pool.query(
        'SELECT generation::text, worker_id, released_at FROM fin_run_leases WHERE source_account_id = $1',
        [acc.id],
      )
    ).rows[0];
    expect(row).toMatchObject({ generation: '2', worker_id: 'worker-new', released_at: null });
    // 담당자 수동 해제도 조회 시점 세대(1)로는 새 잠금을 건드리지 못한다
    expect(
      await releaseLeaseManually(pool, {
        sourceAccountId: acc.id,
        expectedGeneration: 1,
        actor: 'ops',
        reason: 'x',
        verified: 'OWNER_TERMINATED',
      }),
    ).toEqual({ applied: false, reason: 'GENERATION_CHANGED' });
    expect(await heartbeat(pool, fresh)).toBe(true);
  });

  it('7. 같은 요청 ID 를 다른 계정·기간·모드로 재사용하면 명시적 충돌로 거부되고 아무것도 만들지 않는다', async () => {
    const acc = await seedAccount(pool);
    const acc2 = await seedAccount(pool, { externalId: 'EXT-0002', alias: 'B' });
    const first = await enqueueCollection(pool, queue, input(acc.id, 'req-7'));
    expect(first.enqueued).toBe(true);
    const variants = [
      { ...input(acc2.id, 'req-7') },
      { ...input(acc.id, 'req-7'), periodTo: '2026-09-13' },
      { ...input(acc.id, 'req-7'), mode: 'VERIFICATION' as const },
      { ...input(acc.id, 'req-7'), collectorKey: 'other' },
    ];
    for (const v of variants) {
      const r = await enqueueCollection(pool, queue, v);
      expect(r).toMatchObject({ enqueued: false, reason: 'REQUEST_ID_CONFLICT' });
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_collection_jobs')).rows[0].n).toBe(
      1,
    );
    expect(await waitingCount()).toBe(1);
    // 같은 내용은 중복(새 작업 없음), 새 요청 ID 는 허용
    expect(await enqueueCollection(pool, queue, input(acc.id, 'req-7'))).toMatchObject({
      enqueued: false,
      reason: 'DUPLICATE_REQUEST_ID',
    });
    expect((await enqueueCollection(pool, queue, input(acc.id, 'req-7b'))).enqueued).toBe(true);
  });
});
