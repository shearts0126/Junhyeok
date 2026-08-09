/**
 * 공용 멱등성 인프라 (T1-3 보완).
 *
 * scope = (actor, method, route template, key). 자세한 계약은 `./idempotency`.
 */
export { canonicalJson, requestHashOf } from './canonical';
export {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  executeWithIdempotency,
  parseIdempotencyKeyHeader,
  type IdempotencyOutcome,
  type IdempotencyScope,
  type IdempotentExecution,
} from './idempotency';
