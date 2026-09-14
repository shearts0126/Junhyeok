import type { Queryable } from '../db/client';
import { redactText } from '../redact';

export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'BLOCKED';
export type StageName = 'authenticate' | 'request' | 'validate' | 'normalize' | 'reconcile';
export type StageOutcome = 'OK' | 'NOT_IMPLEMENTED' | 'FAILED' | 'SKIPPED';
export type Stages = Partial<Record<StageName, StageOutcome>>;

export interface SourceRun {
  id: string;
  sourceAccountId: string;
  periodFrom: string;
  periodTo: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: RunStatus;
  stages: Stages;
  errorCode: string | null;
  errorMessage: string | null;
  /** 원천 데이터 기준 시각. 원천이 제공하지 않으면 null */
  sourceAsOf: Date | null;
  /** 수신 건수. 확인하지 못하면 null. 실제 0건은 0 */
  receivedCount: number | null;
  note: string | null;
}

export async function startRun(
  db: Queryable,
  input: { sourceAccountId: string; periodFrom: string; periodTo: string },
): Promise<SourceRun> {
  const r = await db.query<RunRow>(
    `INSERT INTO fin_source_runs (source_account_id, period_from, period_to, status)
     VALUES ($1, $2, $3, 'RUNNING') RETURNING ${RUN_COLS}`,
    [input.sourceAccountId, input.periodFrom, input.periodTo],
  );
  const row = r.rows[0];
  if (!row) throw new Error('실행 이력 생성 실패');
  return toRun(row);
}

export interface FinishRunInput {
  status: Exclude<RunStatus, 'RUNNING'>;
  stages: Stages;
  errorCode?: string;
  errorMessage?: string;
  sourceAsOf: Date | null;
  receivedCount: number | null;
  note?: string;
}

export async function finishRun(
  db: Queryable,
  runId: string,
  input: FinishRunInput,
): Promise<SourceRun> {
  const r = await db.query<RunRow>(
    `UPDATE fin_source_runs
     SET finished_at = now(), status = $2, stages = $3::jsonb, error_code = $4, error_message = $5,
         source_as_of = $6, received_count = $7, note = $8
     WHERE id = $1 AND status = 'RUNNING' RETURNING ${RUN_COLS}`,
    [
      runId,
      input.status,
      JSON.stringify(input.stages),
      input.errorCode ?? null,
      input.errorMessage === undefined ? null : redactText(input.errorMessage),
      input.sourceAsOf,
      input.receivedCount,
      input.note ?? null,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`실행 이력 종료 실패(이미 종료됨 또는 없음): ${runId}`);
  return toRun(row);
}

export async function getRun(db: Queryable, runId: string): Promise<SourceRun | null> {
  const r = await db.query<RunRow>(`SELECT ${RUN_COLS} FROM fin_source_runs WHERE id = $1`, [
    runId,
  ]);
  const row = r.rows[0];
  return row ? toRun(row) : null;
}

const RUN_COLS =
  'id, source_account_id, period_from::text, period_to::text, started_at, finished_at, status, stages, error_code, error_message, source_as_of, received_count, note';

interface RunRow {
  id: string;
  source_account_id: string;
  period_from: string;
  period_to: string;
  started_at: Date;
  finished_at: Date | null;
  status: RunStatus;
  stages: Stages;
  error_code: string | null;
  error_message: string | null;
  source_as_of: Date | null;
  received_count: number | null;
  note: string | null;
}

function toRun(row: RunRow): SourceRun {
  return {
    id: row.id,
    sourceAccountId: row.source_account_id,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    stages: row.stages,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    sourceAsOf: row.source_as_of,
    receivedCount: row.received_count,
    note: row.note,
  };
}
