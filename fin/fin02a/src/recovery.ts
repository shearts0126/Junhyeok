import type { Queryable } from './db/client';
import type { RawStore } from './raw/store';
import { redactText } from './redact';
import { RUN_COLS, toRun, type RunRow, type SourceRun } from './runs/repo';

/**
 * 수동 복구 경계(확정 정책).
 * - 자동 실패 마감은 하지 않는다. started_at 만 보고 정상 장기 실행을 종료하지 않는다.
 * - 60분 이상 RUNNING 인 실행은 "확인 후보" 로만 조회한다(조사 기준이지 장애 확정 기준이 아니다).
 * - 담당자가 프로세스 종료·활성 작업 부재를 확인한 뒤 실행 ID 를 지정해 마감한다. 주체·사유를 남긴다.
 * - 적용 직전에 후보 조회 시점의 상태(RUNNING, started_at)를 재확인하고, 바뀌었으면 마감하지 않는다.
 * - 고아 원본·바이트 유실은 목록만 제시하고 자동 삭제하지 않는다.
 * try/catch 로 해결되지 않는 강제 종료·DB 장애의 잔여물은 이 절차로만 정리한다.
 */

export const DEFAULT_CANDIDATE_AGE_MS = 60 * 60 * 1000;

export interface StaleRunCandidate {
  run: SourceRun;
  ageMinutes: number;
}

/** 확인 후보: 임계 시간(기본 60분) 이상 RUNNING 인 실행. 상태를 바꾸지 않는다. */
export async function listStaleRunCandidates(
  db: Queryable,
  olderThanMs = DEFAULT_CANDIDATE_AGE_MS,
  now = new Date(),
): Promise<StaleRunCandidate[]> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const r = await db.query<RunRow>(
    `SELECT ${RUN_COLS} FROM fin_source_runs WHERE status = 'RUNNING' AND started_at < $1 ORDER BY started_at`,
    [cutoff],
  );
  return r.rows.map((row) => {
    const run = toRun(row);
    return { run, ageMinutes: Math.floor((now.getTime() - run.startedAt.getTime()) / 60_000) };
  });
}

export interface ManualCloseInput {
  runId: string;
  /** 후보 조회 시점의 started_at. 적용 직전 재확인에 사용 */
  expectedStartedAt: Date;
  /** 담당자 식별자 */
  actor: string;
  /** 확인 내용(프로세스 종료·활성 작업 부재 확인 등) */
  reason: string;
}

export type ManualCloseResult =
  | { applied: true; run: SourceRun }
  | {
      applied: false;
      reason: 'NOT_RUNNING' | 'STARTED_AT_CHANGED' | 'NOT_FOUND' | 'INVALID_INPUT';
    };

/**
 * 담당자 확인 후 수동 마감. FAILED/STORAGE, RECOVERY_MANUAL_CLOSE. 관측 저장과 SUCCEEDED 는 같은 트랜잭션이므로
 * RUNNING 잔존은 관측이 커밋되지 않았음을 뜻한다. 적용 직전 상태·시작 시각을 재확인한다.
 */
export async function closeStaleRunManually(
  db: Queryable,
  input: ManualCloseInput,
): Promise<ManualCloseResult> {
  const actor = input.actor.trim().slice(0, 64);
  const reason = redactText(input.reason.trim()).slice(0, 500);
  if (!actor || !reason) return { applied: false, reason: 'INVALID_INPUT' };
  const cur = await db.query<{ status: string; started_at: Date }>(
    'SELECT status, started_at FROM fin_source_runs WHERE id = $1',
    [input.runId],
  );
  const row = cur.rows[0];
  if (!row) return { applied: false, reason: 'NOT_FOUND' };
  if (row.status !== 'RUNNING') return { applied: false, reason: 'NOT_RUNNING' };
  if (row.started_at.getTime() !== input.expectedStartedAt.getTime())
    return { applied: false, reason: 'STARTED_AT_CHANGED' };
  const r = await db.query<RunRow>(
    `UPDATE fin_source_runs
     SET finished_at = now(), status = 'FAILED', error_code = 'RECOVERY_MANUAL_CLOSE',
         error_message = '담당자가 복구 절차로 미종료 실행을 실패로 마감', failure_kind = 'STORAGE',
         note = '수동 복구 마감(담당자 확인 후)', closed_by = $2, close_reason = $3
     WHERE id = $1 AND status = 'RUNNING' AND date_trunc('milliseconds', started_at) = date_trunc('milliseconds', $4::timestamptz)
     RETURNING ${RUN_COLS}`,
    [input.runId, actor, reason, input.expectedStartedAt],
  );
  const updated = r.rows[0];
  if (!updated) return { applied: false, reason: 'STARTED_AT_CHANGED' };
  return { applied: true, run: toRun(updated) };
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
  }[];
  orphanRawKeys: string[];
  rawRowsMissingBytes: string[];
}

/** 미리보기: 상태를 바꾸지 않는다. */
export async function previewRecovery(
  db: Queryable,
  store: RawStore,
  olderThanMs = DEFAULT_CANDIDATE_AGE_MS,
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
    })),
    orphanRawKeys: await findOrphanRawKeys(db, store),
    rawRowsMissingBytes: await findRawRowsMissingBytes(db, store),
  };
}
