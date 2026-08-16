import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * BOM 라인·구성품 검증규칙 (T07-2) — **순수 함수**. Prisma 를 import 하지 않는다.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-10(소요량) · §D-11(UOM) · §D-12(구성품 자격).
 *
 * ## "검증규칙 14종" 의 출처
 *
 * 원문 `05:126` 은 `검증규칙 14종 (PRD §22)` 라고만 적었고 그 **PRD 가 저장소에
 * 없다**(docs/18 §1.4). 따라서 열거된 14개 목록은 복구 불가이며, docs/18 이
 * D-10·D-11·D-12·D-13 으로 **강제 대상 규칙을 확정**했다. 이 파일은 그중
 * 데이터만으로 판정 가능한 것을 전부 구현하고, 그래프가 필요한 순환은
 * `cycle.ts`, DB 조회가 필요한 것은 application 계층이 조립한다.
 *
 * ⛔ docs/18 이 **"강제하지 않는다"** 고 못박은 것(parent `manufacturable`,
 *    구성품 `itemType`, `inventoryManaged=false`, `componentRole=SERVICE`)은
 *    여기서도 검사하지 않는다. 규칙을 발명하지 않는 것도 계약이다.
 */

// ═══════════════════════════════════════════════════════════════
// D-10 — 소요량 · 소요량 상태 정합
// ═══════════════════════════════════════════════════════════════

export const QUANTITY_STATUSES = ['CONFIRMED', 'SUGGESTED', 'UNKNOWN'] as const;
export type BomQuantityStatus = (typeof QUANTITY_STATUSES)[number];

/**
 * 소요량 판정에 필요한 최소 정보.
 *
 * ⚠️ `quantityPer` 는 **십진 문자열**이다. `Decimal(18,6)` 을 `Number()` 로 바꾸면
 *    `1/30 = 0.033333` 같은 값에서 정밀도가 깨진다 (프로젝트 공통 규약).
 */
export interface BomLineQuantityInput {
  readonly quantityPer: string | null;
  readonly quantityStatus: BomQuantityStatus;
  readonly isRequired?: boolean;
  /** 오류 맥락용. 없으면 생략된다. */
  readonly lineNo?: number;
}

/** `> 0` 인 십진 문자열인가. ⛔ `Number()`/`parseFloat()` 를 쓰지 않는다. */
export function isPositiveDecimalString(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return false; // 부호·지수표기·빈 값 거부
  return /[1-9]/.test(trimmed); // 0 · 0.000000 은 0 이다
}

export function bomQuantityInvalid(input: BomLineQuantityInput): DomainError {
  return new DomainError(ERROR_CODES.BOM_QTY_INVALID, {
    message: `소요량은 0 보다 커야 합니다 (입력값 '${input.quantityPer ?? 'null'}').`,
    context: { lineNo: input.lineNo, quantityPer: input.quantityPer },
  });
}

export function bomQuantityStatusMismatch(input: BomLineQuantityInput): DomainError {
  return new DomainError(ERROR_CODES.BOM_QTY_STATUS_MISMATCH, {
    message:
      input.quantityStatus === 'UNKNOWN'
        ? 'UNKNOWN 라인은 소요량이 비어 있어야 합니다.'
        : `${input.quantityStatus} 라인은 소요량이 필요합니다.`,
    context: {
      lineNo: input.lineNo,
      quantityStatus: input.quantityStatus,
      quantityPer: input.quantityPer,
    },
  });
}

/**
 * D-10 정합 규칙.
 *
 * | `quantityStatus` | `quantityPer` |
 * |---|---|
 * | `UNKNOWN`   | **`null` 이어야 한다** |
 * | `SUGGESTED` | **`> 0` 필수** |
 * | `CONFIRMED` | **`> 0` 필수** |
 *
 * ⛔ **자동 1 입력 금지** — 이 함수는 값을 채우지 않는다. 판정만 한다
 *    (`03v2:918`, `01:188`, §00 G-02, TC-BOM-010).
 * ⛔ `packQuantity` 로 `quantityPer` 를 유도하지 않는다 (F-19). `1 ÷ packQuantity`
 *    는 UI 추천값이며 사용자가 수락해야 저장된다.
 *
 * @throws {DomainError} `BOM_QTY_STATUS_MISMATCH` / `BOM_QTY_INVALID`
 */
export function assertQuantityConsistency(input: BomLineQuantityInput): void {
  if (input.quantityStatus === 'UNKNOWN') {
    if (input.quantityPer !== null) throw bomQuantityStatusMismatch(input);
    return;
  }
  // SUGGESTED · CONFIRMED — 값이 있어야 하고 0 보다 커야 한다.
  if (input.quantityPer === null) throw bomQuantityStatusMismatch(input);
  if (!isPositiveDecimalString(input.quantityPer)) throw bomQuantityInvalid(input);
}

/**
 * submit 게이트 (D-10) — **순수 판정만** 한다.
 *
 * `isRequired = true` 인 라인 중 `quantityStatus ≠ CONFIRMED` 가 하나라도 있으면
 * 던진다. `isRequired = false` 라인은 게이트 대상이 아니다.
 *
 * ⚠️ T07-2 는 이 규칙을 **호출하는 submit endpoint 를 만들지 않는다** —
 *    T07-5 가 이 함수를 호출한다.
 *
 * @throws {DomainError} `BOM_QTY_UNCONFIRMED`
 */
