/**
 * 거래처·공급조건 Application Service (T06-2).
 *
 * 근거: `docs/17_설계복구_거래처공급조건.md` §39~
 *       (2026-08-12 T06-2 Supply Terms API Design Recovery Decision — D-1 ~ D-30).
 *
 * 범위는 정확히 6 endpoint 다 — Supplier list/create/update ·
 * SupplierSku list/create/update(temporal versioning).
 * ⛔ 가격이력(T06-3)·화면(T06-4)·SKU 역조회(T1-6B4 지원 API)는 여기 없다.
 */
export {
  duplicateSupplierCode,
  supplierSkuEffectiveFromDuplicate,
  supplierSkuPeriodInvalid,
  supplierSkuPeriodOverlap,
  supplierSkuPrimaryConflict,
  supplierSkuVersionDateInvalid,
  translateSupplierSkuWriteError,
  translateSupplierWriteError,
} from './constraint-errors';
export {
  createSupplier,
  SUPPLIER_CREATE_ROUTE_SCOPE,
  SUPPLIER_ENTITY_TYPE,
  SUPPLIER_SKU_ENTITY_TYPE,
  type CreateSupplierResult,
  type SupplierMutateDependencies,
} from './create-supplier';
export {
  assertValidPeriod,
  createSupplierSku,
  supplierSkuCreateRouteScope,
  type CreateSupplierSkuResult,
} from './create-supplier-sku';
export {
  createSupplierSchema,
  createSupplierSkuSchema,
  listSuppliersQuerySchema,
  listSupplierSkusQuerySchema,
  parseCreateSupplierInput,
  parseCreateSupplierSkuInput,
  parseDateOnly,
  parseListSuppliersQuery,
  parseListSupplierSkusQuery,
  parseSupplierId,
  parseSupplierSkuId,
  parseUpdateSupplierInput,
  parseUpdateSupplierSkuInput,
  SUPPLIER_PAGE_SIZE,
  SUPPLY_TYPES,
  updateSupplierSchema,
  VERSION_FIELD_KEYS,
  type CreateSupplierInput,
  type CreateSupplierSkuInput,
  type ListSuppliersQuery,
  type ListSupplierSkusQuery,
  type UpdateSupplierInput,
  type UpdateSupplierSkuInput,
} from './dto';
export {
  listSuppliers,
  type SupplierListResult,
  type SupplierReadDependencies,
} from './list-suppliers';
export { listSupplierSkus, type SupplierSkuListResult } from './list-supplier-skus';
export {
  SUPPLIER_CREATE_PERMISSION,
  SUPPLIER_READ_PERMISSION,
  SUPPLIER_UPDATE_PERMISSION,
} from './policy';
export { skuRefNotFound, supplierNotFound, supplierSkuNotFound } from './refs';
export { updateSupplier } from './update-supplier';
export { updateSupplierSku } from './update-supplier-sku';
export {
  toSupplierSkuView,
  toSupplierView,
  SUPPLIER_SKU_VIEW_INCLUDE,
  type SupplierSkuView,
  type SupplierView,
} from './views';
