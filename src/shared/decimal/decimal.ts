import { ScmDecimal } from './context';
import { createDecimalHelpers } from './helpers';

/**
 * Decimal 안전 유틸 — **server runtime 바인딩**.
 *
 * 로직은 `./helpers` 한 벌뿐이고, 여기서는 server 전용 생성자(`./context`)를
 * 주입해 묶기만 한다. 브라우저 바인딩은 `./browser` 다.
 *
 * ⚠️ 공개 API·동작은 **T07-8 이전과 완전히 동일하다.** 이 파일이 하는 일은
 *    생성자 주입뿐이며, 함수 본문은 한 줄도 다시 쓰지 않았다.
 *
 * ⛔ `'use client'` 그래프에서 import 하지 않는다 — `./context` 를 통해
 *    `@/generated/prisma/client`(→ `node:module`)가 딸려 온다.
 */
const helpers = createDecimalHelpers(ScmDecimal);

export const {
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
} = helpers;

export { ROUNDING, type Decimal, type DecimalInput, type RoundingMode } from './helpers';
