import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runCollection } from '../src/collector/pipeline';
import type { CollectorContext, RawResponse, StageResult } from '../src/collector/types';
import { FsRawStore } from '../src/raw/store';
import { beginAttempt, bindAttemptRun, getJob, listAttempts } from '../src/queue/jobs';
import {
  acquireLease,
  bindLeaseRun,
  heartbeat,
  releaseLeaseManually,
  type Lease,
} from '../src/queue/lease';
import { closeStaleRunManually, previewRecovery } from '../src/recovery';
import { finishRun, startRun } from '../src/runs/repo';

import { FixtureCollector, secretsWith, seedAccount, testPool, truncateAll } from './helpers';

/**
 * 수동 복구 ↔ 실행 소유권 경합(FIN-02C 보완). 시험용 DB 만 사용한다(Redis 불필요).
 * 규칙: 복구 적용은 잠금 행 → 실행 행 순서로 FOR UPDATE 한 뒤 상태·시작 시각·세대값을 재확인한다. worker 커밋도 같은 순서다.
 */

let pool: pg.Pool;
let rawDir: string;
const TOKEN = 'FAKE-TOKEN-CONTENTION-0001';
const period = { periodFrom: '2026-09-12', periodTo: '2026-09-12' };
const items = [{ key: 'TX-1', data: { amount: '1000' } }];

beforeAll(() => {
  pool = testPool();
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-contention-'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE fin_job_attempts, fin_collection_jobs, fin_run_leases CASCADE');
});

/** 요청 단계에서 gate 가 풀릴 때까지 멈추는 수집기(멈춘 worker 흉내). */
class GatedCollector extends FixtureCollector {
  constructor(private readonly gate: Promise<void>) {
    super({ items });
  }
  override async request(
    ctx: CollectorContext,
    auth: { token: string },
  ): Promise<StageResult<RawResponse>> {
    await this.gate;
    return super.request(ctx, auth);
  }
}

const deps = () => ({
  pool,
  rawStore: new FsRawStore(rawDir),
  secrets: secretsWith({ FIN02A_TEST_TOKEN: TOKEN }),
});

/** worker 가 시도를 저장하고 실행을 시작한 직후 상태를 만든다(60분 경과·heartbeat 노후는 옵션). */
async function ownedRun(opts: { workerId: string; staleHeartbeat?: boolean; oldStart?: boolean }) {
  const acc = await seedAccount(pool);
  const job = await pool.query<{ id: string }>(
    "INSERT INTO fin_collection_jobs (request_id, source_account_id, collector_key, period_from, period_to, mode, status) VALUES ($1, $2, 'fx', '2026-09-12', '2026-09-12', 'SCHEDULED', 'QUEUED') RETURNING id",
    [`req-${opts.workerId}-${Date.now()}`, acc.id],
  );
  const jobId = job.rows[0]!.id;
  const lease = (await acquireLease(pool, {
    sourceAccountId: acc.id,
    workerId: opts.workerId,
    jobId,
  }))!;
  const attempt = await beginAttempt(pool, {
    jobId,
    workerId: opts.workerId,
    generation: lease.generation,
  });
  const run = await startRun(pool, {
    sourceAccountId: acc.id,
    ...period,
    workerId: opts.workerId,
    leaseGeneration: lease.generation,
    jobId,
  });
  await bindAttemptRun(pool, { jobId, attemptId: attempt.attemptId, runId: run.id });
  await bindLeaseRun(pool, lease, run.id);
  if (opts.oldStart !== false)
    await pool.query(
      "UPDATE fin_source_runs SET started_at = now() - interval '2 hours' WHERE id = $1",
      [run.id],
    );
  if (opts.staleHeartbeat)
    await pool.query(
      "UPDATE fin_run_leases SET heartbeat_at = now() - interval '10 minutes' WHERE source_account_id = $1",
      [acc.id],
    );
  return { acc, jobId, lease, run, attempt };
}

async function runRow(runId: string): Promise<{ status: string; error_code: string | null }> {
  return (await pool.query('SELECT status, error_code FROM fin_source_runs WHERE id = $1', [runId]))
    .rows[0];
}
async function leaseRow(
  accId: string,
): Promise<{ generation: string; worker_id: string; released_at: Date | null }> {
  return (
    await pool.query(
      'SELECT generation::text, worker_id, released_at FROM fin_run_leases WHERE source_account_id = $1',
      [accId],
    )
  ).rows[0];
}

