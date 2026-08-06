import { describe, expect, it } from 'vitest';

import {
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
} from './decimal';

describe('toDecimal — 생성', () => {
  it('문자열에서 Decimal 을 만든다', () => {
    expect(toDecimalString(toDecimal('123.456'))).toBe('123.456');
    expect(toDecimalString(toDecimal('-0.001'))).toBe('-0.001');
    expect(toDecimalString(toDecimal('0'))).toBe('0');
  });

  it('Decimal 을 넣으면 그대로 돌려준다', () => {
    const original = new Decimal('7.5');
    expect(toDecimal(original)).toBe(original);
  });

  it('★ number 로는 double 정밀도 손실이 발생하지만 Decimal 은 정확하다', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toDecimalString(add('0.1', '0.2'))).toBe('0.3');
  });

  it('★ 2^53 을 넘는 정수도 정확히 보존한다', () => {
    // number 였다면 9007199254740992 로 뭉개진다
    expect(toDecimalString(toDecimal('9007199254740993'))).toBe('9007199254740993');
    expect(toDecimalString(add('9007199254740993', '1'))).toBe('9007199254740994');
  });

  it.each([
    ['abc', '숫자가 아닌 문자'],
    ['', '빈 문자열'],
    ['1,000', '천단위 구분자'],
    [' 1 ', '공백'],
    ['₩1000', '통화기호'],
  ])('★ 잘못된 문자열 %s(%s)은 RangeError', (value) => {
    expect(() => toDecimal(value)).toThrow(RangeError);
  });

  it('★ Infinity·NaN 문자열을 거부한다', () => {
    // decimal.js 자체는 이 둘을 유효한 입력으로 받아들인다.
    expect(new Decimal('Infinity').isFinite()).toBe(false);
    // 유틸은 막는다 — 수량·금액에서는 데이터 오류다.
    expect(() => toDecimal('Infinity')).toThrow(RangeError);
    expect(() => toDecimal('-Infinity')).toThrow(RangeError);
    expect(() => toDecimal('NaN')).toThrow(RangeError);
  });

  it('오류 메시지에 원인이 될 값이 담긴다', () => {
    expect(() => toDecimal('1,000')).toThrow(/1,000/);
  });
});

describe('isDecimal — 판별', () => {
  it('Decimal 인스턴스를 식별한다', () => {
    expect(isDecimal(new Decimal('1'))).toBe(true);
    expect(isDecimal(toDecimal('1'))).toBe(true);
  });

  it('Decimal 이 아닌 값을 걸러낸다', () => {
    for (const value of ['1', 1, null, undefined, {}, [], { toString: () => '1' }]) {
      expect(isDecimal(value)).toBe(false);
    }
  });

  it('타입 가드로 동작한다', () => {
    const value: unknown = new Decimal('2.5');
    if (isDecimal(value)) {
      expect(toDecimalString(value)).toBe('2.5');
    } else {
      throw new Error('타입 가드 실패');
    }
  });
});

describe('사칙연산', () => {
  it('덧셈', () => {
    expect(toDecimalString(add('1.1', '2.2'))).toBe('3.3');
    expect(toDecimalString(add(new Decimal('10'), '0.5'))).toBe('10.5');
  });

  it('뺄셈', () => {
    expect(toDecimalString(subtract('10', '3.5'))).toBe('6.5');
    expect(toDecimalString(subtract('0.3', '0.1'))).toBe('0.2');
  });

  it('곱셈', () => {
    expect(toDecimalString(multiply('1.5', '4'))).toBe('6');
    expect(toDecimalString(multiply('0.1', '0.1'))).toBe('0.01');
  });

  it('나눗셈', () => {
    expect(toDecimalString(divide('10', '4'))).toBe('2.5');
    expect(toDecimalString(divide('1', '8'))).toBe('0.125');
  });

  it('★ 0 으로 나누면 RangeError (Infinity 를 돌려주지 않는다)', () => {
    // decimal.js 는 예외 없이 Infinity 를 반환한다
    expect(new Decimal(1).dividedBy(0).isFinite()).toBe(false);
    // 유틸은 막는다
    expect(() => divide('1', '0')).toThrow(RangeError);
    expect(() => divide('0', '0')).toThrow(RangeError);
    expect(() => divide('1', '0.000')).toThrow(RangeError);
  });

  it('무한소수는 유효자릿수로 잘린 근사값이다', () => {
    // 정확한 자릿수가 필요하면 roundToScale 로 명시해야 한다는 근거
    const third = divide('1', '3');
    expect(toDecimalString(third).startsWith('0.3333333333')).toBe(true);
    expect(toDecimalString(multiply(third, '3'))).not.toBe('1');
  });

  it('연산 결과는 Decimal 이다', () => {
    expect(isDecimal(add('1', '2'))).toBe(true);
    expect(isDecimal(subtract('1', '2'))).toBe(true);
    expect(isDecimal(multiply('1', '2'))).toBe(true);
    expect(isDecimal(divide('1', '2'))).toBe(true);
  });

  it('피연산자를 변형하지 않는다 (Decimal 은 불변)', () => {
    const a = new Decimal('5');
    add(a, '3');
    expect(toDecimalString(a)).toBe('5');
  });
});

