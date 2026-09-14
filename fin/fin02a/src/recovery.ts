import type pg from 'pg';

import { withTx, type Queryable } from './db/client';
import {
  DEFAULT_LEASE_STALE_MS,
  listLeaseAnomalies,
  lockLease,
  type LeaseAnomaly,
  type ManualVerification,
} from './queue/lease';
import type { RawStore } from './raw/store';
import { redactText } from './redact';
import { RUN_COLS, toRun, type RunRow, type SourceRun } from './runs/repo';

/**
 * 수동 복구 경계(확정 정책).
 * - 자동 실패 마감·잠금 탈취는 없다. heartbeat 2분 초과와 RUNNING 60분 초과는 "확인 후보" 기준일 뿐 마감 근거가 아니다.
 * - 수동 마감에는 담당자의 명시적 확인 입력(verified: OWNER_TERMINATED | NO_ACTIVE_WORK)과 사유가 필요하다.
 * - preview 는 실행 ID·시작 시각·소유자(worker_id, 세대값)·잠금 상태를 함께 제시하고, 적용은 그 값들을 재확인한다.
 * - 적용은 한 트랜잭션에서 잠금 행 → 실행 행 순서로 FOR UPDATE 한 뒤 상태·시작 시각·세대값을 재확인한다.
 *   worker 커밋(assertLeaseHeld → finishRun)과 같은 잠금 순서이므로 둘은 직렬화되며, 먼저 확정된 쪽만 반영된다.
 *   - 정상 완료가 먼저 확정 → NOT_RUNNING 으로 거부.  - 소유권이 바뀜(세대값 변경) → OWNERSHIP_CHANGED 로 거부.
 *   - 복구가 먼저 확정 → 실행은 FAILED 로 닫히고 해당 세대 잠금은 해제되므로, 이전 worker 의 관측 커밋(assertLeaseHeld 실패),
 *     종료 갱신(finishRun 의 status='RUNNING' 조건 실패), heartbeat(released_at IS NULL 조건 실패)는 모두 0행이다.
 * - 고아 원본·바이트 유실은 목록만 제시하고 자동 삭제하지 않는다.
 */

export const DEFAULT_CANDIDATE_AGE_MS = 60 * 60 * 1000;
export { DEFAULT_LEASE_STALE_MS };

export interface StaleRunCandidate {
  run: SourceRun;
  ageMinutes: number;
  /** 실행에 기록된 소유자(worker_id, 잠금 세대값, 작업 ID). 없으면 큐 밖에서 시작한 실행 */
  owner: { workerId: string | null; leaseGeneration: number | null; jobId: string | null };
  /** 계정 잠금의 현재 상태(조회 시점). 적용 시 세대값을 재확인하는 기준 */
  lease: {
    generation: number;
    workerId: string | null;
    runId: string | null;
    heartbeatAt: Date | null;
    releasedAt: Date | null;
    heartbeatStaleSeconds: number | null;
  } | null;
}

interface CandidateRow extends RunRow {
  worker_id: string | null;
  lease_generation: string | null;
  job_id: string | null;
  l_generation: string | null;
  l_worker_id: string | null;
  l_run_id: string | null;
  l_heartbeat_at: Date | null;
  l_released_at: Date | null;
}

