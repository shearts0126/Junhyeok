import {
  resolveEffectiveSupplierPriceOutcomes,
  resolvePrimarySupplierSkuOutcomes,
} from '@/modules/supplier/application';
import { toDecimal, toDecimalString, type Decimal } from '@/shared/decimal';
import { AppError, ERROR_CODES } from '@/shared/errors';

import {
  assertQuantityConsistency,
  bomCycleDetected,
  computeCostSubtotals,
  computeRawLineCost,
  computeRawRequiredQty,
  deriveTerminalCostReasons,
  sumKnownDecimals,
  unionProvisionalReasons,
  BOM_MAX_LEVEL,
  type CostProvisionalReason,
  type CostSubtotal,
} from '../domain';

import { type BomCostReadClient } from './refs';
import { resolveEffectiveBomOutcomes } from './resolve-effective-bom';
import { EXPLODE_LINE_INCLUDE, type ExplodeLineRow } from './views';

/**
 * **여러 root BOM 의 원가를 한 번에 · root 별 실패 격리** (T07-8).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md`
 *    `★ T07-7B multi-level roll-up gap closure`(R-1 ~ R-23) ·
 *    `★ T07-8 BOM UI read-model gap closure`(U8-6 ~ U8-10) ·
 *    `★ T07-8 list reference-cost fault isolation remediation`(R8-1 ~ R8-18).
 *
 * ## 두 가지를 동시에 만족한다
 *
 * **① N+1 금지 (U8-8)** — 모든 root 를 같은 frontier 에 올려 level 당 쿼리 2회,
 * 공급처·가격 각 1회. 쿼리 수가 root 수(1 → 50)에 **선형 증가하지 않는다.**
 *
 * **② root 별 실패 격리 (R8-2)** — 한 root 의 무결성 오류가 **다른 root 의 결과를
 * 죽이지 않는다.** 목록은 200 이고 그 root 만 `UNAVAILABLE` 이다.
 *
 * ## ⛔ strict resolver 를 바깥에서 catch 하지 않는다 (R8-1)
 *
 * strict resolver 는 batch 안의 첫 충돌에서 즉시 throw 하므로, 그것을 바깥에서
 * `try/catch` 하면 **어느 root 가 그 손상 dependency 를 썼는지 알 수 없어** 결국
 * 전체 실패가 된다. 그래서 `*Outcomes` low-level reader 를 쓴다 — 같은 batch
 * 쿼리에 key 별 판정만 노출한 것이며, strict resolver 는 그 위의 얇은 wrapper 라
 * **기존 동작이 한 글자도 바뀌지 않는다** (R8-11).
 *
 * ## ⛔ catch-all 금지 (R8-7)
 *
 * 격리 대상은 **exact 7-code whitelist** 뿐이다. DB 연결 실패·프로그래밍 버그·
 * 알 수 없는 예외는 **그대로 위로 던져** 요청 전체를 실패시킨다.
 */

/** ★ R8-6 — 목록에서 격리 가능한 무결성 오류 **exact 7종**. ⛔ 늘리지 않는다. */
export const LIST_REFERENCE_COST_INTEGRITY_ERROR_CODES = [
  ERROR_CODES.BOM_CYCLE_DETECTED,
  ERROR_CODES.BOM_MAX_LEVEL_EXCEEDED,
  ERROR_CODES.BOM_EFFECTIVE_CONFLICT,
  ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT,
  ERROR_CODES.SUPPLIER_PRICE_CHAIN_CONFLICT,
  ERROR_CODES.BOM_QTY_STATUS_MISMATCH,
  ERROR_CODES.BOM_QTY_INVALID,
] as const;

export type ListReferenceCostIntegrityErrorCode =
  (typeof LIST_REFERENCE_COST_INTEGRITY_ERROR_CODES)[number];

/**
 * ★ **R8-7 — whitelist membership 판정.**
 *
 * ⛔ `catch (e) { return UNAVAILABLE }` 를 만들지 않기 위해 존재한다.
 *    이 함수가 `false` 면 오류는 **그대로 위로 던져진다.**
 */
export function isListReferenceCostIntegrityError(
  error: unknown,
): error is AppError & { code: ListReferenceCostIntegrityErrorCode } {
  // ⚠️ `AppError` 로 판정한다 — `ConflictError` 는 `DomainError` 를 상속하지
  //    **않으므로**(둘 다 `AppError` 의 형제) `DomainError` 로 좁히면 409 계열
  //    3종(effective·supplier·price conflict)이 통째로 빠진다.
  if (!(error instanceof AppError)) return false;
  return (LIST_REFERENCE_COST_INTEGRITY_ERROR_CODES as readonly string[]).includes(error.code);
}

