import { assertPermission, type ActorContext } from '@/modules/auth/application';
import {
  resolveEffectiveSupplierPrices,
  resolvePrimarySupplierSkus,
} from '@/modules/supplier/application';
import { businessDateOf } from '@/shared/business-date';
import { toDecimal, toDecimalString, type Decimal } from '@/shared/decimal';

import {
  assertQuantityConsistency,
  bomCycleDetected,
  bomMaxLevelExceeded,
  compareCostComponents,
  computeCostSubtotals,
  computeRawLineCost,
  computeRawRequiredQty,
  deriveTerminalCostReasons,
  projectProvisionalReason,
  sumKnownDecimals,
  toMoneyString,
  toRequiredQtyString,
  unionProvisionalReasons,
  BOM_MAX_LEVEL,
  type CostComponentSortKey,
  type CostProvisionalReason,
  type CostSubtotal,
} from '../domain';

import { parseBomId, parseDateOnly, toDateOnlyString, type CostBomQuery } from './dto';
import { defaultBomClient } from './list-boms';
import { BOM_READ_PERMISSION } from './policy';
import { bomNotFound, type BomCostReadClient } from './refs';
import { resolveEffectiveBoms } from './resolve-effective-bom';
import { EXPLODE_LINE_INCLUDE, type ExplodeLineRow, type SkuRefView } from './views';

/**
 * `GET /api/boms/{id}/cost` — 다단계 BOM 원가 roll-up (T07-7B).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-14(`CostResult`) · §D-15(권한) ·
 *    §D-19(수량 공식) · §D-20(집계) · §D-21(asOf) · §D-22(하위 resolver) ·
 *    §D-23(SupplierSku) · §D-24(price) · §D-25~§D-27(provisional·통화·VAT) ·
 *    `★ T07-7A cost boundary and quantity gap closure`(C-1 ~ C-9) ·
 *    `★ T07-7A direct cost arithmetic gap closure`(F-1 ~ F-13) ·
 *    `★ T07-7B multi-level roll-up gap closure`(R-1 ~ R-23).
 *
 * ## ★ terminal cost-bearing occurrence 만 원가를 낳는다 (R-1)
 *
 * ```
 * P → B → C        B 에 asOf 유효 ACTIVE BOM (B → C) 이 있다
 * ```
 *
 * | 노드 | 역할 |
 * |---|---|
 * | `B` | **intermediate** — 수량만 아래로 전달한다 |
 * | `C` | **terminal** — 실제 원가가 여기서 발생한다 |
 *
 * `B` 는 자체 `SupplierSku`·매입가를 **쓰지 않고**(⛔ 조회조차 하지 않는다, R-4)
 * `components[]` 에도 **넣지 않는다**(R-6). ⛔ `B` 매입가 `1000` + `C` 재료비
 * `600` = `1600` 은 **이중계상**이며 정답은 `600` 이다 (R-2).
 *
 * ★ 판정 기준은 `itemType`·`componentRole` 이 아니라 **asOf 유효 child BOM 의
 *   존재 여부**다. child BOM 이 없으면 그 노드 자신이 terminal 이다 (R-3).
 *
 * ## ★ 수량 미확정은 **경로를 상속**한다 (R-12)
 *
 * root → terminal 경로상의 어느 `BomLine` 이라도 `quantityStatus !== CONFIRMED`
 * 이면 그 terminal 은 `QTY_UNCONFIRMED` 다 (path-level OR). 반대로 intermediate
 * 의 `NO_PRIMARY_SUPPLIER`·`NO_EFFECTIVE_PRICE` 는 **전파하지 않는다** (R-13) —
 * 애초에 조회하지 않는 사실이기 때문이다.
 *
 * ## ★ 집계는 raw partial sum 이다 (R-8·R-10·R-11)
 *
 * `(componentSkuId, uom)` 별로 **known raw 값만** 더한 뒤 마지막에 한 번
 * 반올림한다. ⛔ 반올림된 occurrence 값을 재합산하지 않는다. 전부 `null` 이면
 * `null` 이고, 혼합이면 **known partial** + `QTY_UNCONFIRMED` 다.
 *
 * ## N+1 을 만들지 않는다 (R-23 §23)
 *
 * ```
 * ① root header                                        1회
 * ② level 별 라인 batch + 유효 BOM batch               2 × depth
 * ③ terminal SKU 대표 SupplierSku batch                 1회
 * ④ 선택된 SupplierSku 유효 가격 batch                   1회
 * ```
 *
 * node 수와 무관하다. ⛔ occurrence 마다 단건 resolver 를 부르지 않는다.
 *
 * ## read-only
 *
 * ⛔ write 0 · AuditLog 0 · 멱등 0 · advisory lock 0 · row lock 0.
 */

