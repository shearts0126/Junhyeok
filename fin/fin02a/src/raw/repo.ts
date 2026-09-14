import type { Queryable } from '../db/client';
import { sha256Hex } from '../hash';
import type { RequestSummary } from '../redact';

import type { RawStore } from './store';

export interface RawObject {
  id: string;
  sourceRunId: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  storageKey: string;
  collectedAt: Date;
  requestSummary: RequestSummary;
}

/**
 * 원본 보관: 바이트를 변경하지 않고 저장소에 두고, 해시·실행 ID·수집 시각·콘텐츠 유형·요청 요약을 기록한다.
 * 같은 해시가 다시 수신돼도 실행마다 새 행을 만든다(실행 이력과 원본의 1:N 추적 유지).
 */
export async function storeRawObject(
  db: Queryable,
  store: RawStore,
  input: {
    sourceRunId: string;
    bytes: Uint8Array;
    contentType: string;
    requestSummary: RequestSummary;
  },
): Promise<RawObject> {
  const sha256 = sha256Hex(input.bytes);
  const storageKey = `${input.sourceRunId}/${sha256}`;
  await store.put(storageKey, input.bytes);
  const r = await db.query<RawRow>(
    `INSERT INTO fin_raw_objects (source_run_id, sha256, byte_size, content_type, storage_key, request_summary)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, source_run_id, sha256, byte_size, content_type, storage_key, collected_at, request_summary`,
    [
      input.sourceRunId,
      sha256,
      input.bytes.byteLength,
      input.contentType,
      storageKey,
      JSON.stringify(input.requestSummary),
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error('원본 객체 저장 실패');
  return toRaw(row);
}

export async function getRawObject(db: Queryable, id: string): Promise<RawObject | null> {
  const r = await db.query<RawRow>(
    'SELECT id, source_run_id, sha256, byte_size, content_type, storage_key, collected_at, request_summary FROM fin_raw_objects WHERE id = $1',
    [id],
  );
  const row = r.rows[0];
  return row ? toRaw(row) : null;
}

interface RawRow {
  id: string;
  source_run_id: string;
  sha256: string;
  byte_size: string | number;
  content_type: string;
  storage_key: string;
  collected_at: Date;
  request_summary: RequestSummary;
}

function toRaw(row: RawRow): RawObject {
  return {
    id: row.id,
    sourceRunId: row.source_run_id,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
    contentType: row.content_type,
    storageKey: row.storage_key,
    collectedAt: row.collected_at,
    requestSummary: row.request_summary,
  };
}
