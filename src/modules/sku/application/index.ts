/**
 * SKU Application (T1-3) — CRUD 4종만.
 *
 * ⛔ T1-4 이후의 몫 (여기 없음): submit/approve/reject 워크플로,
 *    deactivate/archive, 이력 조회, 코드 자동제안, Excel import, DELETE.
 */
export { SKU_CREATE_PERMISSION, SKU_READ_PERMISSION, SKU_UPDATE_PERMISSION } from './policy';
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
