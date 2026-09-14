import type { Queryable } from './db/client';
import type { RawStore } from './raw/store';
import { finishRun, type SourceRun } from './runs/repo';

/**
 * 최소 복구 경계.
 * try/catch 는 프로세스 강제 종료·DB 장애로 종료 상태를 못 남기는 경우를 해결하지 못한다. 그런 실행은 RUNNING 으로 남으며,
 * 아래 절차가 이를 식별하고 실패로 마감한다. 원본 파일이 있는데 메타데이터 행이 없는 고아 원본도 식별한다.
 * 재처리(재수집)는 새 실행으로 수행하며, 원본 키에 실행 ID 가 포함되고 관측 저장이 (계정,키,해시) 기준으로 멱등이므로
 * 이전 실패 실행의 잔여물이 중복 부작용을 만들지 않는다.
 */

export async function listUnfinishedRuns(
  db: Queryable,
  olderThanMs: number,
  now = new Date(),
): Promise<SourceRun[]> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const r = await db.query<{ id: string }>(
    `SELECT id FROM fin_source_runs WHERE status = 'RUNNING' AND started_at < $1 ORDER BY started_at`,
    [cutoff],
  );
  const out: SourceRun[] = [];
  for (const row of r.rows) {
    const run = await db.query<{
      id: string;
      source_account_id: string;
      period_from: string;
      period_to: string;
      started_at: Date;
      finished_at: Date | null;
      status: SourceRun['status'];
      stages: SourceRun['stages'];
      error_code: string | null;
      error_message: string | null;
      failure_kind: SourceRun['failureKind'];
      error_class: string | null;
      source_as_of: Date | null;
      received_count: number | null;
      note: string | null;
    }>(
      'SELECT id, source_account_id, period_from::text, period_to::text, started_at, finished_at, status, stages, error_code, error_message, failure_kind, error_class, source_as_of, received_count, note FROM fin_source_runs WHERE id = $1',
      [row.id],
    );
    const x = run.rows[0];
    if (x)
      out.push({
        id: x.id,
        sourceAccountId: x.source_account_id,
        periodFrom: x.period_from,
        periodTo: x.period_to,
        startedAt: x.started_at,
        finishedAt: x.finished_at,
        status: x.status,
        stages: x.stages,
        errorCode: x.error_code,
        errorMessage: x.error_message,
        failureKind: x.failure_kind,
        errorClass: x.error_class,
        sourceAsOf: x.source_as_of,
        receivedCount: x.received_count,
        note: x.note,
      });
  }
  return out;
}

/** 미종료 실행을 FAILED/STORAGE 로 마감한다. 관측이 커밋됐다면 실행 종료도 같은 트랜잭션이었으므로 RUNNING 은 관측 없음을 뜻한다. */
export async function markUnfinishedRunFailed(db: Queryable, runId: string): Promise<SourceRun> {
  return finishRun(db, runId, {
    status: 'FAILED',
    stages: {},
    errorCode: 'RECOVERY_STALE_RUNNING',
    failureKind: 'STORAGE',
    sourceAsOf: null,
    receivedCount: null,
    note: '복구 절차: 종료 기록 없이 남은 실행을 실패로 마감',
  });
}

/** 저장소에는 있으나 fin_raw_objects 행이 없는 키(메타데이터 저장 실패·강제 종료의 잔여물). */
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

/** fin_raw_objects 행은 있으나 저장소에 바이트가 없는 키(저장소 유실). */
export async function findRawRowsMissingBytes(db: Queryable, store: RawStore): Promise<string[]> {
  const keys = new Set(await store.list());
  const r = await db.query<{ storage_key: string }>('SELECT storage_key FROM fin_raw_objects');
  return r.rows.map((x) => x.storage_key).filter((k) => !keys.has(k));
}
