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

export function rawStorageKey(sourceRunId: string, sha256: string): string {
  return `${sourceRunId}/${sha256}`;
}

/** 원본 바이트를 변경 없이 저장소에 둔다(1단계). 실패는 호출자가 RAW_STORE_FAILED 로 분류한다. */
export async function putRawBytes(
  store: RawStore,
  sourceRunId: string,
  bytes: Uint8Array,
): Promise<{ sha256: string; storageKey: string }> {
  const sha256 = sha256Hex(bytes);
  const storageKey = rawStorageKey(sourceRunId, sha256);
  await store.put(storageKey, bytes);
  return { sha256, storageKey };
}

/**
 * 원본 메타데이터 행(2단계). 해시·실행 ID·수집 시각·콘텐츠 유형·요청 요약(원천·메서드·템플릿만).
 * 같은 해시가 다시 수신돼도 실행마다 새 행을 만든다(실행 이력과 원본의 추적 유지).
 * 실패는 호출자가 RAW_META_FAILED 로 분류하며 이미 저장된 바이트는 고아 원본 후보가 된다(recovery.findOrphanRawKeys).
 */
export async function insertRawObject(
  db: Queryable,
  input: {
    sourceRunId: string;
    sha256: string;
    storageKey: string;
    byteSize: number;
    contentType: string;
    requestSummary: RequestSummary;
  },
): Promise<RawObject> {
  const r = await db.query<RawRow>(
    `INSERT INTO fin_raw_objects (source_run_id, sha256, byte_size, content_type, storage_key, request_summary)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, source_run_id, sha256, byte_size, content_type, storage_key, collected_at, request_summary`,
    [
      input.sourceRunId,
      input.sha256,
      input.byteSize,
      input.contentType,
      input.storageKey,
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