/** 한 root 의 원가 사실 — `AVAILABLE` / `UNAVAILABLE` 판별 union (R8-3). */
export type BomCostFacts =
  | {
      readonly status: 'AVAILABLE';
      readonly subtotals: readonly CostSubtotal[];
      readonly isProvisional: boolean;
      readonly provisionalReasons: readonly CostProvisionalReason[];
    }
  | {
      readonly status: 'UNAVAILABLE';
      readonly errorCode: ListReferenceCostIntegrityErrorCode;
    };

export interface CostBomsBatchInput {
  readonly bomHeaderIds: readonly string[];
  /** ★ 모든 root 가 **같은 asOf** 를 쓴다 (D-21). */
  readonly asOf: Date;
  /** 목록은 `"1"` 이다 (U8-6). */
  readonly requestedQty: string;
}

interface BatchTask {
  readonly rootBomId: string;
  readonly bomHeaderId: string;
  readonly parentQty: Decimal | null;
  readonly path: readonly string[];
  readonly pathQtyUnconfirmed: boolean;
}

interface TerminalOccurrence {
  readonly rootBomId: string;
  readonly componentSkuId: string;
  readonly uom: string;
  readonly rawRequiredQty: Decimal | null;
  readonly qtyUnconfirmed: boolean;
}

interface PendingLine {
  readonly row: ExplodeLineRow;
  readonly task: BatchTask;
  readonly raw: Decimal | null;
  readonly qtyUnconfirmed: boolean;
}

export async function costBomsBatch(
  db: BomCostReadClient,
  input: CostBomsBatchInput,
): Promise<Map<string, BomCostFacts>> {
  const rootIds = [...new Set(input.bomHeaderIds)];
  const result = new Map<string, BomCostFacts>();
  if (rootIds.length === 0) return result;

  /** root 별 실패 기록. 여기 있으면 그 root 는 더 이상 계산하지 않는다 (R8-15). */
  const failed = new Map<string, ListReferenceCostIntegrityErrorCode>();
  const failRoot = (rootBomId: string, code: ListReferenceCostIntegrityErrorCode): void => {
    if (!failed.has(rootBomId)) failed.set(rootBomId, code);
  };

  const requestedQty = toDecimal(input.requestedQty);
  const terminals = await collectTerminals(db, rootIds, requestedQty, input.asOf, failRoot, failed);

  // ── terminal SKU 의 대표 공급조건 — ⛔ strict resolver 를 catch 하지 않는다.
  const primaryOutcomes = await resolvePrimarySupplierSkuOutcomes(db, {
    skuIds: terminals.map((item) => item.componentSkuId),
    asOf: input.asOf,
  });

  // ★ R8-8 — ERROR 인 SKU 를 쓰는 **모든 active root** 에 fan-out.
  for (const occurrence of terminals) {
    const outcome = primaryOutcomes.get(occurrence.componentSkuId);
    if (outcome?.status === 'ERROR') {
      failRoot(occurrence.rootBomId, ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT);
    }
  }

  const selectedSupplierSkuIds = [
    ...new Set(
      terminals
        .filter((item) => !failed.has(item.rootBomId))
        .map((item) => {
          const outcome = primaryOutcomes.get(item.componentSkuId);
          return outcome?.status === 'OK' ? outcome.value?.id : undefined;
        })
        .filter((id): id is string => id !== undefined),
    ),
  ];

  const priceOutcomes = await resolveEffectiveSupplierPriceOutcomes(db, {
    supplierSkuIds: selectedSupplierSkuIds,
    asOf: input.asOf,
  });

  // ★ R8-8 — 가격 chain 손상도 그 dependency 를 쓰는 root 들에만 fan-out.
  for (const occurrence of terminals) {
    if (failed.has(occurrence.rootBomId)) continue;
    const primary = primaryOutcomes.get(occurrence.componentSkuId);
    if (primary?.status !== 'OK' || primary.value === null) continue;
    if (priceOutcomes.get(primary.value.id)?.status === 'ERROR') {
      failRoot(occurrence.rootBomId, ERROR_CODES.SUPPLIER_PRICE_CHAIN_CONFLICT);
    }
  }

  // ── root 별 집계.
  const byRoot = new Map<string, TerminalOccurrence[]>();
  for (const rootId of rootIds) byRoot.set(rootId, []);
  for (const occurrence of terminals) byRoot.get(occurrence.rootBomId)?.push(occurrence);

  for (const [rootBomId, occurrences] of byRoot) {
    const failure = failed.get(rootBomId);
    if (failure !== undefined) {
      result.set(rootBomId, { status: 'UNAVAILABLE', errorCode: failure });
      continue;
    }

    const buckets = new Map<
      string,
      {
        componentSkuId: string;
        raws: (Decimal | null)[];
        reasonSets: (readonly CostProvisionalReason[])[];
      }
    >();

    for (const occurrence of occurrences) {
      const primaryOutcome = primaryOutcomes.get(occurrence.componentSkuId);
      const primary = primaryOutcome?.status === 'OK' ? primaryOutcome.value : null;
      const priceOutcome = primary === null ? undefined : priceOutcomes.get(primary.id);
      const price = priceOutcome?.status === 'OK' ? priceOutcome.value : null;

      const rawLineCost = computeRawLineCost({
        rawRequiredQty: occurrence.rawRequiredQty,
        unitPrice: price?.unitPrice ?? null,
      });
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
          raws: [rawLineCost],
          reasonSets: [reasons],
        });
      } else {
        bucket.raws.push(rawLineCost);
        bucket.reasonSets.push(reasons);
      }
    }

    const subtotalInputs = [...buckets.values()].map((bucket) => {
      const primaryOutcome = primaryOutcomes.get(bucket.componentSkuId);
      const primary = primaryOutcome?.status === 'OK' ? primaryOutcome.value : null;
      const priceOutcome = primary === null ? undefined : priceOutcomes.get(primary.id);
      const price = priceOutcome?.status === 'OK' ? priceOutcome.value : null;
      return {
        currency: price?.currency ?? null,
        vatIncluded: price?.vatIncluded ?? null,
        rawLineCost: sumKnownDecimals(bucket.raws),
      };
    });

    const reasonSets = [...buckets.values()].map((bucket) =>
      unionProvisionalReasons(bucket.reasonSets),
    );

    result.set(rootBomId, {
      status: 'AVAILABLE',
      subtotals: computeCostSubtotals(subtotalInputs),
      isProvisional: reasonSets.some((reasons) => reasons.length > 0),
      provisionalReasons: unionProvisionalReasons(reasonSets),
    });
  }

  return result;
}

