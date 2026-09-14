import type { Queryable } from '../db/client';
import { payloadHash } from '../hash';

/**
 * 관측 버전과 중복 처리 기반.
 * - sourceKey 가 있으면 (계정, 키) 범위에서 식별한다.
 * - 동일 키·동일 내용: 업무 버전을 늘리지 않는다(UNCHANGED). 단, 실행별 연결(fin_source_record_observations)은 매 실행 남긴다.
 * - 동일 키·변경 내용: 새 버전을 추가하고 이전 payload 를 보존(VERSIONED).
 * - sourceKey 가 없으면 '미식별' 로 매번 보존(UNIDENTIFIED). 날짜·금액·적요가 같아도 합치지 않는다.
 *   미식별 레코드는 후속 업무 집계에 바로 사용할 수 없는 자료이며 중복 후보 검토는 이 범위 밖이다.
 *
 * 호출자는 이 함수를 대조(reconcile) 성공 후, 실행 종료 기록과 같은 트랜잭션 안에서 호출한다.
 */

export interface ObservationInput {
  sourceKey: string | null;
  payload: unknown;
}

export type ObservationOutcome = 'INSERTED' | 'UNCHANGED' | 'VERSIONED' | 'UNIDENTIFIED';

export interface ObservationResult {
  outcome: ObservationOutcome;
  recordId: string;
  versionId: string;
  version: number;
}

export interface ObserveSummary {
  inserted: number;
  unchanged: number;
  versioned: number;
  unidentified: number;
  results: ObservationResult[];
}

export interface ObserveContext {
  sourceAccountId: string;
  sourceRunId: string;
  rawObjectId: string;
}

export async function observe(
  db: Queryable,
  ctx: ObserveContext,
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
    let result: ObservationResult;
    if (o.sourceKey === null) {
      const rec = await insertRecord(db, ctx, null, hash);
      const versionId = await insertVersion(db, ctx, rec, 1, hash, o.payload);
      summary.unidentified += 1;
      result = { outcome: 'UNIDENTIFIED', recordId: rec, versionId, version: 1 };
    } else {
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
        const rec = await insertRecord(db, ctx, o.sourceKey, hash);
        const versionId = await insertVersion(db, ctx, rec, 1, hash, o.payload);
        summary.inserted += 1;
        result = { outcome: 'INSERTED', recordId: rec, versionId, version: 1 };
      } else if (row.current_payload_hash === hash) {
        await db.query(
          'UPDATE fin_source_records SET last_run_id = $2, updated_at = now() WHERE id = $1',
          [row.id, ctx.sourceRunId],
        );
        const cur = await db.query<{ id: string }>(
          'SELECT id FROM fin_source_record_versions WHERE source_record_id = $1 AND version = $2',
          [row.id, row.current_version],
        );
        const versionId = cur.rows[0]?.id;
        if (!versionId) throw new Error('현재 버전 행 없음');
        summary.unchanged += 1;
        result = {
          outcome: 'UNCHANGED',
          recordId: row.id,
          versionId,
          version: row.current_version,
        };
      } else {
        const next = row.current_version + 1;
        const versionId = await insertVersion(db, ctx, row.id, next, hash, o.payload);
        await db.query(
          'UPDATE fin_source_records SET current_version = $2, current_payload_hash = $3, last_run_id = $4, updated_at = now() WHERE id = $1',
          [row.id, next, hash, ctx.sourceRunId],
        );
        summary.versioned += 1;
        result = { outcome: 'VERSIONED', recordId: row.id, versionId, version: next };
      }
    }
    // 실행별 연결: 중복 제거(업무 버전)와 추적 이력(실행 연결)을 분리한다.
    await db.query(
      `INSERT INTO fin_source_record_observations (source_run_id, source_account_id, source_record_id, version_id, raw_object_id, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ctx.sourceRunId,
        ctx.sourceAccountId,
        result.recordId,
        result.versionId,
        ctx.rawObjectId,
        result.outcome,
      ],
    );
    summary.results.push(result);
  }
  return summary;
}

async function insertRecord(
  db: Queryable,
  ctx: ObserveContext,
  key: string | null,
  hash: string,
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO fin_source_records (source_account_id, source_key, current_version, current_payload_hash, first_run_id, last_run_id)
     VALUES ($1, $2, 1, $3, $4, $4) RETURNING id`,
    [ctx.sourceAccountId, key, hash, ctx.sourceRunId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('원천 레코드 저장 실패');
  return row.id;
}

async function insertVersion(
  db: Queryable,
  ctx: ObserveContext,
  recordId: string,
  version: number,
  hash: string,
  payload: unknown,
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO fin_source_record_versions (source_record_id, source_account_id, version, payload_hash, payload, raw_object_id, source_run_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
    [
      recordId,
      ctx.sourceAccountId,
      version,
      hash,
      JSON.stringify(payload),
      ctx.rawObjectId,
      ctx.sourceRunId,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error('관측 버전 저장 실패');
  return row.id;
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
