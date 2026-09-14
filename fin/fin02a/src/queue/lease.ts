import type pg from 'pg';

import { withTx, type Queryable } from '../db/client';

/** heartbeat 가 이 시간 안이면 소유자가 살아 있다고 본다(기본 2분). 노후는 확인 후보 기준일 뿐 자동 마감·탈취 근거가 아니다. */
export const DEFAULT_LEASE_STALE_MS = 2 * 60 * 1000;

/**
 * 실행 소유권(잠금 + heartbeat + 세대값).
 * - acquire: 계정당 하나. 해제된(또는 없는) 잠금만 획득하며 세대값을 1 올린다. 잡혀 있으면 null(대기·재시도는 호출자 몫).
 * - heartbeat: 같은 worker·세대에서만 갱신. 0행이면 소유권을 잃은 것이다.
 * - assertHeld: 관측 커밋·종료 기록 트랜잭션 안에서 호출하는 펜스. 실패 시 LeaseLostError.
 * - release: 같은 worker·세대에서만 해제. heartbeat 가 오래됐다는 이유로 자동 탈취·해제하지 않는다.
 * 큐의 전달 보장은 "정확히 한 번" 을 뜻하지 않으므로, 이 펜스가 이전 worker 의 늦은 커밋을 거부한다.
 */

export interface Lease {
  sourceAccountId: string;
  workerId: string;
  generation: number;
}

export class LeaseLostError extends Error {
  constructor(readonly lease: Lease) {
    super('LEASE_LOST');
    this.name = 'LeaseLostError';
  }
}

export async function acquireLease(
  db: Queryable,
  input: { sourceAccountId: string; workerId: string; jobId: string },
): Promise<Lease | null> {
  const r = await db.query<{ generation: string }>(
    `INSERT INTO fin_run_leases (source_account_id, generation, worker_id, job_id, acquired_at, heartbeat_at, released_at)
     VALUES ($1, 1, $2, $3, now(), now(), NULL)
     ON CONFLICT (source_account_id) DO UPDATE
       SET generation = fin_run_leases.generation + 1, worker_id = EXCLUDED.worker_id, job_id = EXCLUDED.job_id,
           run_id = NULL, acquired_at = now(), heartbeat_at = now(), released_at = NULL, release_reason = NULL
       WHERE fin_run_leases.released_at IS NOT NULL
     RETURNING generation::text`,
    [input.sourceAccountId, input.workerId, input.jobId],
  );
  const row = r.rows[0];
  if (!row) return null; // 잠금이 살아 있음(해제되지 않음)
  return {
    sourceAccountId: input.sourceAccountId,
    workerId: input.workerId,
    generation: Number(row.generation),
  };
}

export async function bindLeaseRun(db: Queryable, lease: Lease, runId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE fin_run_leases SET run_id = $4 WHERE source_account_id = $1 AND worker_id = $2 AND generation = $3 AND released_at IS NULL`,
    [lease.sourceAccountId, lease.workerId, lease.generation, runId],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function heartbeat(db: Queryable, lease: Lease): Promise<boolean> {
  const r = await db.query(
    `UPDATE fin_run_leases SET heartbeat_at = now() WHERE source_account_id = $1 AND worker_id = $2 AND generation = $3 AND released_at IS NULL`,
    [lease.sourceAccountId, lease.workerId, lease.generation],
  );
  return (r.rowCount ?? 0) === 1;
}

/** 트랜잭션 안에서 잠금 행을 잠그고 소유권을 검증한다(펜스). */
export async function assertLeaseHeld(tx: Queryable, lease: Lease): Promise<void> {
  const r = await tx.query(
    `SELECT 1 FROM fin_run_leases WHERE source_account_id = $1 AND worker_id = $2 AND generation = $3 AND released_at IS NULL FOR UPDATE`,
    [lease.sourceAccountId, lease.workerId, lease.generation],
  );
  if ((r.rowCount ?? 0) !== 1) throw new LeaseLostError(lease);
}

export async function releaseLease(db: Queryable, lease: Lease, reason: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE fin_run_leases SET released_at = now(), release_reason = $4
     WHERE source_account_id = $1 AND worker_id = $2 AND generation = $3 AND released_at IS NULL`,
    [lease.sourceAccountId, lease.workerId, lease.generation, reason.slice(0, 64)],
  );
  return (r.rowCount ?? 0) === 1;
}

export interface LeaseAnomaly {
  sourceAccountId: string;
  workerId: string | null;
  generation: number;
  jobId: string | null;
  runId: string | null;
  heartbeatAt: Date | null;
  staleSeconds: number;
}

