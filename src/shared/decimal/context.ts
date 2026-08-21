import { Prisma } from '@/generated/prisma/client';

import { DECIMAL_CONTEXT_CONFIG } from './config';

/**
 * Decimal 계산 컨텍스트 — **server runtime**.
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
 *
 * ## ★ server 전용이다 (T07-8)
 *
 * 이 파일은 `@/generated/prisma/client` 를 **값으로** import 하므로
 * `node:module` 을 끌고 온다. 즉 **브라우저 번들에 들어갈 수 없다.**
 * 클라이언트 계산은 `./browser-context` 를 쓴다 — 설정은 `./config` 로 공유하고
 * 산술 로직은 `./helpers` 로 공유하므로 두 런타임의 결과가 같다.
 *
 * ⛔ `'use client'` 그래프에서 이 파일(또는 `./decimal`·`./index` barrel)을
 *    import 하지 않는다.
 */

// 설정값은 `./config` 가 단일 출처다 — server·browser 가 같은 객체를 쓴다.
export {
  DECIMAL_MAX_FRACTION_DIGITS,
  DECIMAL_MAX_INTEGER_DIGITS,
  DECIMAL_MAX_SIGNIFICANT_DIGITS,
  DECIMAL_MAX_STRING_LENGTH,
  DECIMAL_MODULO,
  DECIMAL_PRECISION,
  DECIMAL_ROUNDING,
  DECIMAL_TO_EXP_NEG,
  DECIMAL_TO_EXP_POS,
} from './config';

/**
 * 프로젝트 전용 Decimal 생성자 (server).
 *
 * ⚠️ 이 모듈 밖으로 내보내지 않는다. `src/shared/decimal/index.ts` 의 barrel 은
 *    생성자를 노출하지 않고 함수만 노출한다. 계산은 전부 `shared/decimal` 의
 *    함수를 거치게 해서 컨텍스트가 우회되지 않도록 한다.
 */
export const ScmDecimal: typeof Prisma.Decimal = Object.freeze(
  Prisma.Decimal.clone({ ...DECIMAL_CONTEXT_CONFIG }),
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
