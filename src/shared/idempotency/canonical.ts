import { createHash } from 'node:crypto';

import { isDecimal, toDecimalString } from '@/shared/decimal';

/**
 * Canonical JSON 직렬화 + request hash (T1-3 보완).
 *
 * 멱등성 request hash 의 입력은 raw request text 가 아니라 **Zod validation 을
 * 통과한 DTO** 다. 같은 의미의 요청이 JSON property 순서 차이만으로 다른
 * hash 가 되면 안 되므로:
 *
 *   - 객체 key 는 **사전순 정렬** (재귀)
 *   - 배열 순서는 **보존**
 *   - `undefined` 프로퍼티는 생략 (JSON.stringify 와 동일)
 *   - shared Decimal 은 `toDecimalString` 문자열로 — T1-3 응답 계약과 동일
 *
 * ⛔ 입력 **의미**는 정규화하지 않는다 — `'ABC'` 와 `'abc'` 는 다른 입력이다.
 *    trim 도 하지 않는다 (untrimmed 입력은 DTO 가 이미 400 으로 거부한다).
 * ⛔ 클라이언트가 필드를 생략한 요청과 명시적으로 값을 보낸 요청을
 *    임의로 합치는 default 채움도 하지 않는다 — 검증된 DTO 표현 그대로다.
 */

function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  if (isDecimal(value)) return JSON.stringify(toDecimalString(value));

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError('유한수가 아닌 number 는 직렬화할 수 없습니다.');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      // function·symbol·bigint 등 — JSON 표현이 없다.
      throw new TypeError(`canonical JSON 으로 직렬화할 수 없는 값입니다: ${typeof value}`);
  }

  if (Array.isArray(value)) {
    // 배열 순서 보존. undefined 원소는 JSON.stringify 와 동일하게 null 로.
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalize(item))).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${parts.join(',')}}`;
}

/** 검증된 DTO 의 canonical JSON 문자열. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('undefined 는 직렬화할 수 없습니다.');
  return canonicalize(value);
}

/** canonical JSON 의 SHA-256 lowercase hex (64자). */
export function requestHashOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
