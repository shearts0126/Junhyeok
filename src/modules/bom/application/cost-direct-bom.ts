import { assertPermission, type ActorContext } from '@/modules/auth/application';
import {
  resolveEffectiveSupplierPrices,
  resolvePrimarySupplierSkus,
} from '@/modules/supplier/application';
import { toDecimal, toDecimalString, type Decimal } from '@/shared/decimal';

import {
  assertQuantityConsistency,
  computeCostSubtotals,
  computeRawLineCost,
  computeRawRequiredQty,
  deriveCostProvisionalReasons,
  projectProvisionalReason,
  toMoneyString,
  toRequiredQtyString,
  unionProvisionalReasons,
  type CostProvisionalReason,
  type CostSubtotal,
} from '../domain';

import { parseBomId } from './dto';
import { defaultBomClient } from './list-boms';
import { BOM_READ_PERMISSION } from './policy';
import { bomNotFound, type BomCostReadClient } from './refs';
import { EXPLODE_LINE_INCLUDE, type ComponentSkuRefView } from './views';

/**
 * 요청 BOM 의 **direct line 원가** (T07-7A) — direct-line costing engine.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-19(수량·정밀도) · §D-21(asOf) ·
 *    §D-23(SupplierSku 선택) · §D-24(price resolver) · §D-25(provisional) ·
 *    §D-26(currency) · §D-27(VAT) · §D-15(권한) ·
 *    `★ T07-7A cost boundary and quantity gap closure`(C-1 ~ C-9) ·
 *    `★ T07-7A direct cost arithmetic gap closure`(F-1 ~ F-11).
 *
 * ## ⛔ public API 가 아니다
 *
 * `GET /api/boms/{id}/cost` 와 public `CostResult` 는 **T07-7B 소유**다 (C-1).
 * 이 서비스는 그 route 가 소비할 **internal 결과**를 돌려주며, 여기서 HTTP
 * response 를 조립하지 않는다.
 *
 * ## ⛔ direct line 만 본다 (C-2)
 *
 * ```
 * P → B          B 에 asOf 유효 ACTIVE BOM (B → C) 이 있어도
 * ```
 * **`P → B` 까지만** 계산하고 `B` 를 direct component 로 취급해 `B` 자신의
 * `SupplierSku`·가격으로 원가를 낸다. `resolveEffectiveBom`·`explodeBom` 을
 * 호출하지 않는다. 하위 전개·반제품 원가 전파·D-20 집계는 **T07-7B** 다.
 *
 * ## caller 가 `Q` 와 `asOf` 를 확정한다 (C-4)
 *
 * ⛔ 이 서비스는 `requestedQty` 기본값 `"1"` 도, `businessDateOf(now)` 도
 *    스스로 정하지 않는다 — public query 기본값은 T07-7B route 의 몫이다.
 *    ⛔ `new Date()` 를 호출하지 않는다.
 *
 * ## 미확정이어도 selection 을 건너뛰지 않는다
 *
 * 수량이 `UNKNOWN`/`SUGGESTED` 라도 SupplierSku·가격 해석을 **그대로 수행**한다.
 * ① 한 라인에 복수 사유가 동시에 성립할 수 있어 전부 보존해야 하고(F-5),
 * ② 데이터 손상(대표 2건·가격 chain 2건)은 수량 상태와 무관하게 **409** 로
 *    드러나야 하기 때문이다. "어차피 provisional" 이라고 검사를 건너뛰지 않는다.
 *
 * ## N+1 을 만들지 않는다
 *
 * 쿼리는 **정확히 4회**다 — root header 1 · direct line batch 1 ·
 * 대표 SupplierSku batch 1 · 유효 가격 batch 1. 라인 수와 무관하다.
 *
 * ## read-only
 *
 * ⛔ write 0 · AuditLog 0 · 멱등 0 · advisory lock 0 · row lock 0.
 */

