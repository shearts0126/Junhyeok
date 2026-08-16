import { Prisma } from '@/generated/prisma/client';
import { ConflictError, ERROR_CODES } from '@/shared/errors';

/**
 * T07-1 DB 제약 → T07-3 API 오류 매핑.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-29 매핑표. 구현 선례는 T06-2/T06-3 의
 *    `supplier/application/constraint-errors.ts` 와 동일한 3단 판정이다.
 *
 * **DB 가 최종 방어선이다.** application 선조회로 대체하지 않는다 — 동시 요청은
 * UNIQUE/EXCLUDE 에서만 확정적으로 직렬화된다.
 *
 * | 위반 | Prisma | SQLSTATE | 번역 |
 * |---|---|---|---|
 * | ACTIVE 기간 EXCLUDE | `P2039` | **`23P01`** | 409 `BOM_PERIOD_OVERLAP` |
 * | CHECK(기간 순서) | `P2039` | **`23514`** | ⛔ 번역하지 않는다 — DTO 가 먼저 막았어야 하므로 계약 버그(500) |
 * | `(parent_sku_id, version)` | `P2002` | 23505 | 409 `BOM_VERSION_DUPLICATE` |
 * | `(bom_header_id, line_no)` | `P2002` | 23505 | 409 `BOM_LINE_DUPLICATE` |
 * | `ux_bom_line_component_group` | `P2002` | 23505 | 409 `BOM_LINE_DUPLICATE` |
 *
 * ★ **`P2002` 하나로 뭉뚱그리지 않는다** — header 의 version 중복과 line 의
 *   중복은 서로 다른 오류다. 어댑터의 구조화된 제약 컬럼 목록이 1차 계약이고,
 *   constraint 이름 문자열은 최후 fallback 이다.
 */

const EXCLUSION_SQLSTATE = '23P01';
const PERIOD_EXCL_CONSTRAINT = 'bom_header_active_period_excl';
const VERSION_UNIQUE_CONSTRAINT = 'bom_header_parent_sku_id_version_key';
const LINE_NO_UNIQUE_CONSTRAINT = 'bom_line_bom_header_id_line_no_key';
const LINE_GROUP_UNIQUE_CONSTRAINT = 'ux_bom_line_component_group';

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

/** ② `P2039` 의 SQLSTATE — EXCLUDE(`23P01`)와 CHECK(`23514`)를 가른다. */
function sqlState(meta: Record<string, unknown>): string | undefined {
  const cause = adapterCause(meta);
  const code = cause?.['code'] ?? cause?.['originalCode'];
  return typeof code === 'string' ? code : undefined;
}

/** ③ 최후 fallback — 원문 메시지의 constraint 이름. */
function rawMessage(meta: Record<string, unknown>): string {
  const message = adapterCause(meta)?.['originalMessage'];
  const target = meta['target'];
  return `${typeof message === 'string' ? message : ''} ${typeof target === 'string' ? target : ''}`;
}

export function bomVersionDuplicate(version: string): ConflictError {
  return new ConflictError(ERROR_CODES.BOM_VERSION_DUPLICATE, {
    message: `같은 상위 SKU 에 버전 '${version}' 이(가) 이미 있습니다.`,
    publicDetails: { version },
    publicHint: '다른 버전 문자열을 사용하거나 기존 BOM 을 확인하세요.',
    retryable: false,
  });
}

export function bomPeriodOverlap(): ConflictError {
  return new ConflictError(ERROR_CODES.BOM_PERIOD_OVERLAP, {
    message: '같은 상위 SKU 에 적용기간이 겹치는 활성 BOM 이 이미 있습니다.',
    publicHint: '기존 활성 BOM 의 적용기간을 확인하세요. 경계가 맞닿는 기간은 허용됩니다.',
    retryable: false,
  });
}

export function bomLineNoDuplicate(lineNo: number): ConflictError {
  return new ConflictError(ERROR_CODES.BOM_LINE_DUPLICATE, {
    message: `이 BOM 에 순번 ${lineNo} 라인이 이미 있습니다.`,
    publicDetails: { lineNo },
    retryable: false,
  });
}

export function bomLineComponentDuplicate(): ConflictError {
  return new ConflictError(ERROR_CODES.BOM_LINE_DUPLICATE, {
    message: '같은 구성품·대체그룹의 라인이 이미 있습니다.',
    publicHint:
      '대체그룹이 서로 다르면 같은 구성품을 여러 번 넣을 수 있습니다. ' +
      '대체그룹이 비어 있는 라인끼리는 같은 그룹으로 봅니다.',
    retryable: false,
  });
}

/** `BomHeader` 쓰기 오류 번역 — EXCLUDE·version UNIQUE 두 가지다. */
export function translateBomHeaderWriteError(error: unknown, version: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = asRecord(error.meta) ?? {};

    if (error.code === 'P2039') {
      const state = sqlState(meta);
      if (state === EXCLUSION_SQLSTATE || rawMessage(meta).includes(PERIOD_EXCL_CONSTRAINT)) {
        throw bomPeriodOverlap();
      }
      // 23514(CHECK) 등 — DTO 선검증을 통과했다면 계약 버그다. 숨기지 않는다.
      throw error;
    }

    if (error.code === 'P2002') {
      const fields = uniqueConstraintFields(meta) ?? [];
      if (fields.some((field) => field === 'version')) throw bomVersionDuplicate(version);
      if (rawMessage(meta).includes(VERSION_UNIQUE_CONSTRAINT)) throw bomVersionDuplicate(version);
    }
  }
  throw error;
}

/**
 * `BomLine` 쓰기 오류 번역 — 두 UNIQUE 를 **서로 다른 메시지**로 가른다.
 *
 * ⚠️ `line_no` 판정을 먼저 한다 — 표현식 UNIQUE 는 `component_sku_id` 를 담고
 *    `line_no` 를 담지 않으므로 두 집합이 겹치지 않는다.
 */
export function translateBomLineWriteError(error: unknown, lineNo: number | null): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const meta = asRecord(error.meta) ?? {};
    const fields = uniqueConstraintFields(meta) ?? [];
    const message = rawMessage(meta);

    if (fields.some((field) => field === 'line_no' || field === 'lineNo')) {
      throw bomLineNoDuplicate(lineNo ?? 0);
    }
    if (
      fields.some((field) => field === 'component_sku_id' || field === 'componentSkuId') ||
      fields.some((field) => field.includes('alternate_group'))
    ) {
      throw bomLineComponentDuplicate();
    }
    if (message.includes(LINE_NO_UNIQUE_CONSTRAINT)) throw bomLineNoDuplicate(lineNo ?? 0);
    if (message.includes(LINE_GROUP_UNIQUE_CONSTRAINT)) throw bomLineComponentDuplicate();
  }
  throw error;
}
