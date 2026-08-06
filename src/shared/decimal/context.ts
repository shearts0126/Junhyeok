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
 * 지수표기 임계값.
 *
 * decimal.js 기본값(`-7` / `21`)에서는 `toString()` 이 `1e+25`, `1e-7` 같은
 * 지수표기를 낸다. AS-IS 엑셀에서 바코드가 깨진 것과 같은 사고의 원인이다.
 * 임계값을 극단으로 밀어 **지수표기가 나오지 않게** 고정한다.
 * (decimal.js 허용 범위: `toExpNeg` -9e15~0, `toExpPos` 0~9e15)
 */
export const DECIMAL_TO_EXP_NEG = -9e15;
export const DECIMAL_TO_EXP_POS = 9e15;

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