/** 한 direct line 의 원가 결과. ⛔ public DTO 가 아니다 (C-7). */
export interface DirectCostLine {
  readonly bomLineId: string;
  readonly lineNo: number;
  readonly componentSkuId: string;
  readonly componentSku: ComponentSkuRefView;
  readonly componentRole: string;
  readonly quantityStatus: string;
  readonly quantityPer: string | null;
  readonly lossRate: string | null;
  readonly uom: string;
  /** 6dp `ROUND_HALF_UP` 후 minimal 문자열. 미상이면 `null`. */
  readonly requiredQty: string | null;
  readonly supplierSkuId: string | null;
  readonly unitPrice: string | null;
  readonly currency: string | null;
  readonly vatIncluded: boolean | null;
  /** 4dp `ROUND_HALF_UP` 후 minimal 문자열. 산정 불가면 `null` (F-3). */
  readonly lineCost: string | null;
  /** ★ **실제 사유 전부** (F-5). 단수 projection 은 아래 필드다. */
  readonly provisionalReasons: readonly CostProvisionalReason[];
  /** ★ F-6 우선순위로 고른 단일 표시값. */
  readonly provisionalReason: CostProvisionalReason | null;
}

export interface DirectCostResult {
  readonly bomId: string;
  readonly parentSkuId: string;
  readonly requestedQty: string;
  readonly lines: readonly DirectCostLine[];
  /** ★ F-7 union — T07-7B 가 최종 `provisionalReasons[]` 를 만들 때 쓴다. */
  readonly provisionalReasons: readonly CostProvisionalReason[];
  readonly isProvisional: boolean;
  /** ★ F-8 raw 합계 후 4dp. direct level 소계이며 multi-level 이 아니다. */
  readonly subtotals: readonly CostSubtotal[];
}

export interface BomCostDependencies {
  readonly db?: BomCostReadClient;
}

export interface CostDirectBomInput {
  /** `Q` — ⛔ caller 가 명시한다. 서비스가 기본값을 넣지 않는다 (C-4). */
  readonly requestedQty: string;
  /** UTC 자정 date-only `Date`. ⛔ 서비스가 오늘로 채우지 않는다 (D-21). */
  readonly asOf: Date;
}

