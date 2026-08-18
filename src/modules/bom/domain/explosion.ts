import {
  ROUNDING,
  divide,
  isGreaterThan,
  multiply,
  roundToScale,
  toDecimal,
  toDecimalString,
  ZERO,
  type Decimal,
  type DecimalInput,
} from '@/shared/decimal';
import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * BOM 전개 수량 계산 (T07-6) — **순수 함수**. Prisma 를 import 하지 않는다.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-19(공식·정밀도) ·
 *    `★ T07-6 explosion quantity gap closure`(E-1 · E-2 · E-6 · E-7).
 *
 * ## 공식 (D-19)
 *
 * ```
 * scale       = Q / outputQty
 * requiredQty = scale × quantityPer × (1 + lossRate) × (1 + overallLossRate)
 * ```
 *
 * 손실률은 **가산식**이다 — `× (1 + rate)`.
 * ⛔ 수율식 `1 / (1 - rate)` 을 쓰지 않는다 (D-19 가 세 근거로 배제했다).
 * ⛔ 두 손실률을 `(1 + a + b)` 로 합치지 않는다 — **각각 곱한다.**
 * `null` 손실률은 `0` 이다 (`× 1`). ⛔ "미입력이므로 추정" 하지 않는다.
 *
 * ## `packQuantity` 는 이 계산에 **등장하지 않는다**
 *
 * D-19: `quantityPer = 1/입수량` 인 라인에서 박스 환산이 **이미 반영돼 있으므로**
 * 다시 나누면 이중 환산이다. ⛔ `packQuantity` 로 곱하거나 나누지 않는다.
 *
 * ## raw 와 public 을 분리한다 (E-7)
 *
 * | 값 | 용도 |
 * |---|---|
 * | `Decimal` (이 모듈의 반환값) | **내부 전용** — 다음 level 의 `Q` 로 그대로 넘긴다 |
 * | `toRequiredQtyString()` 결과 | **public** — 6dp `ROUND_HALF_UP` 후 minimal 문자열 |
 *
 * ⛔ **public 6dp 값을 다시 `Decimal` 로 읽어 child `Q` 로 쓰지 않는다.**
 *    D-19 의 `⛔ 단계마다 반올림하지 않는다` 가 다단계에도 그대로 적용된다.
 */

/** `requiredQty` public 표현의 소수 자릿수 (D-19 — `Decimal(18,6)` 과 일치). */
export const REQUIRED_QTY_SCALE = 6;

export interface ExplosionQuantityInput {
  /**
   * 부모가 요구하는 이 BOM 산출물의 수량 `Q`.
   *
   * root 에서는 request `qty`, 하위에서는 **부모 node 의 raw requiredQty** 다.
   * `null` = 상위 어딘가가 미확정이라 알 수 없음 (E-2).
   */
  readonly parentQty: Decimal | null;
  /** 이 라인이 속한 header 의 `outputQty`. ⛔ 자동 `1` fallback 금지. */
  readonly outputQty: DecimalInput;
  /** 라인의 `quantityPer`. `null` = 정상 `UNKNOWN` (E-1). */
  readonly quantityPer: DecimalInput | null;
  /** 라인의 `lossRate`. `null` → `0`. */
  readonly lossRate: DecimalInput | null;
  /** header 의 `overallLossRate`. `null` → `0`. */
  readonly overallLossRate: DecimalInput | null;
  /** 진단용 — 오류 context 에만 쓴다. */
  readonly bomHeaderId?: string;
  readonly lineNo?: number;
}

/**
 * `outputQty <= 0` 은 **DB 손상**이다.
 *
 * DTO 는 `positiveDecimal18_6` 으로 `> 0` 을 강제하지만 `output_qty` 컬럼에는
 * CHECK 가 없다(T07-1 migration). 따라서 이관 데이터 등으로 `0`·음수가 존재할 수
 * 있으며, 그때 **조용히 `1` 로 대체하거나 divide-by-zero 를 삼키지 않는다.**
 *
 * ⛔ 새 error code 를 만들지 않는다 — 기존 `BOM_QTY_INVALID`(422, D-29)를 쓴다.
 */
