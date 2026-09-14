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
