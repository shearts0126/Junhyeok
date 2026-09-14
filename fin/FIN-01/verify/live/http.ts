/**
 * 실제 호출용 최소 HTTP 래퍼.
 *
 * 비밀값 정책(2차 검토 반영): 실제 URL 은 어디에도 기록하지 않는다. 결과·로그에는 호출자가 선언한
 * 안전한 엔드포인트 템플릿(예: `GET oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?data=AP01&searchdate={date}`)만 남긴다.
 * 외부 예외 메시지도 그대로 남기지 않고 내부 오류 코드로 분류한다. 응답 본문은 저장하지 않고 상태·바이트 수·해시만 남긴다.
 */

import { createHash } from 'node:crypto';

export type LiveStatus = 'OK' | 'BLOCKED_NO_CREDENTIALS' | 'BLOCKED_NETWORK' | 'FAILED';

export type ImplementationLevel =
  | 'CREDENTIAL_CHECK_ONLY'
  | 'REQUEST_BUILT_SPEC_SNIPPET'
  | 'REQUEST_BUILT_SPEC_ASSUMED'
  | 'PARSE_AND_RECONCILE';

export interface LiveResult {
  source: string;
  status: LiveStatus;
  implementation: ImplementationLevel;
  parsingImplemented: boolean;
  startedAtUtc: string;
  finishedAtUtc: string;
  /** 안전한 엔드포인트 템플릿(실제 URL 아님). 인증키가 경로에 들어가는 API 도 {authkey} 자리표시자로만 표기 */
  endpoint: string;
  /** 민감 정보 없는 요약(HTTP 상태·바이트·해시·항목 수 또는 내부 오류 코드) */
  summary: string;
  verified: boolean;
}

/** 템플릿에 허용되는 문자만 통과시킨다. '=' 뒤에 오는 값은 자리표시자 {…} 또는 고정 상수만 허용한다. */
const TEMPLATE_RE = /^(GET|POST) [A-Za-z0-9._\-/{}?&=:]{1,200}$/;
export function assertSafeTemplate(t: string): string {
  if (!TEMPLATE_RE.test(t) || /=(?!\{)[^&]*[A-Za-z0-9]{20,}/.test(t))
    throw new Error('안전하지 않은 엔드포인트 템플릿');
  return t;
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

export function blockedNoCredentials(
  source: string,
  missing: readonly string[],
  implementation: ImplementationLevel,
  endpoint: string,
): LiveResult {
  const now = new Date().toISOString();
  return {
    source,
    status: 'BLOCKED_NO_CREDENTIALS',
    implementation,
    parsingImplemented: false,
    startedAtUtc: now,
    finishedAtUtc: now,
    endpoint: assertSafeTemplate(endpoint),
    summary: `환경변수 미설정: ${missing.join(', ')} → 실제 수집 미검증`,
    verified: false,
  };
}

/** 외부 예외를 내부 코드로 분류한다. 예외 메시지 자체는 반환·기록하지 않는다. */
function classifyError(e: unknown): { code: string; blocked: boolean } {
  const msg =
    e instanceof Error
      ? `${e.name} ${e.message} ${String((e as { cause?: unknown }).cause ?? '')}`
      : String(e);
  if (/TimeoutError|aborted/i.test(msg)) return { code: 'TIMEOUT', blocked: false };
  if (/403|CONNECT|EGRESS|host_not_allowed/i.test(msg))
    return { code: 'EGRESS_BLOCKED', blocked: true };
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return { code: 'DNS_FAILED', blocked: true };
  if (/ECONNREFUSED|ECONNRESET|fetch failed/i.test(msg))
    return { code: 'CONNECTION_FAILED', blocked: true };
  return { code: 'UNKNOWN_FETCH_ERROR', blocked: false };
}

export async function fetchSummary(
  source: string,
  url: string,
  implementation: ImplementationLevel,
  endpoint: string,
  init: RequestInit = {},
): Promise<LiveResult> {
  const startedAtUtc = new Date().toISOString();
  const safeEndpoint = assertSafeTemplate(endpoint);
  const base = {
    source,
    implementation,
    parsingImplemented: false,
    startedAtUtc,
    endpoint: safeEndpoint,
    verified: false,
  };
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
    const status: LiveStatus = res.ok ? 'OK' : denyReason ? 'BLOCKED_NETWORK' : 'FAILED';
    return {
      ...base,
      status,
      finishedAtUtc: new Date().toISOString(),
      summary: `HTTP ${res.status}${denyReason ? ` (egress proxy: ${denyReason})` : ''}, bytes ${text.length}, sha256:${hash}, items ${count}`,
    };
  } catch (e) {
    const c = classifyError(e);
    return {
      ...base,
      status: c.blocked ? 'BLOCKED_NETWORK' : 'FAILED',
      finishedAtUtc: new Date().toISOString(),
      summary: `내부 오류 코드 ${c.code}`,
    };
  }
}
