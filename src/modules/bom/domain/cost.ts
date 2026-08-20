import {
  ROUNDING,
  multiply,
  roundToScale,
  sumDecimals,
  toDecimalString,
  type Decimal,
  type DecimalInput,
} from '@/shared/decimal';

/**
 * BOM 원가 산술 (T07-7A) — **순수 함수**. Prisma 를 import 하지 않는다.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-19(정밀도) · §D-25(provisional) ·
 *    §D-26(currency) · §D-27(VAT) ·
 *    `★ T07-7A direct cost arithmetic gap closure`(F-1 ~ F-11).
 *
 * ## 이 모듈이 하지 않는 것
 *
 * ⛔ 다단계 roll-up · D-20 component aggregation · 다이아몬드 집계 ·
 *    public `CostResult` 조립. 전부 **T07-7B** 다 (C-1·C-6·F-11).
 */

/** 금액 public 표현의 소수 자릿수 (D-19 — `Decimal(18,4)` 과 일치). */
export const MONEY_SCALE = 4;

/**
 * provisional 사유 3종 (D-25). ⛔ 늘리지 않는다.
 *
 * 배열 순서가 곧 **F-6 우선순위**이자 F-7 의 결정적 정렬 순서다.
 */
export const COST_PROVISIONAL_REASONS = [
  'QTY_UNCONFIRMED',
  'NO_PRIMARY_SUPPLIER',
  'NO_EFFECTIVE_PRICE',
] as const;

export type CostProvisionalReason = (typeof COST_PROVISIONAL_REASONS)[number];

/**
 * ★ **F-1 — 한 라인의 raw 원가.**
 *
 * ```
 * rawLineCost = rawRequiredQty × unitPrice
 * ```
 *
 * 정확히 이 곱셈 하나뿐이다 (F-4).
 * ⛔ `packQuantity` 로 나누거나 곱하지 않는다 — `quantityPer = 1/입수량` 에
 *    박스 환산이 **이미 반영돼 있어** 다시 나누면 이중 환산이다 (D-19).
 * ⛔ `SupplierSku.purchaseUom` 변환 없음 · VAT 가감 없음 · 환율 환산 없음.
 *    `currency`·`vatIncluded` 는 **metadata 이자 grouping key** 이지 피연산자가
 *    아니다.
 *
 * ★ `rawRequiredQty` 는 **D-19 공식의 반올림 전 `Decimal`** 이다.
 * ⛔ public 6dp `requiredQty` 를 되읽어 곱하지 않는다 (F-1 · T07-6 E-7 과 같은
 *    원칙). 그 경로는 다단계에서 오차를 누적시킨다.
 *
 * @returns 계산 불가면 `null` — ⛔ `0` 으로 채우지 않는다 (F-3).
 */
export function computeRawLineCost(input: {
  /** 반올림 전 소요량. `null` = 수량 미상 (E-1·E-2). */
  readonly rawRequiredQty: Decimal | null;
  /** 선택된 승인 가격의 `unitPrice`. `null` = 대표 공급처 또는 유효 가격 없음. */
  readonly unitPrice: DecimalInput | null;
}): Decimal | null {
  if (input.rawRequiredQty === null) return null;
  if (input.unitPrice === null) return null;
  return multiply(input.rawRequiredQty, input.unitPrice);
}

/**
 * ★ **F-2 — 금액 public 직렬화.**
 *
 * ```
 * roundToScale(raw, 4, ROUND_HALF_UP)  →  toDecimalString(rounded)
 * ```
 *
 * ⛔ trailing zero 를 채우지 않는다 — 금액도 minimal form 이다
 *    (`price-views.ts` 의 `unitPrice` 선례).
 *
 * | 반올림 결과 | public |
 * |---|---|
 * | `6.0000` | `"6"` |
 * | `10.5000` | `"10.5"` |
 * | `10.1235` (raw `10.12345`) | `"10.1235"` |
 */
export function toMoneyString(raw: Decimal | null): string | null {
  if (raw === null) return null;
  return toDecimalString(roundToScale(raw, MONEY_SCALE, ROUNDING.HALF_UP));
}

/**
 * ★ **F-5 — 한 라인의 실제 provisional 사유 전부.**
 *
 * 여러 조건이 **동시에** 성립할 수 있으므로 집합으로 돌려준다.
 *
 * | 조건 | reason |
 * |---|---|
 * | `quantityStatus !== 'CONFIRMED'` | `QTY_UNCONFIRMED` |
 * | 대표 SupplierSku 없음 | `NO_PRIMARY_SUPPLIER` |
 * | 대표는 있으나 유효 승인 가격 없음 | `NO_EFFECTIVE_PRICE` |
 *
 * ★ **`SUGGESTED` 도 `QTY_UNCONFIRMED` 다.** D-10 이 `SUGGESTED` 를
 *   "마이그레이션이 자동 생성한 값이며 사람이 수락해야 `CONFIRMED`" 로 정의했고
 *   submit 게이트도 `≠ CONFIRMED` 를 막는다. 즉 `quantityPer > 0` 이라
 *   **계산은 되지만 확정은 아니다** — "계산 가능" ≠ "수량 확정".
 *
 * ⛔ `isRequired` 는 원가 provisional 판정에 쓰지 않는다 — optional 라인이어도
 *    미확정이면 `QTY_UNCONFIRMED` 다. (submit 게이트만 `isRequired` 를 본다.)
 *
 * ⚠️ **대표 공급처가 아예 없으면 `NO_EFFECTIVE_PRICE` 를 추가하지 않는다** —
 *    가격 resolver 를 실행할 대상 자체가 없기 때문이다 (F-5).
 */