// ═══════════════════════════════════════════════════════════════
// public DTO (D-14 `CostResult` · exact keys)
// ═══════════════════════════════════════════════════════════════

/**
 * 집계된 구성품 한 행 — **exact 11 키** (D-14).
 *
 * ★ `componentSku` 는 **3키**다 — `ExplodedNode` 와 달리 `baseUom` 이 없다.
 * ★ `requiredQty` 는 `string | null` 이다 (R-9 가 D-14 의 `string` 을 좁게
 *   supersede). ⛔ 키를 추가·삭제하지 않는다.
 */
export interface CostComponentView {
  readonly componentSkuId: string;
  readonly componentSku: SkuRefView;
  /** ★ terminal occurrence 들의 **최소** level (R-17 · D-20). */
  readonly level: number;
  /** 6dp `ROUND_HALF_UP` 후 minimal 문자열. known 이 하나도 없으면 `null`. */
  readonly requiredQty: string | null;
  readonly uom: string;
  readonly supplierSkuId: string | null;
  readonly unitPrice: string | null;
  readonly currency: string | null;
  readonly vatIncluded: boolean | null;
  /** 4dp `ROUND_HALF_UP` 후 minimal 문자열. known 이 하나도 없으면 `null`. */
  readonly lineCost: string | null;
  readonly provisionalReason: CostProvisionalReason | null;
}

/**
 * `CostResult` — **exact 9 키**. `requestId` 는 route 가 붙인다(기존 규약).
 *
 * ⛔ 단일 `totalCost` 필드를 두지 않는다 (D-26).
 * ⛔ `rawRequiredQty`·`rawLineCost`·`actualReasons`·`lineNoPath` 같은 내부값을
 *    public 에 노출하지 않는다.
 */
export interface CostResultView {
  readonly bomId: string;
  readonly parentSkuId: string;
  /** `YYYY-MM-DD` — 이 request 가 쓴 단일 기준일 (D-21). */
  readonly asOf: string;
  readonly requestedQty: string;
  readonly isProvisional: boolean;
  readonly provisionalReasons: readonly CostProvisionalReason[];
  readonly components: readonly CostComponentView[];
  readonly subtotals: readonly CostSubtotal[];
}

export interface CostBomDependencies {
  readonly db?: BomCostReadClient;
}

// ═══════════════════════════════════════════════════════════════
// traversal 내부 타입
// ═══════════════════════════════════════════════════════════════

/** 한 header 를 전개하기 위한 작업 단위 — BFS frontier 의 원소. */
interface CostTask {
  readonly bomHeaderId: string;
  /** 이 header 산출물의 필요 수량 `Q` (raw). `null` = 상위가 미상. */
  readonly parentQty: Decimal | null;
  /** 조상 skuId 배열 — 순환 판정용. */
  readonly path: readonly string[];
  /** ★ R-12 — 여기까지 오는 경로에 미확정 수량이 있었는가 (path-level OR). */
  readonly pathQtyUnconfirmed: boolean;
}

/** 원가를 낳는 말단 occurrence. ⛔ intermediate 는 여기에 들어오지 않는다. */
interface TerminalOccurrence {
  readonly componentSkuId: string;
  readonly componentSku: SkuRefView;
  readonly uom: string;
  readonly level: number;
  readonly rawRequiredQty: Decimal | null;
  /** ★ 자신 + 조상 전체를 OR 한 결과 (R-12). */
  readonly qtyUnconfirmed: boolean;
}