/**
 * 모든 root 를 동시에 전개해 terminal occurrence 를 모은다.
 *
 * 무결성 오류는 **그것을 실제로 밟은 root 에만** 귀속시킨다 (R8-9·R8-12).
 */
async function collectTerminals(
  db: BomCostReadClient,
  rootIds: readonly string[],
  requestedQty: Decimal,
  asOf: Date,
  failRoot: (rootBomId: string, code: ListReferenceCostIntegrityErrorCode) => void,
  failed: ReadonlyMap<string, ListReferenceCostIntegrityErrorCode>,
): Promise<TerminalOccurrence[]> {
  const roots = await db.bomHeader.findMany({
    where: { id: { in: [...rootIds] } },
    select: { id: true, parentSkuId: true },
  });

  const terminals: TerminalOccurrence[] = [];
  let frontier: BatchTask[] = roots.map((root) => ({
    rootBomId: root.id,
    bomHeaderId: root.id,
    parentQty: requestedQty,
    path: [root.parentSkuId],
    pathQtyUnconfirmed: false,
  }));

  for (let level = 1; frontier.length > 0; level += 1) {
    // 이미 실패한 root 는 더 내려가지 않는다 (R8-15 short-circuit).
    frontier = frontier.filter((task) => !failed.has(task.rootBomId));
    if (frontier.length === 0) break;

    const pending = await collectLines(db, frontier, failRoot, failed);
    if (pending.length === 0) break;

    // ★ R8-9 — 깊이 초과는 **그 root 만** 실패시킨다. 전 root 로 승격하지 않는다.
    const overflow = level > BOM_MAX_LEVEL;
    if (overflow) {
      for (const item of pending) failRoot(item.task.rootBomId, ERROR_CODES.BOM_MAX_LEVEL_EXCEEDED);
      break;
    }

    const stillActive = pending.filter((item) => !failed.has(item.task.rootBomId));
    if (stillActive.length === 0) break;

    // ⛔ strict resolver 를 부르지 않는다 — key 별 outcome 이 필요하다 (R8-1).
    const resolved = await resolveEffectiveBomOutcomes(db, {
      parentSkuIds: stillActive.map((item) => item.row.componentSkuId),
      asOf,
    });

    const next: BatchTask[] = [];
    for (const item of stillActive) {
      if (failed.has(item.task.rootBomId)) continue;

      const outcome = resolved.get(item.row.componentSkuId);
      // ★ R8-8 — 이 SKU 를 실제로 밟은 root 만 실패한다.
      if (outcome?.status === 'ERROR') {
        failRoot(item.task.rootBomId, ERROR_CODES.BOM_EFFECTIVE_CONFLICT);
        continue;
      }

      const childBom = outcome?.status === 'OK' ? outcome.value : null;
      if (childBom === null) {
        terminals.push({
          rootBomId: item.task.rootBomId,
          componentSkuId: item.row.componentSkuId,
          uom: item.row.uom,
          rawRequiredQty: item.raw,
          qtyUnconfirmed: item.qtyUnconfirmed,
        });
        continue;
      }
      next.push({
        rootBomId: item.task.rootBomId,
        bomHeaderId: childBom.id,
        parentQty: item.raw,
        path: [...item.task.path, item.row.componentSkuId],
        pathQtyUnconfirmed: item.qtyUnconfirmed,
      });
    }
    frontier = next;
  }

  // 실패한 root 의 occurrence 는 집계에 쓰이지 않는다.
  return terminals.filter((item) => !failed.has(item.rootBomId));
}

