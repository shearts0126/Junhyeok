/**
 * 실제 호출용 최소 HTTP 래퍼. 응답 본문은 저장하지 않고 요약(상태·건수·해시)만 남긴다.
 * 비밀값은 로그에 출력하지 않는다.
 */

import { createHash } from 'node:crypto';

export type LiveStatus = 'OK' | 'BLOCKED_NO_CREDENTIALS' | 'BLOCKED_NETWORK' | 'FAILED';

export interface LiveResult {
  source: string;
  status: LiveStatus;
  startedAtUtc: string;
  finishedAtUtc: string;
  /** 민감 정보 없는 요약(HTTP 상태, 건수, 본문 해시 등) */
  summary: string;
  /** 실제 수집 검증 여부. OK 여도 대조까지 끝나야 true */
  verified: boolean;
}

export function requireEnv(
  names: readonly string[],
): { ok: true; env: Record<string, string> } | { ok: false; missing: string[] } {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const v = process.env[n];
    if (!v) missing.push(n);
    else env[n] = v;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, env };
}

export function blockedNoCredentials(source: string, missing: readonly string[]): LiveResult {
  const now = new Date().toISOString();
  return {
    source,
    status: 'BLOCKED_NO_CREDENTIALS',
    startedAtUtc: now,
    finishedAtUtc: now,
    summary: `환경변수 미설정: ${missing.join(', ')} → 실제 수집 미검증`,
    verified: false,
  };
}

export async function fetchSummary(
  source: string,
  url: string,
  init: RequestInit & { redactQuery?: boolean } = {},
): Promise<LiveResult> {
  const startedAtUtc = new Date().toISOString();
  const shownUrl = init.redactQuery ? url.split('?')[0] : url;
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    let count = -1;
    try {
      const json: unknown = JSON.parse(text);
      if (Array.isArray(json)) count = json.length;
      else if (json && typeof json === 'object') {
        const o = json as Record<string, unknown>;
        const arr = ['data', 'res_list', 'orders', 'list'].map((k) => o[k]).find(Array.isArray);
        if (arr) count = (arr as unknown[]).length;
      }
    } catch {
      /* 본문이 JSON 이 아니면 건수 미산정 */
    }
    // 본 환경의 egress 프록시는 허용 목록 밖 호스트에 403 + x-deny-reason 헤더로 응답한다(원천 서버 응답 아님).
    const denyReason = res.headers.get('x-deny-reason');
    const status = res.ok ? 'OK' : denyReason ? 'BLOCKED_NETWORK' : 'FAILED';
    return {
      source,
      status,
      startedAtUtc,
      finishedAtUtc: new Date().toISOString(),
      summary: `${shownUrl} → HTTP ${res.status}${denyReason ? ` (egress proxy: ${denyReason})` : ''}, bytes ${text.length}, sha256:${hash}, items ${count}`,
      verified: false,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const blocked = /403|CONNECT|EGRESS|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg);
    return {
      source,
      status: blocked ? 'BLOCKED_NETWORK' : 'FAILED',
      startedAtUtc,
      finishedAtUtc: new Date().toISOString(),
      summary: `${shownUrl} → ${msg}`,
      verified: false,
    };
  }
}