/** 라인 + 그 라인이 만들 raw 수량. resolver 이전 단계의 중간 산물이다. */
interface PendingCostLine {
  readonly row: ExplodeLineRow;
  readonly task: CostTask;
  readonly raw: Decimal | null;
  /** 조상 OR 자기 자신. */
  readonly qtyUnconfirmed: boolean;
}

// ═══════════════════════════════════════════════════════════════
// service
// ═══════════════════════════════════════════════════════════════

export async function costBom(
  actor: ActorContext,
  rawBomId: string,
  query: CostBomQuery,
  dependencies: CostBomDependencies = {},
): Promise<CostResultView> {
  // ⚠️ 2차 권한 가드 — proxy 통과를 신뢰하지 않는다. ⛔ ADMIN bypass 없음.
  //    ★ EXECUTIVE 도 `bom.read` 로 통과한다. ⛔ `bom.cost` 를 만들지 않고
  //    supplier 계열 permission 도 요구하지 않는다 (D-15).
  assertPermission(actor, BOM_READ_PERMISSION);
  const bomId = parseBomId(rawBomId);

  // ★ asOf 는 **request 시작 시 한 번** 확정해 전 계층에 그대로 넘긴다 (D-21).
  //   effective BOM · SupplierSku · Price 가 모두 이 값을 쓴다.
  //   ⛔ 재귀 도중에 오늘 날짜를 다시 읽지 않는다.
  const asOf = parseDateOnly(query.asOf ?? businessDateOf(new Date()));
  const requestedQty = toDecimal(query.qty);

  const db = dependencies.db ?? ((await defaultBomClient()) as BomCostReadClient);

  // ── 쿼리 ① root — 요청한 exact header (R-23 G11).
  //    ⛔ asOf 로 다른 sibling 버전을 재선택하지 않는다. ⛔ status 로 거르지 않는다.
  const root = await db.bomHeader.findUnique({
    where: { id: bomId },
    select: { id: true, parentSkuId: true },
  });
  if (root === null) throw bomNotFound(bomId);

  // ── phase A — traversal. terminal occurrence 만 모은다.
  const terminals = await collectTerminals(db, root.id, root.parentSkuId, requestedQty, asOf);

  // ── phase B — terminal SKU 의 공급처·가격을 batch 로 해석한다.
  //    ★ 수량이 미상이어도 실행한다 — 손상(2건 이상)이 409 로 드러나야 하므로
  //      "어차피 원가 null" 이라고 건너뛰지 않는다 (R-10 §10).
  const primaries = await resolvePrimarySupplierSkus(db, {
    skuIds: terminals.map((item) => item.componentSkuId),
    asOf,
  });
  const prices = await resolveEffectiveSupplierPrices(db, {
    supplierSkuIds: [...new Set(terminals.map((item) => item.componentSkuId))]
      .map((skuId) => primaries.get(skuId)?.id)
      .filter((id): id is string => id !== undefined),
    asOf,
  });

  // ── phase C·D — raw 원가 계산 + D-20 집계.
  const components = aggregateTerminals(terminals, primaries, prices);

  // ── phase E — subtotal + public projection.
  return {
    bomId: root.id,
    parentSkuId: root.parentSkuId,
    asOf: toDateOnlyString(asOf),
    requestedQty: toDecimalString(requestedQty),
    // ★ R-15 — 단수 projection 모음이 아니라 **실제 사유 집합**의 union 이다.
    isProvisional: components.some((entry) => entry.reasons.length > 0),
    provisionalReasons: unionProvisionalReasons(components.map((entry) => entry.reasons)),
    components: components.map((entry) => entry.view),
    // ★ R-11 — component 와 같은 raw 값을 쓴다. ⛔ 반올림된 lineCost 재합산 금지.
    subtotals: computeCostSubtotals(
      components.map((entry) => ({
        currency: entry.view.currency,
        vatIncluded: entry.view.vatIncluded,
        rawLineCost: entry.rawLineCost,
      })),
    ),
  };
}

