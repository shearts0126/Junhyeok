/**
 * 바코드 Application 계층 (T04-3).
 *
 * 계약의 유일한 근거는 `docs/10_설계복구_BarcodeCRUD.md` (2026-08-10 Design
 * Recovery Decision)다.
 *
 * ⛔ 이 모듈은 DataIssue 를 만들지 않는다 — 인터랙티브 CRUD 의 잘못된 값은
 *    HTTP 오류로 끝난다. import·migration 경로의 DataIssue 요구는 별도 Task 다.
 *
 * 중복 예외 요청·승인(T04-4A)은 `docs/11_설계복구_Barcode중복예외승인.md` 로 확정되어
 * 이 barrel 에 함께 들어 있다. 승인 **화면**(T04-4B)은 SKU 상세 바코드 탭
 * (`docs/16_설계복구_SKU상세잔여탭.md`, T1-6B1)이다.
 */
export {
  BARCODE_READ_PERMISSION,
  BARCODE_CREATE_PERMISSION,
  BARCODE_UPDATE_PERMISSION,
  BARCODE_DEACTIVATE_PERMISSION,
  BARCODE_REQUEST_DUPLICATE_PERMISSION,
  BARCODE_APPROVE_DUPLICATE_PERMISSION,
} from './policy';

export {
  BARCODE_TYPES,
  BARCODE_STATUSES,
  BARCODE_ALL_STATUSES,
  BARCODE_STATUS_PENDING_DUPLICATE,
  createBarcodeSchema,
  updateBarcodeSchema,
  requestDuplicateCandidateSchema,
  approveDuplicateSchema,
  parseCreateBarcodeInput,
  parseUpdateBarcodeInput,
  parseRequestDuplicateCandidateInput,
  parseApproveDuplicateInput,
  parseBarcodeId,
  type BarcodeTypeValue,
  type BarcodeStatusValue,
  type CreateBarcodeInput,
  type UpdateBarcodeInput,
  type RequestDuplicateCandidateInput,
  type ApproveDuplicateInput,
} from './dto';

export {
  countActualDuplicates,
  duplicateApprovalInvalidState,
  duplicateApprovalPending,
  duplicateCandidateExists,
  duplicateExceptionNotApplicable,
  lockActualDuplicates,
  lockBarcodeRow,
} from './duplicate-exception';

export {
  BARCODE_CANDIDATE_ROUTE_SCOPE,
  BARCODE_REQUEST_DUPLICATE_ACTION,
  barcodeCandidateRequestHash,
  requestDuplicateCandidate,
  type RequestDuplicateCandidateResult,
} from './request-duplicate-candidate';

export { BARCODE_APPROVE_DUPLICATE_ACTION, approveDuplicateBarcode } from './approve-duplicate';

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
