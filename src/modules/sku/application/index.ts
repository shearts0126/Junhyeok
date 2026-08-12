/**
 * SKU Application (T1-3 CRUD + T1-4A 승인 워크플로).
 *
 * 변경이력 조회(`GET /api/skus/{id}/history`)는 T1-6B3 으로 추가되었다 —
 * 계약은 `docs/16_설계복구_SKU상세잔여탭.md` §27~§40 이다.
 *
 * ⛔ 아직 없는 것 (T1-4B 이후의 몫): **archive** (BOM usage provider 필요),
 *    코드 자동제안, Excel import, DELETE.
 */
export {
  SKU_APPROVE_PERMISSION,
  SKU_CREATE_PERMISSION,
  SKU_DEACTIVATE_PERMISSION,
  SKU_READ_PERMISSION,
  SKU_SUBMIT_PERMISSION,
  SKU_SUGGEST_CODE_PERMISSION,
  SKU_UPDATE_PERMISSION,
} from './policy';
export {
  parseSuggestSkuCodeInput,
  suggestSkuCode,
  suggestSkuCodeSchema,
  type SuggestCodeClient,
  type SuggestCodeDependencies,
  type SuggestSkuCodeInput,
  type SuggestSkuCodeResult,
} from './suggest-code';
export {
  SKU_SORTS,
  createSkuSchema,
  listSkusQuerySchema,
  parseCreateSkuInput,
  parseListSkusQuery,
  parseSkuId,
  parseUpdateSkuInput,
  updateSkuSchema,
  type CreateSkuInput,
  type ListSkusQuery,
  type SkuSort,
  type UpdateSkuInput,
} from './dto';
export { assertValidCodeRefs, type CodeRefField, type CodeRefPatch } from './code-ref-validation';
export { SKU_VIEW_INCLUDE, toSkuView, type SkuCodeRefView, type SkuView } from './views';
export {
  SKU_CREATE_ROUTE_SCOPE,
  SKU_ENTITY_TYPE,
  createSku,
  duplicateSkuCode,
  skuCreateRequestHash,
  type CreateSkuResult,
  type SkuMutateDependencies,
} from './create-sku';
export { skuNotFound, updateSku } from './update-sku';
export { getSku, type SkuReadClient, type SkuReadDependencies } from './get-sku';
export { listSkus, type SkuListResult } from './list-skus';
export {
  SKU_HISTORY_ENTITY_TYPES,
  SKU_HISTORY_PAGE_SIZE,
  listSkuHistory,
  parseSkuHistoryQuery,
  type SkuHistoryDependencies,
  type SkuHistoryQuery,
  type SkuHistoryResult,
} from './list-sku-history';
export {
  SKU_APPROVAL_CHECKS,
  SKU_APPROVAL_CHECK_SEVERITY,
  SKU_ITEM_TYPES,
  buildSkuApprovalValidationReport,
  type SkuApprovalCheckCode,
  type SkuApprovalCheckStatus,
  type SkuApprovalSeverity,
  type SkuApprovalValidationReport,
  type SkuApprovalValidationResult,
} from './approval-validation';
export {
  WORKFLOW_TEXT_MAX,
  approveSkuSchema,
  deactivateSkuSchema,
  parseApproveSkuInput,
  parseDeactivateSkuInput,
  parseRejectSkuInput,
  parseSubmitSkuInput,
  rejectSkuSchema,
  submitSkuSchema,
  type ApproveSkuInput,
  type DeactivateSkuInput,
  type RejectSkuInput,
  type SubmitSkuInput,
} from './workflow-dto';
export {
  approveSku,
  deactivateSku,
  rejectSku,
  submitSku,
  type SkuWorkflowResult,
} from './workflow';