/** 소유권 이상 후보: 해제되지 않았고 heartbeat 가 임계(기본 2분) 이상 멈춘 잠금. 조회만 하며 탈취·마감하지 않는다. */
export async function listLeaseAnomalies(
  db: Queryable,
  staleMs = DEFAULT_LEASE_STALE_MS,
  now = new Date(),
): Promise<LeaseAnomaly[]> {
  const cutoff = new Date(now.getTime() - staleMs);
  const r = await db.query<{
    source_account_id: string;
    worker_id: string | null;
    generation: string;
    job_id: string | null;
    run_id: string | null;
    heartbeat_at: Date | null;
  }>(
    `SELECT source_account_id, worker_id, generation::text, job_id, run_id, heartbeat_at FROM fin_run_leases
     WHERE released_at IS NULL AND heartbeat_at < $1 ORDER BY heartbeat_at`,
    [cutoff],
  );
  return r.rows.map((x) => ({
    sourceAccountId: x.source_account_id,
    workerId: x.worker_id,
    generation: Number(x.generation),
    jobId: x.job_id,
    runId: x.run_id,
    heartbeatAt: x.heartbeat_at,
    staleSeconds: x.heartbeat_at
      ? Math.floor((now.getTime() - x.heartbeat_at.getTime()) / 1000)
      : -1,
  }));
}

/** 담당자가 명시적으로 입력하는 확인 종류. heartbeat 노후는 확인 후보를 만들 뿐 이 입력을 대체하지 않는다. */
export type ManualVerification = 'OWNER_TERMINATED' | 'NO_ACTIVE_WORK';
export const MANUAL_VERIFICATIONS: readonly ManualVerification[] = [
  'OWNER_TERMINATED',
  'NO_ACTIVE_WORK',
];

export interface LeaseRow {
  sourceAccountId: string;
  generation: number;
  workerId: string | null;
  jobId: string | null;
  runId: string | null;
  heartbeatAt: Date | null;
  releasedAt: Date | null;
}

/**
 * 잠금 행을 FOR UPDATE 로 잠그고 읽는다. 잠금 순서는 항상 "잠금 행 → 실행 행" 이다:
 * worker 커밋(assertLeaseHeld → finishRun), 소유권 변경(acquireLease), 수동 복구(closeStaleRunManually)가 같은 순서를 쓴다.
 */
export async function lockLease(tx: Queryable, sourceAccountId: string): Promise<LeaseRow | null> {
  const r = await tx.query<{
    source_account_id: string;
    generation: string;
    worker_id: string | null;
    job_id: string | null;
    run_id: string | null;
    heartbeat_at: Date | null;
    released_at: Date | null;
  }>(
    `SELECT source_account_id, generation::text, worker_id, job_id, run_id, heartbeat_at, released_at
     FROM fin_run_leases WHERE source_account_id = $1 FOR UPDATE`,
    [sourceAccountId],
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    sourceAccountId: x.source_account_id,
    generation: Number(x.generation),
    workerId: x.worker_id,
    jobId: x.job_id,
    runId: x.run_id,
    heartbeatAt: x.heartbeat_at,
    releasedAt: x.released_at,
  };
}

export type ManualReleaseResult =
  | { applied: true; generation: number }
  | {
      applied: false;
      reason:
        | 'CONFIRMATION_REQUIRED'
        | 'NOT_FOUND'
        | 'ALREADY_RELEASED'
        | 'GENERATION_CHANGED'
        | 'OWNER_ALIVE';
    };

/**
 * 담당자 확인 후 수동 해제(복구 절차). 잠금 행을 잠근 채 세대값 일치·미해제·heartbeat 노후를 재확인하고 해제한다.
 * - verified(담당자의 명시적 확인 입력)가 없으면 아무것도 하지 않는다.
 * - 조회 시점 이후 다른 worker 가 새로 획득했으면(세대값 변경) 해제하지 않는다.
 * - heartbeat 가 최근이면 담당자 확인과 모순되므로 해제하지 않는다(OWNER_ALIVE).
 */
export async function releaseLeaseManually(
  pool: pg.Pool,
  input: {
    sourceAccountId: string;
    expectedGeneration: number;
    actor: string;
    reason: string;
    verified?: ManualVerification;
    leaseStaleMs?: number;
  },
): Promise<ManualReleaseResult> {
  if (!input.verified) return { applied: false, reason: 'CONFIRMATION_REQUIRED' };
  return withTx(pool, async (tx) => {
    const lease = await lockLease(tx, input.sourceAccountId);
    if (!lease) return { applied: false, reason: 'NOT_FOUND' };
    if (lease.generation !== input.expectedGeneration)
      return { applied: false, reason: 'GENERATION_CHANGED' };
    if (lease.releasedAt) return { applied: false, reason: 'ALREADY_RELEASED' };
    if (
      lease.heartbeatAt &&
      Date.now() - lease.heartbeatAt.getTime() < (input.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS)
    )
      return { applied: false, reason: 'OWNER_ALIVE' };
    const r = await tx.query(
      `UPDATE fin_run_leases SET released_at = now(), release_reason = $3
       WHERE source_account_id = $1 AND generation = $2 AND released_at IS NULL`,
      [
        input.sourceAccountId,
        input.expectedGeneration,
        `MANUAL:${input.verified}:${input.actor.slice(0, 24)}:${input.reason.slice(0, 16)}`,
      ],
    );
    if ((r.rowCount ?? 0) !== 1) return { applied: false, reason: 'GENERATION_CHANGED' };
    return { applied: true, generation: lease.generation };
  });
}