export function deriveCostProvisionalReasons(input: {
  readonly quantityStatus: string;
  readonly hasPrimarySupplierSku: boolean;
  readonly hasEffectivePrice: boolean;
}): CostProvisionalReason[] {
  const reasons: CostProvisionalReason[] = [];
  // ★ SUGGESTED 포함 — 확정된 것은 CONFIRMED 뿐이다 (D-10).
  if (input.quantityStatus !== 'CONFIRMED') reasons.push('QTY_UNCONFIRMED');
  if (!input.hasPrimarySupplierSku) {
    reasons.push('NO_PRIMARY_SUPPLIER');
    // ⛔ 대표가 없으면 가격 조회 대상이 없다 — NO_EFFECTIVE_PRICE 를 연쇄로
    //    붙이지 않는다.
    return reasons;
  }
  if (!input.hasEffectivePrice) reasons.push('NO_EFFECTIVE_PRICE');
  return reasons;
}

/**
 * ★ **F-6 — public 단수 `provisionalReason` projection.**
 *
 * ```
 * QTY_UNCONFIRMED  >  NO_PRIMARY_SUPPLIER  >  NO_EFFECTIVE_PRICE
 * ```
 *
 * ★ 정보를 버리는 규칙이 **아니다** — 실제 사유 집합은 그대로 보존되고
 *   (F-5), 이 함수는 단일 표시값을 정할 뿐이다. top-level 배열은 union 이다
 *   (F-7).
 */
export function projectProvisionalReason(
  reasons: readonly CostProvisionalReason[],
): CostProvisionalReason | null {
  for (const candidate of COST_PROVISIONAL_REASONS) {
    if (reasons.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * ★ **F-7 — 여러 라인의 사유를 union 한다.**
 *
 * ⛔ 단수 projection 결과를 모으는 것이 아니라 **실제 사유 집합**의 합집합이다.
 * 정렬은 F-6 우선순위 고정, 중복 제거.
 *
 * ⚠️ 이 helper 가 있다고 T07-7A 가 public `provisionalReasons[]` 를 조립하는
 *    것은 아니다 — 최종 조립은 **T07-7B** 다 (C-5).
 */
export function unionProvisionalReasons(
  reasonSets: readonly (readonly CostProvisionalReason[])[],
): CostProvisionalReason[] {
  const seen = new Set<CostProvisionalReason>();
  for (const set of reasonSets) for (const reason of set) seen.add(reason);
  return COST_PROVISIONAL_REASONS.filter((reason) => seen.has(reason));
}

/** `(currency, vatIncluded)` 조합 하나의 소계 (D-26·D-27). */
export interface CostSubtotal {
  readonly currency: string;
  readonly vatIncluded: boolean;
  /** 4dp `ROUND_HALF_UP` 후 minimal 문자열. */
  readonly amount: string;
}

/** 소계 입력 — 계산 불가한 라인은 `rawLineCost = null` 로 들어온다. */
export interface CostSubtotalInput {
  readonly currency: string | null;
  readonly vatIncluded: boolean | null;
  readonly rawLineCost: Decimal | null;
}

/**
 * ★ **F-8·F-9 — `(currency, vatIncluded)` 별 소계.**
 *
 * ```
 * rawSubtotal     = Σ rawLineCost          (계산 가능한 라인만)
 * subtotal.amount = roundToScale(rawSubtotal, 4, ROUND_HALF_UP) → minimal string
 * ```
 *
 * ⛔ **반올림된 public `lineCost` 를 다시 합산하지 않는다** — 금액도 중간
 *    무반올림이다. 두 경로는 실제로 다른 값을 낸다(F-10 CASE 4).
 * ⛔ `rawLineCost === null` 인 라인은 **산술에서 제외**한다. `0` 으로 더한 것처럼
 *    취급하지 않는다 — 결과는 **"확정 가능한 부분의 합"** 이지 "missing 을 0 으로
 *    본 전체 합" 이 아니다 (D-25 · F-9).
 *
 * 정렬은 D-26 대로 `currency` asc → `vatIncluded` false 먼저.
 * 계산 가능한 라인이 하나도 없으면 **빈 배열**이다.
 */
export function computeCostSubtotals(lines: readonly CostSubtotalInput[]): CostSubtotal[] {
  const buckets = new Map<string, { currency: string; vatIncluded: boolean; raws: Decimal[] }>();

  for (const line of lines) {
    // F-9 — 계산 불가 라인은 소계에 들어가지 않는다.
    if (line.rawLineCost === null) continue;
    // 금액이 있는데 통화·VAT 가 없을 수는 없다(가격 행에서 함께 온다).
    if (line.currency === null || line.vatIncluded === null) continue;

    const key = `${line.currency} ${String(line.vatIncluded)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, {
        currency: line.currency,
        vatIncluded: line.vatIncluded,
        raws: [line.rawLineCost],
      });
    } else {
      bucket.raws.push(line.rawLineCost);
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      currency: bucket.currency,
      vatIncluded: bucket.vatIncluded,
      // ★ raw 를 먼저 전부 더하고 **마지막에 한 번만** 반올림한다.
      amount: toMoneyString(sumDecimals(bucket.raws)) as string,
    }))
    .sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) || Number(a.vatIncluded) - Number(b.vatIncluded),
    );
}