// ═══════════════════════════════════════════════════════════════
// phase A — traversal
// ═══════════════════════════════════════════════════════════════

/**
 * BFS 로 내려가며 **terminal occurrence** 만 수집한다 (R-1).
 *
 * T07-6 `explodeBom` 과 같은 frontier 구조다 — level 당 쿼리 정확히 2회
 * (라인 batch + 유효 BOM batch). 차이는 **무엇을 결과로 남기는가** 뿐이다.
 *
 * | 하위 유효 BOM | 처리 |
 * |---|---|
 * | 0건 | **terminal** — 원가 대상으로 수집 |
 * | 1건 | **intermediate** — 수집하지 않고 다음 frontier 로 |
 * | 2건+ | **409 `BOM_EFFECTIVE_CONFLICT`** (resolver 가 던진다) |
 */
async function collectTerminals(
  db: BomCostReadClient,
  rootHeaderId: string,
  rootParentSkuId: string,
  requestedQty: Decimal,
  asOf: Date,
): Promise<TerminalOccurrence[]> {
  const terminals: TerminalOccurrence[] = [];
  let frontier: CostTask[] = [
    {
      bomHeaderId: rootHeaderId,
      parentQty: requestedQty,
      path: [rootParentSkuId],
      pathQtyUnconfirmed: false,
    },
  ];

  for (let level = 1; frontier.length > 0; level += 1) {
    const pending = await collectCostLines(db, frontier);
    if (pending.length === 0) break;

    // ★ 깊이는 **실제 node 가 생길 때** 판정한다 (T07-6 과 같은 노드 기준).
    //   ⛔ 조용히 절단하지 않는다 — 요청 전체가 422 로 실패한다 (R-23 G12).
    //   ⚠️ 순환 판정은 `collectCostLines` 안에서 **먼저** 일어난다 (D-13 순서).
    if (level > BOM_MAX_LEVEL) {
      const deepest = pending[0];
      throw bomMaxLevelExceeded(
        [...(deepest?.task.path ?? []), deepest?.row.componentSkuId ?? ''],
        BOM_MAX_LEVEL,
      );
    }

    // 유효 하위 BOM batch — terminal / intermediate 를 여기서 가른다.
    const resolved = await resolveEffectiveBoms(db, {
      parentSkuIds: pending.map((item) => item.row.componentSkuId),
      asOf,
    });

    const nextFrontier: CostTask[] = [];
    for (const item of pending) {
      const childBom = resolved.get(item.row.componentSkuId) ?? null;

      if (childBom === null) {
        // ★ terminal — 여기서 원가가 발생한다 (R-1).
        terminals.push({
          componentSkuId: item.row.componentSkuId,
          componentSku: {
            id: item.row.componentSku.id,
            skuCode: item.row.componentSku.skuCode,
            skuName: item.row.componentSku.skuName,
          },
          uom: item.row.uom,
          level,
          rawRequiredQty: item.raw,
          qtyUnconfirmed: item.qtyUnconfirmed,
        });
        continue;
      }

      // ★ intermediate — ⛔ 수집하지 않는다. ⛔ 공급처·가격을 조회하지 않는다
      //   (R-4). 수량과 미확정 여부만 아래로 전달한다.
      nextFrontier.push({
        bomHeaderId: childBom.id,
        // ★ 반올림 전 raw 를 넘긴다 (T07-6 E-7 과 같은 원칙).
        parentQty: item.raw,
        path: [...item.task.path, item.row.componentSkuId],
        // ★ R-12 — 경로 OR 는 아래로 계속 상속된다.
        pathQtyUnconfirmed: item.qtyUnconfirmed,
      });
    }
    frontier = nextFrontier;
  }

  return terminals;
}

/**
 * 이 level 부모들의 라인을 **한 번에** 읽고, 순환·정합을 판정하고, raw 수량과
 * 경로 미확정 플래그를 계산한다.
 *
 * ⛔ N+1 금지 — `bomHeaderId IN (...)` 한 번이다.
 */
