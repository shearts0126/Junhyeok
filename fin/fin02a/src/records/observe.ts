import type { Queryable } from '../db/client';
import { payloadHash } from '../hash';

/**
 * 관측 버전과 중복 처리 기반.
 * - sourceKey 가 있으면 (계정, 키) 범위에서 식별한다.
 * - 동일 키·동일 내용: 새 관측을 만들지 않고 last_run 만 갱신(UNCHANGED).
 * - 동일 키·변경 내용: 새 버전을 추가하고 이전 payload 를 보존(VERSIONED).
 * - sourceKey 가 없으면 '미식별' 로 매번 보존(UNIDENTIFIED). 날짜·금액·적요가 같아도 합치지 않는다.
 */

export interface ObservationInput {
  sourceKey: string | null;
  payload: unknown;
}

export type ObservationOutcome = 'INSERTED' | 'UNCHANGED' | 'VERSIONED' | 'UNIDENTIFIED';

export interface ObservationResult {
  outcome: ObservationOutcome;
  recordId: string;
  version: number;
}

export interface ObserveSummary {
  inserted: number;
  unchanged: number;
  versioned: number;
  unidentified: number;
  results: ObservationResult[];
}

export async function observe(
  db: Queryable,
  ctx: { sourceAccountId: string; sourceRunId: string; rawObjectId: string },
  observations: readonly ObservationInput[],
): Promise<ObserveSummary> {
  const summary: ObserveSummary = {
    inserted: 0,
    unchanged: 0,
    versioned: 0,
    unidentified: 0,
    results: [],
  };
  for (const o of observations) {
    const hash = payloadHash(o.payload);
    if (o.sourceKey === null) {
      const rec = await insertRecord(db, ctx.sourceAccountId, null, hash, ctx.sourceRunId);
      await insertVersion(db, rec, 1, hash, o.payload, ctx);
      summary.unidentified += 1;
      summary.results.push({ outcome: 'UNIDENTIFIED', recordId: rec, version: 1 });
      continue;
    }
    const existing = await db.query<{
      id: string;
      current_version: number;
      current_payload_hash: string;
    }>(
      `SELECT id, current_version, current_payload_hash FROM fin_source_records
       WHERE source_account_id = $1 AND source_key = $2 FOR UPDATE`,
      [ctx.sourceAccountId, o.sourceKey],
    );
    const row = existing.rows[0];
    if (!row) {
      const rec = await insertRecord(db, ctx.sourceAccountId, o.sourceKey, hash, ctx.sourceRunId);
      await insertVersion(db, rec, 1, hash, o.payload, ctx);
      summary.inserted += 1;
      summary.results.push({ outcome: 'INSERTED', recordId: rec, version: 1 });
    } else if (row.current_payload_hash === hash) {
      await db.query(
        'UPDATE fin_source_records SET last_run_id = $2, updated_at = now() WHERE id = $1',
        [row.id, ctx.sourceRunId],
      );
      summary.unchanged += 1;
      summary.results.push({
        outcome: 'UNCHANGED',
        recordId: row.id,
        version: row.current_version,
      });
    } else {
      const next = row.current_version + 1;
      await insertVersion(db, row.id, next, hash, o.payload, ctx);
      await db.query(
        'UPDATE fin_source_records SET current_version = $2, current_payload_hash = $3, last_run_id = $4, updated_at = now() WHERE id = $1',
        [row.id, next, hash, ctx.sourceRunId],
      );
      summary.versioned += 1;
      summary.results.push({ outcome: 'VERSIONED', recordId: row.id, version: next });
    }
  }
  return summary;
}

async function insertRecord(
  db: Queryable,
  accountId: string,
  key: string | null,
  hash: string,
  runId: string,
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO fin_source_records (source_account_id, source_key, current_version, current_payload_hash, first_run_id, last_run_id)
     VALUES ($1, $2, 1, $3, $4, $4) RETURNING id`,
    [accountId, key, hash, runId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('원천 레코드 저장 실패');
  return row.id;
}

async function insertVersion(
  db: Queryable,
  recordId: string,
  version: number,
  hash: string,
  payload: unknown,
  ctx: { sourceRunId: string; rawObjectId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO fin_source_record_versions (source_record_id, version, payload_hash, payload, raw_object_id, source_run_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [recordId, version, hash, JSON.stringify(payload), ctx.rawObjectId, ctx.sourceRunId],
  );
}

export interface RecordVersion {
  id: string;
  recordId: string;
  version: number;
  payloadHash: string;
  payload: unknown;
  rawObjectId: string;
  sourceRunId: string;
  observedAt: Date;
}

export async function listVersions(db: Queryable, recordId: string): Promise<RecordVersion[]> {
  const r = await db.query<{
    id: string;
    source_record_id: string;
    version: number;
    payload_hash: string;
    payload: unknown;
    raw_object_id: string;
    source_run_id: string;
    observed_at: Date;
  }>(
    'SELECT id, source_record_id, version, payload_hash, payload, raw_object_id, source_run_id, observed_at FROM fin_source_record_versions WHERE source_record_id = $1 ORDER BY version',
    [recordId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    recordId: x.source_record_id,
    version: x.version,
    payloadHash: x.payload_hash,
    payload: x.payload,
    rawObjectId: x.raw_object_id,
    sourceRunId: x.source_run_id,
    observedAt: x.observed_at,
  }));
}