describe('수동 복구와 실행 소유권 경합', () => {
  it('A. preview 후 소유권 세대값이 바뀌면 복구를 거부한다(OWNERSHIP_CHANGED)', async () => {
    const { acc, run } = await ownedRun({ workerId: 'w-old', staleHeartbeat: true });
    const preview = await previewRecovery(pool, new FsRawStore(rawDir));
    const cand = preview.staleRunCandidates.find((c) => c.runId === run.id)!;
    expect(cand.owner).toEqual({
      workerId: 'w-old',
      leaseGeneration: 1,
      jobId: expect.any(String),
    });
    expect(cand.lease).toMatchObject({
      generation: 1,
      workerId: 'w-old',
      runId: run.id,
      releasedAt: null,
    });
    expect(cand.lease!.heartbeatStaleSeconds).toBeGreaterThanOrEqual(590);
    expect(cand.closeArgs).toEqual({ run: run.id, startedAt: cand.startedAt, generation: 1 });
    // preview 이후: 담당자가 잠금을 해제하고 새 worker 가 세대 2 로 획득(소유권 변경)
    expect(
      await releaseLeaseManually(pool, {
        sourceAccountId: acc.id,
        expectedGeneration: 1,
        actor: 'ops',
        reason: 'dead',
        verified: 'OWNER_TERMINATED',
      }),
    ).toMatchObject({ applied: true });
    const newLease = await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'w-new',
      jobId: cand.owner.jobId!,
    });
    expect(newLease?.generation).toBe(2);
    const r = await closeStaleRunManually(pool, {
      runId: run.id,
      expectedStartedAt: new Date(cand.startedAt),
      expectedGeneration: cand.closeArgs.generation,
      actor: 'ops',
      reason: '이전 preview 기준',
      verified: 'OWNER_TERMINATED',
    });
    expect(r).toEqual({ applied: false, reason: 'OWNERSHIP_CHANGED' });
    expect((await runRow(run.id)).status).toBe('RUNNING'); // 상태 변경 없음
    expect(await leaseRow(acc.id)).toMatchObject({
      generation: '2',
      worker_id: 'w-new',
      released_at: null,
    }); // 새 소유자 잠금 유지
  });

  it('B. worker 정상 완료가 먼저 확정되면 복구는 적용되지 않는다(NOT_RUNNING)', async () => {
    const acc = await seedAccount(pool);
    const job = await pool.query<{ id: string }>(
      "INSERT INTO fin_collection_jobs (request_id, source_account_id, collector_key, period_from, period_to, mode, status) VALUES ('req-b', $1, 'fx', '2026-09-12', '2026-09-12', 'SCHEDULED', 'RUNNING') RETURNING id",
      [acc.id],
    );
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const lease: Lease = (await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'w-live',
      jobId: job.rows[0]!.id,
    }))!;
    let runId = '';
    const running = runCollection(deps(), new GatedCollector(gate), {
      sourceAccountId: acc.id,
      ...period,
      lease,
      onRunStarted: async (id) => {
        runId = id;
        await bindLeaseRun(pool, lease, id);
        await pool.query(
          "UPDATE fin_source_runs SET started_at = now() - interval '2 hours' WHERE id = $1",
          [id],
        );
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const preview = await previewRecovery(pool, new FsRawStore(rawDir));
    const cand = preview.staleRunCandidates.find((c) => c.runId === runId)!;
    expect(cand).toBeDefined();
    // worker 가 먼저 정상 완료
    open();
    const out = await running;
    expect(out.run.status).toBe('SUCCEEDED');
    const r = await closeStaleRunManually(pool, {
      runId,
      expectedStartedAt: new Date(cand.startedAt),
      expectedGeneration: cand.closeArgs.generation,
      actor: 'ops',
      reason: '늦은 복구',
      verified: 'NO_ACTIVE_WORK',
    });
    expect(r).toEqual({ applied: false, reason: 'NOT_RUNNING' });
    expect(await runRow(runId)).toEqual({ status: 'SUCCEEDED', error_code: null });
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM fin_source_record_observations')).rows[0].n,
    ).toBe(1);
  });

  it('C. 확인된 수동 복구가 먼저 확정되면 이전 worker 의 관측 커밋·종료 갱신·heartbeat 는 모두 거부된다', async () => {
    const acc = await seedAccount(pool);
    const job = await pool.query<{ id: string }>(
      "INSERT INTO fin_collection_jobs (request_id, source_account_id, collector_key, period_from, period_to, mode, status) VALUES ('req-c', $1, 'fx', '2026-09-12', '2026-09-12', 'SCHEDULED', 'QUEUED') RETURNING id",
      [acc.id],
    );
    const jobId = job.rows[0]!.id;
    const lease = (await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'w-paused',
      jobId,
    }))!;
    const attempt = await beginAttempt(pool, {
      jobId,
      workerId: 'w-paused',
      generation: lease.generation,
    });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let runId = '';
    const paused = runCollection(deps(), new GatedCollector(gate), {
      sourceAccountId: acc.id,
      ...period,
      lease,
      jobId,
      onRunStarted: async (id) => {
        runId = id;
        await bindAttemptRun(pool, { jobId, attemptId: attempt.attemptId, runId: id });
        await bindLeaseRun(pool, lease, id);
        await pool.query(
          "UPDATE fin_source_runs SET started_at = now() - interval '2 hours' WHERE id = $1",
          [id],
        );
        await pool.query(
          "UPDATE fin_run_leases SET heartbeat_at = now() - interval '10 minutes' WHERE source_account_id = $1",
          [acc.id],
        );
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const preview = await previewRecovery(pool, new FsRawStore(rawDir));
    const cand = preview.staleRunCandidates.find((c) => c.runId === runId)!;
    // 담당자가 소유자 종료를 확인(실제로는 멈춰 있을 뿐인 worker)하고 복구 적용
    const r = await closeStaleRunManually(pool, {
      runId,
      expectedStartedAt: new Date(cand.startedAt),
      expectedGeneration: cand.closeArgs.generation,
      actor: 'ops',
      reason: '프로세스 종료 확인',
      verified: 'OWNER_TERMINATED',
    });
    expect(r).toMatchObject({ applied: true, leaseReleased: true, jobStatus: 'NEEDS_REVIEW' });
    // 이전 worker 복귀: 대조까지 통과하지만 커밋 펜스에서 거부되고, 종료 갱신도 0행(RUNNING 아님)이라 되살리지 못한다
    open();
    const out = await paused;
    expect(out.finalized).toBe(false);
    expect(out.unrecordedFailure?.originalErrorCode).toBe('OWNERSHIP_LOST');
    expect(out.observations).toBeNull();
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM fin_source_record_observations')).rows[0].n,
    ).toBe(0);
    expect(await runRow(runId)).toEqual({ status: 'FAILED', error_code: 'RECOVERY_MANUAL_CLOSE' });
    expect(await heartbeat(pool, lease)).toBe(false); // heartbeat 로도 되살릴 수 없음
    expect(await leaseRow(acc.id)).toMatchObject({
      generation: '1',
      released_at: expect.any(Date),
    });
    expect((await getJob(pool, jobId))!.status).toBe('NEEDS_REVIEW');
    expect((await listAttempts(pool, jobId))[0]).toMatchObject({
      attemptNo: 1,
      outcome: 'MANUAL_CLOSE',
      runId,
    });
  });

  it('D. heartbeat 노후·60분 경과만 있고 담당자 확인 입력이 없으면 마감·해제 모두 거부한다', async () => {
    const { acc, run, lease } = await ownedRun({ workerId: 'w-stale', staleHeartbeat: true });
    const preview = await previewRecovery(pool, new FsRawStore(rawDir));
    expect(preview.staleRunCandidates.map((c) => c.runId)).toEqual([run.id]); // 후보로는 보인다
    expect(preview.leaseAnomalies.map((a) => a.sourceAccountId)).toEqual([acc.id]);
    const close = await closeStaleRunManually(pool, {
      runId: run.id,
      expectedStartedAt: run.startedAt,
      expectedGeneration: 1,
      actor: 'ops',
      reason: 'heartbeat 10분 정지',
    });
    expect(close).toEqual({ applied: false, reason: 'CONFIRMATION_REQUIRED' });
    const rel = await releaseLeaseManually(pool, {
      sourceAccountId: acc.id,
      expectedGeneration: 1,
      actor: 'ops',
      reason: 'stale',
    });
    expect(rel).toEqual({ applied: false, reason: 'CONFIRMATION_REQUIRED' });
    expect((await runRow(run.id)).status).toBe('RUNNING');
    expect(await leaseRow(acc.id)).toMatchObject({ generation: '1', released_at: null });
    expect(await heartbeat(pool, lease)).toBe(true); // 소유자는 그대로 유효
  });

  it('E. 실제 행 잠금 경합: worker 커밋 트랜잭션이 잠금 행을 먼저 잡으면 복구는 그 뒤에 재확인해 NOT_RUNNING 으로 끝난다', async () => {
    const { acc, run, lease } = await ownedRun({ workerId: 'w-commit', staleHeartbeat: true });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // worker 커밋 순서: 잠금 행 FOR UPDATE → 실행 종료 UPDATE
      const held = await client.query(
        'SELECT 1 FROM fin_run_leases WHERE source_account_id = $1 AND worker_id = $2 AND generation = $3 AND released_at IS NULL FOR UPDATE',
        [acc.id, lease.workerId, lease.generation],
      );
      expect(held.rowCount).toBe(1);
      // 복구가 동시에 시작: 잠금 행에서 대기한다(아직 아무것도 바꾸지 못함)
      const closing = closeStaleRunManually(pool, {
        runId: run.id,
        expectedStartedAt: run.startedAt,
        expectedGeneration: 1,
        actor: 'ops',
        reason: '동시 복구',
        verified: 'OWNER_TERMINATED',
      });
      await new Promise((r) => setTimeout(r, 150));
      expect((await runRow(run.id)).status).toBe('RUNNING');
      await finishRun(client, run.id, {
        status: 'SUCCEEDED',
        stages: {},
        sourceAsOf: null,
        receivedCount: 0,
      });
      await client.query('COMMIT');
      expect(await closing).toEqual({ applied: false, reason: 'NOT_RUNNING' });
    } finally {
      client.release();
    }
    expect(await runRow(run.id)).toEqual({ status: 'SUCCEEDED', error_code: null });
  });
});
