import { describe, expect, it } from 'vitest';

import { BUSINESS_TIME_ZONE, businessDateOf, parseBusinessDate, toKstDate } from './business-date';

/**
 * 업무일자 KST 파생 (T2-4 = legacy `T09-2`).
 *
 * ⚠️ 근거: `docs/03_ERD와_Prisma스키마_v0.2.md` §공통 규약
 *          — `business_date DATE = (occurred_at AT TIME ZONE 'Asia/Seoul')::date`
 *    `docs/00_요구사항_이해와_충돌검토_v0.2.md` **G-08** (✅ 승인)
 *    `docs/07_개발백로그와_테스트전략_v0.2.md` T2-4 완료조건 · §429 단위 matrix
 *          — `UTC 15:00 → KST 익일 / UTC 14:59 → 당일 / 월말·연말 경계`
 *    `docs/07_개발백로그와_테스트전략.md` §323 — `DST 없음 확인`
 *
 * ★ 모든 input 은 **고정 ISO 타임스탬프**다.
 * ⛔ `new Date()` · `Date.now()` 를 쓰지 않는다 — 오늘 날짜에 따라 결과가
 *    달라지는 테스트는 경계 계약을 증명하지 못한다.
 *
 * ⛔ **문서가 정하지 않은 것을 고정하지 않는다** (T2-3 REVIEW FIX 원칙):
 *    `Invalid Date` · `null`/`undefined` 처리 계약이 정본에 없으므로 그 동작을
 *    허용으로도 금지로도 테스트하지 않는다. 밀리초 단위 경계
 *    (`14:59:59.999Z`)도 authoritative 목록에 없어 별도 계약으로 굳히지 않는다.
 *    authoritative 경계는 `UTC 14:59` · `UTC 15:00` 이다.
 */

/** 검증을 읽기 쉽게 — 반환 Date 를 `YYYY-MM-DD` 로 본다. */
function kstDateText(iso: string): string {
  return toKstDate(new Date(iso)).toISOString().slice(0, 10);
}

describe('T2-4. toKstDate — (occurred_at AT TIME ZONE Asia/Seoul)::date', () => {
  it('★ timezone 은 Asia/Seoul 고정이다', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Seoul');
  });

  it('13. ★★ 일반 케이스 — UTC 자정은 KST 09:00 이라 같은 날이다', () => {
    // v0.1 완료조건 원문: UTC 2026-09-01T00:00Z → 2026-09-01 (KST 09:00 = 동일일)
    expect(toKstDate(new Date('2026-09-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('14. ★★ UTC 14:59 → KST 23:59 — 당일', () => {
    expect(kstDateText('2026-09-01T14:59:00.000Z')).toBe('2026-09-01');
  });

  it('15. ★★ UTC 15:00 → KST 익일 00:00 — 익일', () => {
    expect(kstDateText('2026-09-01T15:00:00.000Z')).toBe('2026-09-02');
  });

  it('16. ★ 월말 경계 — UTC 15:00 에 월이 넘어간다', () => {
    expect(kstDateText('2026-01-31T15:00:00.000Z')).toBe('2026-02-01');
    // 같은 날 14:59 는 아직 1월이다.
    expect(kstDateText('2026-01-31T14:59:00.000Z')).toBe('2026-01-31');
  });

  it('17. ★ 연말 경계 — UTC 15:00 에 해가 넘어간다', () => {
    expect(kstDateText('2026-12-31T15:00:00.000Z')).toBe('2027-01-01');
    expect(kstDateText('2026-12-31T14:59:00.000Z')).toBe('2026-12-31');
  });

  it('18. ★★ DST 없음 — 겨울·여름이 같은 +9h 경계를 갖는다', () => {
    // Asia/Seoul 은 DST 를 쓰지 않으므로 1월과 7월의 15:00Z 경계가 동일하다.
    // ⛔ 역사적 timezone 규칙 전체를 검증하지 않는다 — 대표 2개면 충분하다.
    expect(kstDateText('2026-01-15T14:59:00.000Z')).toBe('2026-01-15');
    expect(kstDateText('2026-01-15T15:00:00.000Z')).toBe('2026-01-16');

    expect(kstDateText('2026-07-15T14:59:00.000Z')).toBe('2026-07-15');
    expect(kstDateText('2026-07-15T15:00:00.000Z')).toBe('2026-07-16');
  });

  it('19. ★★ 반환 타입은 Date 이며 UTC 자정이다 (Prisma @db.Date 호환)', () => {
    const result = toKstDate(new Date('2026-09-01T15:00:00.000Z'));

    expect(result).toBeInstanceOf(Date);
    // `@db.Date` 는 UTC 자정으로 저장된다 — 시·분·초·밀리초가 전부 0이어야 한다.
    expect(result.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });

  it('★ 기존 두 함수의 합성이다 — 같은 규칙을 두 벌 만들지 않았다', () => {
    for (const iso of [
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T14:59:00.000Z',
      '2026-09-01T15:00:00.000Z',
      '2026-12-31T15:00:00.000Z',
    ]) {
      const instant = new Date(iso);
      expect(toKstDate(instant).toISOString(), iso).toBe(
        parseBusinessDate(businessDateOf(instant)).toISOString(),
      );
    }
  });

  it('⛔ 서버 timezone 에 의존하지 않는다 — Intl 이 IANA 규칙으로 계산한다', () => {
    // `Asia/Seoul` 을 명시 전달한 결과와 기본값이 같다. 실행 환경 TZ 를
    // 바꾸지 않고도 고정 규칙임을 확인한다.
    const instant = new Date('2026-09-01T15:00:00.000Z');
    expect(businessDateOf(instant, 'Asia/Seoul')).toBe('2026-09-02');
    expect(businessDateOf(instant)).toBe('2026-09-02');
    // 대조군 — UTC 로 보면 아직 당일이다. 그래서 KST 고정이 필요하다.
    expect(businessDateOf(instant, 'UTC')).toBe('2026-09-01');
  });
});
