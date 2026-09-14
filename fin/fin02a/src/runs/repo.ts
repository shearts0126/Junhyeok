import type { FailureKind } from '../collector/types';
import type { Queryable } from '../db/client';
import { isCode, redactText } from '../redact';

export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'BLOCKED';
export type StageName = 'authenticate' | 'request' | 'validate' | 'normalize' | 'reconcile';
export type StageOutcome = 'OK' | 'NOT_IMPLEMENTED' | 'FAILED' | 'SKIPPED';
export interface StageRecord {
  outcome: StageOutcome;
  /** NOT_IMPLEMENTED / FAILED 의 식별자 코드 */
  code?: string;
}
export type Stages = Partial<Record<StageName, StageRecord>>;

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
  /** 오류 코드별 고정 설명(카탈로그). 외부 예외 메시지가 아니다 */
  errorMessage: string | null;
  failureKind: FailureKind | null;
  /** 예외 클래스 이름(예: TypeError). 메시지는 저장하지 않는다 */
  errorClass: string | null;
  sourceAsOf: Date | null;
  receivedCount: number | null;
  note: string | null;
}

/** 오류 코드 → 고정 설명. 여기 없는 코드는 코드 자체만 설명으로 쓴다. 외부 문자열은 절대 섞지 않는다. */
const ERROR_CATALOG: Record<string, string> = {
  NO_CREDENTIALS: '자격정보 없음',
  AUTH_NOT_IMPLEMENTED: '인증 단계 미구현',
  REQUEST_NOT_IMPLEMENTED: '요청 단계 미구현',
  VALIDATE_NOT_IMPLEMENTED: '응답 검증 단계 미구현',
  NORMALIZE_NOT_IMPLEMENTED: '정규화 단계 미구현',
  RECONCILE_NOT_IMPLEMENTED: '대조 단계 미구현',
  NETWORK: '외부 요청 실패(네트워크)',
  PARSE_FAILED: '응답 파싱 실패',
  RECONCILE_MISMATCH: '원본·정규화 대조 불일치',
  RAW_CONTAINS_CREDENTIAL: '응답 본문에 사용한 인증값이 반사되어 원본 저장 중단',
  RAW_TOKEN_FIELD: '응답에 토큰 성격 필드가 있어 원본 저장 중단',
  REQUEST_SUMMARY_INVALID: '요청 요약 템플릿이 안전 규칙에 맞지 않음',
  RAW_STORE_FAILED: '원본 바이트 저장 실패',
  RAW_META_FAILED: '원본 메타데이터 저장 실패(고아 원본 가능)',
  OBSERVE_STORE_FAILED: '관측 저장 트랜잭션 실패',
  RECOVERY_STALE_RUNNING: '복구 절차가 미종료 실행을 실패로 마감',
};

export function catalogMessage(code: string): string {
  return ERROR_CATALOG[code] ?? `오류 코드 ${code}`;
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
  failureKind?: FailureKind;
  errorClass?: string;
  sourceAsOf: Date | null;
  receivedCount: number | null;
  /** 파이프라인이 만든 고정 문장만 넣는다 */
  note?: string;
}

export async function finishRun(
  db: Queryable,
  runId: string,
  input: FinishRunInput,
): Promise<SourceRun> {
  const errorCode =
    input.errorCode === undefined
      ? null
      : isCode(input.errorCode)
        ? input.errorCode
        : 'INVALID_ERROR_CODE';
  const failureKind = input.status === 'SUCCEEDED' ? null : (input.failureKind ?? 'UNKNOWN');
  const r = await db.query<RunRow>(
    `UPDATE fin_source_runs
     SET finished_at = now(), status = $2, stages = $3::jsonb, error_code = $4, error_message = $5,
         failure_kind = $6, error_class = $7, source_as_of = $8, received_count = $9, note = $10
     WHERE id = $1 AND status = 'RUNNING' RETURNING ${RUN_COLS}`,
    [
      runId,
      input.status,
      JSON.stringify(sanitizeStages(input.stages)),
      errorCode,
      errorCode === null ? null : catalogMessage(errorCode),
      failureKind,
      input.errorClass === undefined
        ? null
        : input.errorClass.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64),
      input.sourceAsOf,
      input.receivedCount,
      input.note === undefined ? null : redactText(input.note).slice(0, 500),
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`실행 이력 종료 실패(이미 종료됨 또는 없음): ${runId}`);
  return toRun(row);
}

function sanitizeStages(stages: Stages): Stages {
  const out: Stages = {};
  for (const [k, v] of Object.entries(stages) as [StageName, StageRecord][]) {
    out[k] =
      v.code === undefined
        ? { outcome: v.outcome }
        : { outcome: v.outcome, code: isCode(v.code) ? v.code : 'INVALID_CODE' };
  }
  return out;
}

export async function getRun(db: Queryable, runId: string): Promise<SourceRun | null> {
  const r = await db.query<RunRow>(`SELECT ${RUN_COLS} FROM fin_source_runs WHERE id = $1`, [
    runId,
  ]);
  const row = r.rows[0];
  return row ? toRun(row) : null;
}

const RUN_COLS =
  'id, source_account_id, period_from::text, period_to::text, started_at, finished_at, status, stages, error_code, error_message, failure_kind, error_class, source_as_of, received_count, note';

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
  failure_kind: FailureKind | null;
  error_class: string | null;
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
    failureKind: row.failure_kind,
    errorClass: row.error_class,
    sourceAsOf: row.source_as_of,
    receivedCount: row.received_count,
    note: row.note,
  };
}