/** 확인 후보: 임계 시간(기본 60분) 이상 RUNNING 인 실행 + 소유자·잠금 상태. 상태를 바꾸지 않는다. */
export async function listStaleRunCandidates(
  db: Queryable,
  olderThanMs = DEFAULT_CANDIDATE_AGE_MS,
  now = new Date(),
): Promise<StaleRunCandidate[]> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const cols = RUN_COLS.split(', ')
    .map((c) => `r.${c}`)
    .join(', ');
  const r = await db.query<CandidateRow>(
    `SELECT ${cols}, r.worker_id, r.lease_generation::text, r.job_id,
            l.generation::text AS l_generation, l.worker_id AS l_worker_id, l.run_id AS l_run_id,
            l.heartbeat_at AS l_heartbeat_at, l.released_at AS l_released_at
     FROM fin_source_runs r LEFT JOIN fin_run_leases l ON l.source_account_id = r.source_account_id
     WHERE r.status = 'RUNNING' AND r.started_at < $1 ORDER BY r.started_at`,
    [cutoff],
  );
  return r.rows.map((row) => {
    const run = toRun(row);
    return {
      run,
      ageMinutes: Math.floor((now.getTime() - run.startedAt.getTime()) / 60_000),
      owner: {
        workerId: row.worker_id,
        leaseGeneration: row.lease_generation === null ? null : Number(row.lease_generation),
        jobId: row.job_id,
      },
      lease:
        row.l_generation === null
          ? null
          : {
              generation: Number(row.l_generation),
              workerId: row.l_worker_id,
              runId: row.l_run_id,
              heartbeatAt: row.l_heartbeat_at,
              releasedAt: row.l_released_at,
              heartbeatStaleSeconds: row.l_heartbeat_at
                ? Math.floor((now.getTime() - row.l_heartbeat_at.getTime()) / 1000)
                : null,
            },
    };
  });
}

export interface ManualCloseInput {
  runId: string;
  /** 후보 조회 시점의 started_at. 적용 직전 재확인에 사용 */
  expectedStartedAt: Date;
  /** 후보 조회 시점의 계정 잠금 세대값(preview 의 lease.generation). 생략하면 실행에 기록된 lease_generation 을 기준으로 삼는다 */
  expectedGeneration?: number | null;
  /** 담당자 식별자 */
  actor: string;
  /** 확인 내용(프로세스 종료·활성 작업 부재 확인 등) */
  reason: string;
  /** 담당자의 명시적 확인 종류. 없으면 마감하지 않는다(heartbeat 노후는 대체 근거가 아니다) */
  verified?: ManualVerification;
  /** 이 시간 안에 heartbeat 가 있으면 소유자가 살아 있다고 보고 마감을 거부(기본 2분) */
  leaseStaleMs?: number;
}

export type ManualCloseResult =
  | { applied: true; run: SourceRun; leaseReleased: boolean; jobStatus: string | null }
  | {
      applied: false;
      reason:
        | 'NOT_RUNNING'
        | 'STARTED_AT_CHANGED'
        | 'NOT_FOUND'
        | 'INVALID_INPUT'
        | 'CONFIRMATION_REQUIRED'
        | 'OWNER_ALIVE'
        | 'OWNERSHIP_CHANGED';
    };

/**
 * 담당자 확인 후 수동 마감. FAILED/STORAGE, RECOVERY_MANUAL_CLOSE. 관측 저장과 SUCCEEDED 는 같은 트랜잭션이므로
 * RUNNING 잔존은 관측이 커밋되지 않았음을 뜻한다. 한 트랜잭션에서 잠금 행 → 실행 행 순서로 잠근 뒤 재확인·적용한다.
 * 적용 시 같은 세대의 미해제 잠금을 함께 해제하고(탈취가 아니라 확인된 소유자 종료의 정리), 이 실행을 가리키는 작업은
 * NEEDS_REVIEW 로, 미종료 시도는 MANUAL_CLOSE 로 닫는다.
 */
