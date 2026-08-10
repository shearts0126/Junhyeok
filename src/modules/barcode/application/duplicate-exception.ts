import type { SkuBarcode } from '@/generated/prisma/client';
import type { TransactionClient } from '@/shared/db';
import { ConflictError, DomainError, ERROR_CODES } from '@/shared/errors';

import { BARCODE_STATUS_PENDING_DUPLICATE } from './dto';

/**
 * 중복 예외 승인 공통 판정 (T04-4A).
 *
 * ⚠️ 근거: `docs/11_설계복구_Barcode중복예외승인.md` §6·§7·§15·§19·§21.
 */

/**
 * "실제 중복"의 정의 — **cross-SKU ACTIVE 공유만** 해당한다.
 *
 *     other.skuId  !=  대상 SKU
 *     other.barcode ==  정규화된 바코드
 *     other.status  ==  'ACTIVE'
 *
 * ★ `other.duplicateException` 값은 보지 않는다 — 이미 예외 승인된 ACTIVE 바코드와
 *   또 다른 SKU 가 같은 값을 쓰려는 경우도 중복 예외 대상이다.
 * ⛔ 같은 SKU 안의 중복은 대상이 아니다 (§7) — 그것은 데이터 중복일 뿐이다.
 *   조건에 `skuId` 제외가 들어 있으므로 같은 SKU 행만 있으면 결과가 0 이 되어
 *   자연스럽게 `BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE` 로 떨어진다.
 */
export interface ActualDuplicateQuery {
  readonly skuId: string;
  readonly barcode: string;
}

/** 잠금 없이 판정한다 — candidate 요청 시점의 사전 확인용. */
export async function countActualDuplicates(
  tx: TransactionClient,
  query: ActualDuplicateQuery,
): Promise<number> {
  return tx.skuBarcode.count({
    where: { barcode: query.barcode, status: 'ACTIVE', skuId: { not: query.skuId } },
  });
}

/**
 * 승인 트랜잭션 전용 — 상대 ACTIVE 행을 **같은 트랜잭션에서 잠근 채** 센다 (§21).
 *
 * candidate 를 먼저 잠근 뒤 호출한다. 중복 확인과 승인 mutation 사이에 상대 행이
 * 사라지는 stale 판정을 줄이기 위함이며, 대상 행만 잠근다 —
 * ⛔ 테이블/전역 lock 을 쓰지 않는다.
 */
export async function lockActualDuplicates(
  tx: TransactionClient,
  query: ActualDuplicateQuery,
): Promise<readonly string[]> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM sku_barcode
      WHERE barcode = $1 AND status = 'ACTIVE' AND sku_id <> $2::uuid
      FOR UPDATE`,
    query.barcode,
    query.skuId,
  );
  return rows.map((row) => row.id);
}

/** candidate row 를 잠근다. 없으면 0행 — 소유권·존재 판정은 호출부가 한다. */
export async function lockBarcodeRow(tx: TransactionClient, barcodeId: string): Promise<void> {
  await tx.$queryRawUnsafe(`SELECT id FROM sku_barcode WHERE id = $1::uuid FOR UPDATE`, barcodeId);
}

// ═══════════════════════════════════════════════════════════════
// 오류
// ═══════════════════════════════════════════════════════════════

/** 다른 SKU 가 활성으로 쓰는 동일 바코드가 없다 — 예외를 승인할 이유가 없다. */
export function duplicateExceptionNotApplicable(barcode: string): DomainError {
  return new DomainError(ERROR_CODES.BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE, {
    context: { barcode },
    publicDetails: { field: 'barcode' },
  });
}

/** 같은 SKU·바코드로 내용이 다른 승인 대기 후보가 이미 있다 (§9). */
export function duplicateCandidateExists(barcodeId: string): ConflictError {
  return new ConflictError(ERROR_CODES.BARCODE_DUPLICATE_CANDIDATE_EXISTS, {
    context: { barcodeId },
    publicHint: '기존 승인 대기 요청을 확인하거나 취소한 뒤 다시 요청하세요.',
    retryable: false,
  });
}

/** 승인 대상 상태가 아니다 (§19). 자동 상태수정은 하지 않는다. */
export function duplicateApprovalInvalidState(row: SkuBarcode): DomainError {
  return new DomainError(ERROR_CODES.BARCODE_DUPLICATE_APPROVAL_INVALID_STATE, {
    context: {
      barcodeId: row.id,
      status: row.status,
      duplicateException: row.duplicateException,
      approved: row.approvedBy !== null,
    },
  });
}

/** 승인 대기 중인 후보는 일반 PATCH 로 만질 수 없다 (§23). */
export function duplicateApprovalPending(barcodeId: string): DomainError {
  return new DomainError(ERROR_CODES.BARCODE_DUPLICATE_APPROVAL_PENDING, {
    context: { barcodeId, status: BARCODE_STATUS_PENDING_DUPLICATE },
    publicHint: '중복 예외 승인 또는 취소(비활성) 후 수정하세요.',
  });
}