async function collectCostLines(
  db: BomCostReadClient,
  frontier: readonly CostTask[],
): Promise<PendingCostLine[]> {
  const headerIds = [...new Set(frontier.map((task) => task.bomHeaderId))];
  const rows = await db.bomLine.findMany({
    where: { bomHeaderId: { in: headerIds } },
    include: EXPLODE_LINE_INCLUDE,
    orderBy: [{ bomHeaderId: 'asc' }, { lineNo: 'asc' }],
  });
  if (rows.length === 0) return [];

  const linesByHeader = new Map<string, ExplodeLineRow[]>();
  for (const row of rows) {
    const bucket = linesByHeader.get(row.bomHeaderId);
    if (bucket === undefined) linesByHeader.set(row.bomHeaderId, [row]);
    else bucket.push(row);
  }

  const pending: PendingCostLine[] = [];
  for (const task of frontier) {
    for (const row of linesByHeader.get(task.bomHeaderId) ?? []) {
      // ★ 순환은 **현재 경로**로만 판정한다 — 다이아몬드는 순환이 아니다 (D-13).
      //   ⛔ 전역 visited 로 두 번째 경로를 지우지 않는다 (D-20 집계가 두
      //      occurrence 를 모두 세야 하기 때문이다).
      const seen = task.path.indexOf(row.componentSkuId);
      if (seen >= 0) {
        throw bomCycleDetected([...task.path.slice(seen), row.componentSkuId]);
      }

      // ★ 손상 정합은 완화하지 않는다 — 정상 UNKNOWN 만 통과시킨다.
      const quantityPer = row.quantityPer === null ? null : toDecimalString(row.quantityPer);
      assertQuantityConsistency({ quantityPer, quantityStatus: row.quantityStatus });

      pending.push({
        row,
        task,
        raw: computeRawRequiredQty({
          parentQty: task.parentQty,
          outputQty: row.bomHeader.outputQty,
          quantityPer,
          lossRate: row.lossRate === null ? null : toDecimalString(row.lossRate),
          overallLossRate:
            row.bomHeader.overallLossRate === null
              ? null
              : toDecimalString(row.bomHeader.overallLossRate),
          bomHeaderId: row.bomHeaderId,
          lineNo: row.lineNo,
        }),
        // ★ R-12 — 조상이 미확정이었으면 자기 라인이 CONFIRMED 여도 미확정이다.
        //   F-12 와 같은 판정(`!== 'CONFIRMED'`)을 경로로 확장한 것이다.
        qtyUnconfirmed: task.pathQtyUnconfirmed || row.quantityStatus !== 'CONFIRMED',
      });
    }
  }
  return pending;
}

// ═══════════════════════════════════════════════════════════════
// phase C·D — raw 원가 + D-20 집계
// ═══════════════════════════════════════════════════════════════

type PrimaryMap = Awaited<ReturnType<typeof resolvePrimarySupplierSkus>>;
type PriceMap = Awaited<ReturnType<typeof resolveEffectiveSupplierPrices>>;

/** public 행 + 소계가 쓸 raw 금액 + 사유 집합. */
interface AggregatedComponent {
  readonly view: CostComponentView;
  /** ⛔ public 에 나가지 않는다 — 소계 산술 전용 (R-11). */
  readonly rawLineCost: Decimal | null;
  /** ⛔ public 에 나가지 않는다 — top-level union 전용 (R-15). */
  readonly reasons: readonly CostProvisionalReason[];
}

/**
 * terminal occurrence 를 `(componentSkuId, uom)` 로 묶어 public 행을 만든다
 * (R-7 · D-20).
 *
 * ★ 공급처·가격 metadata 는 `(skuId, asOf)` 로 결정되므로 같은 group 의 모든
 *   occurrence 가 **필연적으로 동일**하다 (R-16). ⛔ weighted average · ⛔ path
 *   별 임의 선택 · ⛔ mismatch 처리 규칙을 만들지 않는다.
 */
