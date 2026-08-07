/**
 * RuleTester 전용 Decimal 대역.
 *
 * 규칙은 **타입 이름**으로 Decimal 을 판정하므로, 실제 decimal.js 를 끌어오지
 * 않고 같은 이름의 클래스로 판정 로직을 검증할 수 있다.
 * 실제 Prisma Decimal 에 대한 검증은 __fixtures__/prisma-decimal.ts 가 담당한다.
 */
export declare class Decimal {
  constructor(value: string | number);
  plus(other: Decimal | string): Decimal;
  minus(other: Decimal | string): Decimal;
  toNumber(): number;
  toString(): string;
  toFixed(dp?: number): string;
  isZero(): boolean;
}

/** Decimal 을 상속한 타입 — 상속 경로 판정 확인용 */
export declare class Money extends Decimal {
  readonly currency: string;
}

export interface OrderLine {
  readonly quantity: Decimal;
  readonly note: string;
}

export declare function getQuantity(): Decimal;
export declare function maybeQuantity(): Decimal | null;