/** 이 level 의 모든 header 라인을 **한 번에** 읽는다. ⛔ N+1 금지. */
async function collectLines(
  db: BomCostReadClient,
  frontier: readonly BatchTask[],
  failRoot: (rootBomId: string, code: ListReferenceCostIntegrityErrorCode) => void,
  failed: ReadonlyMap<string, ListReferenceCostIntegrityErrorCode>,
): Promise<PendingLine[]> {
  const headerIds = [...new Set(frontier.map((task) => task.bomHeaderId))];
  const rows = await db.bomLine.findMany({
    where: { bomHeaderId: { in: headerIds } },
    include: EXPLODE_LINE_INCLUDE,
    orderBy: [{ bomHeaderId: 'asc' }, { lineNo: 'asc' }],
  });
  if (rows.length === 0) return [];

  const byHeader = new Map<string, ExplodeLineRow[]>();
  for (const row of rows) {
    const bucket = byHeader.get(row.bomHeaderId);
    if (bucket === undefined) byHeader.set(row.bomHeaderId, [row]);
    else bucket.push(row);
  }

  const pending: PendingLine[] = [];
  for (const task of frontier) {
    if (failed.has(task.rootBomId)) continue;

    for (const row of byHeader.get(task.bomHeaderId) ?? []) {
      // ★ R8-9 — 순환은 **현재 경로**로만 판정하고 그 root 만 실패시킨다.
      const seen = task.path.indexOf(row.componentSkuId);
      if (seen >= 0) {
        // 오류 객체를 만들어 code 를 읽는다 — whitelist 밖이면 그대로 던진다.
        const error = bomCycleDetected([...task.path.slice(seen), row.componentSkuId]);
        if (!isListReferenceCostIntegrityError(error)) throw error;
        failRoot(task.rootBomId, error.code as ListReferenceCostIntegrityErrorCode);
        break;
      }

      const quantityPer = row.quantityPer === null ? null : toDecimalString(row.quantityPer);

      // ★ R8-12 — 수량 정합·산출수량 손상도 **그 root 에만** 귀속시킨다.
      //   ⛔ catch-all 이 아니다 — whitelist 밖이면 그대로 던진다 (R8-7).
      let raw: Decimal | null;
      try {
        assertQuantityConsistency({ quantityPer, quantityStatus: row.quantityStatus });
        raw = computeRawRequiredQty({
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
        });
      } catch (error) {
        if (!isListReferenceCostIntegrityError(error)) throw error;
        failRoot(task.rootBomId, error.code as ListReferenceCostIntegrityErrorCode);
        break;
      }

      pending.push({
        row,
        task,
        raw,
        // ★ R-12 — 경로 OR 상속.
        qtyUnconfirmed: task.pathQtyUnconfirmed || row.quantityStatus !== 'CONFIRMED',
      });
    }
  }
  return pending;
}
