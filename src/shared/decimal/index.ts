/**
 * Decimal 안전 유틸 (T0-4).
 *
 * 수량·금액은 Decimal 로만 다룬다. `number` 변환 함수는 제공하지 않으며
 * ESLint 규칙 `deeppoint/no-decimal-to-number` 가 변환 시도를 차단한다.
 */

export {
  Decimal,
  ROUNDING,
  ZERO,
  add,
  compareDecimals,
  divide,
  isDecimal,
  isEqual,
  isGreaterThan,
  isGreaterThanOrEqual,
  isLessThan,
  isLessThanOrEqual,
  isNegative,
  isZero,
  multiply,
  roundToScale,
  subtract,
  sumDecimals,
  toDecimal,
  toDecimalString,
  type DecimalInput,
  type RoundingMode,
} from './decimal';
