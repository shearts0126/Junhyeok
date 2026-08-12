import { Prisma } from '@/generated/prisma/client';
import { ConflictError, DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * T06-1 DB 제약 → T06-2 API 오류 매핑.
 *
 * ⚠️ 근거: `docs/17_설계복구_거래처공급조건.md` §39~ (D-20) 및 T06-2 PRE-FLIGHT 의
 *    실측 Prisma error shape.
 *
 * **DB 가 최종 방어선**이다. application 선조회로 대체하지 않는다 — 동시 요청은
 * EXCLUDE·UNIQUE 에서만 확정적으로 직렬화된다.
 *
 * ## 실측된 위반별 shape (PostgreSQL 16 + Prisma 7 driver adapter)
 *
 * | 위반 | Prisma code | SQLSTATE | 구분 단서 |
 * |---|---|---|---|
 * | EXCLUDE (기간 중첩)   | `P2039` | `23P01` | cause.code + constraint 이름 |
 * | CHECK (moq>0 등)      | `P2039` | `23514` | cause.code — **overlap 아님** |
 * | supplierCode UNIQUE   | `P2002` | 23505   | fields `[supplier_code]` |
 * | 동일 시작일 UNIQUE    | `P2002` | 23505   | fields `[supplier_id, sku_id, effective_from]` |
 * | 현행 대표 partial     | `P2002` | 23505   | fields `[sku_id]` |
 *
 * ★ **`P2039` 하나로 전부 overlap 처리하지 않는다** — CHECK 위반도 같은 코드로
 *   나오므로 SQLSTATE 로 반드시 가른다. DTO 가 선검증하므로 CHECK 위반이 실제로
 *   도달하면 계약 버그다 → 원본 오류를 그대로 던져 500 으로 드러낸다.
 *
 * 1차 계약은 어댑터의 **구조화된 제약 컬럼 목록**이고, constraint 이름 문자열은
 * 최후 fallback 이다 (T04-3 `constraint-errors.ts` 와 동일한 원칙 — 단 supplier
 * 전용 매핑으로 별도 구현한다).
 */

const EXCLUSION_SQLSTATE = '23P01';
const PERIOD_EXCL_CONSTRAINT = 'supplier_sku_effective_period_excl';

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

function adapterCause(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(asRecord(meta['driverAdapterError'])?.['cause']);
}

/** ① 어댑터의 구조화된 UNIQUE 제약 컬럼 목록 (1차 계약). */
function uniqueConstraintFields(meta: Record<string, unknown>): readonly string[] | undefined {
  return (
    asStringArray(asRecord(adapterCause(meta)?.['constraint'])?.['fields']) ??
    asStringArray(meta['target'])
  );
}

/** ② P2039 의 SQLSTATE — EXCLUDE(`23P01`)와 CHECK(`23514`)를 가른다. */
function sqlState(meta: Record<string, unknown>): string | undefined {
  const cause = adapterCause(meta);
  const code = cause?.['code'] ?? cause?.['originalCode'];
  return typeof code === 'string' ? code : undefined;
}

/** ③ 최후 fallback — 원문 메시지의 constraint 이름. */
function rawMessage(meta: Record<string, unknown>): string {
  const message = adapterCause(meta)?.['originalMessage'];
  return typeof message === 'string' ? message : '';
}

export function duplicateSupplierCode(supplierCode: string): ConflictError {
  return new ConflictError(ERROR_CODES.SUPPLIER_CODE_DUPLICATE, {
    message: `거래처 코드 '${supplierCode}' 이(가) 이미 사용 중입니다.`,
    publicDetails: { supplierCode },
    publicHint: '다른 코드를 사용하거나 기존 거래처를 확인하세요.',
    retryable: false,
  });
}

export function supplierSkuPeriodOverlap(): ConflictError {
  return new ConflictError(ERROR_CODES.SUPPLIER_SKU_PERIOD_OVERLAP, {
    message: '같은 거래처·SKU 에 적용기간이 겹치는 공급조건이 이미 있습니다.',
    publicHint: '기존 공급조건의 적용기간을 확인하세요. 경계가 맞닿는 기간은 허용됩니다.',
    retryable: false,
  });
}

export function supplierSkuEffectiveFromDuplicate(): ConflictError {
  return new ConflictError(ERROR_CODES.SUPPLIER_SKU_EFFECTIVE_FROM_DUPLICATE, {
    message: '같은 거래처·SKU 에 동일한 적용 시작일의 공급조건이 이미 있습니다.',
    retryable: false,
  });
}

export function supplierSkuPrimaryConflict(): ConflictError {
  return new ConflictError(ERROR_CODES.SUPPLIER_SKU_PRIMARY_CONFLICT, {
    message: '이 SKU 의 현행(미종료) 우선공급업체가 이미 있습니다.',
    publicHint:
      '기존 우선공급 조건을 먼저 종료(effectiveTo)한 뒤 새 우선공급업체를 지정하세요. ' +
      '자동 교체는 하지 않습니다.',
    retryable: false,
  });
}

export function supplierSkuPeriodInvalid(detail: string): DomainError {
  return new DomainError(ERROR_CODES.SUPPLIER_SKU_EFFECTIVE_PERIOD_INVALID, {
    message: `적용기간이 올바르지 않습니다 — ${detail}`,
  });
}

export function supplierSkuVersionDateInvalid(detail: string): DomainError {
  return new DomainError(ERROR_CODES.SUPPLIER_SKU_VERSION_DATE_INVALID, {
    message: `버전 날짜가 올바르지 않습니다 — ${detail}`,
  });
}

/** `POST/PATCH` supplier 쓰기 오류 번역 — UNIQUE(supplier_code)만 다룬다. */
export function translateSupplierWriteError(error: unknown, supplierCode: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const fields = uniqueConstraintFields(asRecord(error.meta) ?? {});
    if (fields === undefined || fields.some((field) => field.includes('supplier_code'))) {
      throw duplicateSupplierCode(supplierCode);
    }
  }
  throw error;
}

