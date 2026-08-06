/**
 * Decimal 안전 유틸 (T0-4).
 *
 * 수량·금액은 Decimal 로만 다룬다. `number` 변환 함수는 제공하지 않으며
 * ESLint 규칙 `deeppoint/no-decimal-to-number` 가 변환 시도를 차단한다.
 *
 * ⚠️ **Decimal 생성자를 내보내지 않는다.** 계산 컨텍스트(유효자릿수·지수표기
 *    임계값)를 우회해 값을 만들 수 없게 하기 위함이다. 값 생성은 `toDecimal()`,
 *    계산은 이 모듈의 함수를 쓴다. 컨텍스트 설정은 `./context` 참조.
 */

export {
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
  type Decimal,
  type DecimalInput,
  type RoundingMode,
} from './decimal';

export {
  DECIMAL_MAX_FRACTION_DIGITS,
  DECIMAL_MAX_INTEGER_DIGITS,
  DECIMAL_MAX_SIGNIFICANT_DIGITS,
  DECIMAL_MAX_STRING_LENGTH,
  DECIMAL_PRECISION,
  DECIMAL_ROUNDING,
  DECIMAL_TO_EXP_NEG,
  DECIMAL_TO_EXP_POS,
  readDecimalContext,
} from './context';
