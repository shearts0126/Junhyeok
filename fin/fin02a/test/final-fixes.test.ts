import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isSchedulable, runCollection } from '../src/collector/pipeline';
import { FsRawStore, MemoryRawStore } from '../src/raw/store';
import { closeStaleRunManually, listStaleRunCandidates, previewRecovery } from '../src/recovery';
import { startRun } from '../src/runs/repo';

import {
  faultyPool,
  FixtureCollector,
  secretsWith,
  seedAccount,
  testPool,
  truncateAll,
} from './helpers';

/**
 * 3차 검토 지적(인증 실패 분류, 로그 예외 격리)과 확정 정책(수동 복구, 검증 모드)의 회귀 시험.
 * 시험용 일회용 PostgreSQL + 가상 데이터. 외부 연동 성공을 뜻하지 않는다.
 */

let pool: pg.Pool;
let rawDir: string;
const TOKEN = 'FAKE-TOKEN-ABCDEFGHIJ-0002';
const period = { periodFrom: '2026-09-12', periodTo: '2026-09-12' };
const items = [{ key: 'TX-1', data: { amount: '1000' } }];
const deps = (
  over: { pool?: pg.Pool; secrets?: Record<string, string>; log?: (l: string) => void } = {},
) => ({
  pool: over.pool ?? pool,
  rawStore: new FsRawStore(rawDir),
  secrets: secretsWith(over.secrets ?? { FIN02A_TEST_TOKEN: TOKEN }),
  ...(over.log ? { log: over.log } : {}),
});

beforeAll(() => {
  pool = testPool();
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-final-'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
});

