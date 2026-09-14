import type { Queryable } from '../db/client';
import type { FailureKind } from '../collector/types';
import type { RunMode } from '../runs/repo';

/**
 * 수집 작업(fin_collection_jobs)·시도 이력(fin_job_attempts).
 * 상태 전이: QUEUED → RUNNING → (SUCCEEDED | PARTIAL | BLOCKED | FAILED | NEEDS_REVIEW | RETRY_SCHEDULED → QUEUED …)
 * - 같은 request_id 재전송은 UNIQUE 로 거부(중복 작업 없음). 의도한 재수집은 새 request_id.
 * - 작업 상태 갱신은 current_run_id 로 펜싱한다: 오래된 worker 의 시도는 다른 실행 ID 이므로 상태를 덮어쓰지 못한다.
 */

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'RETRY_SCHEDULED'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'FAILED'
  | 'BLOCKED'
  | 'NEEDS_REVIEW';

export interface CollectionJob {
  id: string;
  requestId: string;
  sourceAccountId: string;
  collectorKey: string;
  periodFrom: string;
  periodTo: string;
  mode: RunMode;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  currentRunId: string | null;
  nextAttemptAt: Date | null;
  /** 큐(Redis) 등록이 실제로 성공한 시각. null 이면 "DB 에만 있는 작업" 후보(resyncUnqueuedJobs 대상) */
  queuedAt: Date | null;
}

const COLS =
  'id, request_id, source_account_id, collector_key, period_from::text, period_to::text, mode, status, attempt_count, max_attempts, current_run_id, next_attempt_at, queued_at';

interface Row {
  id: string;
  request_id: string;
  source_account_id: string;
  collector_key: string;
  period_from: string;
  period_to: string;
  mode: RunMode;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  current_run_id: string | null;
  next_attempt_at: Date | null;
  queued_at: Date | null;
}
const toJob = (r: Row): CollectionJob => ({
  id: r.id,
  requestId: r.request_id,
  sourceAccountId: r.source_account_id,
  collectorKey: r.collector_key,
  periodFrom: r.period_from,
  periodTo: r.period_to,
  mode: r.mode,
  status: r.status,
  attemptCount: r.attempt_count,
  maxAttempts: r.max_attempts,
  currentRunId: r.current_run_id,
  nextAttemptAt: r.next_attempt_at,
  queuedAt: r.queued_at,
});

export type CreateJobResult =
  { created: true; job: CollectionJob } | { created: false; existing: CollectionJob };

/** 요청 ID 로 멱등 생성. 이미 있으면 기존 작업을 돌려주고 새로 만들지 않는다. */
export async function createJob(
  db: Queryable,
  input: {
    requestId: string;
    sourceAccountId: string;
    collectorKey: string;
    periodFrom: string;
    periodTo: string;
    mode: RunMode;
    maxAttempts?: number;
  },
): Promise<CreateJobResult> {
  const r = await db.query<Row>(
    `INSERT INTO fin_collection_jobs (request_id, source_account_id, collector_key, period_from, period_to, mode, status, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED', $7)
     ON CONFLICT (request_id) DO NOTHING RETURNING ${COLS}`,
    [
      input.requestId,
      input.sourceAccountId,
      input.collectorKey,
      input.periodFrom,
      input.periodTo,
      input.mode,
      input.maxAttempts ?? 3,
    ],
  );
  const row = r.rows[0];
  if (row) return { created: true, job: toJob(row) };
  const existing = await db.query<Row>(
    `SELECT ${COLS} FROM fin_collection_jobs WHERE request_id = $1`,
    [input.requestId],
  );
  const e = existing.rows[0];
  if (!e) throw new Error('작업 생성 실패');
  return { created: false, existing: toJob(e) };
}