export function assertAllRequiredQuantitiesConfirmed(lines: readonly BomLineQuantityInput[]): void {
  const unconfirmed = lines.filter(
    (line) => (line.isRequired ?? true) && line.quantityStatus !== 'CONFIRMED',
  );
  if (unconfirmed.length === 0) return;

  throw new DomainError(ERROR_CODES.BOM_QTY_UNCONFIRMED, {
    message: `소요량이 확정되지 않은 라인이 ${unconfirmed.length}건 있습니다.`,
    context: { unconfirmedLineNos: unconfirmed.map((line) => line.lineNo) },
    publicDetails: { unconfirmedCount: unconfirmed.length },
  });
}

// ═══════════════════════════════════════════════════════════════
// D-11 — UOM
// ═══════════════════════════════════════════════════════════════

export interface BomUomInput {
  /** 라인의 `uom` 또는 헤더의 `outputUom`. */
  readonly uom: string;
  /** 대상 SKU 의 `baseUom`. */
  readonly baseUom: string;
  readonly skuId?: string;
  readonly lineNo?: number;
}

/**
 * `quantityPer` 는 **구성품 SKU 의 `baseUom` 기준**이므로 `uom` 은 그 값과 같아야
 * 한다. 헤더의 `outputUom` 도 parent `baseUom` 과 같아야 한다 (D-11).
 *
 * ⛔ **T07 은 단위 환산을 하지 않는다.** 환산 계수 테이블·필드가 저장소에 없다.
 * ⛔ `SupplierSku.purchaseUom` 을 보지 않는다 — 구매 단위이며 사용 단위와 다른 축이다.
 *
 * @throws {DomainError} `BOM_UOM_MISMATCH`
 */
export function assertUomMatchesBase(input: BomUomInput): void {
  if (input.uom === input.baseUom) return;
  throw new DomainError(ERROR_CODES.BOM_UOM_MISMATCH, {
    message: `단위 '${input.uom}' 이(가) SKU 기준단위 '${input.baseUom}' 과 다릅니다.`,
    context: { uom: input.uom, baseUom: input.baseUom, skuId: input.skuId, lineNo: input.lineNo },
  });
}

// ═══════════════════════════════════════════════════════════════
// D-12 — 구성품 자격
// ═══════════════════════════════════════════════════════════════

/** `Sku.status` 중 BOM 판정에 쓰는 값. 문자열로 받아 미지의 값도 그대로 다룬다. */
export type SkuStatusLike = string;

/** ⛔ 상위는 `DRAFT` 만 제외한다 — `05:119` "상위 SKU 승인 상태" 의 최소 해석. */
export const BOM_PARENT_FORBIDDEN_STATUSES: readonly SkuStatusLike[] = ['DRAFT'];
/** ⛔ 구성품은 `ARCHIVED` 만 금지한다 — 폐기된 SKU 를 새로 편성할 수 없다. */
export const BOM_COMPONENT_FORBIDDEN_STATUSES: readonly SkuStatusLike[] = ['ARCHIVED'];

export interface BomComponentEligibilityInput {
  readonly parentSkuId: string;
  readonly componentSkuId: string;
  readonly lineNo?: number;
}

/**
 * `parentSkuId == componentSkuId` 금지 (TC-BOM-001).
 *
 * ★ 그래프 차원의 자기참조는 `cycle.ts` 가 다시 잡는다 — 두 방어를 모두 둔다 (§D-13).
 *
 * @throws {DomainError} `BOM_SELF_COMPONENT`
 */
export function assertNotSelfComponent(input: BomComponentEligibilityInput): void {
  if (input.parentSkuId !== input.componentSkuId) return;
  throw new DomainError(ERROR_CODES.BOM_SELF_COMPONENT, {
    message: '상위 SKU 를 자신의 구성품으로 넣을 수 없습니다.',
    context: { skuId: input.parentSkuId, lineNo: input.lineNo },
  });
}

/**
 * 상위 SKU 자격 (D-12).
 *
 * ⛔ `manufacturable = true` 를 강제하지 않는다 — 근거 문서가 없다.
 *    `Sku.manufacturable` 필드는 존재하지만 BOM 이 그것을 조건으로 삼지 않는다.
 *
 * @throws {DomainError} `BOM_PARENT_NOT_ELIGIBLE`
 */
export function assertParentEligible(input: {
  readonly skuId: string;
  readonly status: SkuStatusLike;
}): void {
  if (!BOM_PARENT_FORBIDDEN_STATUSES.includes(input.status)) return;
  throw new DomainError(ERROR_CODES.BOM_PARENT_NOT_ELIGIBLE, {
    message: `상태 '${input.status}' 인 SKU 는 BOM 의 상위 품목이 될 수 없습니다.`,
    context: { skuId: input.skuId, status: input.status },
  });
}

/**
 * 구성품 SKU 자격 (D-12).
 *
 * ⛔ `componentRole = SERVICE` 를 배제하지 않는다 — 임가공비 464원이 실제 라인이다
 *    (`01:193`). ⛔ `inventoryManaged = false` 도 허용한다. ⛔ `itemType` 제한 없음.
 *
 * @throws {DomainError} `BOM_COMPONENT_NOT_ELIGIBLE`
 */
export function assertComponentEligible(input: {
  readonly skuId: string;
  readonly status: SkuStatusLike;
  readonly lineNo?: number;
}): void {
  if (!BOM_COMPONENT_FORBIDDEN_STATUSES.includes(input.status)) return;
  throw new DomainError(ERROR_CODES.BOM_COMPONENT_NOT_ELIGIBLE, {
    message: `상태 '${input.status}' 인 SKU 는 구성품으로 사용할 수 없습니다.`,
    context: { skuId: input.skuId, status: input.status, lineNo: input.lineNo },
  });
}
