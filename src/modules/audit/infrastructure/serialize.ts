import { isDecimal, toDecimalString } from '@/shared/decimal';
import { isSensitiveKey, maskSecretsInString, REDACTED } from '@/shared/errors';

/**
 * 감사로그 값 직렬화 (T0-7).
 *
 * `before_value` / `after_value` 는 JSONB 로 저장된다. 그대로 넣으면
 *
 *   - `Decimal` 이 `{ s, e, d }` 내부 표현으로 저장되어 읽을 수 없고,
 *   - `Date` 가 로컬 타임존 문자열로 굳고,
 *   - `BigInt` 는 `JSON.stringify` 가 예외를 던지고,
 *   - 순환 참조가 있으면 저장 시점에 터지며,
 *   - 비밀번호·토큰이 감사로그에 영구 보존된다.
 *
 * 감사로그는 **불변**이라 잘못 들어간 값을 지울 수 없다. 그래서 저장 전에 정규화한다.
 */

/** 순환 참조·과도한 중첩을 막는 상한. */
const MAX_DEPTH = 12;

export class CircularReferenceError extends Error {
  constructor(path: string) {
    super(`감사로그 값에 순환 참조가 있습니다: ${path}. 저장할 수 없습니다.`);
    this.name = 'CircularReferenceError';
  }
}

function serializeValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  path: string,
): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined; // 호출부가 키를 제거한다

  // Decimal 은 문자열로. 정밀도를 보존하고 사람이 읽을 수 있다.
  if (isDecimal(value)) return toDecimalString(value);

  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return maskSecretsInString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();

  if (depth >= MAX_DEPTH) {
    throw new CircularReferenceError(path);
  }

  const asObject = value as object;
  if (seen.has(asObject)) {
    throw new CircularReferenceError(path);
  }
  seen.add(asObject);

  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => serializeValue(item, seen, depth + 1, `${path}[${index}]`));
    }

    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      // 민감값은 저장 전에 가린다. 감사로그는 지울 수 없다.
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
        continue;
      }
      const serialized = serializeValue(nested, seen, depth + 1, `${path}.${key}`);
      // undefined 는 JSONB 에 넣을 수 없다. 키 자체를 뺀다.
      if (serialized !== undefined) result[key] = serialized;
    }
    return result;
  } finally {
    seen.delete(asObject);
  }
}

/**
 * 감사로그에 저장할 형태로 정규화한다.
 *
 * @throws {CircularReferenceError} 순환 참조가 있거나 중첩이 과도한 경우
 */
export function serializeAuditValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const serialized = serializeValue(value, new WeakSet(), 0, '$');
  return serialized === undefined ? null : serialized;
}
