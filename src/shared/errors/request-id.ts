import { randomUUID } from 'node:crypto';

/**
 * Request ID 생성·전파.
 *
 * 외부 응답에는 request ID 만 나가고 상세 원인은 서버 로그에 남는다.
 * 사용자가 문의할 때 이 ID로 로그를 찾는다.
 *
 * 전파 우선순위
 *   1. `x-request-id`  — 클라이언트·게이트웨이가 지정한 값
 *   2. `x-vercel-id`   — Vercel 이 부여하는 요청 식별자
 *   3. 신규 생성
 */

export const REQUEST_ID_HEADER = 'x-request-id';
const VERCEL_ID_HEADER = 'x-vercel-id';

/** 헤더로 받은 값의 최대 길이. 로그 오염·주입을 막는다. */
const MAX_LENGTH = 200;

/** 제어문자·개행을 제거한다. 로그 위조(log injection) 방지. */
function sanitize(value: string): string | undefined {
  const cleaned = value
    .trim()
    // 제어문자(개행·탭·NUL 등)를 제거해 로그 위조를 막는다.

    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, MAX_LENGTH);
  return cleaned === '' ? undefined : cleaned;
}

export function generateRequestId(): string {
  return randomUUID();
}

/**
 * 요청 헤더에서 request ID 를 얻는다. 없으면 새로 만든다.
 *
 * @param headers `Headers` 또는 헤더 맵
 */
export function resolveRequestId(headers?: Headers | Record<string, string | undefined>): string {
  if (!headers) return generateRequestId();

  const read = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    return headers[name] ?? headers[name.toLowerCase()];
  };

  const incoming = read(REQUEST_ID_HEADER) ?? read(VERCEL_ID_HEADER);
  if (incoming === undefined) return generateRequestId();

  return sanitize(incoming) ?? generateRequestId();
}
