import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import { DECIMAL_PRECISION, readDecimalContext, ScmDecimal } from './context';
import {
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

  it('전용 컨텍스트의 Decimal 은 그대로 돌려준다 (불변이므로 복사 불필요)', () => {
    const own = toDecimal('7.5');
    expect(toDecimal(own)).toBe(own);
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
    expect(new Prisma.Decimal('Infinity').isFinite()).toBe(false);
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
    expect(isDecimal(new Prisma.Decimal('1'))).toBe(true);
    expect(isDecimal(toDecimal('1'))).toBe(true);
  });

  it('Decimal 이 아닌 값을 걸러낸다', () => {
    for (const value of ['1', 1, null, undefined, {}, [], { toString: () => '1' }]) {
      expect(isDecimal(value)).toBe(false);
    }
  });

  it('타입 가드로 동작한다', () => {
    const value: unknown = new Prisma.Decimal('2.5');
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
    expect(toDecimalString(add(new Prisma.Decimal('10'), '0.5'))).toBe('10.5');
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
    expect(new Prisma.Decimal(1).dividedBy(0).isFinite()).toBe(false);
    // 유틸은 막는다
    expect(() => divide('1', '0')).toThrow(RangeError);
    expect(() => divide('0', '0')).toThrow(RangeError);
    expect(() => divide('1', '0.000')).toThrow(RangeError);
  });

  it('무한소수는 유효자릿수로 잘린 근사값이다', () => {
    // 정확한 자릿수가 필요하면 roundToScale 로 명시해야 한다는 근거
    const third = divide('1', '3');
    expect(toDecimalString(third).startsWith('0.3333333333')).toBe(true);
    // 유효자릿수 60 이므로 소수점 아래 60자리
    expect(toDecimalString(third)).toHaveLength('0.'.length + DECIMAL_PRECISION);
    expect(toDecimalString(multiply(third, '3'))).not.toBe('1');
  });

  it('연산 결과는 Decimal 이다', () => {
    expect(isDecimal(add('1', '2'))).toBe(true);
    expect(isDecimal(subtract('1', '2'))).toBe(true);
    expect(isDecimal(multiply('1', '2'))).toBe(true);
    expect(isDecimal(divide('1', '2'))).toBe(true);
  });

  it('피연산자를 변형하지 않는다 (Decimal 은 불변)', () => {
    const a = new Prisma.Decimal('5');
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
    expect(toDecimalString(sumDecimals([new Prisma.Decimal('1.5'), '2.5']))).toBe('4');
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
  it('HALF_UP (사사오입)', () => {
    expect(toDecimalString(roundToScale('1.005', 2, ROUNDING.HALF_UP))).toBe('1.01');
    expect(toDecimalString(roundToScale('2.5', 0, ROUNDING.HALF_UP))).toBe('3');
    expect(toDecimalString(roundToScale('-2.5', 0, ROUNDING.HALF_UP))).toBe('-3');
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
    expect(isDecimal(roundToScale('1.005', 2, ROUNDING.HALF_UP))).toBe(true);
  });

  it('★ 잘못된 scale 은 RangeError', () => {
    expect(() => roundToScale('1', -1, ROUNDING.HALF_UP)).toThrow(RangeError);
    expect(() => roundToScale('1', 1.5, ROUNDING.HALF_UP)).toThrow(RangeError);
    expect(() => roundToScale('1', Number.NaN, ROUNDING.HALF_UP)).toThrow(RangeError);
  });

  it('수량 6자리 형태', () => {
    expect(toDecimalString(roundToScale('1.0000005', 6, ROUNDING.HALF_UP))).toBe('1.000001');
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
    expect(new Prisma.Decimal('1e25').toString()).toBe('1e+25');
    // toDecimalString 은 일반 표기
    expect(toDecimalString(toDecimal('1e25'))).toBe('10000000000000000000000000');
  });

  it('★ 작은 수도 지수표기로 내보내지 않는다', () => {
    expect(new Prisma.Decimal('1e-7').toString()).toBe('1e-7');
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

// ═══════════════════════════════════════════════════════════════
// 계산 컨텍스트 (T0-4 보완)
// ═══════════════════════════════════════════════════════════════
describe('★ 계산 컨텍스트 고정', () => {
  it('전역 기본값이 아니라 명시된 설정을 쓴다', () => {
    const context = readDecimalContext();

    expect(context.precision).toBe(DECIMAL_PRECISION);
    expect(context.precision).toBeGreaterThanOrEqual(40);
    expect(context.rounding).toBe(4); // ROUND_HALF_UP
    expect(context.frozen).toBe(true);

    // decimal.js 전역 기본값과 다르다는 것 자체를 고정한다
    expect(Prisma.Decimal.precision).toBe(20);
    expect(context.precision).not.toBe(Prisma.Decimal.precision);
  });

  it('지수표기 임계값이 극단으로 고정되어 있다', () => {
    const context = readDecimalContext();
    expect(context.toExpNeg).toBe(-9e15);
    expect(context.toExpPos).toBe(9e15);
  });

  it('★ 18자리 × 18자리 중간 계산이 절단 없이 보존된다', () => {
    // 수량 DECIMAL(18,6) 최대치 × 금액 DECIMAL(18,4) 최대치
    const quantity = '123456789012.345678'; // 18 유효자릿수
    const amount = '12345678901234.5678'; // 18 유효자릿수

    const product = multiply(quantity, amount);

    // 정확한 곱은 36 유효자릿수
    expect(toDecimalString(product)).toBe('1524157875323883652796829.9765279684');

    // 전역 기본값(20자리)이었다면 절단되었을 것이다
    const truncated = new Prisma.Decimal(quantity).times(amount).toFixed();
    expect(truncated).not.toBe(toDecimalString(product));
  });

  it('★ 3항 연쇄(수량 × 단가 × 계수)도 절단되지 않는다', () => {
    const chained = multiply(
      multiply('123456789012.345678', '12345678901234.5678'),
      '999999.999999',
    );
    // 54 유효자릿수 < 60 이므로 정확해야 한다
    // 정확한 값은 47 유효자릿수 (< 60)
    expect(toDecimalString(chained)).toBe('1524157875322359494921506092875.1715700234720316');
  });

  it('★ 다른 코드가 Prisma.Decimal 설정을 바꿔도 영향받지 않는다', () => {
    const before = toDecimalString(divide('1', '3'));
    const originalPrecision = Prisma.Decimal.precision;

    try {
      // 외부 코드가 전역 설정을 바꾸는 상황을 재현한다
      Prisma.Decimal.set({ precision: 5 });
      expect(Prisma.Decimal.precision).toBe(5);

      expect(toDecimalString(divide('1', '3'))).toBe(before);
      expect(toDecimalString(divide('1', '3'))).toHaveLength('0.'.length + DECIMAL_PRECISION);
    } finally {
      Prisma.Decimal.set({ precision: originalPrecision });
    }
  });

  it('★ 전용 생성자의 설정은 변경할 수 없다 (freeze)', () => {
    const context = readDecimalContext();

    expect(() =>
      (ScmDecimal as unknown as { set: (c: unknown) => void }).set({ precision: 5 }),
    ).toThrow();
    expect(() => {
      (ScmDecimal as unknown as { precision: number }).precision = 5;
    }).toThrow();

    expect(readDecimalContext()).toEqual(context);
  });

  it('★ 동일 입력은 실행 순서와 무관하게 동일 결과를 낸다', () => {
    const inputs = ['0.1', '123456789012.345678', '1e-30', '-7.5'];

    const forward = inputs.map((value) => toDecimalString(divide(value, '7')));
    const backward = [...inputs].reverse().map((value) => toDecimalString(divide(value, '7')));

    expect(backward.reverse()).toEqual(forward);

    // 다른 연산을 사이에 끼워도 결과가 변하지 않는다
    divide('999', '7');
    multiply('3', '11');
    expect(inputs.map((value) => toDecimalString(divide(value, '7')))).toEqual(forward);
  });
});

describe('★ Prisma 호환성', () => {
  it('Prisma 가 돌려준 Decimal 을 입력으로 받는다', () => {
    const fromPrisma = new Prisma.Decimal('12.5');
    expect(toDecimalString(toDecimal(fromPrisma))).toBe('12.5');
    expect(toDecimalString(add(fromPrisma, '0.5'))).toBe('13');
  });

  it('★ 외부 컨텍스트의 Decimal 은 전용 컨텍스트로 다시 감싼다', () => {
    const fromPrisma = new Prisma.Decimal('1');
    const wrapped = toDecimal(fromPrisma);

    expect(wrapped).not.toBe(fromPrisma);
    expect((wrapped as unknown as { constructor: unknown }).constructor).toBe(ScmDecimal);

    // 감싸지 않았다면 유효자릿수 20 으로 계산되었을 것이다
    expect(toDecimalString(divide(fromPrisma, '3'))).toHaveLength('0.'.length + DECIMAL_PRECISION);
  });

  it('전용 컨텍스트의 값은 다시 감싸지 않는다', () => {
    const own = toDecimal('1.5');
    expect(toDecimal(own)).toBe(own);
  });

  it('★ DB 전달 가능 타입과 호환된다', () => {
    const value = toDecimal('123.456789');

    // Prisma 는 numeric 필드 값을 Decimal.isDecimal / instanceof 로 판별한다
    expect(Prisma.Decimal.isDecimal(value)).toBe(true);
    expect(value).toBeInstanceOf(Prisma.Decimal);

    // Prisma 생성자로 다시 감싸도 값이 보존된다 (직렬화 왕복)
    expect(new Prisma.Decimal(value).toFixed()).toBe('123.456789');
    expect(value.toJSON()).toBe('123.456789');
  });

  it('일반 문자열 입력을 허용한다', () => {
    expect(toDecimalString(toDecimal('0.000001'))).toBe('0.000001');
    expect(toDecimalString(add('1', '2'))).toBe('3');
  });

  it('★ number 입력은 타입 오류다', () => {
    // @ts-expect-error number 는 DecimalInput 이 아니다 (정밀도 손실 방지)
    expect(() => toDecimal(1.5)).not.toThrow();
    // @ts-expect-error number 는 DecimalInput 이 아니다
    expect(() => add(0.1, 0.2)).not.toThrow();
  });

  it('★ Infinity·NaN 은 입력과 연산 결과 모두에서 거부된다', () => {
    // 입력
    expect(() => toDecimal('Infinity')).toThrow(RangeError);
    expect(() => toDecimal('NaN')).toThrow(RangeError);

    // 외부에서 만들어진 비유한 Decimal 을 입력으로 받은 경우
    expect(() => toDecimal(new Prisma.Decimal('Infinity'))).toThrow(RangeError);
    expect(() => toDecimal(new Prisma.Decimal(0).dividedBy(0))).toThrow(RangeError);

    // 연산 경로
    expect(() => divide('1', '0')).toThrow(RangeError);
    expect(() => add(new Prisma.Decimal('Infinity'), '1')).toThrow(RangeError);
    expect(() => sumDecimals(['1', new Prisma.Decimal('NaN')])).toThrow(RangeError);
  });
});

describe('★ roundToScale — rounding mode 필수', () => {
  it('mode 를 생략하면 타입 오류다', () => {
    // @ts-expect-error rounding mode 는 필수다 (업무 정책이 미확정이므로 기본값 없음)
    expect(() => roundToScale('1.005', 2)).not.toThrow();
  });

  it('같은 값이라도 mode 에 따라 결과가 다르다', () => {
    expect(toDecimalString(roundToScale('2.5', 0, ROUNDING.HALF_UP))).toBe('3');
    expect(toDecimalString(roundToScale('2.5', 0, ROUNDING.HALF_EVEN))).toBe('2');
    expect(toDecimalString(roundToScale('2.5', 0, ROUNDING.DOWN))).toBe('2');
    expect(toDecimalString(roundToScale('2.5', 0, ROUNDING.UP))).toBe('3');
  });

  it('수량 6자리 / 금액 4자리 형태', () => {
    expect(toDecimalString(roundToScale('1.00000049', 6, ROUNDING.HALF_UP), 6)).toBe('1.000000');
    expect(toDecimalString(roundToScale('1234.56785', 4, ROUNDING.HALF_EVEN), 4)).toBe('1234.5678');
  });
});

describe('★ 지수표기 없는 직렬화 (컨텍스트 반영)', () => {
  it('전용 컨텍스트에서는 toString() 도 지수표기를 쓰지 않는다', () => {
    // 전역 기본값이었다면 '1e+25' / '1e-7' 이 나온다
    expect(new Prisma.Decimal('1e25').toString()).toBe('1e+25');
    expect(toDecimal('1e25').toString()).toBe('10000000000000000000000000');
    expect(toDecimal('1e-7').toString()).toBe('0.0000001');
    expect(toDecimal('1e-30').toString()).toBe('0.000000000000000000000000000001');
  });

  it('toDecimalString 은 어떤 크기에서도 일반 표기를 낸다', () => {
    for (const value of ['1e25', '1e-30', '-1e25', '-1e-30', '0']) {
      expect(toDecimalString(toDecimal(value))).not.toMatch(/e/i);
    }
  });

  it('연산 결과도 지수표기가 되지 않는다', () => {
    expect(toDecimalString(multiply('1e12', '1e12'))).toBe('1000000000000000000000000');
    expect(toDecimalString(divide('1', '1e20'))).toBe('0.00000000000000000001');
  });
});
