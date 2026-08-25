/**
 * BOM application (T07-2 domain services + T07-3 CRUD).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-6·§D-9~§D-17 · §D-22 · §D-28 ~ §D-32.
 *
 * ⚠️ 이 barrel 은 Prisma 런타임을 끌고 온다 — **클라이언트 번들에서 import 하지
 *    않는다** (T06 `supplier/application` 과 같은 경계).
 * ⛔ cost·import 는 여기 없다 — T07-7 이후의 몫이다.
 */

// ── T07-2 domain services ────────────────────────────────────
export {
  assertNoBomCycleForCandidate,
  buildBomCycleGraph,
  type AssertNoBomCycleForCandidateInput,
  type BomCycleCandidate,
  type BomCycleGraphSnapshot,
} from './cycle-graph';
export {
  resolveEffectiveBom,
  resolveEffectiveBoms,
  type EffectiveBomHeaderRow,
  type ResolveEffectiveBomInput,
  type ResolveEffectiveBomsInput,
} from './resolve-effective-bom';
export {
  validateBomCandidateInTransaction,
  type ValidateBomCandidateInput,
} from './validate-candidate';

// ── refs · locks ─────────────────────────────────────────────
export {
  assertProductionPartnerExists,
  bomLineNotFound,
  bomNotFound,
  loadBomSkuRef,
  productionPartnerNotFound,
  skuRefNotFound,
  type BomCostReadClient,
  type BomDbClient,
  type BomReadClient,
  type BomSkuRef,
} from './refs';
export { lockBomHeaderRow, lockSkuRows } from './locks';

// ── policy ───────────────────────────────────────────────────
export {
  BOM_APPROVE_PERMISSION,
  BOM_CREATE_PERMISSION,
  BOM_READ_PERMISSION,
  BOM_SUBMIT_PERMISSION,
  BOM_UPDATE_PERMISSION,
} from './policy';

// ── DTO ──────────────────────────────────────────────────────
export {
  assertNoQueryParams,
  assertPeriodOrder,
  normalizeAlternateGroup,
  parseBomId,
  parseBomLineId,
  parseBulkConfirmQtyInput,
  parseCreateBomInput,
  parseCostBomQuery,
  parseCreateLineInput,
  parseDateOnly,
  parseExplodeBomQuery,
  parseListBomsQuery,
  parseSkuRefId,
  parseUpdateBomInput,
  parseUpdateLineInput,
  toDateOnlyString,
  BOM_ALTERNATE_GROUP_MAX_LENGTH,
  BOM_PAGE_SIZE,
  BOM_QUANTITY_STATUSES,
  BOM_STATUSES,
  BOM_SUPPLY_TYPES,
  BOM_TYPES,
  BOM_UOM_MAX_LENGTH,
  BOM_VERSION_MAX_LENGTH,
  COMPONENT_ROLES,
  type BulkConfirmQtyInput,
  type BulkConfirmQtyItem,
  type CostBomQuery,
  type CreateBomInput,
  type CreateLineInput,
  type ExplodeBomQuery,
  type ListBomsQuery,
  type UpdateBomInput,
  type UpdateLineInput,
} from './dto';

// ── views ────────────────────────────────────────────────────
export {
  countsOf,
  toBomDetailView,
  toBomHeaderView,
  toBomLineView,
  toWhereUsedView,
  BOM_HEADER_VIEW_INCLUDE,
  BOM_LINE_VIEW_INCLUDE,
  EXPLODE_LINE_INCLUDE,
  WHERE_USED_INCLUDE,
  type BomDetailView,
  type BomHeaderView,
  type BomLineView,
  type BomListItemView,
  type BomReferenceCostView,
  type BomWhereUsedView,
  type ComponentSkuRefView,
  type ExplodedNodeView,
  type SkuRefView,
  type SupplierRefView,
} from './views';

// ── editability · constraint 번역 ────────────────────────────
export {
  assertBomEditable,
  bomActiveImmutable,
  bomNotEditable,
  isBomEditable,
  BOM_EDITABLE_STATUSES,
} from './editability';
export {
  bomLineComponentDuplicate,
  bomLineNoDuplicate,
  bomPeriodOverlap,
  bomVersionDuplicate,
  translateBomHeaderWriteError,
  translateBomLineWriteError,
} from './constraint-errors';