export async function closeStaleRunManually(
  pool: pg.Pool,
  input: ManualCloseInput,
): Promise<ManualCloseResult> {
  const actor = input.actor.trim().slice(0, 64);
  const reason = redactText(input.reason.trim()).slice(0, 500);
  if (!actor || !reason) return { applied: false, reason: 'INVALID_INPUT' };
  if (!input.verified) return { applied: false, reason: 'CONFIRMATION_REQUIRED' };
  const staleMs = input.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS;
  return withTx(pool, async (tx) => {
    // 1) 실행 조회(잠금 없음): 계정과 기록된 소유자를 얻는다.
    const cur = await tx.query<{
      status: string;
      started_at: Date;
      source_account_id: string;
      lease_generation: string | null;
    }>(
      'SELECT status, started_at, source_account_id, lease_generation::text FROM fin_source_runs WHERE id = $1',
      [input.runId],
    );
    const row = cur.rows[0];
    if (!row) return { applied: false, reason: 'NOT_FOUND' };
    if (row.status !== 'RUNNING') return { applied: false, reason: 'NOT_RUNNING' };
    // 2) 잠금 행 FOR UPDATE (worker 커밋과 같은 순서). 그 다음 실행 행 FOR UPDATE.
    const lease = await lockLease(tx, row.source_account_id);
    const locked = await tx.query<{ status: string; started_at: Date }>(
      'SELECT status, started_at FROM fin_source_runs WHERE id = $1 FOR UPDATE',
      [input.runId],
    );
    const l = locked.rows[0];
    if (!l || l.status !== 'RUNNING') return { applied: false, reason: 'NOT_RUNNING' }; // 정상 완료가 먼저 확정됨
    if (l.started_at.getTime() !== input.expectedStartedAt.getTime())
      return { applied: false, reason: 'STARTED_AT_CHANGED' };
    // 3) 소유권 재확인(잠금으로 시작된 실행만): 조회 시점 세대값(없으면 실행에 기록된 세대값)과 현재 잠금 세대값이 같아야 한다.
    //    큐 밖에서 시작한 실행(lease_generation 없음, expectedGeneration 미지정)은 잠금과 무관하므로 잠금을 검사·해제하지 않는다.
    const expectedGeneration =
      input.expectedGeneration ??
      (row.lease_generation === null ? null : Number(row.lease_generation));
    const owned = expectedGeneration !== null && lease !== null;
    if (owned) {
      if (lease.generation !== expectedGeneration)
        return { applied: false, reason: 'OWNERSHIP_CHANGED' };
      if (!lease.releasedAt && lease.runId !== null && lease.runId !== input.runId)
        return { applied: false, reason: 'OWNERSHIP_CHANGED' }; // 잠금이 다른 실행을 가리킴
      if (
        !lease.releasedAt &&
        lease.heartbeatAt &&
        Date.now() - lease.heartbeatAt.getTime() < staleMs
      )
        return { applied: false, reason: 'OWNER_ALIVE' }; // 담당자 확인과 모순되는 최근 heartbeat
    }
    // 4) 적용: 실행 마감(조건부 UPDATE) → 같은 세대 잠금 해제 → 작업·시도 정리.
    const r = await tx.query<RunRow>(
      `UPDATE fin_source_runs
       SET finished_at = now(), status = 'FAILED', error_code = 'RECOVERY_MANUAL_CLOSE',
           error_message = '담당자가 복구 절차로 미종료 실행을 실패로 마감', failure_kind = 'STORAGE',
           note = '수동 복구 마감(담당자 확인 후)', closed_by = $2, close_reason = $3, close_verification = $5
       WHERE id = $1 AND status = 'RUNNING' AND date_trunc('milliseconds', started_at) = date_trunc('milliseconds', $4::timestamptz)
       RETURNING ${RUN_COLS}`,
      [input.runId, actor, reason, input.expectedStartedAt, input.verified],
    );
    const updated = r.rows[0];
    if (!updated) return { applied: false, reason: 'STARTED_AT_CHANGED' };
    let leaseReleased = false;
    if (owned && !lease.releasedAt && (lease.runId === null || lease.runId === input.runId)) {
      const rel = await tx.query(
        `UPDATE fin_run_leases SET released_at = now(), release_reason = $3
         WHERE source_account_id = $1 AND generation = $2 AND released_at IS NULL`,
        [
          row.source_account_id,
          lease.generation,
          `MANUAL_CLOSE:${input.verified}:${actor.slice(0, 24)}`,
        ],
      );
      leaseReleased = (rel.rowCount ?? 0) === 1;
    }
    await tx.query(
      `UPDATE fin_job_attempts SET finished_at = now(), outcome = 'MANUAL_CLOSE', error_code = 'RECOVERY_MANUAL_CLOSE'
       WHERE run_id = $1 AND finished_at IS NULL`,
      [input.runId],
    );
    const job = await tx.query<{ status: string }>(
      `UPDATE fin_collection_jobs SET status = 'NEEDS_REVIEW', updated_at = now()
       WHERE current_run_id = $1 AND status = 'RUNNING' RETURNING status`,
      [input.runId],
    );
    return {
      applied: true,
      run: toRun(updated),
      leaseReleased,
      jobStatus: job.rows[0]?.status ?? null,
    };
  });
}