describe('2. 인증 실패 분류', () => {
  it('자격 부족 → BLOCKED/CREDENTIALS, 인증 서버 일시 장애 → FAILED/TRANSIENT, 인증 중 예외 → FAILED/UNKNOWN', async () => {
    const acc = await seedAccount(pool);
    const noCred = await runCollection(deps({ secrets: {} }), new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect([noCred.run.status, noCred.run.failureKind, noCred.run.errorCode]).toEqual([
      'BLOCKED',
      'CREDENTIALS',
      'NO_CREDENTIALS',
    ]);

    const transient = await runCollection(
      deps(),
      new FixtureCollector({ items, authTransient: true }),
      { sourceAccountId: acc.id, ...period },
    );
    expect([transient.run.status, transient.run.failureKind, transient.run.errorCode]).toEqual([
      'FAILED',
      'TRANSIENT',
      'AUTH_SERVER_TIMEOUT',
    ]);
    expect(transient.run.stages.authenticate).toEqual({
      outcome: 'FAILED',
      code: 'AUTH_SERVER_TIMEOUT',
    });

    const thrown = await runCollection(
      deps(),
      new FixtureCollector({ items, authThrows: 'socket hang up token=FAKE-SHOULD-NOT-PERSIST' }),
      { sourceAccountId: acc.id, ...period },
    );
    expect([
      thrown.run.status,
      thrown.run.failureKind,
      thrown.run.errorCode,
      thrown.run.errorClass,
    ]).toEqual(['FAILED', 'UNKNOWN', 'UNHANDLED_AUTHENTICATE', 'Error']);
    expect(JSON.stringify(thrown)).not.toContain('FAKE-SHOULD-NOT-PERSIST');
    const blocked = await pool.query(
      "SELECT count(*)::int AS n FROM fin_source_runs WHERE status = 'BLOCKED'",
    );
    expect(blocked.rows[0].n).toBe(1); // 자격 부족만 BLOCKED
  });
});

describe('3. 로그 예외 격리', () => {
  it('성공 종료 후 로그 콜백 예외: DB 는 SUCCEEDED, 반환은 finalized=true·관측 포함·logFailed=true', async () => {
    const acc = await seedAccount(pool);
    const r = await runCollection(
      deps({
        log: () => {
          throw new Error('log sink down');
        },
      }),
      new FixtureCollector({ items }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(r.finalized).toBe(true);
    expect(r.logFailed).toBe(true);
    expect(r.run.status).toBe('SUCCEEDED');
    expect(r.observations?.inserted).toBe(1);
    expect(r.unrecordedFailure).toBeUndefined();
    const db = await pool.query('SELECT status FROM fin_source_runs WHERE id = $1', [r.runId]);
    expect(db.rows[0].status).toBe('SUCCEEDED'); // 저장 상태와 반환 상태 일치
  });

  it('실패 종료 후 로그 콜백 예외: DB 는 FAILED, finalized=true 유지, 종료 기록 장애로 오인하지 않음', async () => {
    const acc = await seedAccount(pool);
    let calls = 0;
    const r = await runCollection(
      deps({
        log: () => {
          calls += 1;
          throw new Error('log sink down');
        },
      }),
      new FixtureCollector({ items, requestFails: true }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(r.finalized).toBe(true);
    expect(r.logFailed).toBe(true);
    expect(r.unrecordedFailure).toBeUndefined();
    expect(r.run.status).toBe('FAILED');
    expect(r.run.errorCode).toBe('NETWORK');
    expect(calls).toBe(1); // 로그 오류를 같은 로그 함수로 다시 출력하지 않는다(재귀 없음)
    expect(
      (await pool.query('SELECT status FROM fin_source_runs WHERE id = $1', [r.runId])).rows[0]
        .status,
    ).toBe('FAILED');
  });

  it('로그 장애와 DB 종료 기록 장애는 구분된다', async () => {
    const acc = await seedAccount(pool);
    const r = await runCollection(
      deps({
        pool: faultyPool(pool, /UPDATE fin_source_runs/),
        log: () => {
          throw new Error('log sink down');
        },
      }),
      new FixtureCollector({ items, requestFails: true }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(r.finalized).toBe(false);
    expect(r.logFailed).toBe(true);
    expect(r.unrecordedFailure?.originalErrorCode).toBe('NETWORK');
  });
});

describe('4. 수동 복구 정책', () => {
  it('60분 이상 RUNNING 은 확인 후보로만 조회되고 자동 마감되지 않으며, 정상 장기 실행은 시간 경과만으로 종료되지 않는다', async () => {
    const acc = await seedAccount(pool);
    const longRunning = await startRun(pool, { sourceAccountId: acc.id, ...period }); // 아직 정상 진행 중인 실행이라고 가정
    const recent = await startRun(pool, { sourceAccountId: acc.id, ...period });
    await pool.query(
      "UPDATE fin_source_runs SET started_at = now() - interval '90 minutes' WHERE id = $1",
      [longRunning.id],
    );
    const preview = await previewRecovery(pool, new MemoryRawStore());
    expect(preview.staleRunCandidates.map((c) => c.runId)).toEqual([longRunning.id]);
    expect(preview.staleRunCandidates[0]!.ageMinutes).toBeGreaterThanOrEqual(90);
    expect(preview.orphanRawKeys).toEqual([]);
    // 미리보기·후보 조회 후에도 상태는 그대로(자동 마감 없음)
    const statuses = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM fin_source_runs',
    );
    expect(statuses.rows.every((s) => s.status === 'RUNNING')).toBe(true);
    expect(statuses.rows.map((s) => s.id).sort()).toEqual([longRunning.id, recent.id].sort());
  });

  it('담당자 확인 후 적용: 주체·사유 기록, 적용 직전 재확인으로 상태 변경 시 마감하지 않음', async () => {
    const acc = await seedAccount(pool);
    const stale = await startRun(pool, { sourceAccountId: acc.id, ...period });
    await pool.query(
      "UPDATE fin_source_runs SET started_at = now() - interval '2 hours' WHERE id = $1",
      [stale.id],
    );
    const [cand] = await listStaleRunCandidates(pool);
    expect(cand?.run.id).toBe(stale.id);
    // 입력 검증: 주체·사유 없으면 거부
    expect(
      await closeStaleRunManually(pool, {
        runId: stale.id,
        expectedStartedAt: cand!.run.startedAt,
        actor: ' ',
        reason: 'x',
        verified: 'OWNER_TERMINATED',
      }),
    ).toEqual({ applied: false, reason: 'INVALID_INPUT' });
    // 담당자의 명시적 확인 입력이 없으면 거부(heartbeat 노후·경과 시간은 대체 근거가 아니다)
    expect(
      await closeStaleRunManually(pool, {
        runId: stale.id,
        expectedStartedAt: cand!.run.startedAt,
        actor: 'ops-a',
        reason: '오래됨',
      }),
    ).toEqual({ applied: false, reason: 'CONFIRMATION_REQUIRED' });
    // 후보 조회 후 상태가 바뀐 경우(다른 경로로 종료됨): 마감하지 않음
    const finishedElsewhere = await startRun(pool, { sourceAccountId: acc.id, ...period });
    await pool.query(
      "UPDATE fin_source_runs SET started_at = now() - interval '2 hours' WHERE id = $1",
      [finishedElsewhere.id],
    );
    const [c2] = (await listStaleRunCandidates(pool)).filter(
      (c) => c.run.id === finishedElsewhere.id,
    );
    await pool.query(
      "UPDATE fin_source_runs SET status = 'FAILED', finished_at = now(), failure_kind = 'UNKNOWN' WHERE id = $1",
      [finishedElsewhere.id],
    );
    expect(
      await closeStaleRunManually(pool, {
        runId: finishedElsewhere.id,
        expectedStartedAt: c2!.run.startedAt,
        actor: 'ops-a',
        reason: '확인',
        verified: 'OWNER_TERMINATED',
      }),
    ).toEqual({ applied: false, reason: 'NOT_RUNNING' });
    // started_at 이 바뀐 경우(재시작 등): 마감하지 않음
    expect(
      await closeStaleRunManually(pool, {
        runId: stale.id,
        expectedStartedAt: new Date(cand!.run.startedAt.getTime() + 1000),
        actor: 'ops-a',
        reason: '확인',
        verified: 'OWNER_TERMINATED',
      }),
    ).toEqual({ applied: false, reason: 'STARTED_AT_CHANGED' });
    // 정상 적용
    const applied = await closeStaleRunManually(pool, {
      runId: stale.id,
      expectedStartedAt: cand!.run.startedAt,
      actor: 'ops-a',
      reason: '프로세스 종료·활성 작업 부재 확인 (token=FAKE-REASON-SECRET-123)',
      verified: 'OWNER_TERMINATED',
    });
    expect(applied.applied).toBe(true);
    if (applied.applied) {
      expect(applied.run.status).toBe('FAILED');
      expect(applied.run.errorCode).toBe('RECOVERY_MANUAL_CLOSE');
      expect(applied.run.failureKind).toBe('STORAGE');
      expect(applied.run.closedBy).toBe('ops-a');
      expect(applied.run.closeReason).toContain('[REDACTED]');
      expect(applied.run.closeReason).not.toContain('FAKE-REASON-SECRET-123');
    }
    expect(
      await closeStaleRunManually(pool, {
        runId: stale.id,
        expectedStartedAt: cand!.run.startedAt,
        actor: 'ops-a',
        reason: '재시도',
        verified: 'OWNER_TERMINATED',
      }),
    ).toEqual({ applied: false, reason: 'NOT_RUNNING' });
    expect(
      await closeStaleRunManually(pool, {
        runId: '00000000-0000-0000-0000-000000000000',
        expectedStartedAt: new Date(),
        actor: 'ops-a',
        reason: 'x',
        verified: 'OWNER_TERMINATED',
      }),
    ).toEqual({ applied: false, reason: 'NOT_FOUND' });
  });
});

describe('5. 대조 미구현 소스 정책', () => {
  it('정기 실행은 완전 구현 수집기만 허용하고 미구현 수집기는 외부 요청 전에 거부한다. 검증 모드는 명시적으로만', async () => {
    const acc = await seedAccount(pool);
    const partialCollector = new FixtureCollector({ items, reconcileNotImplemented: true });
    expect(isSchedulable(partialCollector)).toBe(false);
    expect(isSchedulable(new FixtureCollector({ items }))).toBe(true);
    // 기본값(SCHEDULED)에서 거부: 외부 요청(request 단계) 미실행, 원본 없음
    const rejected = await runCollection(deps(), partialCollector, {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(rejected.run.status).toBe('PARTIAL');
    expect(rejected.run.failureKind).toBe('NOT_IMPLEMENTED');
    expect(rejected.run.errorCode).toBe('SCHEDULED_REQUIRES_COMPLETE_COLLECTOR');
    expect(rejected.run.mode).toBe('SCHEDULED');
    expect(rejected.run.stages.request).toEqual({ outcome: 'SKIPPED' });
    expect(rejected.rawObjectId).toBeNull();
    // 검증 모드에서만 원본 수집 허용. 결과는 PARTIAL/NOT_IMPLEMENTED, 관측 미반영
    const verify = await runCollection(deps(), partialCollector, {
      sourceAccountId: acc.id,
      ...period,
      mode: 'VERIFICATION',
    });
    expect(verify.run.mode).toBe('VERIFICATION');
    expect(verify.run.status).toBe('PARTIAL');
    expect(verify.run.errorCode).toBe('RECONCILE_NOT_IMPLEMENTED');
    expect(verify.rawObjectId).not.toBeNull();
    expect(verify.observations).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_source_records')).rows[0].n).toBe(
      0,
    );
    // 완전 구현 수집기는 정기 실행 가능
    const ok = await runCollection(deps(), new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(ok.run.status).toBe('SUCCEEDED');
    expect(ok.run.mode).toBe('SCHEDULED');
  });
});
