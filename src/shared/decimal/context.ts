import { Prisma } from '@/generated/prisma/client';

/**
 * Decimal 계산 컨텍스트.
 *
 * decimal.js 의 **전역 기본 설정에 의존하지 않는다.** 기본값은 유효자릿수 20,
 * `toExpNeg = -7`, `toExpPos = 21` 이며, 어떤 코드든 `Prisma.Decimal.set(...)` 을
 * 부르면 프로세스 전체의 계산 결과가 바뀐다. 재고 원장처럼 되돌릴 수 없는
 * 데이터를 다루면서 그런 전역 상태에 기대면 안 된다.
 *
 * 그래서 **전용 생성자를 clone 해서 쓰고, 그 생성자를 freeze 한다.**
 *
 *   - clone 이므로 `Prisma.Decimal` 의 설정이 바뀌어도 이쪽은 영향받지 않는다.
 *   - freeze 이므로 이쪽 설정도 `set()` 이나 직접 대입으로 바꿀 수 없다.
 *   - decimal.js 의 clone 은 프로토타입을 공유하고 `constructor` 만 인스턴스마다
 *     따로 갖는다. 따라서 `instanceof Prisma.Decimal` 과
 *     `Prisma.Decimal.isDecimal()` 이 그대로 성립하고, Prisma 로 값을 넘기거나
 *     Prisma 가 돌려준 Decimal 을 받는 데 문제가 없다.
 *
 * ⚠️ 연산은 **수신자(receiver)의 생성자 설정**을 따른다. Prisma 가 돌려준
 *    Decimal 을 그대로 받아 `.plus()` 를 부르면 유효자릿수 20 으로 계산된다.
 *    그래서 `toDecimal()` 이 외부 Decimal 을 항상 이 생성자로 다시 감싼다.
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
 * 지수표기 없는 **업무 출력은 `toDecimalString()` 이 보장한다.** 그 함수는
 * 문자열을 만들기 전에 표현 가능 범위를 검사하고, 범위를 넘으면 거대한 문자열을
 * 만드는 대신 `RangeError` 를 던진다.
 *
 * 따라서 `toString()` 은 범위 밖에서 지수표기를 쓸 수 있다. 출력 경계에서는
 * 항상 `toDecimalString()` 을 쓴다.
 */
export const DECIMAL_TO_EXP_NEG = -7;
export const DECIMAL_TO_EXP_POS = 21;

/**
 * `toDecimalString()` 이 허용하는 표현 범위.
 *
 * DB 수량 `DECIMAL(18,6)`·금액 `DECIMAL(18,4)` 과 유효자릿수 60 의 중간 계산
 * 결과를 모두 수용하면서, 비정상적인 거대 지수 입력은 조기에 거부한다.
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

/** 나머지 연산의 반올림 — `ROUND_DOWN`(절단). */
export const DECIMAL_MODULO = 1;

/**
 * 프로젝트 전용 Decimal 생성자.
 *
 * ⚠️ 이 모듈 밖으로 내보내지 않는다. `src/shared/decimal/index.ts` 의 barrel 은
 *    생성자를 노출하지 않고 함수만 노출한다. 계산은 전부 `shared/decimal` 의
 *    함수를 거치게 해서 컨텍스트가 우회되지 않도록 한다.
 */
export const ScmDecimal: typeof Prisma.Decimal = Object.freeze(
  Prisma.Decimal.clone({
    precision: DECIMAL_PRECISION,
    rounding: DECIMAL_ROUNDING,
    toExpNeg: DECIMAL_TO_EXP_NEG,
    toExpPos: DECIMAL_TO_EXP_POS,
    modulo: DECIMAL_MODULO,
  }),
);

/**
 * 현재 컨텍스트 설정. 테스트와 진단용 읽기 전용 스냅샷.
 */
export function readDecimalContext(): Readonly<{
  precision: number;
  rounding: number;
  toExpNeg: number;
  toExpPos: number;
  modulo: number;
  frozen: boolean;
}> {
  const ctor = ScmDecimal as unknown as {
    precision: number;
    rounding: number;
    toExpNeg: number;
    toExpPos: number;
    modulo: number;
  };
  return Object.freeze({
    precision: ctor.precision,
    rounding: ctor.rounding,
    toExpNeg: ctor.toExpNeg,
    toExpPos: ctor.toExpPos,
    modulo: ctor.modulo,
    frozen: Object.isFrozen(ScmDecimal),
  });
}
