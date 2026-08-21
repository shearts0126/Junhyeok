import {
  add,
  divide,
  isEqual,
  isGreaterThan,
  multiply,
  roundToScale,
  toDecimal,
  toDecimalString,
  ROUNDING,
  ZERO,
  type Decimal,
  // ★ **browser 바인딩이다** (T07-8). `@/shared/decimal` server barrel 을 쓰면
  //   `@/generated/prisma/client` → `node:module` 이 딸려 와 클라이언트 번들이
  //   만들어지지 않는다. 산술 설정·로직은 두 바인딩이 공유하므로 결과는 같다.
} from '@/shared/decimal/browser';

/**
 * `/master/boms/[id]` 상세 표시 helper (T07-8).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-6(편집 가능) · §D-19(수량 공식) ·
 *    §D-31(15열 · 5단계 UX · 권한 렌더) ·
 *    `★ T07-8 BOM UI read-model gap closure` U8-11·U8-12.
 *
 * ⛔ 순수 함수만 둔다 — Prisma·서버 모듈을 import 하지 않는다.
 * ⛔ `Number()` · `parseFloat()` · `Math.round()` 를 쓰지 않는다 (Decimal 전용).
 */

// ═══════════════════════════════════════════════════════════════
// select 후보값 — 서버 enum 의 **표시용 복제본**
// ═══════════════════════════════════════════════════════════════

/**
 * ⚠️ `@/modules/bom/application` 은 Prisma 를 끌고 오므로 client 에서 import 하지
 *    않는다. 값이 어긋나면 서버 `strictObject` 가 400 으로 잡아 준다 —
 *    ⛔ 조용히 무시되는 경로가 없다.
 */
export const BOM_COMPONENT_ROLE_OPTIONS = ['PRODUCT', 'MATERIAL', 'PACKAGING', 'SERVICE'] as const;

export const BOM_SUPPLY_TYPE_OPTIONS = ['SELF_SUPPLIED', 'TURNKEY'] as const;

/** ★ 정확히 3종이다 — `BomStatus`(7종) 와 혼동하지 않는다. */
export const BOM_QUANTITY_STATUS_OPTIONS = ['CONFIRMED', 'SUGGESTED', 'UNKNOWN'] as const;

// ═══════════════════════════════════════════════════════════════
// U8-12 — 라인 그리드 `실제 필요량`
// ═══════════════════════════════════════════════════════════════

export const ACTUAL_REQUIRED_QTY_SCALE = 6;

/**
 * ★ **U8-12 — 이 BOM 을 기준생산량만큼 만들 때의 라인 소요량.**
 *
 * `Q = BomHeader.outputQty` 를 D-19 에 넣는다 — `scale = Q / outputQty = 1`.
 *
 * ```
 * (outputQty / outputQty) × quantityPer × (1 + lossRate) × (1 + overallLossRate)
 * ```
 *
 * ⛔ **별도 단순화 공식을 새로 정의하지 않는다** — D-19 를 그대로 적용한 것이며
 *    `scale` 항을 남겨 두어 공식의 동일성이 눈에 보이게 한다.
 * ⛔ 이 값을 위해 `/explode` 도 `/cost` 도 호출하지 않는다 (N+1 금지).
 * ⛔ `packQuantity` 는 이 산식의 피연산자가 **아니다** (TC-BOM-009 · F-13).
 *
 * @returns 계산 불가면 `null` — UI 는 `—` 로 표시한다.
 */
export function computeActualRequiredQty(input: {
  readonly outputQty: string;
  readonly quantityPer: string | null;
  readonly lossRate: string | null;
  readonly overallLossRate: string | null;
}): string | null {
  if (input.quantityPer === null) return null;

  const outputQty = toDecimal(input.outputQty);
  // `outputQty <= 0` 은 DB 손상이다 — 화면에서 0 으로 나누지 않고 `—` 로 둔다.
  if (!isGreaterThan(outputQty, ZERO)) return null;

  const scale = divide(outputQty, outputQty);
  const base = multiply(scale, input.quantityPer);
  const withLine = multiply(base, lossFactor(input.lossRate));
  const raw = multiply(withLine, lossFactor(input.overallLossRate));

  return toDecimalString(roundToScale(raw, ACTUAL_REQUIRED_QTY_SCALE, ROUNDING.HALF_UP));
}

function lossFactor(rate: string | null): Decimal {
  return add('1', rate === null ? '0' : rate);
}

// ═══════════════════════════════════════════════════════════════
// D-31 ② — packQuantity 추천값
// ═══════════════════════════════════════════════════════════════

export const SUGGESTED_QTY_SCALE = 6;

/**
 * ★ **D-31 ② — `packQuantity` 가 있으면 `1 / 입수량` 을 추천한다.**
 *
 * ⛔ **추천일 뿐이다** — 자동 저장하지 않고, 사용자가 명시적으로 수락해야 한다.
 * ★ `1/30 = 0.033333`(6dp) 이며 ⛔ 정확한 `1/30` 으로 재정규화하지 않는다
 *   (D-19 · TC-BOM-009).
 */
