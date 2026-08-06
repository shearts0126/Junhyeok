import { Prisma } from '@/generated/prisma/client';

/**
 * Decimal 안전 유틸.
 *
 * 수량과 금액은 **끝까지 Decimal 로 다룬다.** 중간 계산에서 한 번이라도
 * JavaScript `number` 로 내려가면 그 시점에 정밀도가 깨지고, 되돌릴 수 없다.
 *
 * ```
 * 0.1 + 0.2 === 0.30000000000000004     // number
 * 9007199254740993 → 9007199254740992   // 2^53 초과 정수는 표현 불가
 * ```
 *
 * 재고 원장은 **불변**이고 현재고는 원장의 합으로 계산된다. 한 건의 반올림
 * 오차가 모든 후속 잔고에 누적되며, 원장을 고칠 수 없으므로 정정거래로만
 * 바로잡을 수 있다. 그래서 `toNumber()` 계열 변환을 ESLint 로 차단한다
 * (`eslint-rules/no-decimal-to-number.js`).
 *
 * ## 경계별 처리 원칙
 *
 * ┌──────────────────┬────────────────────────────────────────────┐
 * │ 경계             │ 표현                                       │
 * ├──────────────────┼────────────────────────────────────────────┤
 * │ DB (Prisma)      │ Decimal 그대로 전달. 문자열로 바꾸지 않는다│
 * │ 도메인·계산      │ Decimal 유지. number 로 내리지 않는다      │
 * │ API 응답(JSON)   │ 문자열 (`toDecimalString`)                 │
 * │ 로그             │ 문자열                                     │
 * │ 파일(CSV/Excel)  │ 문자열                                     │
 * │ 화면 표시        │ 문자열 (표시 서식은 프레젠테이션 계층)     │
 * └──────────────────┴────────────────────────────────────────────┘
 *
 * JSON 숫자 리터럴로 내보내지 않는 이유: 클라이언트의 `JSON.parse` 가
 * IEEE754 double 로 읽어 서버가 지킨 정밀도를 바로 잃는다.
 */

/** Prisma 가 쓰는 Decimal 구현(decimal.js). */
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

/**
 * Decimal 로 받아들이는 입력.
 *
 * ⚠️ `number` 는 **의도적으로 제외**한다. `toDecimal(0.1 + 0.2)` 가
 *    타입 수준에서 막혀야 정밀도 손실이 유틸 안으로 새어 들어오지 않는다.
 */
export type DecimalInput = Decimal | string;

/** 반올림 방식. decimal.js 상수와 같은 값이다. */
export const ROUNDING = {
  /** 0 에서 먼 쪽으로 올림 */
  UP: 0,
  /** 0 쪽으로 버림 */
  DOWN: 1,
  /** +∞ 쪽으로 */
  CEIL: 2,
  /** -∞ 쪽으로 */
  FLOOR: 3,
  /** 0.5 는 0 에서 먼 쪽으로 (일반적인 사사오입) */
  HALF_UP: 4,
  /** 0.5 는 가까운 짝수로 (은행가 반올림) */
  HALF_EVEN: 6,
} as const;

export type RoundingMode = (typeof ROUNDING)[keyof typeof ROUNDING];

/** 0. 비교·초기값에 쓴다. */
export const ZERO: Decimal = new Decimal(0);

// ── 생성·판별 ───────────────────────────────────────────────────

/**
 * 값이 Decimal 인스턴스인가.
 *
 * 외부(파싱 결과, Prisma 반환값)에서 온 값을 좁힐 때 쓴다.
 */
export function isDecimal(value: unknown): value is Decimal {
  return Decimal.isDecimal(value);
}

/**
 * 문자열에서 Decimal 을 만든다.
 *
 * 이미 Decimal 이면 그대로 돌려준다(Decimal 은 불변이므로 복사가 불필요하다).
 *
 * @throws {RangeError} 숫자로 해석할 수 없거나, 유한수가 아닌 경우
 *   (`'abc'`, `''`, `'1,000'`, `' 1 '`, `'Infinity'`, `'NaN'`)
 */
export function toDecimal(value: DecimalInput): Decimal {
  if (isDecimal(value)) {
    assertFinite(value, String(value));
    return value;
  }

  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new RangeError(
      `Decimal 로 변환할 수 없는 값입니다: ${JSON.stringify(value)}. ` +
        `천단위 구분자·공백·통화기호를 제거한 숫자 문자열이어야 합니다.`,
    );
  }

  // decimal.js 는 'Infinity' 와 'NaN' 을 유효한 입력으로 받아들인다.
  // 수량·금액에서는 둘 다 데이터 오류이므로 여기서 막는다.
  assertFinite(parsed, value);
  return parsed;
}

function assertFinite(value: Decimal, original: string): void {
  if (!value.isFinite()) {
    throw new RangeError(
      `유한한 수가 아닙니다: ${JSON.stringify(original)}. 수량·금액에는 사용할 수 없습니다.`,
    );
  }
}

