import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * BOM 편집 가능 상태 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-6 "편집 가능 상태 요약" 표.
 *
 * | status | header PATCH | line 추가/수정 | line 삭제 |
 * |---|:-:|:-:|:-:|
 * | `DRAFT` | ✅ | ✅ | ✅ |
 * | `REJECTED` | ✅ | ✅ | ✅ |
 * | `PENDING_APPROVAL` | ⛔ | ⛔ | ⛔ |
 * | `APPROVED` | ⛔ | ⛔ | ⛔ |
 * | `ACTIVE` | ⛔ `BOM_ACTIVE_IMMUTABLE` | ⛔ | ⛔ |
 * | `INACTIVE`·`ARCHIVED` | ⛔ | ⛔ | ⛔ |
 *
 * ★ 세 열의 허용 집합이 **완전히 같다** — `DRAFT`·`REJECTED` 뿐이다. 그래서
 *   판정 함수를 하나로 둔다(`05:123` 의 line DELETE `DRAFT/REJECTED만` 과 정합).
 * ★ `ACTIVE` 만 `BOM_ACTIVE_IMMUTABLE`(원문 코드 `05v2:352`)이고, 나머지
 *   편집 불가 상태는 `BOM_NOT_EDITABLE` 다 — 두 오류를 합치지 않는다.
 *
 * ⛔ generic status transition 을 여기서 구현하지 않는다 — 상태 변경은 전용
 *    endpoint 로만 하며 T07-5 의 몫이다.
 */

export const BOM_EDITABLE_STATUSES: readonly string[] = ['DRAFT', 'REJECTED'];

export function isBomEditable(status: string): boolean {
  return BOM_EDITABLE_STATUSES.includes(status);
}

export function bomActiveImmutable(bomId: string): DomainError {
  return new DomainError(ERROR_CODES.BOM_ACTIVE_IMMUTABLE, {
    message: '활성 BOM 은 수정할 수 없습니다. 새 버전을 생성하세요.',
    context: { bomId, status: 'ACTIVE' },
    publicHint: '새 버전을 생성해 변경하세요.',
  });
}

export function bomNotEditable(bomId: string, status: string): DomainError {
  return new DomainError(ERROR_CODES.BOM_NOT_EDITABLE, {
    message: `상태 '${status}' 인 BOM 은 수정할 수 없습니다.`,
    context: { bomId, status },
    publicDetails: { status },
  });
}

/**
 * 편집 가능 상태 가드.
 *
 * ⚠️ **트랜잭션 안에서 lock 을 잡은 뒤 다시 부른다** — 선조회 결과를 그대로
 *    믿으면 동시 activate 와 경합한다.
 *
 * @throws 422 `BOM_ACTIVE_IMMUTABLE` (ACTIVE) · 422 `BOM_NOT_EDITABLE` (그 밖)
 */
export function assertBomEditable(bomId: string, status: string): void {
  if (isBomEditable(status)) return;
  if (status === 'ACTIVE') throw bomActiveImmutable(bomId);
  throw bomNotEditable(bomId, status);
}