function bomOutputQtyInvalid(input: ExplosionQuantityInput, outputQty: string): DomainError {
  return new DomainError(ERROR_CODES.BOM_QTY_INVALID, {
    message: `BOM 산출수량(outputQty)이 0 이하입니다: ${outputQty}`,
    context: {
      outputQty,
      ...(input.bomHeaderId === undefined ? {} : { bomHeaderId: input.bomHeaderId }),
      ...(input.lineNo === undefined ? {} : { lineNo: input.lineNo }),
    },
  });
}

/**
 * 한 라인의 **raw**(무반올림) 소요량. 계산할 수 없으면 `null`.
 *
 * `null` 을 돌려주는 경우는 정확히 두 가지이며 **둘 다 오류가 아니다**:
 *
 * | 조건 | 근거 |
 * |---|---|
 * | `quantityPer === null` (정상 `UNKNOWN`) | E-1 |
 * | `parentQty === null` (상위가 이미 미상) | E-2 |
 *
 * ⛔ `0` 이나 `1` 로 채우지 않는다. ⛔ `BOM_QTY_UNCONFIRMED` 422 를 내지 않는다.
 *
 * ⚠️ `quantityStatus` 와 `quantityPer` 의 정합(E-5)은 **호출부가 먼저**
 *    `assertQuantityConsistency` 로 검사한다 — 이 함수는 손상 상태를 완화하는
 *    자리가 아니다.
 *
 * @throws {DomainError} `BOM_QTY_INVALID` — `outputQty <= 0` (DB 손상)
 */
export function computeRawRequiredQty(input: ExplosionQuantityInput): Decimal | null {
  // E-1 — 정상 UNKNOWN. 부모 Q 를 보기 전에 끝난다.
  if (input.quantityPer === null) return null;
  // E-2 — 상위가 미상이면 이 라인이 CONFIRMED 여도 미상이다.
  if (input.parentQty === null) return null;

  const outputQty = toDecimal(input.outputQty);
  if (!isGreaterThan(outputQty, ZERO)) {
    throw bomOutputQtyInvalid(input, toDecimalString(outputQty));
  }

  // ⛔ 여기서 반올림하지 않는다 — 중간 연산은 컨텍스트 전체 정밀도다 (D-19).
  const scale = divide(input.parentQty, outputQty);
  const base = multiply(scale, input.quantityPer);
  const withLineLoss = multiply(base, lossFactor(input.lossRate));
  return multiply(withLineLoss, lossFactor(input.overallLossRate));
}

/** `(1 + rate)`. `null` 은 `1` 이다 — ⛔ 추정하지 않는다 (D-19). */
function lossFactor(rate: DecimalInput | null): Decimal {
  return rate === null ? toDecimal('1') : toDecimal(rate).plus(1);
}

/**
 * raw `Decimal` → **public** `requiredQty` 문자열 (E-6).
 *
 * ```
 * roundToScale(raw, 6, ROUND_HALF_UP)  →  toDecimalString(rounded)
 * ```
 *
 * ⛔ `toDecimalString(value, 6)` 로 trailing zero 를 강제하지 않는다 — 계약은
 *    **자릿수가 아니라 값**이며 BOM Decimal API 전체가 minimal form 이다.
 *
 * | raw | 반올림 | public |
 * |---|---|---|
 * | `6` | `6.000000` | `"6"` |
 * | `0.9999901` | `0.999990` | `"0.99999"` |
 * | `1.2345678` | `1.234568` | `"1.234568"` |
 */
export function toRequiredQtyString(raw: Decimal | null): string | null {
  if (raw === null) return null;
  return toDecimalString(roundToScale(raw, REQUIRED_QTY_SCALE, ROUNDING.HALF_UP));
}