/** 저장소에는 있으나 fin_raw_objects 행이 없는 키(메타데이터 저장 실패·강제 종료의 잔여물). 목록만, 삭제 없음. */
export async function findOrphanRawKeys(db: Queryable, store: RawStore): Promise<string[]> {
  const keys = await store.list();
  if (keys.length === 0) return [];
  const r = await db.query<{ storage_key: string }>(
    'SELECT storage_key FROM fin_raw_objects WHERE storage_key = ANY($1::text[])',
    [keys],
  );
  const known = new Set(r.rows.map((x) => x.storage_key));
  return keys.filter((k) => !known.has(k));
}

/** fin_raw_objects 행은 있으나 저장소에 바이트가 없는 키(저장소 유실). 목록만. */
export async function findRawRowsMissingBytes(db: Queryable, store: RawStore): Promise<string[]> {
  const keys = new Set(await store.list());
  const r = await db.query<{ storage_key: string }>('SELECT storage_key FROM fin_raw_objects');
  return r.rows.map((x) => x.storage_key).filter((k) => !keys.has(k));
}

export interface RecoveryPreview {
  generatedAt: string;
  candidateAgeMinutes: number;
  staleRunCandidates: {
    runId: string;
    accountId: string;
    startedAt: string;
    ageMinutes: number;
    mode: string;
    stages: unknown;
    owner: StaleRunCandidate['owner'];
    lease: StaleRunCandidate['lease'];
    /** 적용 명령에 그대로 넣을 확인 기준(실행 ID·시작 시각·세대값). verified 는 담당자가 직접 입력한다 */
    closeArgs: { run: string; startedAt: string; generation: number | null };
  }[];
  orphanRawKeys: string[];
  rawRowsMissingBytes: string[];
  /** heartbeat 가 임계(기본 2분) 이상 멈춘 실행 잠금. 조회만이며 탈취·마감 근거가 아니다 */
  leaseAnomalies: LeaseAnomaly[];
  leaseStaleMinutes: number;
}

/** 미리보기: 상태를 바꾸지 않는다. */
export async function previewRecovery(
  db: Queryable,
  store: RawStore,
  olderThanMs = DEFAULT_CANDIDATE_AGE_MS,
  leaseStaleMs = DEFAULT_LEASE_STALE_MS,
): Promise<RecoveryPreview> {
  const candidates = await listStaleRunCandidates(db, olderThanMs);
  return {
    generatedAt: new Date().toISOString(),
    candidateAgeMinutes: Math.floor(olderThanMs / 60_000),
    staleRunCandidates: candidates.map((c) => ({
      runId: c.run.id,
      accountId: c.run.sourceAccountId,
      startedAt: c.run.startedAt.toISOString(),
      ageMinutes: c.ageMinutes,
      mode: c.run.mode,
      stages: c.run.stages,
      owner: c.owner,
      lease: c.lease,
      closeArgs: {
        run: c.run.id,
        startedAt: c.run.startedAt.toISOString(),
        generation: c.lease?.generation ?? c.owner.leaseGeneration,
      },
    })),
    orphanRawKeys: await findOrphanRawKeys(db, store),
    rawRowsMissingBytes: await findRawRowsMissingBytes(db, store),
    leaseAnomalies: await listLeaseAnomalies(db, leaseStaleMs),
    leaseStaleMinutes: Math.floor(leaseStaleMs / 60_000),
  };
}
