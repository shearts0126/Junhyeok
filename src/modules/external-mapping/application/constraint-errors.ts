import { Prisma } from '@/generated/prisma/client';
import { ConflictError, ERROR_CODES } from '@/shared/errors';

/**
 * T05-1 조건부 UNIQUE 2종 → API 오류 매핑 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §10.
 *
 *   - `ux_external_mapping_code`
 *     (`UNIQUE(external_system_id, external_product_code)`
 *      `WHERE external_product_code <> '' AND effective_to IS NULL`)
 *     → 409 `EXTERNAL_MAPPING_CODE_DUPLICATE`
 *   - `ux_external_mapping_primary`
 *     (`UNIQUE(sku_id, external_system_id) WHERE is_primary = true`)
 *     → 409 `EXTERNAL_MAPPING_PRIMARY_CONFLICT`
 *
 * **DB 가 최종 방어선**이다. application 선조회로 대체하지 않는다 — 동시 요청은
 * partial UNIQUE 에서만 확정적으로 직렬화된다.
 *
 * ⛔ 두 위반을 하나의 generic 409 로 합치지 않는다.
 * ⛔ barcode 의 오류코드를 재사용하지 않는다 — 다른 도메인이다.
 *
 * ## 두 위반의 구분
 *
 * 1차 계약은 **구조화된 제약 컬럼 목록**이다. 두 index 는 모두 2컬럼이지만
 * 서로 다른 컬럼 집합을 쓴다:
 *
 *   code    → `external_system_id` + `external_product_code`
 *   primary → `sku_id`             + `external_system_id`
 *
 * 판정은 두 index 를 구분하는 **고유 컬럼**(`external_product_code` vs `sku_id`)
 * 으로 한다. 어댑터의 `originalMessage`(인덱스 이름)는 **최후 fallback** 일 뿐
 * 1차 계약이 아니다 — 드라이버 구현 세부라 안정성을 보장할 수 없다.
 */

const CODE_COLUMNS = ['external_product_code', 'externalProductCode'] as const;
const SKU_ID_COLUMNS = ['sku_id', 'skuId'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as readonly string[];
  }
  return undefined;
}

/** ① 드라이버 어댑터가 전달하는 구조화된 제약 컬럼 목록 (1차 계약). */
function constraintFieldsFromAdapter(meta: Record<string, unknown>): readonly string[] | undefined {
  const cause = asRecord(asRecord(meta['driverAdapterError'])?.['cause']);
  return asStringArray(asRecord(cause?.['constraint'])?.['fields']);
}

/** ② Prisma 표준 `meta.target` (엔진/어댑터 조합에 따라 존재). */
function constraintFieldsFromTarget(meta: Record<string, unknown>): readonly string[] | undefined {
  return asStringArray(meta['target']);
}

/** ③ 최후 fallback — 원문 메시지의 인덱스 이름. 1차 계약으로 삼지 않는다. */
function indexNameFromMessage(
  meta: Record<string, unknown>,
): ExternalMappingUniqueViolation | undefined {
  const cause = asRecord(asRecord(meta['driverAdapterError'])?.['cause']);
  const message = cause?.['originalMessage'];
  if (typeof message !== 'string') return undefined;
  if (message.includes('ux_external_mapping_code')) return 'ux_external_mapping_code';
  if (message.includes('ux_external_mapping_primary')) return 'ux_external_mapping_primary';
  return undefined;
}

export type ExternalMappingUniqueViolation =
  'ux_external_mapping_code' | 'ux_external_mapping_primary';

/** P2002 가 어느 조건부 UNIQUE 인지 판정한다. 알 수 없으면 `undefined`. */
export function resolveExternalMappingUniqueViolation(
  error: Prisma.PrismaClientKnownRequestError,
): ExternalMappingUniqueViolation | undefined {
  const meta = asRecord(error.meta) ?? {};

  const fields = constraintFieldsFromAdapter(meta) ?? constraintFieldsFromTarget(meta);
  if (fields !== undefined) {
    // 두 index 를 가르는 것은 `external_system_id` 가 아니라 나머지 한 컬럼이다.
    if (CODE_COLUMNS.some((column) => fields.includes(column))) return 'ux_external_mapping_code';
    if (SKU_ID_COLUMNS.some((column) => fields.includes(column))) {
      return 'ux_external_mapping_primary';
    }
  }

  return indexNameFromMessage(meta);
}

export function duplicateExternalCode(
  externalSystemId: string,
  externalProductCode: string,
): ConflictError {
  return new ConflictError(ERROR_CODES.EXTERNAL_MAPPING_CODE_DUPLICATE, {
    message: `외부시스템 '${externalSystemId}' 에 외부코드 '${externalProductCode}' 의 현행 매핑이 이미 있습니다.`,
    publicDetails: { externalProductCode },
    publicHint: '기존 매핑을 확인하거나 종료(effectiveTo)한 뒤 다시 시도하세요.',
    retryable: false,
  });
}

export function primaryMappingConflict(skuId: string, externalSystemId: string): ConflictError {
  return new ConflictError(ERROR_CODES.EXTERNAL_MAPPING_PRIMARY_CONFLICT, {
    message: `SKU '${skuId}' 와 외부시스템 '${externalSystemId}' 조합에는 이미 대표 매핑이 있습니다.`,
    publicDetails: { skuId, externalSystemId },
    // ★ 자동 교체를 하지 않으므로, 사용자가 명시적으로 해제해야 한다.
    publicHint: '기존 대표 매핑을 먼저 대표 해제한 뒤 다시 시도하세요.',
    retryable: false,
  });
}

/**
 * 매핑 쓰기 중 발생한 오류를 API 오류로 번역한다.
 *
 * P2002 가 아니거나 어느 제약인지 판정할 수 없으면 **원래 오류를 그대로 던진다** —
 * 추측으로 409 를 만들어내지 않는다.
 */
export function translateMappingWriteError(
  error: unknown,
  context: {
    readonly skuId: string;
    readonly externalSystemId: string;
    readonly externalProductCode: string | null;
  },
): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const violation = resolveExternalMappingUniqueViolation(error);
    if (violation === 'ux_external_mapping_code') {
      throw duplicateExternalCode(context.externalSystemId, context.externalProductCode ?? '');
    }
    if (violation === 'ux_external_mapping_primary') {
      throw primaryMappingConflict(context.skuId, context.externalSystemId);
    }
  }
  throw error;
}
