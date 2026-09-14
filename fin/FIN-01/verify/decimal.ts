/**
 * FIN-01 검증용 정밀 십진수 유틸.
 *
 * 계획서 §3: 금액은 NUMERIC, JS 부동소수점 계산 금지.
 * 검증 코드에서도 금액을 문자열로 받고 BigInt(소수 6자리 고정 스케일)로만 연산한다.
 */

export const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** 문자열 금액을 스케일 적용 BigInt 로 변환한다. 소수 7자리 이상은 오류. */
export function toUnits(value: string): bigint {
  const trimmed = value.replace(/,/g, '').trim();
  const m = DECIMAL_RE.exec(trimmed);
  if (!m) throw new Error(`금액 형식 오류: "${value}"`);
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] ?? '0';
  const fracRaw = m[3] ?? '';
  if (fracRaw.length > SCALE) throw new Error(`소수 자릿수 초과(${SCALE}): "${value}"`);
  const frac = fracRaw.padEnd(SCALE, '0');
  return sign * (BigInt(intPart) * SCALE_FACTOR + BigInt(frac));
}

/** 스케일 적용 BigInt 를 정규 문자열로 되돌린다. 불필요한 0 은 제거한다. */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const intPart = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const body = frac.length > 0 ? `${intPart}.${frac}` : intPart.toString();
  return negative ? `-${body}` : body;
}

export function add(a: string, b: string): string {
  return fromUnits(toUnits(a) + toUnits(b));
}

export function sub(a: string, b: string): string {
  return fromUnits(toUnits(a) - toUnits(b));
}

export function neg(a: string): string {
  return fromUnits(-toUnits(a));
}

export function eq(a: string, b: string): boolean {
  return toUnits(a) === toUnits(b);
}

export function isZero(a: string): boolean {
  return toUnits(a) === 0n;
}

export function sum(values: readonly string[]): string {
  let acc = 0n;
  for (const v of values) acc += toUnits(v);
  return fromUnits(acc);
}

/** 정수 마이크로 단위(예: Google Ads cost_micros) → 통화 단위 문자열. */
export function fromMicros(micros: string): string {
  const m = /^(-)?(\d+)$/.exec(micros.trim());
  if (!m) throw new Error(`마이크로 단위 정수 형식 오류: "${micros}"`);
  const sign = m[1] === '-' ? -1n : 1n;
  // 1 micro = 10^-6 → 스케일 6 과 동일하므로 그대로 units 로 사용한다.
  return fromUnits(sign * BigInt(m[2] ?? '0'));
}

/** 정규화된 문자열인지 확인한다(파서 통과 여부). */
export function isDecimalString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    toUnits(value);
    return true;
  } catch {
    return false;
  }
}