/**
 * SupplierSku 쓰기 오류 번역 — 세 invariant 를 **서로 다른 오류**로 가른다.
 * 단순 supplierId+skuId 중복 판정은 존재하지 않는다 — 기간이 겹치지 않으면
 * 여러 행이 정상이다.
 */
export function translateSupplierSkuWriteError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = asRecord(error.meta) ?? {};

    if (error.code === 'P2039') {
      const state = sqlState(meta);
      if (state === EXCLUSION_SQLSTATE || rawMessage(meta).includes(PERIOD_EXCL_CONSTRAINT)) {
        throw supplierSkuPeriodOverlap();
      }
      // 23514(CHECK) 등 — DTO 선검증을 통과했다면 계약 버그다. 숨기지 않는다.
      throw error;
    }

    if (error.code === 'P2002') {
      const fields = uniqueConstraintFields(meta) ?? [];
      if (fields.some((field) => field === 'effective_from' || field === 'effectiveFrom')) {
        throw supplierSkuEffectiveFromDuplicate();
      }
      if (fields.some((field) => field === 'sku_id' || field === 'skuId')) {
        // ★ composite UNIQUE 도 sku_id 를 포함하므로 effective_from 판정이 먼저다.
        throw supplierSkuPrimaryConflict();
      }
      // 구조화 정보가 없으면 constraint 이름으로 최후 판정한다.
      const message = rawMessage(meta);
      if (message.includes('ux_supplier_sku_primary_current')) throw supplierSkuPrimaryConflict();
      if (message.includes('supplier_sku_supplier_id_sku_id_effective_from_key')) {
        throw supplierSkuEffectiveFromDuplicate();
      }
    }
  }
  throw error;
}
