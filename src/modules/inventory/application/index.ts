/**
 * 재고 모듈 application 공개 인터페이스 (T2-5).
 *
 * ⚠️ canonical module root 는 **`src/modules/inventory`** 다 —
 *    `eslint-rules/inventory-boundary.ts`(T0-5) 의 allowlist
 *    `src/modules/inventory/infrastructure/**` 가 executable architecture
 *    contract 이며, `docs/02`·`docs/04` 의 `inventory-ledger` 3분할 표기는
 *    v0.1 시점 기록이다(`CHANGELOG_v0.2` — *"미수정 파일 … 02"*).
 *
 * ★ T2-5 는 **application 계층만** 만든다. `domain/`·`infrastructure/`·
 *   `presentation/` 은 후속 task 가 연다.
 *
 * ⛔ `post()` · `postInventoryTransaction()` 을 내보내지 않는다 — 실제 posting
 *    관문은 **T2-10** 이다.
 */

export {
  // DTO
  postingCommandPayloadSchema,
  postingEntrySchema,
  postingExternalSchema,
  postingSourceDocumentSchema,
  // ① 구조 검증
  validateStructure,
  // 형식 상수
  EXTERNAL_LINE_ID_MAX_LENGTH,
  LOT_NO_MAX_LENGTH,
  OWNER_CODE_MAX_LENGTH,
  REASON_CODE_MAX_LENGTH,
  SERIAL_NO_MAX_LENGTH,
  SOURCE_DOCUMENT_EXEMPT_TYPE,
  SOURCE_DOCUMENT_NO_MAX_LENGTH,
  SOURCE_DOCUMENT_TYPE_MAX_LENGTH,
  UOM_MAX_LENGTH,
  type PostingCommand,
  type PostingCommandPayload,
  type PostingEntry,
  type PostingExternal,
  type PostingResult,
  type PostingSourceDocument,
  type StockKeyBalance,
} from './posting-command';

export {
  assertAllExistAndUsable,
  loadReferences,
  locationRefNotFound,
  skuRefNotFound,
  warehouseInactive,
  warehouseRefNotFound,
  type PostingDbClient,
  type PostingLocationKey,
  type PostingLocationRef,
  type PostingReadClient,
  type PostingReferences,
  type PostingSkuRef,
  type PostingWarehouseRef,
} from './refs';

export type {
  AssertChannelUsable,
  AssertPeriodOpen,
  AssertPostingPermission,
  AssertSourceDocumentState,
  PostingValidationDependencies,
} from './ports';

export {
  assertInventoryManaged,
  assertSourceDocument,
  validatePostingCommand,
  type PostingPhase1,
} from './validate-posting-command';
