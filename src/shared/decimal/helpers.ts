// ⚠️ **type-only import 다** — TS 가 컴파일 시 완전히 지우므로 브라우저 번들에
//    `@/generated/prisma/client`(→ `node:module`)가 들어가지 않는다. 이 파일이
//    `'use client'` 그래프에서도 안전한 이유가 이것이다. 실측 근거는 `pnpm build`.
import type { Prisma } from '@/generated/prisma/client';

import {
  DECIMAL_MAX_FRACTION_DIGITS,
  DECIMAL_MAX_INTEGER_DIGITS,
  DECIMAL_MAX_SIGNIFICANT_DIGITS,
  DECIMAL_MAX_STRING_LENGTH,
} from './config';

/**
 * Decimal 안전 유틸 — **생성자를 주입받는 factory** (T07-8).
 *
 * ## 왜 factory 인가
 *
 * server 는 `@/generated/prisma/client`, browser 는 `@/generated/prisma/browser`
 * 의 `Prisma.Decimal` 을 쓴다. 두 런타임은 별개 프로세스이므로 생성자가 다를 수
 * 밖에 없다. 그렇다고 산술 로직을 두 벌 쓰면 **결과가 갈리는 순간을 아무도
 * 못 잡는다.**
 *
 * 그래서 로직은 이 파일 **한 벌**만 두고, 생성자만 주입한다.
 *
 *   - `./context`  → server 생성자로 bind (`./decimal.ts`)
 *   - `./browser-context` → browser 생성자로 bind (`./browser.ts`)
 *
 * 두 결과가 같다는 것은 `decimal-runtime-parity.test.ts` 가 실측한다.
 *
 * ⛔ 이 파일은 생성자를 **직접 만들지 않는다** — 주입만 받는다.
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
 *
 * ## 계산 컨텍스트
 *
 * 유효자릿수·지수표기 임계값은 `context.ts` 에서 고정한다. 생성자는 barrel 로
 * 내보내지 않으며, 계산은 전부 이 모듈의 함수를 거친다.
 */

/**
 * Decimal 값 타입.
 *
 * 인스턴스는 `Prisma.Decimal` 의 인스턴스이기도 하므로(clone 이 프로토타입을
 * 공유한다) Prisma 에 그대로 넘길 수 있다.
 *
 * ⚠️ 생성자는 노출하지 않는다. 값을 만들 때는 `toDecimal()` 을 쓴다.
 */
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

/** 주입받는 Decimal 생성자. server·browser 가 각자의 것을 넘긴다. */
export type DecimalConstructor = typeof Prisma.Decimal;

export type DecimalHelpers = ReturnType<typeof createDecimalHelpers>;

/**
 * 주어진 생성자에 bind 된 Decimal 유틸 한 벌을 만든다.
 *
 * @param ScmDecimal 이 런타임의 전용 생성자. 이미 프로젝트 설정으로
 *   `clone()` 되어 freeze 된 것이어야 한다 (`./context`·`./browser-context`).
 */
