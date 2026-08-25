/**
 * Decimal 계산 컨텍스트 **설정값** — server·browser 양쪽이 공유한다 (T07-8).
 *
 * ⛔ 이 파일은 **순수 상수만** 둔다. Prisma·Node·server-only 모듈을 import 하지
 *    않는다. `'use client'` 그래프에 들어가도 안전해야 하기 때문이다.
 *
 * ## 왜 설정만 따로 떼는가
 *
 * 생성자는 runtime 마다 다르다 — server 는 `@/generated/prisma/client`,
 * browser 는 `@/generated/prisma/browser` 의 `Prisma.Decimal` 을 쓴다. 두
 * 런타임은 애초에 별개 프로세스라 **생성자 identity 를 공유할 수 없고, 공유할
 * 이유도 없다.**
 *
 * 대신 지켜야 하는 불변식은 이것이다.
 *
 * ┌────────────────────┬──────────────────────────────────────────┐
 * │ 불변식             │ 범위                                     │
 * ├────────────────────┼──────────────────────────────────────────┤
 * │ 산술 설정 동일     │ server · browser **양쪽**                │
 * │ 최종 문자열 동일   │ server · browser **양쪽**                │
 * │ DB 전달 가능 타입  │ **server 전용** (`instanceof Prisma`)    │
 * │ 생성자 identity    │ 요구하지 않는다                          │
 * └────────────────────┴──────────────────────────────────────────┘
 *
 * 그래서 이 파일이 두 런타임의 **단일 설정 출처**다.
 */

/**
 * 유효자릿수 60.
 *
 * ┌──────────────────────────────────────┬──────────┐
 * │ 근거                                 │ 유효자릿수│
 * ├──────────────────────────────────────┼──────────┤
 * │ 수량 `DECIMAL(18,6)`                 │ 18       │
 * │ 금액 `DECIMAL(18,4)`                 │ 18       │
 * │ 수량 × 금액 (정확한 곱)              │ 36       │
 * │ 3항 연쇄 (수량 × 단가 × 환율·계수)   │ 54       │
 * │ 나눗셈·평균의 중간 반올림 여유       │ +6       │
 * └──────────────────────────────────────┴──────────┘
 *
 * 요구 하한 40 을 넘고, 3항 연쇄까지 절단 없이 담긴다.
 * decimal.js 상한은 1e9 이며 60 자리의 성능 비용은 무시할 수준이다.
 */
export const DECIMAL_PRECISION = 60;

/**
 * 중간 연산의 반올림 방식 — `ROUND_HALF_UP`.
 *
 * ⚠️ 이것은 **유효자릿수를 넘는 중간 결과**(예: 나눗셈)에 적용되는 값이며,
 *    DB 저장이나 화면 표시에 쓰는 **업무상 scale/rounding 정책과 다르다.**
 *    업무 정책은 `roundToScale(value, scale, rounding)` 로 호출부가 명시한다.
 */
export const DECIMAL_ROUNDING = 4;

/**
 * 지수표기 임계값 — decimal.js 기본값을 **명시적으로** 고정한다.
 *
 * ⚠️ 임계값을 극단으로 밀어 "지수표기가 절대 안 나오게" 만들지 않는다.
 *    그렇게 하면 `new Decimal('1e1000000000').toString()` 이 10억 자리 문자열을
 *    만들려다 메모리를 소진한다. 거대한 지수 입력이 방어 없이 확장되는 셈이다.
 *
 * 지수표기 없는 **업무 출력은 `toDecimalString()` 이 보장한다.**
 */
export const DECIMAL_TO_EXP_NEG = -7;
export const DECIMAL_TO_EXP_POS = 21;

/** 나머지 연산의 반올림 — `ROUND_DOWN`(절단). */
export const DECIMAL_MODULO = 1;

/**
 * `toDecimalString()` 이 허용하는 표현 범위.
 *
 * ┌────────────────────┬─────┬──────────────────────────────────────┐
 * │ 한도               │ 값  │ 근거                                 │
 * ├────────────────────┼─────┼──────────────────────────────────────┤
 * │ 최대 유효자릿수    │ 60  │ DECIMAL_PRECISION 과 동일            │
 * │ 최대 정수부 자릿수 │ 60  │ 3항 연쇄 결과(≈36)의 여유 포함       │
 * │ 최대 소수부 자릿수 │ 60  │ 나눗셈 중간 결과(최대 60자리) 수용   │
 * │ 최대 문자열 길이   │ 128 │ 부호 1 + 정수 60 + '.' + 소수 60 = 122│
 * └────────────────────┴─────┴──────────────────────────────────────┘
 */
export const DECIMAL_MAX_SIGNIFICANT_DIGITS = 60;
export const DECIMAL_MAX_INTEGER_DIGITS = 60;
export const DECIMAL_MAX_FRACTION_DIGITS = 60;
export const DECIMAL_MAX_STRING_LENGTH = 128;

/**
 * `Decimal.clone()` 에 그대로 넘기는 설정 객체.
 *
 * ★ **server 와 browser 가 문자 그대로 같은 객체를 쓴다.** 한쪽만 바꾸는 실수를
 *   구조적으로 막기 위해서다. 설정 동일성은 `decimal-runtime-parity.test.ts` 가
 *   실측으로 다시 확인한다.
 *
 * ⚠️ `minE`·`maxE`·`crypto` 는 **지금도 설정하지 않는다** — decimal.js 기본값을
 *    쓰는 것이 현재 동작이며, 이번 분리는 동작 변경이 아니라 출처 이동이다.
 *
 * ## ⚠️ `clone()` 에 이 객체를 **그대로 넘기지 않는다**
 *
 * decimal.js 의 `clone(obj)` 는 빠진 속성을 부모 기본값으로 **넘겨받은 객체에
 * 직접 채워 넣는다**(`if (!obj.hasOwnProperty(p)) obj[p] = this[p]`). 즉 그대로
 * 넘기면 이 공유 상수에 `minE`·`maxE`·`crypto` 가 덧씌워지고, **먼저 clone 한
 * 런타임의 기본값이 나중 런타임에게 전달된다.**
 *
 * 그래서 호출부는 반드시 **얕은 복사본**을 넘긴다:
 * `Prisma.Decimal.clone({ ...DECIMAL_CONTEXT_CONFIG })`.
 * 아래 `Object.freeze` 는 그 규칙을 어기면 즉시 터지게 하는 안전장치다.
 */
export const DECIMAL_CONTEXT_CONFIG = Object.freeze({
  precision: DECIMAL_PRECISION,
  rounding: DECIMAL_ROUNDING,
  toExpNeg: DECIMAL_TO_EXP_NEG,
  toExpPos: DECIMAL_TO_EXP_POS,
  modulo: DECIMAL_MODULO,
} as const);
