/**
 * SKU 도메인 규칙 (T1-2) — 순수 함수만.
 *
 * CRUD·승인 워크플로·권한·감사로그는 여기 없다 (T1-3 이후의 Application 몫).
 */
export {
  SKU_STATUSES,
  SKU_STATUS_TRANSITIONS,
  canTransitionSkuStatus,
  assertSkuStatusTransition,
  type SkuStatusValue,
} from './status-transition';
export {
  canChangeSkuCode,
  assertSkuCodeChangeAllowed,
  type SkuCodeChangeInput,
} from './code-immutability';
export {
  skuArchiveBlockers,
  canArchiveSku,
  assertSkuArchivable,
  type SkuArchiveBlocker,
  type SkuUsageFacts,
} from './archive-eligibility';
export {
  SKU_CODE_POLICY,
  SKU_SERIAL_DIGITS,
  SKU_SERIAL_MAX,
  SKU_SERIAL_MIN,
  buildSkuCodePrefix,
  formatSkuSerial,
  nextSkuSerial,
  skuSerialExhausted,
  usedSkuSerials,
} from './code-suggestion';
