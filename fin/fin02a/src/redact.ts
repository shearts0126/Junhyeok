/**
 * 비밀값 제거. 저장 데이터(실행 이력 오류 메시지, 원본 요청 요약)와 로그에 토큰·인증 헤더가 남지 않게 한다.
 * 정책: 헤더는 값 자체를 저장하지 않고 이름만 남긴다. URL 쿼리의 비밀 파라미터 값과 Bearer/키 형태 문자열은 마스킹한다.
 */

const SECRET_QUERY_KEYS =
  /^(authkey|access_token|token|api_key|apikey|key|secret|client_secret|signature|password|refresh_token)$/i;
const SECRET_HEADER_NAMES =
  /^(authorization|access-token|x-api-key|x-signature|x-secret|cookie|set-cookie|proxy-authorization)$/i;

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.test(k)) u.searchParams.set(k, '[REDACTED]');
    }
    if (u.username || u.password) {
      u.username = u.username ? '[REDACTED]' : '';
      u.password = u.password ? '[REDACTED]' : '';
    }
    return u.toString();
  } catch {
    return redactText(url);
  }
}

export function redactText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]')
    .replace(
      /([?&](?:authkey|access_token|token|api_key|apikey|key|secret|client_secret|signature|password|refresh_token)=)[^&\s"']+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:authkey|access_token|token|api_key|apikey|secret|client_secret|signature|password|refresh_token)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1[REDACTED]',
    );
}

export function isSecretHeaderName(name: string): boolean {
  return SECRET_HEADER_NAMES.test(name);
}

/** 요청 요약: 메서드, 비밀값 제거 URL, 헤더 이름 목록(값 없음). */
export interface RequestSummary {
  method: string;
  url: string;
  headerNames: string[];
}

export function summarizeRequest(
  method: string,
  url: string,
  headers: Record<string, string> | Headers | undefined,
): RequestSummary {
  const names: string[] = [];
  if (headers instanceof Headers) headers.forEach((_v, k) => names.push(k.toLowerCase()));
  else if (headers) for (const k of Object.keys(headers)) names.push(k.toLowerCase());
  return { method: method.toUpperCase(), url: redactUrl(url), headerNames: names.sort() };
}
