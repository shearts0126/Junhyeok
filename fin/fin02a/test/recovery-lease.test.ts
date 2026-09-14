import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { acquireLease } from '../src/queue/lease';
import { closeStaleRunManually, listStaleRunCandidates } from '../src/recovery';
import { runRecoveryCli } from '../scripts/recovery';
import { startRun } from '../src/runs/repo';

import { seedAccount, testPool, truncateAll } from './helpers';

/** 복구 절차가 정상 처리 중인 작업을 종료하지 않도록 실행 소유권을 확인한다(FIN-02C 복구 정책). */

let pool: pg.Pool;
let rawDir: string;
const period = { periodFrom: '2026-09-12', periodTo: '2026-09-12' };

beforeAll(() => {
  pool = testPool();
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-rl-'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE fin_job_attempts, fin_collection_jobs, fin_run_leases CASCADE');
});

describe('복구와 소유권', () => {
  it('heartbeat 가 살아 있는 실행은 60분이 지나도 수동 마감이 거부되고, 잠금 해제는 세대값 일치·--confirm 에서만 적용된다', async () => {
    const acc = await seedAccount(pool);
    const job = await pool.query<{ id: string }>(
      "INSERT INTO fin_collection_jobs (request_id, source_account_id, collector_key, period_from, period_to, mode, status) VALUES ('req-rl', $1, 'fx', '2026-09-12', '2026-09-12', 'SCHEDULED', 'RUNNING') RETURNING id",
      [acc.id],
    );
    const lease = (await acquireLease(pool, {
      sourceAccountId: acc.id,
      workerId: 'worker-live',
      jobId: job.rows[0]!.id,
    }))!;
    const run = await startRun(pool, {
      sourceAccountId: acc.id,
      ...period,
      workerId: 'worker-live',
      leaseGeneration: lease.generation,
    });
    await pool.query('UPDATE fin_run_leases SET run_id = $2 WHERE source_account_id = $1', [
      acc.id,
      run.id,
    ]);
    await pool.query(
      "UPDATE fin_source_runs SET started_at = now() - interval '2 hours' WHERE id = $1",
      [run.id],
    ); // 장기 실행이지만 heartbeat 는 최근
    const [cand] = await listStaleRunCandidates(pool);
    expect(cand?.run.id).toBe(run.id); // 확인 후보로는 조회됨
    const refused = await closeStaleRunManually(pool, {
      runId: run.id,
      expectedStartedAt: cand!.run.startedAt,
      actor: 'ops',
      reason: '오래됨',
    });
    expect(refused).toEqual({ applied: false, reason: 'OWNER_ALIVE' }); // 소유자 heartbeat 최근 → 종료하지 않음
    // heartbeat 가 오래된 경우(worker 사망 확인)에만 마감·해제 가능
    await pool.query(
      "UPDATE fin_run_leases SET heartbeat_at = now() - interval '10 minutes' WHERE source_account_id = $1",
      [acc.id],
    );
    const env = {
      FIN02A_DATABASE_URL: process.env['FIN02A_TEST_DATABASE_URL'] ?? '',
      FIN02A_RAW_STORE_DIR: rawDir,
    };
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    expect(
      await runRecoveryCli(
        [
          'release-lease',
          '--account',
          acc.id,
          '--generation',
          '1',
          '--actor',
          'ops',
          '--reason',
          '프로세스 종료 확인',
        ],
        env,
        io,
      ),
    ).toBe(3); // 드라이런
    expect(
      (
        await pool.query('SELECT released_at FROM fin_run_leases WHERE source_account_id = $1', [
          acc.id,
        ])
      ).rows[0].released_at,
    ).toBeNull();
    expect(
      await runRecoveryCli(
        [
          'release-lease',
          '--account',
          acc.id,
          '--generation',
          '2',
          '--actor',
          'ops',
          '--reason',
          'x',
          '--confirm',
        ],
        env,
        io,
      ),
    ).toBe(4); // 세대 불일치
    expect(
      await runRecoveryCli(
        [
          'release-lease',
          '--account',
          acc.id,
          '--generation',
          '1',
          '--actor',
          'ops',
          '--reason',
          '프로세스 종료 확인',
          '--confirm',
        ],
        env,
        io,
      ),
    ).toBe(0);
    const applied = await closeStaleRunManually(pool, {
      runId: run.id,
      expectedStartedAt: cand!.run.startedAt,
      actor: 'ops',
      reason: '프로세스 종료·활성 작업 부재 확인',
    });
    expect(applied.applied).toBe(true);
    const preview = JSON.parse(
      (out.length,
      await (async () => {
        const o: string[] = [];
        await runRecoveryCli(['preview'], env, { out: (l) => o.push(l), err: () => undefined });
        return o[0]!;
      })()),
    ) as { leaseAnomalies: unknown[]; staleRunCandidates: unknown[] };
    expect(preview.leaseAnomalies).toHaveLength(0); // 해제됨
    expect(preview.staleRunCandidates).toHaveLength(0); // 마감됨
  });
});