describe('sumDecimals — 배열 합계', () => {
  it('합계를 구한다', () => {
    expect(toDecimalString(sumDecimals(['1.1', '2.2', '3.3']))).toBe('6.6');
  });

  it('빈 배열은 0', () => {
    expect(toDecimalString(sumDecimals([]))).toBe('0');
    expect(isZero(sumDecimals([]))).toBe(true);
  });

  it('원소 하나', () => {
    expect(toDecimalString(sumDecimals(['42']))).toBe('42');
  });

  it('★ 양수·음수가 섞여도 정확히 합산한다', () => {
    // 재고 원장의 증감 합산과 같은 형태
    expect(toDecimalString(sumDecimals(['10', '-6', '-6']))).toBe('-2');
  });

  it('Decimal 과 문자열을 섞어도 된다', () => {
    expect(toDecimalString(sumDecimals([new Decimal('1.5'), '2.5']))).toBe('4');
  });

  it('★ 0.1 을 10번 더해도 정확히 1', () => {
    expect(toDecimalString(sumDecimals(Array<string>(10).fill('0.1')))).toBe('1');
  });
});

describe('비교', () => {
  it('compareDecimals 는 -1 / 0 / 1 을 돌려준다', () => {
    expect(compareDecimals('1', '2')).toBe(-1);
    expect(compareDecimals('2', '2')).toBe(0);
    expect(compareDecimals('3', '2')).toBe(1);
  });

  it('자릿수가 달라도 값으로 비교한다', () => {
    expect(compareDecimals('1.0', '1.000')).toBe(0);
    expect(isEqual('1.0', '1.000')).toBe(true);
  });

  it('대소 비교', () => {
    expect(isGreaterThan('2', '1')).toBe(true);
    expect(isGreaterThan('1', '1')).toBe(false);
    expect(isGreaterThanOrEqual('1', '1')).toBe(true);
    expect(isLessThan('1', '2')).toBe(true);
    expect(isLessThanOrEqual('1', '1')).toBe(true);
    expect(isLessThanOrEqual('2', '1')).toBe(false);
  });

  it('isZero', () => {
    expect(isZero('0')).toBe(true);
    expect(isZero('0.000')).toBe(true);
    expect(isZero('-0')).toBe(true);
    expect(isZero(ZERO)).toBe(true);
    expect(isZero('0.001')).toBe(false);
  });

  it('isNegative — 0 은 음수가 아니다', () => {
    expect(isNegative('-1')).toBe(true);
    expect(isNegative('-0.000001')).toBe(true);
    expect(isNegative('0')).toBe(false);
    expect(isNegative('-0')).toBe(false);
    expect(isNegative('1')).toBe(false);
  });

  it('★ 가용재고 검증 형태로 동작한다', () => {
    const available = toDecimal('3.000000');
    const requested = toDecimal('10.000000');
    expect(isLessThan(available, requested)).toBe(true);
    expect(isNegative(subtract(available, requested))).toBe(true);
  });
});

