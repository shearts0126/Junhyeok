import { Prisma } from '@/generated/prisma/client';
import { ConflictError, ERROR_CODES } from '@/shared/errors';

/**
 * T08-1 DB 제약 → T08-2 API 오류 매핑.
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D34 ("기존 duplicate/conflict 오류
 *    관례를 재사용한다 — 새 generic error framework 금지").
 *
 * **DB 가 최종 방어선**이다. application 선조회로 대체하지 않는다 — 동시 요청은
 * UNIQUE 에서만 확정적으로 직렬화된다 (T06-2 와 같은 원칙).
 *
 * | 위반 | Prisma | 매핑 |
 * |---|---|---|
 * | `warehouse_code` UNIQUE | `P2002` fields `[warehouse_code]` | 409 `WAREHOUSE_CODE_DUPLICATE` |
 * | `(warehouse_id, location_code)` UNIQUE | `P2002` fields 2개 | 409 `WAREHOUSE_LOCATION_CODE_DUPLICATE` |
 * | `IN_TRANSIT` partial UNIQUE | `P2002` | seed 전용 경로에서만 도달 — 그대로 던진다 |
 *
 * ⛔ 그 밖의 오류는 **삼키지 않는다** — 원본을 그대로 다시 던져 500 으로
 *    드러낸다. DTO·사전검증이 이미 막아야 할 것이 여기 도달했다면 계약 버그다.
 */

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

/** ① 어댑터의 구조화된 UNIQUE 제약 컬럼 목록 (1차 계약), ② `target` fallback. */
function uniqueConstraintFields(meta: Record<string, unknown>): readonly string[] | undefined {
  const cause = asRecord(asRecord(meta['driverAdapterError'])?.['cause']);
  return (
    asStringArray(asRecord(cause?.['constraint'])?.['fields']) ?? asStringArray(meta['target'])
  );
}

export function warehouseCodeDuplicate(warehouseCode: string): ConflictError {
  return new ConflictError(ERROR_CODES.WAREHOUSE_CODE_DUPLICATE, {
    message: `창고 코드 '${warehouseCode}' 이(가) 이미 사용 중입니다.`,
    publicDetails: { warehouseCode },
    publicHint: '다른 코드를 사용하거나 기존 창고를 확인하세요.',
    retryable: false,
  });
}

export function locationCodeDuplicate(locationCode: string): ConflictError {
  return new ConflictError(ERROR_CODES.WAREHOUSE_LOCATION_CODE_DUPLICATE, {
    message: `로케이션 코드 '${locationCode}' 이(가) 이 창고에 이미 있습니다.`,
    publicDetails: { locationCode },
    publicHint: '같은 창고 안에서는 로케이션 코드가 유일해야 합니다.',
    retryable: false,
  });
}

/**
 * 창고 쓰기 오류 번역. **반환하지 않는다** — 항상 throw 한다.
 */
export function translateWarehouseWriteError(error: unknown, warehouseCode: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const fields = uniqueConstraintFields(asRecord(error.meta) ?? {}) ?? [];
    if (fields.some((field) => field.includes('warehouse_code') || field === 'warehouseCode')) {
      throw warehouseCodeDuplicate(warehouseCode);
    }
  }
  throw error;
}

/**
 * 로케이션 쓰기 오류 번역. **반환하지 않는다** — 항상 throw 한다.
 */
export function translateLocationWriteError(error: unknown, locationCode: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const fields = uniqueConstraintFields(asRecord(error.meta) ?? {}) ?? [];
    if (fields.some((field) => field.includes('location_code') || field === 'locationCode')) {
      throw locationCodeDuplicate(locationCode);
    }
  }
  throw error;
}