export function createDecimalHelpers(ScmDecimal: DecimalConstructor) {
  /** 0. 비교·초기값에 쓴다. */
  const ZERO: Decimal = new ScmDecimal(0);

  // ── 생성·판별 ───────────────────────────────────────────────────

  /**
   * 값이 Decimal 인스턴스인가.
   *
   * 외부(파싱 결과, Prisma 반환값)에서 온 값을 좁힐 때 쓴다.
   * 전용 생성자로 만든 값과 Prisma 가 돌려준 값을 모두 인식한다.
   */
  function isDecimal(value: unknown): value is Decimal {
    return ScmDecimal.isDecimal(value);
  }

  /** 이 프로젝트의 계산 컨텍스트로 만들어진 값인가. */
  function isOwnContext(value: Decimal): boolean {
    return (value as unknown as { constructor: unknown }).constructor === ScmDecimal;
  }

  /**
   * Decimal 을 만든다. 문자열 또는 다른 Decimal 을 받는다.
   *
   * ⚠️ Prisma 가 돌려준 Decimal 처럼 **다른 컨텍스트의 값은 다시 감싼다.**
   *    decimal.js 는 연산 시 수신자의 생성자 설정을 따르므로, 그대로 두면
   *    이후 계산이 전역 기본값(유효자릿수 20)으로 수행된다.
   *
   * @throws {RangeError} 숫자로 해석할 수 없거나, 유한수가 아닌 경우
   *   (`'abc'`, `''`, `'1,000'`, `' 1 '`, `'Infinity'`, `'NaN'`)
   */
  function toDecimal(value: DecimalInput): Decimal {
    if (isDecimal(value)) {
      assertFinite(value, String(value));
      return isOwnContext(value) ? value : new ScmDecimal(value);
    }

    let parsed: Decimal;
    try {
      parsed = new ScmDecimal(value);
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

  function add(a: DecimalInput, b: DecimalInput): Decimal {
    return toDecimal(a).plus(toDecimal(b));
  }

  function subtract(a: DecimalInput, b: DecimalInput): Decimal {
    return toDecimal(a).minus(toDecimal(b));
  }

  function multiply(a: DecimalInput, b: DecimalInput): Decimal {
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
  function divide(a: DecimalInput, b: DecimalInput): Decimal {
    const divisor = toDecimal(b);
    if (divisor.isZero()) {
      throw new RangeError('0 으로 나눌 수 없습니다.');
    }
    return toDecimal(a).dividedBy(divisor);
  }

  /** 배열 합계. 빈 배열은 0. */
  function sumDecimals(values: readonly DecimalInput[]): Decimal {
    return values.reduce<Decimal>((total, value) => total.plus(toDecimal(value)), ZERO);
  }

  // ── 비교 ────────────────────────────────────────────────────────

  /** `a < b` 면 -1, 같으면 0, `a > b` 면 1. */
  function compareDecimals(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
    const result = toDecimal(a).comparedTo(toDecimal(b));
    if (result < 0) return -1;
    if (result > 0) return 1;
    return 0;
  }

  function isEqual(a: DecimalInput, b: DecimalInput): boolean {
    return compareDecimals(a, b) === 0;
  }

  function isGreaterThan(a: DecimalInput, b: DecimalInput): boolean {
    return compareDecimals(a, b) > 0;
  }

  function isGreaterThanOrEqual(a: DecimalInput, b: DecimalInput): boolean {
    return compareDecimals(a, b) >= 0;
  }

  function isLessThan(a: DecimalInput, b: DecimalInput): boolean {
    return compareDecimals(a, b) < 0;
  }

  function isLessThanOrEqual(a: DecimalInput, b: DecimalInput): boolean {
    return compareDecimals(a, b) <= 0;
  }

  /** 0 인가. `'0'`, `'0.000'`, `'-0'` 모두 true. */
  function isZero(value: DecimalInput): boolean {
    return toDecimal(value).isZero();
  }

  /** 음수인가. 음수재고 차단 검증에 쓴다. */
  function isNegative(value: DecimalInput): boolean {
    return toDecimal(value).isNegative() && !toDecimal(value).isZero();
  }

  // ── 반올림·직렬화 ───────────────────────────────────────────────

  /**
   * 지정한 소수 자릿수로 반올림한다.
   *
   * ⚠️ **`rounding` 에 기본값이 없다.** 필드별 반올림 정책(수량 6자리 사사오입,
   *    금액 4자리 은행가 반올림 등)은 아직 확정되지 않은 **업무 규칙**이며,
   *    이 함수가 조용히 하나를 골라서는 안 된다. 호출부가 반드시 명시한다.
   *
   * ```ts
   * roundToScale(value, 6, ROUNDING.HALF_UP);
   * roundToScale(value, 4, ROUNDING.HALF_EVEN);
   * roundToScale(value, 6);                       // ❌ 컴파일 오류
   * ```
   *
   * ⚠️ 이 scale/rounding 은 **DB 저장·화면 표시용 업무 정책**이며,
   *    `context.ts` 의 `DECIMAL_PRECISION`·`DECIMAL_ROUNDING`(중간 연산의
   *    유효자릿수와 반올림)과는 다른 층위다.
   *
   * @param scale 소수 자릿수. 0 이상의 정수.
   * @param rounding 반올림 방식. 필수.
   * @throws {RangeError} scale 이 음수이거나 정수가 아닌 경우
   */
  function roundToScale(value: DecimalInput, scale: number, rounding: RoundingMode): Decimal {
    if (!Number.isInteger(scale) || scale < 0) {
      throw new RangeError(`scale 은 0 이상의 정수여야 합니다: ${String(scale)}`);
    }
    return toDecimal(value).toDecimalPlaces(scale, rounding);
  }

  /**
   * 값의 표현 규모. 문자열을 **만들기 전에** 계산한다.
   *
   * decimal.js 는 값을 (유효숫자 배열, 지수)로 들고 있으므로 `1e1000000000` 도
   * 생성 자체는 싸다. 비싼 것은 `toFixed()` 로 펼치는 순간이다.
   * 그래서 펼치기 전에 여기서 규모를 본다.
   */
  function measure(value: Decimal): {
    significantDigits: number;
    integerDigits: number;
    fractionDigits: number;
    stringLength: number;
  } {
    const fractionDigits = value.decimalPlaces();
    // exponent + 1 이 정수부 자릿수다. |x| < 1 이면 정수부는 '0' 한 자리.
    const integerDigits = value.e >= 0 ? value.e + 1 : 1;
    const sign = value.isNegative() ? 1 : 0;
    const point = fractionDigits > 0 ? 1 : 0;

    return {
      significantDigits: value.precision(),
      integerDigits,
      fractionDigits,
      stringLength: sign + integerDigits + point + fractionDigits,
    };
  }

  /**
   * 일반 표기로 안전하게 펼칠 수 있는 값인지 검사한다.
   *
   * @throws {RangeError} 한도를 넘는 경우. **거대한 문자열을 만들지 않는다.**
   */
  function assertRepresentable(value: Decimal): void {
    const scale = measure(value);

    const violations: string[] = [];
    if (scale.significantDigits > DECIMAL_MAX_SIGNIFICANT_DIGITS) {
      violations.push(`유효자릿수 ${scale.significantDigits} > ${DECIMAL_MAX_SIGNIFICANT_DIGITS}`);
    }
    if (scale.integerDigits > DECIMAL_MAX_INTEGER_DIGITS) {
      violations.push(`정수부 ${scale.integerDigits}자리 > ${DECIMAL_MAX_INTEGER_DIGITS}`);
    }
    if (scale.fractionDigits > DECIMAL_MAX_FRACTION_DIGITS) {
      violations.push(`소수부 ${scale.fractionDigits}자리 > ${DECIMAL_MAX_FRACTION_DIGITS}`);
    }
    if (scale.stringLength > DECIMAL_MAX_STRING_LENGTH) {
      violations.push(`문자열 길이 ${scale.stringLength} > ${DECIMAL_MAX_STRING_LENGTH}`);
    }

    if (violations.length > 0) {
      // ⚠️ 값 자체를 메시지에 넣지 않는다. 펼치는 순간이 바로 막으려던 그 비용이다.
      throw new RangeError(
        `일반 표기로 직렬화할 수 없는 규모입니다 (${violations.join(', ')}). ` +
          `수량·금액의 정상 범위를 벗어났습니다.`,
      );
    }
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
   * ⚠️ **펼치기 전에 규모를 검사한다.** `1e1000000000` 같은 값을 그대로 `toFixed()`
   *    하면 10억 자리 문자열을 만들려다 메모리를 소진한다. 한도를 넘으면 문자열을
   *    만들지 않고 `RangeError` 를 던진다 (`context.ts` 의 `DECIMAL_MAX_*`).
   *
   * @param scale 지정하면 그 자릿수로 반올림해 고정 소수점으로 낸다.
   *              미지정 시 값이 가진 자릿수를 그대로 유지한다.
   * @throws {RangeError} scale 이 잘못됐거나, 값이 표현 한도를 넘는 경우
   */
  function toDecimalString(value: DecimalInput, scale?: number): string {
    const decimal = toDecimal(value);

    if (scale === undefined) {
      assertRepresentable(decimal);
      return decimal.toFixed();
    }

    if (!Number.isInteger(scale) || scale < 0) {
      throw new RangeError(`scale 은 0 이상의 정수여야 합니다: ${String(scale)}`);
    }
    // scale 을 지정해도 정수부는 그대로 펼쳐지므로 검사가 필요하다.
    // 반올림 후를 기준으로 본다.
    assertRepresentable(decimal.toDecimalPlaces(scale, ROUNDING.HALF_UP));
    return decimal.toFixed(scale);
  }

  return {
    ZERO,
    isDecimal,
    toDecimal,
    add,
    subtract,
    multiply,
    divide,
    sumDecimals,
    compareDecimals,
    isEqual,
    isGreaterThan,
    isGreaterThanOrEqual,
    isLessThan,
    isLessThanOrEqual,
    isZero,
    isNegative,
    roundToScale,
    toDecimalString,
  };
}
