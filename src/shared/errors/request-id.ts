import { randomUUID } from 'node:crypto';

/**
 * Request ID 와 Correlation ID.
 *
 * 둘은 출처가 다르므로 분리한다.
 *
 * ┌────────────────┬──────────────────┬──────────────────────────────────┐
 * │                │ 출처             │ 쓰이는 곳                        │
 * ├────────────────┼──────────────────┼──────────────────────────────────┤
 * │ requestId      │ 서버가 항상 생성 │ 응답 본문, `x-request-id` 헤더,  │
 * │                │ (randomUUID)     │ 서버 로그                        │
 * │ correlationId  │ 외부 헤더        │ **서버 로그만**                  │
 * └────────────────┴──────────────────┴──────────────────────────────────┘
 *
 * 외부에서 받은 값을 시스템 식별자로 쓰지 않는 이유:
 *
 *   1. **유일성을 보장할 수 없다.** 클라이언트가 같은 값을 반복 전송하면
 *      서로 다른 요청이 같은 ID를 갖게 되어 로그 추적이 무너진다.
 *   2. **공격자가 통제할 수 있다.** 다른 사용자의 ID를 사칭하거나
 *      로그 검색을 오염시킬 수 있다.
 *
 * 그래도 외부 값을 버리지는 않는다. 게이트웨이·프론트엔드의 추적 ID 와
 * 서버 로그를 잇는 데 필요하므로 `correlationId` 로 **로그에만** 남긴다.
 */

export const REQUEST_ID_HEADER = 'x-request-id';
const VERCEL_ID_HEADER = 'x-vercel-id';

/** 외부 헤더 값의 최대 길이. 로그 오염을 막는다. */
const MAX_LENGTH = 200;

export interface RequestContext {
  /** 서버가 생성한 요청 식별자. 응답과 로그에 모두 나간다. */
  readonly requestId: string;
  /** 외부에서 전달된 추적 식별자. **로그에만** 기록한다. 없으면 생략된다. */
  readonly correlationId?: string;
}

export type HeaderSource = Headers | Record<string, string | undefined>;

/** 제어문자·개행을 제거한다. 로그 위조(log injection) 방지. */
function sanitize(value: string): string | undefined {
  const cleaned = value
    .trim()
    // 제어문자(개행·탭·NUL 등)를 제거해 로그 위조를 막는다.
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, MAX_LENGTH);
  return cleaned === '' ? undefined : cleaned;
}

/** 서버 요청 식별자를 만든다. 외부 입력을 절대 받지 않는다. */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * 외부 추적 식별자를 읽는다.
 *
 * 우선순위: `x-request-id` → `x-vercel-id`. 없거나 정규화 후 비면 `undefined`.
 */
export function resolveCorrelationId(headers?: HeaderSource): string | undefined {
  if (!headers) return undefined;

  const read = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    return headers[name] ?? headers[name.toLowerCase()];
  };

  const incoming = read(REQUEST_ID_HEADER) ?? read(VERCEL_ID_HEADER);
  return incoming === undefined ? undefined : sanitize(incoming);
}

/**
 * 요청 1건의 식별자 묶음을 만든다.
 *
 * `requestId` 는 헤더와 무관하게 매번 새로 생성된다.
 */
export function resolveRequestContext(headers?: HeaderSource): RequestContext {
  const correlationId = resolveCorrelationId(headers);
  return {
    requestId: generateRequestId(),
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
}
