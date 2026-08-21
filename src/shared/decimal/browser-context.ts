import { Prisma } from '@/generated/prisma/browser';

import { DECIMAL_CONTEXT_CONFIG } from './config';

/**
 * Decimal 계산 컨텍스트 — **browser runtime** (T07-8).
 *
 * ## 왜 별도 파일인가
 *
 * `./context` 는 `@/generated/prisma/client` 를 값으로 import 한다. 그 엔트리는
 * `node:module` 을 끌고 오므로 `'use client'` 번들에 들어갈 수 없다.
 * Prisma 가 프론트엔드용으로 **공식 생성**하는 `@/generated/prisma/browser` 는
 * server-only 의존성 없이 같은 `Prisma.Decimal` 을 제공한다.
 *
 * ⛔ next.config 의 bundler alias 로 경계를 숨기지 않는다 — import 그래프에서
 *    server/browser 경계를 **눈에 보이게** 표현한다.
 *
 * ## 무엇이 같고 무엇이 다른가
 *
 * ┌────────────────────┬─────────────────────────────────────────┐
 * │ 산술 설정          │ `./config` 로 **동일**                  │
 * │ 산술·직렬화 로직   │ `./helpers` factory 로 **동일**         │
 * │ 최종 문자열 결과   │ **동일** (parity 테스트가 실측)         │
 * │ 생성자 identity    │ 다르다 — 별개 런타임이므로 당연하다     │
 * │ DB 전달 가능 여부  │ ⛔ browser 값은 DB 경계에 가지 않는다   │
 * └────────────────────┴─────────────────────────────────────────┘
 *
 * `instanceof` 를 런타임 간에 비교하지 않는다. cross-runtime 불변식은
 * **생성자 동일성이 아니라 산술·출력 동일성**이다.
 *
 * ⛔ 이 값을 Prisma write/read 경계로 넘기지 않는다 — 그쪽은 server 전용이다.
 */

/**
 * 브라우저 전용 Decimal 생성자.
 *
 * ⚠️ `Prisma.Decimal.set(...)` 이 아니라 **`clone()`** 을 쓴다. `set()` 은 공용
 *    생성자의 전역 설정을 바꿔 버리는데, 그것이 바로 `./context` 가 장문으로
 *    금지해 둔 "전역 상태 의존"이다. server 와 정확히 같은 방식으로 만든다.
 */
export const BrowserDecimal: typeof Prisma.Decimal = Object.freeze(
  Prisma.Decimal.clone({ ...DECIMAL_CONTEXT_CONFIG }),
);

/** 현재 브라우저 컨텍스트 설정. parity 테스트와 진단용 읽기 전용 스냅샷. */
export function readBrowserDecimalContext(): Readonly<{
  precision: number;
  rounding: number;
  toExpNeg: number;
  toExpPos: number;
  modulo: number;
  frozen: boolean;
}> {
  const ctor = BrowserDecimal as unknown as {
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
    frozen: Object.isFrozen(BrowserDecimal),
  });
}
