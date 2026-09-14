/**
 * 재수집 무중복·관측 버전 검증(계획서 §5 source_records 규칙).
 *
 * - 같은 원천키 + 같은 payload 해시 → 새 버전을 만들지 않는다.
 * - 같은 원천키 + 다른 payload 해시 → 관측 버전을 추가하고 최신 유효 레코드로 대체한다.
 * - 날짜·금액·적요만 같은 두 정상 거래는 원천키가 다르므로 합쳐지지 않는다.
 */

import { payloadHash } from './mapping';
import type { SourceRecord, SourceSystem } from './types';

export interface IngestResult {
  inserted: number;
  unchanged: number;
  versioned: number;
}

export class SourceRecordStore {
  private readonly records = new Map<string, SourceRecord>();
  private readonly payloads = new Map<string, unknown>();

  ingest(
    sourceSystem: SourceSystem,
    accountAlias: string,
    runId: string,
    items: readonly { sourceKey: string; raw: unknown }[],
  ): IngestResult {
    const result: IngestResult = { inserted: 0, unchanged: 0, versioned: 0 };
    for (const item of items) {
      const hash = payloadHash(item.raw);
      const existing = this.records.get(item.sourceKey);
      if (!existing) {
        this.records.set(item.sourceKey, {
          sourceSystem,
          accountAlias,
          sourceKey: item.sourceKey,
          payloadHash: hash,
          observedVersion: 1,
          firstSeenRunId: runId,
          lastSeenRunId: runId,
        });
        this.payloads.set(item.sourceKey, item.raw);
        result.inserted += 1;
      } else if (existing.payloadHash === hash) {
        existing.lastSeenRunId = runId;
        result.unchanged += 1;
      } else {
        existing.payloadHash = hash;
        existing.observedVersion += 1;
        existing.lastSeenRunId = runId;
        this.payloads.set(item.sourceKey, item.raw);
        result.versioned += 1;
      }
    }
    return result;
  }

  size(): number {
    return this.records.size;
  }

  get(sourceKey: string): SourceRecord | undefined {
    return this.records.get(sourceKey);
  }

  /** 최신 유효 payload 목록(재계산 입력). */
  latestPayloads(): { sourceKey: string; raw: unknown; version: number }[] {
    const out: { sourceKey: string; raw: unknown; version: number }[] = [];
    for (const [key, rec] of this.records) {
      out.push({ sourceKey: key, raw: this.payloads.get(key), version: rec.observedVersion });
    }
    return out;
  }
}
