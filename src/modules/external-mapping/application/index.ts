/**
 * 외부 상품 매핑 Application 계층 (T05-2).
 *
 * 계약의 유일한 근거는 `docs/13_설계복구_외부상품매핑CRUD.md`
 * (2026-08-10 External Mapping CRUD Design Recovery Decision)다.
 *
 * ⛔ `POST /import` · `GET /unmatched` 는 이 모듈에 없다 — 각각 T15(업로드
 *    파이프라인)와 T17(스냅샷)의 선행 모델이 필요하다. stub 도 만들지 않는다.
 * ⛔ SKU 해석 서비스(resolver)는 T05-3, 화면은 T05-4 다.
 * ⛔ `ExternalSystem` CRUD API 는 만들지 않는다 — 원 API 문서에 없다.
 */
export {
  EXTERNAL_MAPPING_READ_PERMISSION,
  EXTERNAL_MAPPING_CREATE_PERMISSION,
  EXTERNAL_MAPPING_UPDATE_PERMISSION,
} from './policy';

export {
  MAPPING_STATUSES,
  EXTERNAL_PRODUCT_CODE_MAX_LENGTH,
  EXTERNAL_PRODUCT_NAME_MAX_LENGTH,
  EXTERNAL_BARCODE_MAX_LENGTH,
  createMappingSchema,
  updateMappingSchema,
  listMappingsQuerySchema,
  parseCreateMappingInput,
  parseUpdateMappingInput,
  parseListMappingsQuery,
  parseExternalMappingId,
  type MappingStatusValue,
  type CreateMappingInput,
  type UpdateMappingInput,
  type ListMappingsQuery,
} from './dto';

export {
  normalizeExternalText,
  normalizeExternalBarcode,
  classifyExternalBarcode,
  normalizeIdentifiers,
  type NormalizedIdentifiers,
  type ExternalBarcodeClassification,
} from './normalize';

export {
  MAPPING_STATUS_MATCHED,
  MAPPING_STATUS_REVIEW_REQUIRED,
  MAPPING_STATUS_UNMATCHED,
  deriveMappingStatus,
  identifierRequired,
  primaryRequiresMatched,
  unmatchedNotInteractive,
  type IdentifierState,
} from './status';

export {
  BUSINESS_TIME_ZONE,
  businessDateOf,
  resolveEffectiveTo,
  mappingEnded,
  primaryMustBeClearedBeforeEnd,
} from './effective-date';

export {
  resolveExternalMappingUniqueViolation,
  duplicateExternalCode,
  primaryMappingConflict,
  translateMappingWriteError,
  type ExternalMappingUniqueViolation,
} from './constraint-errors';

export {
  EXTERNAL_MAPPING_VIEW_INCLUDE,
  toExternalMappingView,
  type ExternalMappingView,
  type ExternalMappingRow,
} from './views';

export {
  assertSkuExists,
  assertExternalSystemExists,
  findMapping,
  skuNotFound,
  externalSystemNotFound,
  mappingNotFound,
} from './refs';

export {
  listExternalMappings,
  type ExternalMappingListResult,
  type MappingListDependencies,
} from './list-mappings';

/**
 * 외부시스템 lookup (T05-4A) — 관리 UI 의 선택 수단 전용. CRUD 는 없다.
 */
export {
  listExternalSystems,
  parseListExternalSystemsQuery,
  type ExternalSystemView,
  type ExternalSystemListResult,
  type ExternalSystemListDependencies,
} from './list-external-systems';

export {
  EXTERNAL_MAPPING_ENTITY_TYPE,
  EXTERNAL_MAPPING_CREATE_ROUTE_SCOPE,
  createExternalMapping,
  mappingCreateRequestHash,
  type CreateMappingResult,
  type MappingMutateDependencies,
} from './create-mapping';

export { updateExternalMapping } from './update-mapping';

/**
 * SKU 해석 서비스 (T05-3) — **internal application service** 다.
 * REST 라우트·권한·HTTP 계약을 만들지 않는다 (docs/14 §4).
 */
export {
  resolveOne,
  resolveMany,
  type ResolveExternalMappingInput,
  type ResolveExternalMappingResult,
  type ResolverDependencies,
  type ExternalMappingResolutionStatus,
  type ExternalMappingMatchMethod,
  type ExternalMappingResolutionReason,
} from './resolve-mapping';

export {
  createPrismaResolverPort,
  type ExternalMappingResolverPort,
  type ExternalMappingLookupRow,
  type ResolverPrismaClient,
} from './resolver-port';
