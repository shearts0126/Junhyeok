/**
 * 창고·로케이션 application 계층 공개 API (T08-2 = v0.2 T2-1B).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` (W-D1 ~ W-D42).
 *
 * endpoint 는 **정확히 5개**다 — `POST`·`GET /api/warehouses`,
 * `PATCH /api/warehouses/{id}`, `GET`·`POST /api/warehouses/{id}/locations`.
 *
 * ⛔ UI(`/master/warehouses`) · `active` lifecycle · 재고 존재 시 비활성 차단은
 *    `T2-20` 이다 (§W-D27·§W-D28).
 * ⛔ posting·ledger·balance 는 T09 다 (§W-D18·§W-D40).
 */

export {
  DEFAULT_LOCATION_FIXED,
  insertWarehouseWithDefaultLocation,
  type AtomicWarehouseInput,
  type AtomicWarehouseResult,
} from './atomic-create';

export {
  locationCodeDuplicate,
  translateLocationWriteError,
  translateWarehouseWriteError,
  warehouseCodeDuplicate,
} from './constraint-errors';

export {
  createWarehouseLocation,
  locationCreateRouteScope,
  parseLocationSnapshot,
  type CreateLocationResult,
} from './create-location';

export {
  WAREHOUSE_CREATE_ROUTE_SCOPE,
  WAREHOUSE_ENTITY_TYPE,
  WAREHOUSE_LOCATION_ENTITY_TYPE,
  assertSupplierRule,
  createWarehouse,
  parseCreateWarehouseSnapshot,
  type CreateWarehouseResult,
  type WarehouseMutateDependencies,
} from './create-warehouse';

export {
  DEFAULT_TIMEZONE,
  WAREHOUSE_PATCH_FIELDS,
  WAREHOUSE_TYPES,
  assertNoLocationListQuery,
  createLocationSchema,
  createWarehouseSchema,
  isReservedWarehouseInput,
  parseCreateLocationInput,
  parseCreateWarehouseInput,
  parseListWarehousesQuery,
  parseUpdateWarehouseInput,
  parseWarehouseId,
  updateWarehouseSchema,
  type CreateLocationInput,
  type CreateWarehouseInput,
  type ListWarehousesQuery,
  type UpdateWarehouseInput,
  type WarehouseType,
} from './dto';

export {
  listWarehouseLocations,
  type LocationListResult,
  type LocationReadDependencies,
} from './list-locations';

export {
  defaultWarehouseClient,
  listWarehouses,
  type WarehouseListResult,
  type WarehouseReadDependencies,
} from './list-warehouses';

export {
  DEFAULT_LOCATION_CODE,
  IN_TRANSIT_WAREHOUSE_CODE,
  WAREHOUSE_CREATE_PERMISSION,
  WAREHOUSE_PAGE_SIZE,
  WAREHOUSE_READ_PERMISSION,
  WAREHOUSE_UPDATE_PERMISSION,
} from './policy';

export {
  assertExternalSystemExists,
  assertSupplierRefExists,
  externalSystemNotFound,
  supplierRefNotFound,
  warehouseNotFound,
  type WarehouseDbClient,
  type WarehouseReadClient,
} from './refs';

export { updateWarehouse } from './update-warehouse';

export {
  toLocationView,
  toWarehouseView,
  type LocationRow,
  type LocationView,
  type WarehouseRow,
  type WarehouseView,
} from './views';
