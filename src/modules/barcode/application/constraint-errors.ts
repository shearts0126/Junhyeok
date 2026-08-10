import { Prisma } from '@/generated/prisma/client';
import { ConflictError, ERROR_CODES } from '@/shared/errors';

/**
 * T04-1 조건부 UNIQUE 2종 → API 오류 매핑 (T04-3).
 *
 * ⚠️ 근거: `docs/10_설계복구_BarcodeCRUD.md` §18·§19.
 *
 *   - `ux_barcode_active`  (`UNIQUE(barcode) WHERE status='ACTIVE' AND duplicate_exception=false`)
 *     → 409 `BARCODE_DUPLICATE`
 *   - `ux_barcode_primary` (`UNIQUE(sku_id) WHERE is_primary=true AND status='ACTIVE'`)
 *     → 409 `BARCODE_PRIMARY_CONFLICT`
 *
 * **DB 가 최종 방어선**이다. application 선조회로 대체하지 않는다 — 동시 요청은
 * partial UNIQUE 에서만 확정적으로 직렬화된다.
 *
 * ⛔ 자동 `duplicateException=true` · 자동 승인 · 기존 바코드 자동 비활성 ·
 *    기존 대표 자동 해제 — 어떤 숨은 side effect 도 만들지 않는다.
 *
 * ## 두 위반의 구분
 *
 * 1차 계약은 **구조화된 제약 컬럼 목록**이다. 두 partial index 는 각각
 * 단일 컬럼이고 서로 다르므로(`barcode` vs `sku_id`) 이것만으로 구분된다.
 * 어댑터의 `originalMessage` 문자열(인덱스 이름)은 **최후 fallback** 일 뿐
 * 1차 계약이 아니다 — 드라이버 구현 세부라 안정성을 보장할 수 없다.
 */

const BARCODE_COLUMN = 'barcode';
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
function indexNameFromMessage(meta: Record<string, unknown>): string | undefined {
  const cause = asRecord(asRecord(meta['driverAdapterError'])?.['cause']);
  const message = cause?.['originalMessage'];
  if (typeof message !== 'string') return undefined;
  if (message.includes('ux_barcode_active')) return 'ux_barcode_active';
  if (message.includes('ux_barcode_primary')) return 'ux_barcode_primary';
  return undefined;
}

export type BarcodeUniqueViolation = 'ux_barcode_active' | 'ux_barcode_primary';

/** P2002 가 어느 조건부 UNIQUE 인지 판정한다. 알 수 없으면 `undefined`. */
export function resolveBarcodeUniqueViolation(
  error: Prisma.PrismaClientKnownRequestError,
): BarcodeUniqueViolation | undefined {
  const meta = asRecord(error.meta) ?? {};

  const fields = constraintFieldsFromAdapter(meta) ?? constraintFieldsFromTarget(meta);
  if (fields !== undefined) {
    if (fields.includes(BARCODE_COLUMN)) return 'ux_barcode_active';
    if (SKU_ID_COLUMNS.some((column) => fields.includes(column))) return 'ux_barcode_primary';
  }

  return indexNameFromMessage(meta) as BarcodeUniqueViolation | undefined;
}

export function duplicateActiveBarcode(barcode: string): ConflictError {
  return new ConflictError(ERROR_CODES.BARCODE_DUPLICATE, {
    message: `바코드 '${barcode}' 이(가) 이미 활성 상태로 사용 중입니다.`,
    publicDetails: { barcode },
    publicHint: '기존 바코드를 확인하거나 중복 예외 승인을 요청하세요.',
    retryable: false,
  });
}

export function primaryBarcodeConflict(skuId: string): ConflictError {
  return new ConflictError(ERROR_CODES.BARCODE_PRIMARY_CONFLICT, {
    message: `SKU '${skuId}' 에는 이미 활성 대표 바코드가 있습니다.`,
    publicDetails: { skuId },
    // ★ 자동 교체를 하지 않으므로, 사용자가 명시적으로 해제해야 한다.
    publicHint: '기존 대표 바코드를 먼저 대표 해제한 뒤 다시 시도하세요.',
    retryable: false,
  });
}

/**
 * 바코드 쓰기 중 발생한 오류를 API 오류로 번역한다.
 *
 * P2002 가 아니거나 어느 제약인지 판정할 수 없으면 **원래 오류를 그대로 던진다** —
 * 추측으로 409 를 만들어내지 않는다.
 */
export function translateBarcodeWriteError(
  error: unknown,
  context: { readonly skuId: string; readonly barcode: string },
): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const violation = resolveBarcodeUniqueViolation(error);
    if (violation === 'ux_barcode_active') throw duplicateActiveBarcode(context.barcode);
    if (violation === 'ux_barcode_primary') throw primaryBarcodeConflict(context.skuId);
  }
  throw error;
}
