/**
 * 비밀값 취급 경계.
 *
 * 원칙(2차 검토 반영): "정규식으로 모든 비밀값을 탐지한다" 는 보장 대신, 영속화·로그에 허용되는 메타데이터를
 * 명시적으로 제한한다.
 * - 요청 요약: 원천 시스템·HTTP 메서드·안전한 엔드포인트 템플릿만. 실제 URL·헤더 값은 받지도 저장하지도 않는다.
 * - 오류: 내부 오류 코드(식별자 패턴)와 코드별 고정 설명만. 외부 예외 메시지는 영속화하지 않는다.
 * - note: 파이프라인이 만든 고정 문장만.
 * - redactText 는 로그 한 줄을 조립할 때의 보조 방어선이며 정책의 근거가 아니다.
 */

/** 오류 코드·단계 코드 식별자 패턴 */
export const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function isCode(v: unknown): v is string {
  return typeof v === 'string' && CODE_RE.test(v);
}

/**
 * 안전한 엔드포인트 템플릿. 실제 값 대신 {placeholder} 를 쓴다.
 * 허용 문자 외('?', '=', '&' 포함)는 거부해 쿼리 문자열·자격값이 들어올 수 없게 한다.
 * 예: 'GET /site/program/financial/exchangeJSON{authkey,searchdate,data=AP01}' 대신 'GET /site/program/financial/exchangeJSON'
 */
const ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE) [A-Za-z0-9._\-/{}:]{1,200}$/;

export function isSafeEndpoint(v: unknown): v is string {
  return typeof v === 'string' && ENDPOINT_RE.test(v) && !/[A-Za-z0-9]{24,}/.test(v);
}

/** 영속화되는 요청 요약. 이 세 필드 외에는 받지 않는다. */
export interface RequestSummary {
  sourceSystem: string;
  method: string;
  endpoint: string;
}

export function buildRequestSummary(sourceSystem: string, endpoint: string): RequestSummary | null {
  if (!isSafeEndpoint(endpoint)) return null;
  const [method, path] = endpoint.split(' ', 2) as [string, string];
  return { sourceSystem, method, endpoint: path };
}

/** 로그 조립용 보조 마스킹. 저장 데이터의 근거로 쓰지 않는다. */
export function redactText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]')
    .replace(
      /([?&/](?:authkey|access_token|token|api_key|apikey|key|secret|client_secret|signature|password|refresh_token)[=/])[^&\s"'/]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:authkey|access_token|token|api_key|apikey|secret|client_secret|signature|password|refresh_token)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1[REDACTED]',
    );
}

/** 응답 JSON 에 토큰 성격의 필드가 있는지(어느 깊이든). 있으면 업무 원본으로 저장하지 않는다. */
const TOKEN_FIELD_RE =
  /^(access_token|refresh_token|id_token|token|client_secret|secret|api_key|apikey|authkey|password)$/i;

export function findTokenField(value: unknown, depth = 0): string | null {
  if (depth > 32 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findTokenField(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (TOKEN_FIELD_RE.test(k)) return k;
    const hit = findTokenField(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** 이번 실행에서 사용한 비밀값이 응답 본문에 그대로 반사됐는지(길이 8 이상만 검사). */
export function reflectsCredential(bytes: Uint8Array, usedSecrets: readonly string[]): boolean {
  if (usedSecrets.length === 0) return false;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return usedSecrets.some((s) => s.length >= 8 && text.includes(s));
}
