import type { MappingStatus } from '@/generated/prisma/client';
import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * `mappingStatus` 자동판정 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §2·§3·§4.
 *
 * ## server-managed
 *
 * `mappingStatus` 는 interactive API 에서 **client 입력이 아니다**. DTO 가
 * `mappingStatus` 키 자체를 400 으로 막고, 서버가 **정규화 후 prospective
 * state** 로부터 파생한다.
 *
 * ## truth table
 *
 * | code | barcode | name | 결과                                        |
 * |:----:|:-------:|:----:|--------------------------------------------|
 * |  O   |    X    | any  | `MATCHED`                                   |
 * |  X   |    O    | any  | `MATCHED`                                   |
 * |  O   |    O    | any  | `MATCHED`                                   |
 * |  X   |    X    |  O   | `REVIEW_REQUIRED`                           |
 * |  X   |    X    |  X   | 422 `EXTERNAL_MAPPING_IDENTIFIER_REQUIRED`  |
 *
 * 근거: `05:81`("코드 없이 상품명만이면 `REVIEW_REQUIRED` 강제"),
 *       `05:82`("`MATCHED` 전환은 외부코드 **또는** 바코드 필수"),
 *       `06:188·190`("외부코드 존재 → `MATCHED`").
 *
 * ## `UNMATCHED` 는 만들지 않는다
 *
 * `SkuExternalMapping.skuId` 는 NOT NULL 이라 "어느 SKU 에도 매칭되지 않은 외부
 * 행"을 이 테이블로 표현할 수 없다. 실제 미매칭은 ingestion 계층
 * (`ExternalInventorySnapshotLine.matchedSkuId = NULL` / `matchMethod='UNMATCHED'`,
 * `InventoryReconciliationLine.skuId = NULL`)이 표현한다.
 * enum 값은 스키마 호환을 위해 **유지**하되, 이 API 는 생성·전환하지 않는다.
 */

export const MAPPING_STATUS_MATCHED = 'MATCHED' satisfies MappingStatus;
export const MAPPING_STATUS_REVIEW_REQUIRED = 'REVIEW_REQUIRED' satisfies MappingStatus;
export const MAPPING_STATUS_UNMATCHED = 'UNMATCHED' satisfies MappingStatus;

export interface IdentifierState {
  readonly externalProductCode: string | null;
  readonly externalProductName: string | null;
  readonly externalBarcode: string | null;
}

export function identifierRequired(): DomainError {
  return new DomainError(ERROR_CODES.EXTERNAL_MAPPING_IDENTIFIER_REQUIRED, {
    message: '외부코드·외부바코드·외부상품명 중 최소 하나가 필요합니다.',
    publicDetails: {
      fields: ['externalProductCode', 'externalBarcode', 'externalProductName'],
    },
  });
}

/**
 * prospective identifier 상태 → `mappingStatus`.
 *
 * @throws {DomainError} 422 — 식별자가 하나도 없을 때
 */
export function deriveMappingStatus(state: IdentifierState): MappingStatus {
  const hasCode = state.externalProductCode !== null;
  const hasBarcode = state.externalBarcode !== null;
  if (hasCode || hasBarcode) return MAPPING_STATUS_MATCHED;

  if (state.externalProductName !== null) return MAPPING_STATUS_REVIEW_REQUIRED;

  throw identifierRequired();
}

/**
 * `isPrimary = true` 는 `MATCHED` 에서만 허용된다 (§9).
 *
 * 상품명 기반(`REVIEW_REQUIRED`) 매핑은 자동 원장 반영 대상이 아니므로
 * (`02:479` ②) 대표로 세울 수 없다.
 */
export function primaryRequiresMatched(): DomainError {
  return new DomainError(ERROR_CODES.EXTERNAL_MAPPING_PRIMARY_REQUIRES_MATCHED, {
    message: '외부코드 또는 외부바코드가 있는 매핑만 대표로 지정할 수 있습니다.',
    publicDetails: { field: 'isPrimary' },
  });
}

/** interactive API 는 `UNMATCHED` 행을 변경하지 않는다 (§3). */
export function unmatchedNotInteractive(mappingId: string): DomainError {
  return new DomainError(ERROR_CODES.EXTERNAL_MAPPING_UNMATCHED_NOT_INTERACTIVE, {
    message: `매핑 '${mappingId}' 은(는) UNMATCHED 상태라 이 API 로 수정할 수 없습니다.`,
    context: { mappingId },
  });
}
