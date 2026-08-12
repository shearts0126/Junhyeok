/**
 * 거래처·공급조건 Application Service (T06-2 + T06-3).
 *
 * 근거: `docs/17_설계복구_거래처공급조건.md` §39~ (T06-2 D-1~D-30) ·
 *       §58~ (2026-08-12 T06-3 Price History API Design Recovery — D-1~D-37).
 *
 * 범위는 정확히 9 endpoint 다 — Supplier list/create/update ·
 * SupplierSku list/create/update(temporal versioning) ·
 * Price list(asOf)/create/approve.
 * ⛔ 화면(T06-4)·SKU 역조회(T1-6B4 지원 API)·BOM cost(T07)는 여기 없다.
 */
export { approveSupplierSkuPrice } from './approve-price';
export {
  duplicateSupplierCode,
  supplierPriceChainConflict,
  supplierPriceEffectiveFromDuplicate,
  supplierSkuEffectiveFromDuplicate,
  supplierSkuPeriodInvalid,
  supplierSkuPeriodOverlap,
  supplierSkuPrimaryConflict,
  supplierSkuVersionDateInvalid,
  translateSupplierPriceWriteError,
  translateSupplierSkuWriteError,
  translateSupplierWriteError,
} from './constraint-errors';
export {
  createSupplierSkuPrice,
  parseSupplierSkuPriceViewSnapshot,
  SUPPLIER_SKU_PRICE_ENTITY_TYPE,
  supplierSkuPriceCreateRouteScope,
  type CreatePriceResult,
} from './create-price';
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
export { listSupplierSkuPrices, type SupplierSkuPriceListResult } from './list-prices';
export {
  SUPPLIER_CREATE_PERMISSION,
  SUPPLIER_PRICE_APPROVE_PERMISSION,
  SUPPLIER_PRICE_CREATE_PERMISSION,
  SUPPLIER_PRICE_READ_PERMISSION,
  SUPPLIER_READ_PERMISSION,
  SUPPLIER_UPDATE_PERMISSION,
} from './policy';
export {
  approvePriceSchema,
  assertUnitPriceSemantics,
  createPriceSchema,
  listPricesQuerySchema,
  parseApprovePriceInput,
  parseCreatePriceInput,
  parseListPricesQuery,
  parseSupplierSkuPriceId,
  SOURCE_DOCUMENT_MAX_LENGTH,
  type ApprovePriceInput,
  type CreatePriceInput,
  type ListPricesQuery,
} from './price-dto';
export {
  toSupplierSkuPriceView,
  type SupplierSkuPriceRow,
  type SupplierSkuPriceView,
} from './price-views';
export {
  skuRefNotFound,
  supplierNotFound,
  supplierSkuNotFound,
  supplierSkuPriceNotFound,
} from './refs';
export {
  resolveEffectiveSupplierPrice,
  type ResolveEffectivePriceInput,
} from './resolve-effective-price';
export { updateSupplier } from './update-supplier';
export { updateSupplierSku } from './update-supplier-sku';
export {
  toSupplierSkuView,
  toSupplierView,
  SUPPLIER_SKU_VIEW_INCLUDE,
  type SupplierSkuView,
  type SupplierView,
} from './views';
