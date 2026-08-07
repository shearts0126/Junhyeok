/**
 * 자격증명·비밀정보 마스킹.
 *
 * 서버 로그는 신뢰 경계 안에 있지만, 로그는 수집기·백업·화면 캡처를 통해
 * 경계 밖으로 흘러나가는 일이 잦다. 따라서 로그에 남기는 값도 비밀정보는 가린다.
 *
 * 두 축으로 마스킹한다.
 *   1. **키 기반**  — 객체를 재귀 순회하며 민감한 이름의 값을 통째로 치환
 *   2. **패턴 기반** — 문자열 안에 섞여 들어온 자격증명을 형태로 탐지해 치환
 *
 * 마스킹은 되돌릴 수 없다. 값이 필요하면 로그가 아닌 다른 경로로 확인한다.
 */

/** 마스킹 후 남는 값. */
export const REDACTED = '***';

/**
 * 이 조각이 키 이름에 포함되면 값을 통째로 가린다.
 *
 * 비교 전 키를 소문자화하고 영숫자만 남긴다. 따라서
 * `set-cookie`→`setcookie`, `DATABASE_URL`→`databaseurl`,
 * `accessToken`/`refreshToken`→`...token` 이 모두 걸린다.
 *
 * 부분일치를 쓰는 이유: 새 필드명(`clientSecret`, `idToken`)이 생겨도
 * 목록을 고치지 않고 걸린다. 과잉 마스킹은 누락보다 안전하다.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'databaseurl',
  'directurl',
  'connectionstring',
] as const;

/** 순환 참조·깊은 중첩으로 로그 생성이 폭주하지 않도록 제한한다. */
const MAX_DEPTH = 6;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

// ── 문자열 패턴 ─────────────────────────────────────────────────

/** `postgresql://user:pw@host:5432/db` 형태의 사용자명·비밀번호 */
const URL_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/g;

/** `Authorization: Bearer <token>` */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/** `Authorization: Basic <base64>` */
const BASIC_AUTH = /\bBasic\s+[A-Za-z0-9+/]+=*/gi;

/**
 * 연결 문자열의 자격증명을 가린다.
 *
 * `postgresql://user:pw@host:5432/db` → `postgresql://***:***@host:5432/db`
 *
 * 호스트·포트·데이터베이스명은 남긴다. 서버 로그에서 디버깅에 필요하고,
 * 이 값이 외부 응답으로 나가지 않는 것은 `buildErrorResponse` 가 보장한다.
 */
export function maskCredentials(value: string): string {
  return value.replace(URL_CREDENTIALS, `$1${REDACTED}:${REDACTED}@`);
}

/** 문자열에 섞인 알려진 형태의 자격증명을 모두 가린다. */
export function maskSecretsInString(value: string): string {
  return maskCredentials(value)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(BASIC_AUTH, `Basic ${REDACTED}`);
}

// ── 재귀 순회 ───────────────────────────────────────────────────

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return maskSecretsInString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return '[function]';

  if (depth >= MAX_DEPTH) return '[깊이 초과]';
  if (value instanceof Date) return value.toISOString();

  const asObject = value as object;
  if (seen.has(asObject)) return '[순환 참조]';
  seen.add(asObject);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  // Error 는 열거 가능한 속성이 없어 Object.entries 로는 비어 보인다.
  // cause 체인을 따라가야 원인이 로그에 남으므로 별도로 처리한다.
  if (value instanceof Error) {
    const result: Record<string, unknown> = {
      name: value.name,
      message: maskSecretsInString(value.message),
    };
    if (value.stack !== undefined) result['stack'] = maskSecretsInString(value.stack);
    if (value.cause !== undefined) result['cause'] = redactValue(value.cause, depth + 1, seen);
    for (const [key, nested] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? REDACTED : redactValue(nested, depth + 1, seen);
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(nested, depth + 1, seen);
  }
  return result;
}

/**
 * 임의의 값에서 비밀정보를 제거한다.
 *
 * 배열·중첩 객체·`Error.cause` 내부까지 재귀로 순회한다.
 * 원본은 수정하지 않고 새 값을 만든다.
 */
export function redactSecrets(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}

/** 로그 항목의 `context`·`details` 처럼 객체가 확실한 값을 마스킹한다. */
export function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactValue(value, 0, new WeakSet()) as Record<string, unknown>;
}