function aggregateTerminals(
  terminals: readonly TerminalOccurrence[],
  primaries: PrimaryMap,
  prices: PriceMap,
): AggregatedComponent[] {
  interface Bucket {
    readonly componentSkuId: string;
    readonly componentSku: SkuRefView;
    readonly uom: string;
    level: number;
    readonly rawQtys: (Decimal | null)[];
    readonly rawCosts: (Decimal | null)[];
    readonly reasonSets: (readonly CostProvisionalReason[])[];
  }

  const buckets = new Map<string, Bucket>();

  for (const occurrence of terminals) {
    const primary = primaries.get(occurrence.componentSkuId) ?? null;
    const price = primary === null ? null : (prices.get(primary.id) ?? null);

    // ★ F-1 — raw 소요량 × 저장된 unitPrice. ⛔ packQuantity·purchaseUom·VAT·
    //   환율 어느 것도 곱하거나 나누지 않는다 (TC-BOM-009 · F-4).
    const rawLineCost = computeRawLineCost({
      rawRequiredQty: occurrence.rawRequiredQty,
      unitPrice: price?.unitPrice ?? null,
    });

    // ★ R-12 — 수량 사유는 **경로 OR** 결과를 쓴다. 공급처·가격 사유는 이
    //   terminal 자신의 사실이다 (R-13).
    const reasons = deriveTerminalCostReasons({
      qtyUnconfirmed: occurrence.qtyUnconfirmed,
      hasPrimarySupplierSku: primary !== null,
      hasEffectivePrice: price !== null,
    });

    const key = `${occurrence.componentSkuId} ${occurrence.uom}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, {
        componentSkuId: occurrence.componentSkuId,
        componentSku: occurrence.componentSku,
        uom: occurrence.uom,
        level: occurrence.level,
        rawQtys: [occurrence.rawRequiredQty],
        rawCosts: [rawLineCost],
        reasonSets: [reasons],
      });
    } else {
      // ★ R-17 — 합산 행의 level 은 **등장한 최소 level** 이다 (D-20).
      bucket.level = Math.min(bucket.level, occurrence.level);
      bucket.rawQtys.push(occurrence.rawRequiredQty);
      bucket.rawCosts.push(rawLineCost);
      bucket.reasonSets.push(reasons);
    }
  }

  return (
    [...buckets.values()]
      .map((bucket) => {
        const primary = primaries.get(bucket.componentSkuId) ?? null;
        const price = primary === null ? null : (prices.get(primary.id) ?? null);

        // ★ R-8·R-10 — known raw 값만 더하고 **마지막에 한 번만** 반올림한다.
        //   ⛔ 반올림된 occurrence 값을 재합산하지 않는다.
        const rawRequiredQty = sumKnownDecimals(bucket.rawQtys);
        const rawLineCost = sumKnownDecimals(bucket.rawCosts);
        const reasons = unionProvisionalReasons(bucket.reasonSets);

        return {
          rawLineCost,
          reasons,
          view: {
            componentSkuId: bucket.componentSkuId,
            componentSku: bucket.componentSku,
            level: bucket.level,
            requiredQty: toRequiredQtyString(rawRequiredQty),
            uom: bucket.uom,
            supplierSkuId: primary?.id ?? null,
            // ⛔ price row 값을 그대로 쓴다 — SupplierSku.currency 로 덮지 않는다.
            unitPrice: price === null ? null : toDecimalString(price.unitPrice),
            currency: price?.currency ?? null,
            vatIncluded: price?.vatIncluded ?? null,
            lineCost: toMoneyString(rawLineCost),
            provisionalReason: projectProvisionalReason(reasons),
          },
        };
      })
      // ★ R-18 — level → skuCode → skuId → uom, 전부 code-point 비교.
      //   집계 키 전체를 덮으므로 동률이 존재할 수 없다.
      .sort((a, b) => compareCostComponents(sortKeyOf(a.view), sortKeyOf(b.view)))
  );
}

function sortKeyOf(view: CostComponentView): CostComponentSortKey {
  return {
    level: view.level,
    skuCode: view.componentSku.skuCode,
    componentSkuId: view.componentSkuId,
    uom: view.uom,
  };
}