describe('roundToScale — 반올림', () => {
  it('기본은 HALF_UP', () => {
    expect(toDecimalString(roundToScale('1.005', 2))).toBe('1.01');
    expect(toDecimalString(roundToScale('2.5', 0))).toBe('3');
    expect(toDecimalString(roundToScale('-2.5', 0))).toBe('-3');
  });

  it('HALF_EVEN (은행가 반올림)', () => {
    expect(toDecimalString(roundToScale('2.5', 0, ROUNDING.HALF_EVEN))).toBe('2');
    expect(toDecimalString(roundToScale('3.5', 0, ROUNDING.HALF_EVEN))).toBe('4');
  });

  it('DOWN / UP / FLOOR / CEIL', () => {
    expect(toDecimalString(roundToScale('1.999', 0, ROUNDING.DOWN))).toBe('1');
    expect(toDecimalString(roundToScale('1.001', 0, ROUNDING.UP))).toBe('2');
    expect(toDecimalString(roundToScale('-1.001', 0, ROUNDING.FLOOR))).toBe('-2');
    expect(toDecimalString(roundToScale('1.001', 0, ROUNDING.CEIL))).toBe('2');
  });

  it('결과는 Decimal 이다', () => {
    expect(isDecimal(roundToScale('1.005', 2))).toBe(true);
  });

  it('★ 잘못된 scale 은 RangeError', () => {
    expect(() => roundToScale('1', -1)).toThrow(RangeError);
    expect(() => roundToScale('1', 1.5)).toThrow(RangeError);
    expect(() => roundToScale('1', Number.NaN)).toThrow(RangeError);
  });

  it('수량 6자리 형태', () => {
    expect(toDecimalString(roundToScale('1.0000005', 6))).toBe('1.000001');
  });
});

describe('toDecimalString — 직렬화', () => {
  it('값의 자릿수를 유지한다', () => {
    expect(toDecimalString(toDecimal('1.500'))).toBe('1.5');
    expect(toDecimalString(toDecimal('10'))).toBe('10');
  });

  it('scale 을 주면 고정 소수점으로 낸다', () => {
    expect(toDecimalString('1.5', 6)).toBe('1.500000');
    expect(toDecimalString('1.0000005', 6)).toBe('1.000001');
    expect(toDecimalString('10', 0)).toBe('10');
  });

  it('★ 큰 수를 지수표기로 내보내지 않는다', () => {
    // Decimal.toString() 은 지수표기를 쓴다 — 엑셀·외부 시스템이 오해한다
    expect(new Decimal('1e25').toString()).toBe('1e+25');
    // toDecimalString 은 일반 표기
    expect(toDecimalString(toDecimal('1e25'))).toBe('10000000000000000000000000');
  });

  it('★ 작은 수도 지수표기로 내보내지 않는다', () => {
    expect(new Decimal('1e-7').toString()).toBe('1e-7');
    expect(toDecimalString(toDecimal('1e-7'))).toBe('0.0000001');
    expect(toDecimalString(toDecimal('1e-30'))).toBe('0.000000000000000000000000000001');
  });

  it('음수·0 도 일반 표기', () => {
    expect(toDecimalString(toDecimal('-1e-8'))).toBe('-0.00000001');
    expect(toDecimalString(ZERO)).toBe('0');
  });

  it('★ 잘못된 scale 은 RangeError', () => {
    expect(() => toDecimalString('1', -1)).toThrow(RangeError);
    expect(() => toDecimalString('1', 2.5)).toThrow(RangeError);
  });

  it('★ 왕복 변환이 값을 보존한다', () => {
    for (const value of ['0', '1.5', '-0.000001', '9007199254740993', '1e25', '1e-30']) {
      const roundTripped = toDecimalString(toDecimal(toDecimalString(toDecimal(value))));
      expect(isEqual(roundTripped, value)).toBe(true);
    }
  });
});

describe('ZERO 상수', () => {
  it('0 이다', () => {
    expect(isZero(ZERO)).toBe(true);
    expect(toDecimalString(ZERO)).toBe('0');
  });

  it('연산의 항등원으로 쓸 수 있다', () => {
    expect(toDecimalString(add(ZERO, '5'))).toBe('5');
  });
});
