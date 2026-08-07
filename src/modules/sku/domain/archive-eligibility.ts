import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * SKU 폐기(ARCHIVED) 자격 (T1-2, TC-SKU-008) — **순수 도메인 규칙.**
 *
 * 확정 원칙 (02 §모듈 불변식 / 05 archive API):
 *
 *   **ARCHIVED 는 거래·BOM 사용 이력이 0건일 때만 가능하다.**
 *
 * ## 상태 전이와 별개다
 *
 *   `status-transition.ts` 의 `→ ARCHIVED` 허용은 "그 상태에서 폐기라는 전이가
 *   문법적으로 가능한가"이고, 이 규칙은 "사용 이력상 폐기해도 되는가"다.
 *   실제 폐기 워크플로(T1-4)는 **둘 다** 통과해야 한다.
 *
 * ## 사용 사실은 입력이다
 *
 *   BOM·재고 모델은 아직 없다(T1-2 시점). 이 규칙은 호출자가 판정해 온
 *   사실(`SkuUsageFacts`)만 본다 — 여기서 repository/query 를 부르지 않는다.
 *   향후 Application Service 가 실제 조회로 사실을 구해 전달한다.
 *
 *   `hasBomUsage` 는 **상위 SKU(parent)든 구성품(component)이든** BOM 에
 *   등장한 적이 있으면 true 다 — 계약을 한쪽으로 좁히지 않는다.
 */

export interface SkuUsageFacts {
  /** 재고 거래 이력이 존재하는가 */
  readonly hasTransaction: boolean;
  /** BOM 에 상위 SKU 또는 구성품으로 사용된 이력이 존재하는가 */
  readonly hasBomUsage: boolean;
}

/** 폐기를 막는 사유. */
export type SkuArchiveBlocker = 'TRANSACTION' | 'BOM_USAGE';

/** 폐기를 막는 사유 목록. 비어 있으면 폐기 가능. */
export function skuArchiveBlockers(facts: SkuUsageFacts): readonly SkuArchiveBlocker[] {
  const blockers: SkuArchiveBlocker[] = [];
  if (facts.hasTransaction) blockers.push('TRANSACTION');
  if (facts.hasBomUsage) blockers.push('BOM_USAGE');
  return blockers;
}

/** 거래·BOM 사용 이력이 없어 폐기 가능한가. */
export function canArchiveSku(facts: SkuUsageFacts): boolean {
  return skuArchiveBlockers(facts).length === 0;
}

/**
 * 사용 이력이 있으면 폐기를 차단한다.
 *
 * @throws {DomainError} `SKU_ARCHIVE_BLOCKED` / HTTP 422.
 *   `publicDetails.blockers` 로 사유(TRANSACTION / BOM_USAGE)를 구분한다 —
 *   하나의 오류코드 + 상세 구조.
 */
export function assertSkuArchivable(facts: SkuUsageFacts): void {
  const blockers = skuArchiveBlockers(facts);
  if (blockers.length === 0) return;

  throw new DomainError(ERROR_CODES.SKU_ARCHIVE_BLOCKED, {
    message: `사용 이력이 있어 폐기할 수 없습니다. (${blockers.join(', ')})`,
    publicDetails: { blockers },
    publicHint: '거래·BOM 이력이 있는 SKU 는 폐기 대신 사용중지(INACTIVE) 처리하세요.',
  });
}
