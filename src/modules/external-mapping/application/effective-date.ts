import { BUSINESS_TIME_ZONE, businessDateOf, dateOnlyOf } from '@/shared/business-date';
import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * 적용 종료일(매핑 해제) 규칙 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §8.
 *
 * DELETE endpoint 는 만들지 않는다 — 원 API 문서에 없다. 화면의 "매핑 해제"
 * (`05:343`)는 **PATCH `effectiveTo`** 로 표현한다.
 *
 * ## 규칙
 *
 *   - `null → date` 만 허용. 재활성(`date → null`)은 V1 범위 밖이며 DTO 가 막는다.
 *   - `effectiveTo <= 오늘(Asia/Seoul 업무일자)` — **미래일 종료 금지**.
 *   - 기존 `effectiveFrom` 이 있으면 `effectiveTo >= effectiveFrom`.
 *
 * ★ 근거: T05-1 의 `ux_external_mapping_code` predicate 가
 *   `effective_to IS NULL` 을 **"현행"의 정의**로 쓴다. 미래일 종료를 허용하면
 *   "아직 유효하지만 이미 predicate 밖"인 행이 생겨 현행 유일성이 무너진다.
 *
 * ⛔ `effective_from <= effective_to` DB CHECK 를 추가하지 않는다 — T05-1 결정
 *    유지. 이것은 application 계층의 입력 규칙이다.
 */

/**
 * 업무일자 계산은 `@/shared/business-date` 로 옮겼다 (T1-6B4 최소 추출) —
 * supplier 요약이 같은 날짜 규칙을 써야 하는데 도메인 간 import 를 만들지 않기
 * 위해서다. **계산은 한 글자도 바뀌지 않았고** 기존 import 경로도 그대로
 * 동작하도록 여기서 re-export 한다.
 */
export { BUSINESS_TIME_ZONE, businessDateOf };

/** `@db.Date` 컬럼값을 `YYYY-MM-DD` 로 (UTC 자정 저장). */
export const toDateOnly = dateOnlyOf;

function invalid(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError(ERROR_CODES.EXTERNAL_MAPPING_EFFECTIVE_DATE_INVALID, {
    message,
    publicDetails: { field: 'effectiveTo', ...details },
  });
}

/**
 * 종료일 입력을 검증하고 저장할 `Date` 를 만든다.
 *
 * @throws {DomainError} 422 — 미래일이거나 `effectiveFrom` 보다 이르면
 */
export function resolveEffectiveTo(
  effectiveTo: string,
  effectiveFrom: Date | null,
  now: Date = new Date(),
): Date {
  const today = businessDateOf(now);
  if (effectiveTo > today) {
    throw invalid('종료일은 오늘 이후일 수 없습니다.', { effectiveTo, today });
  }

  if (effectiveFrom !== null) {
    const from = toDateOnly(effectiveFrom);
    if (effectiveTo < from) {
      throw invalid('종료일은 적용 시작일보다 이를 수 없습니다.', {
        effectiveTo,
        effectiveFrom: from,
      });
    }
  }

  return new Date(`${effectiveTo}T00:00:00.000Z`);
}

/** 이미 종료된 매핑은 이력이다 — 후속 수정을 허용하지 않는다 (§8). */
export function mappingEnded(mappingId: string, effectiveTo: Date): DomainError {
  return new DomainError(ERROR_CODES.EXTERNAL_MAPPING_ENDED, {
    message: `매핑 '${mappingId}' 은(는) ${toDateOnly(effectiveTo)} 에 종료되어 수정할 수 없습니다.`,
    context: { mappingId },
    publicDetails: { effectiveTo: toDateOnly(effectiveTo) },
  });
}

/**
 * 대표 매핑을 종료하려면 같은 PATCH 에서 `isPrimary=false` 를 **명시**해야 한다 (§9).
 *
 * ★ 자동으로 내려주지 않는다. T05-1 의 primary predicate 는 `effective_to` 를
 *   보지 않으므로, 종료된 행이 `isPrimary=true` 로 남으면 그 (SKU, 시스템)
 *   조합의 새 대표를 **영구히** 막는다. 그 상태를 만들지 않기 위한 규칙이다.
 */
export function primaryMustBeClearedBeforeEnd(mappingId: string): DomainError {
  return new DomainError(ERROR_CODES.EXTERNAL_MAPPING_PRIMARY_MUST_BE_CLEARED_BEFORE_END, {
    message: `대표 매핑 '${mappingId}' 을(를) 종료하려면 같은 요청에서 isPrimary=false 를 지정해야 합니다.`,
    context: { mappingId },
    publicDetails: { fields: ['effectiveTo', 'isPrimary'] },
  });
}
