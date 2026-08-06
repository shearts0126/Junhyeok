/**
 * 실제 Prisma Decimal 에 대한 규칙 검증용 fixture.
 *
 * ⚠️ 이 파일은 **의도적으로 위반 코드를 담고 있다.**
 *    `eslint.config.ts` 의 globalIgnores 에 `eslint-rules/__fixtures__/**` 가
 *    들어 있어 `pnpm lint` 대상에서 제외된다. 대신
 *    `tests/eslint-rules/no-decimal-to-number.test.ts` 가 ESLint API 로
 *    이 파일만 직접 검사해 기대한 위치·메시지가 나오는지 확인한다.
 *
 *    TypeScript 로는 유효한 코드이므로 `tsc --noEmit` 은 통과한다.
 *    (정밀도 손실은 타입 오류가 아니라 업무 규칙 위반이다.)
 *
 * 줄 번호가 테스트의 기대값과 연결되어 있다. 위쪽에 줄을 추가하면
 * 테스트가 함께 깨지므로, 새 예제는 **파일 끝에** 추가한다.
 */

import { Prisma } from '@/generated/prisma/client';
// 별칭 import — 이름을 바꿔도 타입으로 판정되는지 확인한다.
// (생성자는 barrel 로 내보내지 않으므로 타입만 가져온다)
import type { Decimal as MoneyValue, DecimalInput } from '@/shared/decimal';

interface LedgerLine {
  readonly quantityDelta: Prisma.Decimal;
  readonly memo: string;
}

// ── 위반 ────────────────────────────────────────────────────────

/** ① 직접 생성값의 toNumber() */
export function violationDirectToNumber(): number {
  return new Prisma.Decimal('1.5').toNumber();
}

/** ② 함수 인자로 받은 Decimal 의 Number() 변환 */
export function violationParameterNumber(quantity: Prisma.Decimal): number {
  return Number(quantity);
}

/** ③ 객체 속성 Decimal 의 단항 + */
export function violationPropertyUnaryPlus(line: LedgerLine): number {
  return +line.quantityDelta;
}

/** ④ 연산 결과 Decimal 의 toNumber() */
export function violationOperationResult(a: Prisma.Decimal, b: Prisma.Decimal): number {
  return a.plus(b).toNumber();
}

/** ⑤ 별칭 import 한 타입의 값 */
export function violationAliasedImport(money: MoneyValue): number {
  return money.toNumber();
}

/** ⑥ 문자열로 우회하는 parseFloat */
export function violationParseFloat(quantity: Prisma.Decimal): number {
  return parseFloat(quantity.toString());
}

/** ⑦ 문자열로 우회하는 parseInt */
export function violationParseInt(quantity: Prisma.Decimal): number {
  return parseInt(quantity.toString(), 10);
}

/** ⑧ 변수명을 바꿔도 우회되지 않는다 */
export function violationRenamedVariable(): number {
  const 수량 = new Prisma.Decimal('7');
  return 수량.toNumber();
}

/** ⑨ toFixed() 결과를 Number() 로 되돌리는 우회 */
export function violationNumberOfToFixed(quantity: Prisma.Decimal): number {
  return Number(quantity.toFixed(6));
}

// ── 허용 ────────────────────────────────────────────────────────

/** 일반 문자열의 Number 변환 — 허용 */
export function allowedNumberFromString(): number {
  return Number('123');
}

/** 일반 문자열의 parseFloat — 허용 */
export function allowedParseFloat(): number {
  return parseFloat('1.25');
}

/** 일반 문자열의 parseInt — 허용 */
export function allowedParseInt(): number {
  return parseInt('10', 10);
}

/** Decimal 을 문자열로 직렬화 — 허용 (출력 경계의 정상 경로) */
export function allowedToFixed(quantity: Prisma.Decimal): string {
  return quantity.toFixed();
}

/** Decimal 끼리 계산 — 허용 */
export function allowedDecimalArithmetic(a: DecimalInput, b: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(a as string).plus(b);
}

/** 일반 number 의 단항 + — 허용 */
export function allowedUnaryPlusOnString(raw: string): number {
  return +raw;
}
