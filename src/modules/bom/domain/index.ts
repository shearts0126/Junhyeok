/**
 * BOM 도메인 (T07-2) — **순수 함수만**. Prisma 를 import 하지 않는다.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-10 ~ §D-13 · §D-22.
 *
 * ⛔ SKU 도메인(`@/modules/sku/domain`)을 import 하지 않는다 — `canArchiveSku`
 *    같은 함수를 여기서 부르면 BOM↔SKU 모듈 순환 의존이 생긴다. SKU 사실은
 *    application 계층이 read model 로 넘긴다 (`hasBomUsage` provider 는 T07-3).
 */

export { BOM_MAX_LEVEL } from './constants';
export {
  assertNoBomCycle,
  bomCycleDetected,
  bomMaxLevelExceeded,
  findBomCyclePath,
  type BomChildrenLookup,
  type DetectBomCycleInput,
} from './cycle';
export { bomEffectiveConflict, selectEffectiveBom } from './effective-selection';
export {
  computeCostSubtotals,
  computeRawLineCost,
  deriveCostProvisionalReasons,
  projectProvisionalReason,
  toMoneyString,
  unionProvisionalReasons,
  COST_PROVISIONAL_REASONS,
  MONEY_SCALE,
  type CostProvisionalReason,
  type CostSubtotal,
  type CostSubtotalInput,
} from './cost';
export {
  computeRawRequiredQty,
  toRequiredQtyString,
  REQUIRED_QTY_SCALE,
  type ExplosionQuantityInput,
} from './explosion';
export {
  assertAllRequiredQuantitiesConfirmed,
  assertComponentEligible,
  assertNotSelfComponent,
  assertParentEligible,
  assertQuantityConsistency,
  assertUomMatchesBase,
  bomQuantityInvalid,
  bomQuantityStatusMismatch,
  BOM_COMPONENT_FORBIDDEN_STATUSES,
  BOM_PARENT_FORBIDDEN_STATUSES,
  isPositiveDecimalString,
  QUANTITY_STATUSES,
  type BomComponentEligibilityInput,
  type BomLineQuantityInput,
  type BomQuantityStatus,
  type BomUomInput,
  type SkuStatusLike,
} from './line-rules';
