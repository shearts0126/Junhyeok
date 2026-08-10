/**
 * 바코드 Application 계층 (T04-3).
 *
 * 계약의 유일한 근거는 `docs/10_설계복구_BarcodeCRUD.md` (2026-08-10 Design
 * Recovery Decision)다.
 *
 * ⛔ 이 모듈은 DataIssue 를 만들지 않는다 — 인터랙티브 CRUD 의 잘못된 값은
 *    HTTP 오류로 끝난다. import·migration 경로의 DataIssue 요구는 별도 Task 다.
 * ⛔ 중복 예외 승인(`approve-duplicate`)·UI 는 T04-4 / T1-6B 다.
 */
export {
  BARCODE_READ_PERMISSION,
  BARCODE_CREATE_PERMISSION,
  BARCODE_UPDATE_PERMISSION,
  BARCODE_DEACTIVATE_PERMISSION,
} from './policy';

export {
  BARCODE_TYPES,
  BARCODE_STATUSES,
  createBarcodeSchema,
  updateBarcodeSchema,
  parseCreateBarcodeInput,
  parseUpdateBarcodeInput,
  parseBarcodeId,
  type BarcodeTypeValue,
  type BarcodeStatusValue,
  type CreateBarcodeInput,
  type UpdateBarcodeInput,
} from './dto';

export { toSkuBarcodeView, type SkuBarcodeView } from './views';

export {
  BARCODE_MAX_LENGTH,
  resolveBarcodeInput,
  type BarcodeInputResolution,
} from './normalize-input';

export {
  duplicateActiveBarcode,
  primaryBarcodeConflict,
  resolveBarcodeUniqueViolation,
  translateBarcodeWriteError,
  type BarcodeUniqueViolation,
} from './constraint-errors';

export {
  assertParentSkuExists,
  barcodeNotFound,
  findOwnedBarcode,
  skuNotFound,
} from './parent-sku';

export { listSkuBarcodes, type BarcodeListDependencies } from './list-barcodes';

export {
  BARCODE_ENTITY_TYPE,
  BARCODE_CREATE_ROUTE_SCOPE,
  barcodeCreateRequestHash,
  createSkuBarcode,
  type BarcodeMutateDependencies,
  type CreateBarcodeResult,
} from './create-barcode';

export { updateSkuBarcode } from './update-barcode';
export { deactivateSkuBarcode } from './deactivate-barcode';