// ── 사칙연산 ────────────────────────────────────────────────────

export function add(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).plus(toDecimal(b));
}

export function subtract(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).minus(toDecimal(b));
}

export function multiply(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).times(toDecimal(b));
}

/**
 * 나눗셈.
 *
 * ⚠️ decimal.js 는 0 으로 나누면 **예외 없이 `Infinity`** 를 돌려준다
 *    (`0/0` 은 `NaN`). 그 값이 원장·잔고로 흘러가면 조용히 오염되므로
 *    여기서 막는다.
 *
 * ⚠️ 나눗셈은 무한소수가 될 수 있다(`1/3`). decimal.js 의 유효자릿수
 *    (기본 20)로 잘린 근사값이 나온다. BOM 소요량 환산처럼 정확한 자릿수가
 *    필요한 곳은 `roundToScale` 로 **명시적으로** 자리를 확정한다.
 *
 * @throws {RangeError} 제수가 0 인 경우
 */
export function divide(a: DecimalInput, b: DecimalInput): Decimal {
  const divisor = toDecimal(b);
  if (divisor.isZero()) {
    throw new RangeError('0 으로 나눌 수 없습니다.');
  }
  return toDecimal(a).dividedBy(divisor);
}

/** 배열 합계. 빈 배열은 0. */
export function sumDecimals(values: readonly DecimalInput[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(toDecimal(value)), ZERO);
}

// ── 비교 ────────────────────────────────────────────────────────

/** `a < b` 면 -1, 같으면 0, `a > b` 면 1. */
export function compareDecimals(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
  const result = toDecimal(a).comparedTo(toDecimal(b));
  if (result < 0) return -1;
  if (result > 0) return 1;
  return 0;
}

export function isEqual(a: DecimalInput, b: DecimalInput): boolean {
  return compareDecimals(a, b) === 0;
}

export function isGreaterThan(a: DecimalInput, b: DecimalInput): boolean {
  return compareDecimals(a, b) > 0;
}

export function isGreaterThanOrEqual(a: DecimalInput, b: DecimalInput): boolean {
  return compareDecimals(a, b) >= 0;
}

export function isLessThan(a: DecimalInput, b: DecimalInput): boolean {
  return compareDecimals(a, b) < 0;
}

export function isLessThanOrEqual(a: DecimalInput, b: DecimalInput): boolean {
  return compareDecimals(a, b) <= 0;
}

/** 0 인가. `'0'`, `'0.000'`, `'-0'` 모두 true. */
export function isZero(value: DecimalInput): boolean {
  return toDecimal(value).isZero();
}

/** 음수인가. 음수재고 차단 검증에 쓴다. */
export function isNegative(value: DecimalInput): boolean {
  return toDecimal(value).isNegative() && !toDecimal(value).isZero();
}

// ── 반올림·직렬화 ───────────────────────────────────────────────

/**
 * 지정한 소수 자릿수로 반올림한다.
 *
 * ⚠️ 필드별 반올림 정책(수량 6자리, 금액 원 단위 등)은 **업무 규칙**이며
 *    이 함수가 정하지 않는다. 호출부가 자릿수와 방식을 명시한다.
 *
 * @param scale 소수 자릿수. 0 이상의 정수.
 * @param rounding 기본값 `HALF_UP`(사사오입).
 * @throws {RangeError} scale 이 음수이거나 정수가 아닌 경우
 */
export function roundToScale(
  value: DecimalInput,
  scale: number,
  rounding: RoundingMode = ROUNDING.HALF_UP,
): Decimal {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`scale 은 0 이상의 정수여야 합니다: ${String(scale)}`);
  }
  return toDecimal(value).toDecimalPlaces(scale, rounding);
}

/**
 * 문자열로 직렬화한다. **API·로그·파일 출력 경계에서 쓴다.**
 *
 * ⚠️ `Decimal.toString()` 을 쓰지 않는 이유: 지수가 크거나 작으면
 *    **지수표기**로 나온다.
 *
 * ```
 * new Decimal('1e25').toString()  // '1e+25'   ← 엑셀·외부 시스템이 오해한다
 * new Decimal('1e25').toFixed()   // '10000000000000000000000000'
 * new Decimal('1e-7').toString()  // '1e-7'
 * new Decimal('1e-7').toFixed()   // '0.0000001'
 * ```
 *
 * AS-IS 엑셀에서 바코드가 지수표기로 깨진 것과 같은 종류의 사고다.
 * `toFixed()` 는 항상 일반 표기를 낸다.
 *
 * @param scale 지정하면 그 자릿수로 반올림해 고정 소수점으로 낸다.
 *              미지정 시 값이 가진 자릿수를 그대로 유지한다.
 */
export function toDecimalString(value: DecimalInput, scale?: number): string {
  const decimal = toDecimal(value);
  if (scale === undefined) return decimal.toFixed();

  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`scale 은 0 이상의 정수여야 합니다: ${String(scale)}`);
  }
  return decimal.toFixed(scale);
}