export function suggestQuantityPer(packQuantity: string | null): string | null {
  if (packQuantity === null || packQuantity === '') return null;
  const pack = toDecimal(packQuantity);
  if (!isGreaterThan(pack, ZERO)) return null;
  return toDecimalString(roundToScale(divide('1', pack), SUGGESTED_QTY_SCALE, ROUNDING.HALF_UP));
}

// ═══════════════════════════════════════════════════════════════
// U8-11 — 원가 탭 `비중`
// ═══════════════════════════════════════════════════════════════

export const COST_SHARE_SCALE = 2;

/**
 * ★ **U8-11 — 비중의 분모는 같은 `(currency, vatIncluded)` subtotal 이다.**
 *
 * ```
 * sharePct = lineCost / (같은 bucket 의 subtotal).amount × 100
 * ```
 *
 * ⛔ 전 통화 합계를 분모로 쓰지 않는다 · ⛔ FX 0 · ⛔ VAT bucket 합산 0.
 * ★ `totalCost` 와 FX 를 **새로 만들지 않고** 성립한다.
 *
 * | 상황 | 반환 |
 * |---|---|
 * | `lineCost === null` | `null` → `—` |
 * | 대응 subtotal 없음 | `null` → `—` |
 * | subtotal `0` | `null` → `—` (0 으로 나누지 않는다) |
 * | `lineCost = 0`, subtotal > 0 | `"0%"` |
 */
export function computeCostSharePct(
  component: {
    readonly lineCost: string | null;
    readonly currency: string | null;
    readonly vatIncluded: boolean | null;
  },
  subtotals: readonly {
    readonly currency: string;
    readonly vatIncluded: boolean;
    readonly amount: string;
  }[],
): string | null {
  if (component.lineCost === null) return null;
  if (component.currency === null || component.vatIncluded === null) return null;

  const bucket = subtotals.find(
    (row) => row.currency === component.currency && row.vatIncluded === component.vatIncluded,
  );
  if (bucket === undefined) return null;

  const denominator = toDecimal(bucket.amount);
  if (isEqual(denominator, ZERO)) return null;

  const pct = multiply(divide(component.lineCost, denominator), '100');
  return `${toDecimalString(roundToScale(pct, COST_SHARE_SCALE, ROUNDING.HALF_UP))}%`;
}

// ═══════════════════════════════════════════════════════════════
// D-6 · D-31 — status 별 UI action matrix
// ═══════════════════════════════════════════════════════════════

/** 편집 가능한 상태 — 라인 CRUD·헤더 수정·일괄확정이 여기서만 렌더된다 (D-6). */
export const EDITABLE_STATUSES = ['DRAFT', 'REJECTED'] as const;

export interface BomActionVisibility {
  readonly canEditHeader: boolean;
  readonly canMutateLines: boolean;
  readonly canBulkConfirm: boolean;
  readonly canSubmit: boolean;
  readonly canApprove: boolean;
  readonly canReject: boolean;
  readonly canActivate: boolean;
  readonly canDeactivate: boolean;
  readonly canArchive: boolean;
  readonly canClone: boolean;
}

/**
 * ★ **status × permission 으로 UI control 노출을 정한다.**
 *
 * 전이 집합은 T07-5 `BOM_TRANSITIONS` 와 정확히 같다.
 * ⛔ 권한이 없으면 **`disabled` 가 아니라 렌더하지 않는다** (D-31).
 * ⛔ role 이름을 하드코딩하지 않는다 — permission 데이터만 본다.
 * ⛔ `REJECTED → DRAFT` 버튼 없음 · ⛔ `INACTIVE → activate` 없음 ·
 * ⛔ `ARCHIVED` mutation 없음 · ⛔ generic status PATCH 없음.
 */
export function resolveBomActions(
  status: string,
  permissions: readonly string[],
): BomActionVisibility {
  const has = (key: string) => permissions.includes(key);
  const editable = (EDITABLE_STATUSES as readonly string[]).includes(status);

  return {
    canEditHeader: editable && has('bom.update'),
    canMutateLines: editable && has('bom.update'),
    canBulkConfirm: editable && has('bom.update'),
    canSubmit: editable && has('bom.submit'),
    canApprove: status === 'PENDING_APPROVAL' && has('bom.approve'),
    canReject: status === 'PENDING_APPROVAL' && has('bom.approve'),
    canActivate: status === 'APPROVED' && has('bom.approve'),
    canDeactivate: status === 'ACTIVE' && has('bom.approve'),
    canArchive: editable && has('bom.approve'),
    // 복사·버전 생성은 같은 clone endpoint 다 — 어느 상태에서든 새 버전을 만든다.
    canClone: has('bom.create'),
  };
}

/** 진행률 바 — "확정 N / 전체 M" (D-31 ⑤). `SUGGESTED` 는 미확정이다. */
export function confirmProgress(lineCount: number, unconfirmedCount: number): string {
  return `확정 ${lineCount - unconfirmedCount} / 전체 ${lineCount}`;
}