// ── T07-3 CRUD services ──────────────────────────────────────
export {
  defaultBomClient,
  listBoms,
  bomListWhere,
  type BomListResult,
  type BomReadDependencies,
} from './list-boms';
export { getBom } from './get-bom';
export {
  createBom,
  parseBomHeaderViewSnapshot,
  BOM_CREATE_ROUTE_SCOPE,
  BOM_HEADER_ENTITY_TYPE,
  type BomMutateDependencies,
  type CreateBomResult,
} from './create-bom';
export { updateBom } from './update-bom';
export {
  createBomLine,
  bomLineCreateRouteScope,
  parseBomLineViewSnapshot,
  BOM_LINE_ENTITY_TYPE,
  type CreateLineResult,
} from './create-line';
export { updateBomLine } from './update-line';
export {
  bulkConfirmBomLineQuantities,
  bomLineBulkConfirmRouteScope,
  parseBomDetailSnapshot,
  type BulkConfirmQtyAuditSummary,
  type BulkConfirmQtyResult,
} from './bulk-confirm-qty';
export { deleteBomLine } from './delete-line';
export { listBomWhereUsed, type WhereUsedResult } from './where-used';

// ── T07-5 workflow ───────────────────────────────────────────
export {
  BOM_TRANSITIONS,
  BOM_WORKFLOW_ACTIONS,
  bomInvalidTransition,
  resolveBomTransition,
  shouldPerformBomTransition,
  type BomTransitionOutcome,
  type BomWorkflowAction,
} from './transitions';
export {
  approveBom,
  archiveBom,
  loadBomDetailInTransaction,
  rejectBom,
  submitBom,
  BOM_WORKFLOW_ENTITY_TYPE,
  type BomWorkflowResult,
} from './workflow';
export { activateBom, deactivateBom } from './activation';
export { bomCloneRouteScope, cloneBom, parseCloneSnapshot, type CloneBomResult } from './clone-bom';
export {
  parseActivateBomInput,
  parseApproveBomInput,
  parseArchiveBomInput,
  parseCloneBomInput,
  parseDeactivateBomInput,
  parseRejectBomInput,
  parseSubmitBomInput,
  BOM_WORKFLOW_TEXT_MAX,
  type ActivateBomInput,
  type ApproveBomInput,
  type ArchiveBomInput,
  type CloneBomInput,
  type DeactivateBomInput,
  type RejectBomInput,
  type SubmitBomInput,
} from './workflow-dto';
export { hasBomUsage, type HasBomUsageDependencies } from './has-bom-usage';

// ── T07-6 explode ────────────────────────────────────────────
export { explodeBom } from './explode-bom';

// ── T07-7A direct-line costing ───────────────────────────────
// ⛔ public `/cost` route 와 `CostResult` 는 T07-7B 소유다 (docs/18 C-1).
export {
  costDirectBom,
  type BomCostDependencies,
  type CostDirectBomInput,
  type DirectCostLine,
  type DirectCostResult,
} from './cost-direct-bom';

// ── T07-8 supporting read-model ──────────────────────────────
export {
  costBomsBatch,
  isListReferenceCostIntegrityError,
  LIST_REFERENCE_COST_INTEGRITY_ERROR_CODES,
  type BomCostFacts,
  type CostBomsBatchInput,
  type ListReferenceCostIntegrityErrorCode,
} from './cost-boms-batch';
export {
  listBomHistory,
  parseBomHistoryQuery,
  BOM_HISTORY_PAGE_SIZE,
  type BomHistoryDependencies,
  type BomHistoryQuery,
  type BomHistoryResult,
} from './list-bom-history';

// ── T07-7B multi-level cost roll-up ──────────────────────────
// ★ terminal cost-bearing occurrence 만 산입한다 (docs/18 R-1·R-2).
export {
  costBom,
  type CostBomDependencies,
  type CostComponentView,
  type CostResultView,
} from './cost-bom';
