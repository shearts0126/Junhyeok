import { BrowserDecimal } from './browser-context';
import { createDecimalHelpers } from './helpers';

/**
 * Decimal 안전 유틸 — **browser runtime 바인딩** (T07-8).
 *
 * `'use client'` 컴포넌트가 Decimal 계산을 해야 할 때 **이 파일만** 쓴다.
 *
 * ```ts
 * import { multiply, toDecimalString } from '@/shared/decimal/browser';
 * ```
 *
 * ⛔ `@/shared/decimal`(server barrel)을 client 에서 import 하지 않는다 —
 *    `node:module` 이 딸려 와 Turbopack 이 클라이언트 청크를 만들지 못한다.
 * ⛔ 여기서 만든 값을 DB 경계로 넘기지 않는다 — Prisma write/read 는 server
 *    전용이며 `./context` 의 생성자만 쓴다.
 *
 * ## 노출 범위를 좁게 유지한다
 *
 * server barrel 전체를 브라우저로 복제하지 않는다. 화면 계산에 실제로 필요한
 * 것만 내보낸다 — 현재 사용처는 `master/boms` 의 `실제 필요량`(U8-12) ·
 * `비중`(U8-11) · `소요량 추천`(D-31 ②) 세 가지다.
 *
 * ⛔ `sumDecimals`·`compareDecimals` 등 DB/도메인 지향 helper 와 `PrismaClient`
 *    는 내보내지 않는다. 필요해지면 그때 근거와 함께 넓힌다.
 */
const helpers = createDecimalHelpers(BrowserDecimal);

export const {
  ZERO,
  toDecimal,
  toDecimalString,
  roundToScale,
  add,
  multiply,
  divide,
  isEqual,
  isGreaterThan,
} = helpers;

export { ROUNDING, type Decimal, type DecimalInput, type RoundingMode } from './helpers';
