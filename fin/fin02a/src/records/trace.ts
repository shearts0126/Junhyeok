import type { Queryable } from '../db/client';

/** 처리 결과(관측 버전) → 원본 객체 → 수집 실행 → 원천 계정 → 법인 추적. */
export interface Trace {
  versionId: string;
  version: number;
  recordId: string;
  sourceKey: string | null;
  rawObjectId: string;
  rawSha256: string;
  storageKey: string;
  runId: string;
  runStatus: string;
  periodFrom: string;
  periodTo: string;
  sourceAccountAlias: string;
  legalEntityCode: string;
}

export async function traceVersion(db: Queryable, versionId: string): Promise<Trace | null> {
  const r = await db.query<Trace>(
    `SELECT v.id AS "versionId", v.version, v.source_record_id AS "recordId", rec.source_key AS "sourceKey",
            ro.id AS "rawObjectId", ro.sha256 AS "rawSha256", ro.storage_key AS "storageKey",
            run.id AS "runId", run.status AS "runStatus", run.period_from::text AS "periodFrom", run.period_to::text AS "periodTo",
            acc.alias AS "sourceAccountAlias", le.code AS "legalEntityCode"
     FROM fin_source_record_versions v
     JOIN fin_source_records rec ON rec.id = v.source_record_id
     JOIN fin_raw_objects ro ON ro.id = v.raw_object_id
     JOIN fin_source_runs run ON run.id = v.source_run_id
     JOIN fin_source_accounts acc ON acc.id = rec.source_account_id
     JOIN fin_legal_entities le ON le.id = acc.legal_entity_id
     WHERE v.id = $1`,
    [versionId],
  );
  return r.rows[0] ?? null;
}

/** 실행 → 그 실행이 관측한 (레코드, 버전, 원본) 목록. 내용이 같아 버전이 늘지 않은 실행도 조회된다. */
export interface RunObservation {
  recordId: string;
  sourceKey: string | null;
  versionId: string;
  version: number;
  outcome: string;
  rawObjectId: string;
  rawSha256: string;
}

export async function traceRun(db: Queryable, runId: string): Promise<RunObservation[]> {
  const r = await db.query<RunObservation>(
    `SELECT o.source_record_id AS "recordId", rec.source_key AS "sourceKey", o.version_id AS "versionId", v.version,
            o.outcome, o.raw_object_id AS "rawObjectId", ro.sha256 AS "rawSha256"
     FROM fin_source_record_observations o
     JOIN fin_source_records rec ON rec.id = o.source_record_id
     JOIN fin_source_record_versions v ON v.id = o.version_id
     JOIN fin_raw_objects ro ON ro.id = o.raw_object_id
     WHERE o.source_run_id = $1
     ORDER BY o.observed_at, rec.source_key`,
    [runId],
  );
  return r.rows;
}

/** 레코드 → 이 레코드를 관측한 모든 실행(첫·중간·마지막). */
export async function runsForRecord(
  db: Queryable,
  recordId: string,
): Promise<
  { runId: string; versionId: string; version: number; outcome: string; rawObjectId: string }[]
> {
  const r = await db.query<{
    runId: string;
    versionId: string;
    version: number;
    outcome: string;
    rawObjectId: string;
  }>(
    `SELECT o.source_run_id AS "runId", o.version_id AS "versionId", v.version, o.outcome, o.raw_object_id AS "rawObjectId"
     FROM fin_source_record_observations o JOIN fin_source_record_versions v ON v.id = o.version_id
     WHERE o.source_record_id = $1 ORDER BY o.observed_at`,
    [recordId],
  );
  return r.rows;
}