export async function costDirectBom(
  actor: ActorContext,
  rawBomId: string,
  input: CostDirectBomInput,
  dependencies: BomCostDependencies = {},
): Promise<DirectCostResult> {
  // ⚠️ 2차 권한 가드 — ⛔ ADMIN bypass 없음. ★ EXECUTIVE 도 `bom.read` 로 통과.
  //    ⛔ `bom.cost` 를 만들지 않고 supplier 권한도 요구하지 않는다 (D-15).
  assertPermission(actor, BOM_READ_PERMISSION);
  const bomId = parseBomId(rawBomId);
  const requestedQty = toDecimal(input.requestedQty);

  // `defaultBomClient()` 는 PrismaClient 를 그대로 준다 — supplier 델리게이트도 포함된다.
  const db = dependencies.db ?? ((await defaultBomClient()) as BomCostReadClient);

  // ── 쿼리 ① root — 요청한 exact header. ⛔ 다른 버전으로 재선택하지 않는다.
  //    ⛔ status 로 거르지 않는다 (C-2 · D-18 과 같은 판단).
  const root = await db.bomHeader.findUnique({
    where: { id: bomId },
    select: { id: true, parentSkuId: true, outputQty: true, overallLossRate: true },
  });
  if (root === null) throw bomNotFound(bomId);

  // ── 쿼리 ② direct line batch. ⛔ 하위 BOM 을 따라가지 않는다.
  const rows = await db.bomLine.findMany({
    where: { bomHeaderId: root.id },
    include: EXPLODE_LINE_INCLUDE,
    // 결정적 정렬 — DB 자연 순서에 의존하지 않는다.
    orderBy: [{ lineNo: 'asc' }, { id: 'asc' }],
  });

  // 수량·정합 판정과 raw 소요량을 먼저 만든다.
  const staged = rows.map((row) => {
    const quantityPer = row.quantityPer === null ? null : toDecimalString(row.quantityPer);
    // ★ 손상 정합은 완화하지 않는다 — 정상 UNKNOWN 만 통과시킨다 (E-5).
    assertQuantityConsistency({ quantityPer, quantityStatus: row.quantityStatus });

    return {
      row,
      quantityPer,
      lossRate: row.lossRate === null ? null : toDecimalString(row.lossRate),
      // ★ D-19 — Q 는 request 수량이고 outputQty 는 **root header** 의 것이다.
      rawRequiredQty: computeRawRequiredQty({
        parentQty: requestedQty,
        outputQty: root.outputQty,
        quantityPer,
        lossRate: row.lossRate === null ? null : toDecimalString(row.lossRate),
        overallLossRate:
          root.overallLossRate === null ? null : toDecimalString(root.overallLossRate),
        bomHeaderId: root.id,
        lineNo: row.lineNo,
      }),
    };
  });

  // ── 쿼리 ③ 대표 SupplierSku batch (D-23). 0 → null · 1 → 선택 · 2+ → 409.
  //    ★ 수량이 미상이어도 실행한다 — 복수 사유 보존 + 손상 노출.
  const primaries = await resolvePrimarySupplierSkus(db, {
    skuIds: staged.map((item) => item.row.componentSkuId),
    asOf: input.asOf,
  });

  // ── 쿼리 ④ 유효 승인 가격 batch (D-24) — 기존 resolver 를 그대로 재사용한다.
  //    ⛔ 새 price SQL 을 복제하지 않는다. pending 은 잡히지 않는다.
  const prices = await resolveEffectiveSupplierPrices(db, {
    supplierSkuIds: staged
      .map((item) => primaries.get(item.row.componentSkuId)?.id)
      .filter((id): id is string => id !== undefined),
    asOf: input.asOf,
  });

  const rawByLine: (Decimal | null)[] = [];
  const lines: DirectCostLine[] = staged.map((item) => {
    const primary = primaries.get(item.row.componentSkuId) ?? null;
    const price = primary === null ? null : (prices.get(primary.id) ?? null);

    // ★ F-1 — raw 소요량 × 저장된 unitPrice. 그 외 어떤 계수도 곱하지 않는다.
    const rawLineCost = computeRawLineCost({
      rawRequiredQty: item.rawRequiredQty,
      unitPrice: price?.unitPrice ?? null,
    });
    rawByLine.push(rawLineCost);

    const reasons = deriveCostProvisionalReasons({
      quantityStatus: item.row.quantityStatus,
      hasPrimarySupplierSku: primary !== null,
      hasEffectivePrice: price !== null,
    });

    return {
      bomLineId: item.row.id,
      lineNo: item.row.lineNo,
      componentSkuId: item.row.componentSkuId,
      componentSku: {
        id: item.row.componentSku.id,
        skuCode: item.row.componentSku.skuCode,
        skuName: item.row.componentSku.skuName,
        baseUom: item.row.componentSku.baseUom,
      },
      componentRole: item.row.componentRole,
      quantityStatus: item.row.quantityStatus,
      quantityPer: item.quantityPer,
      lossRate: item.lossRate,
      uom: item.row.uom,
      requiredQty: toRequiredQtyString(item.rawRequiredQty),
      // ★ 대표가 없으면 가격 metadata 도 전부 null 이다.
      supplierSkuId: primary?.id ?? null,
      // ⛔ price row 의 값을 그대로 쓴다 — SupplierSku.currency 로 덮지 않는다.
      unitPrice: price === null ? null : toDecimalString(price.unitPrice),
      currency: price?.currency ?? null,
      vatIncluded: price?.vatIncluded ?? null,
      // ★ F-2 — 4dp HALF_UP 후 minimal 문자열.
      lineCost: toMoneyString(rawLineCost),
      provisionalReasons: reasons,
      provisionalReason: projectProvisionalReason(reasons),
    };
  });

  return {
    bomId: root.id,
    parentSkuId: root.parentSkuId,
    requestedQty: toDecimalString(requestedQty),
    lines,
    // ★ F-7 — 단수 projection 이 아니라 **실제 사유 집합**의 union 이다.
    provisionalReasons: unionProvisionalReasons(lines.map((line) => line.provisionalReasons)),
    isProvisional: lines.some((line) => line.provisionalReasons.length > 0),
    // ★ F-8 — raw 를 먼저 합하고 마지막에 4dp. ⛔ 반올림된 lineCost 재합산 금지.
    subtotals: computeCostSubtotals(
      lines.map((line, index) => ({
        currency: line.currency,
        vatIncluded: line.vatIncluded,
        rawLineCost: rawByLine[index] ?? null,
      })),
    ),
  };
}