export async function getJob(db: Queryable, id: string): Promise<CollectionJob | null> {
  const r = await db.query<Row>(`SELECT ${COLS} FROM fin_collection_jobs WHERE id = $1`, [id]);
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

/** 시도 시작: 작업을 RUNNING 으로, 시도 번호 증가, 시도 행 생성. 반환 attemptNo. */
export async function beginAttempt(
  db: Queryable,
  input: { jobId: string; workerId: string; generation: number },
): Promise<{ attemptNo: number; attemptId: string }> {
  const j = await db.query<{ attempt_count: number }>(
    `UPDATE fin_collection_jobs SET status = 'RUNNING', attempt_count = attempt_count + 1, updated_at = now()
     WHERE id = $1 AND status IN ('QUEUED', 'RETRY_SCHEDULED') RETURNING attempt_count`,
    [input.jobId],
  );
  const row = j.rows[0];
  if (!row) throw new Error('JOB_NOT_STARTABLE');
  const a = await db.query<{ id: string }>(
    `INSERT INTO fin_job_attempts (job_id, attempt_no, worker_id, generation) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.jobId, row.attempt_count, input.workerId, input.generation],
  );
  return { attemptNo: row.attempt_count, attemptId: a.rows[0]!.id };
}

/** 시도에 실행 ID 를 연결하고 작업의 current_run_id 를 설정(펜스 기준). */
export async function bindAttemptRun(
  db: Queryable,
  input: { jobId: string; attemptId: string; runId: string },
): Promise<void> {
  await db.query('UPDATE fin_job_attempts SET run_id = $2 WHERE id = $1', [
    input.attemptId,
    input.runId,
  ]);
  await db.query(
    'UPDATE fin_collection_jobs SET current_run_id = $2, updated_at = now() WHERE id = $1',
    [input.jobId, input.runId],
  );
}

export interface AttemptOutcome {
  outcome: string;
  failureKind?: FailureKind | null;
  errorCode?: string | null;
  retryScheduled?: boolean;
}

export async function finishAttempt(
  db: Queryable,
  attemptId: string,
  o: AttemptOutcome,
): Promise<void> {
  await db.query(
    'UPDATE fin_job_attempts SET finished_at = now(), outcome = $2, failure_kind = $3, error_code = $4, retry_scheduled = $5 WHERE id = $1',
    [attemptId, o.outcome, o.failureKind ?? null, o.errorCode ?? null, o.retryScheduled ?? false],
  );
}

/**
 * 작업 상태 갱신(펜스): current_run_id 가 이 시도의 실행 ID 일 때만 반영된다.
 * 오래된 worker(다른 실행 ID)의 늦은 결과는 0행 갱신으로 무시된다.
 * RETRY_SCHEDULED 로 바꿀 때는 queued_at 을 비운다(지연 재투입 등록이 성공하면 markQueued 로 채운다).
 */
export async function setJobStatusFenced(
  db: Queryable,
  input: { jobId: string; expectedRunId: string; status: JobStatus; nextAttemptAt?: Date | null },
): Promise<boolean> {
  const r = await db.query(
    `UPDATE fin_collection_jobs SET status = $3, next_attempt_at = $4, updated_at = now(),
       queued_at = CASE WHEN $3 = 'RETRY_SCHEDULED' THEN NULL ELSE queued_at END
     WHERE id = $1 AND current_run_id = $2`,
    [input.jobId, input.expectedRunId, input.status, input.nextAttemptAt ?? null],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * 잠금을 얻지 못해 시도를 시작하지 못한 경우(시도 수 미포함). 상태는 바꾸지 않는다: QUEUED 인 행의 next_attempt_at 만 갱신하고
 * queued_at 을 비운 뒤 재투입 등록 후 markQueued 로 채운다. 오래된 조회로 들어온 worker 가 RUNNING·완료·NEEDS_REVIEW·
 * RETRY_SCHEDULED(재시도 대기 시각 보존) 행을 건드리지 않도록 WHERE 로 제한한다. 반환값은 갱신 여부.
 */
export async function requeueJob(
  db: Queryable,
  jobId: string,
  nextAttemptAt: Date,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE fin_collection_jobs SET next_attempt_at = $2, queued_at = NULL, updated_at = now() WHERE id = $1 AND status = 'QUEUED'`,
    [jobId, nextAttemptAt],
  );
  return (r.rowCount ?? 0) === 1;
}

/** 큐 등록 성공 기록. 등록 성공 응답을 받은 뒤에만 호출하며, 시작 가능 상태(QUEUED/RETRY_SCHEDULED)인 행만 갱신한다. */
export async function markQueued(db: Queryable, jobId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE fin_collection_jobs SET queued_at = now(), updated_at = now() WHERE id = $1 AND status IN ('QUEUED', 'RETRY_SCHEDULED')`,
    [jobId],
  );
  return (r.rowCount ?? 0) === 1;
}

/** DB 에는 있으나 큐 등록 기록이 없는 작업(등록 실패·응답 유실·지연 재투입 실패). 상태를 바꾸지 않는다. */
export async function listUnqueuedJobs(db: Queryable): Promise<CollectionJob[]> {
  const r = await db.query<Row>(
    `SELECT ${COLS} FROM fin_collection_jobs WHERE queued_at IS NULL AND status IN ('QUEUED', 'RETRY_SCHEDULED') ORDER BY created_at`,
  );
  return r.rows.map(toJob);
}

export async function listAttempts(
  db: Queryable,
  jobId: string,
): Promise<
  {
    attemptNo: number;
    runId: string | null;
    outcome: string | null;
    failureKind: string | null;
    errorCode: string | null;
    retryScheduled: boolean;
    workerId: string;
    generation: number;
  }[]
> {
  const r = await db.query<{
    attempt_no: number;
    run_id: string | null;
    outcome: string | null;
    failure_kind: string | null;
    error_code: string | null;
    retry_scheduled: boolean;
    worker_id: string;
    generation: string;
  }>(
    'SELECT attempt_no, run_id, outcome, failure_kind, error_code, retry_scheduled, worker_id, generation::text FROM fin_job_attempts WHERE job_id = $1 ORDER BY attempt_no',
    [jobId],
  );
  return r.rows.map((x) => ({
    attemptNo: x.attempt_no,
    runId: x.run_id,
    outcome: x.outcome,
    failureKind: x.failure_kind,
    errorCode: x.error_code,
    retryScheduled: x.retry_scheduled,
    workerId: x.worker_id,
    generation: Number(x.generation),
  }));
}

/** 정기 실행 설정(구조만). enabled=false 기본. 이 단계에서는 활성화된 스케줄이 있어도 자동 enqueue 루프를 띄우지 않는다. */
export async function listEnabledSchedules(db: Queryable): Promise<
  {
    id: string;
    sourceAccountId: string;
    collectorKey: string;
    cronExpression: string;
    timezone: string;
  }[]
> {
  const r = await db.query<{
    id: string;
    source_account_id: string;
    collector_key: string;
    cron_expression: string;
    timezone: string;
  }>(
    'SELECT id, source_account_id, collector_key, cron_expression, timezone FROM fin_collection_schedules WHERE enabled = true',
  );
  return r.rows.map((x) => ({
    id: x.id,
    sourceAccountId: x.source_account_id,
    collectorKey: x.collector_key,
    cronExpression: x.cron_expression,
    timezone: x.timezone,
  }));
}
