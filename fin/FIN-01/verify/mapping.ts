/**
 * 원천 필드 → 표준 필드 대응 명세와 적용 엔진.
 *
 * 필드매핑표(FIN-01_필드매핑표.md)의 각 행은 이 명세의 FieldMapping 하나에 대응한다.
 * status 는 "원천 문서를 어떤 근거로 확인했는가" 를 기록하며, ASSUMED 는 실제 응답으로
 * 확인되기 전까지 검증 완료로 취급하지 않는다.
 */

import { createHash } from 'node:crypto';

export type EvidenceStatus =
  | 'CONFIRMED' // 공식 문서 원문 또는 실제 응답으로 확인
  | 'SNIPPET' // 공식 문서의 검색 결과 발췌로만 확인(원문 미열람)
  | 'ASSUMED' // 문서 미확인 상태의 자리표시자. 실제 응답 확보 후 확정 필요
  | 'UNVERIFIED' // 제공 여부 자체를 확인하지 못함("지원하지 않음" 이 아님)
  | 'MISSING'; // 원천이 제공하지 않음을 공식 근거로 확인(대체 규칙 필요)

export type Transform =
  | 'identity'
  | 'decimal'
  | 'micros_to_decimal'
  | 'yyyymmdd_to_iso_date'
  | 'yyyymmdd_hhmmss_to_local_datetime'
  | 'inout_to_direction'
  | 'constant'
  | 'derived';

export interface FieldMapping {
  /** 표준 필드명(types.ts) */
  target: string;
  /** 원천 필드 경로(점 구분). derived/constant 는 생략 가능 */
  source?: string;
  transform: Transform;
  status: EvidenceStatus;
  /** constant 변환 시 값 */
  constant?: string;
  /** 대체 규칙·근거·주의 */
  note: string;
}

export interface SourceSpec {
  sourceSystem: string;
  displayName: string;
  /** 공식 문서 URL 과 확인일. access 는 실제 열람 수준 */
  docs: { url: string; checkedOn: string; access: 'FULL_TEXT' | 'SEARCH_SNIPPET' | 'BLOCKED' }[];
  /** 원천 시간대 */
  sourceTz: string;
  /** 원천 고유키 구성(시스템+계정+거래/행/이벤트 ID) */
  keyFields: string[];
  mappings: FieldMapping[];
}

export interface MappingCoverage {
  confirmed: number;
  snippet: number;
  assumed: number;
  unverified: number;
  missing: number;
  total: number;
}

export function coverage(spec: SourceSpec): MappingCoverage {
  const c: MappingCoverage = {
    confirmed: 0,
    snippet: 0,
    assumed: 0,
    unverified: 0,
    missing: 0,
    total: 0,
  };
  for (const m of spec.mappings) {
    c.total += 1;
    if (m.status === 'CONFIRMED') c.confirmed += 1;
    else if (m.status === 'SNIPPET') c.snippet += 1;
    else if (m.status === 'ASSUMED') c.assumed += 1;
    else if (m.status === 'UNVERIFIED') c.unverified += 1;
    else c.missing += 1;
  }
  return c;
}

/** 점 구분 경로로 중첩 값을 읽는다. */
export function readPath(raw: unknown, path: string): unknown {
  let cur: unknown = raw;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 원천 레코드의 안정적 payload 해시(키 정렬 JSON, SHA-256). */
export function payloadHash(raw: unknown): string {
  return createHash('sha256').update(stableJson(raw)).digest('hex');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 원천키 = 시스템 + 계정 + 지정 필드 값들. */
export function buildSourceKey(
  sourceSystem: string,
  accountAlias: string,
  raw: unknown,
  keyFields: readonly string[],
): string {
  const parts = keyFields.map((f) => {
    const v = readPath(raw, f);
    if (v === undefined || v === null || v === '') {
      throw new Error(`원천키 필드 누락: ${sourceSystem}.${f}`);
    }
    return String(v);
  });
  return [sourceSystem, accountAlias, ...parts].join('|');
}
