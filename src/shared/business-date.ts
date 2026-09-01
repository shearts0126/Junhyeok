/**
 * 업무일자 (T1-6B4 최소 추출) — 순수 함수만. 도메인 의존이 없다.
 *
 * ⚠️ 이 파일은 **새 규칙을 만든 것이 아니다.** T05-2 가
 *    `modules/external-mapping/application/effective-date.ts` 에 두었던 계산을
 *    **글자 그대로** 옮겨 온 것이며, 그 모듈은 이제 여기서 re-export 한다 —
 *    기존 semantics·테스트는 그대로다.
 *
 * 옮긴 이유: T1-6B4 supplier 요약이 같은 업무일자를 써야 하는데, supplier
 * 모듈이 external-mapping 모듈을 import 하면 **도메인 간 의존**이 생긴다.
 * 순수 date 계산은 어느 도메인의 것도 아니므로 shared 로 내린다.
 *
 * ⛔ 새 timezone/date framework 를 만들지 않는다. 여기 있는 것이 전부다.
 */

/** 업무일자 = `(now AT TIME ZONE 'Asia/Seoul')::date` (03 §공통 규약). */
export const BUSINESS_TIME_ZONE = 'Asia/Seoul';

/**
 * `YYYY-MM-DD` — `en-CA` 로케일이 ISO 형식을 준다.
 *
 * ⛔ `toISOString().slice(0,10)` 을 쓰지 않는다 — UTC 기준이라 KST 자정 직후에
 *    전날로 밀린다.
 */
export function businessDateOf(instant: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * `@db.Date` 컬럼값(UTC 자정 저장)을 `YYYY-MM-DD` 로.
 *
 * ★ 여기서는 `toISOString` 이 옳다 — 저장 자체가 UTC 자정이라 timezone 변환을
 *   하면 오히려 하루가 밀린다. 위 `businessDateOf` 와 용도가 다르다.
 */
export function dateOnlyOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** date-only 문자열 → UTC 자정 `Date`. DB `@db.Date` 와 같은 표현. */
export function parseBusinessDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * 재고 업무일자 (T2-4) — `(occurred_at AT TIME ZONE 'Asia/Seoul')::date`.
 *
 * ⚠️ 근거: `docs/03_ERD와_Prisma스키마_v0.2.md` §공통 규약 · `docs/00` **G-08** ·
 *    `docs/04` §8.12 의사코드(`const businessDate = toKstDate(cmd.occurredAt)`).
 *
 * `occurredAt` 이 **유일한 원천**이다 — `businessDate` 는 API 입력이 아니라
 * 서비스가 파생한다(`docs/04` PostingCommand 주석). 이 값이 일별·월별 집계,
 * 월마감, 수불부의 **유일 기준**이다(`docs/03` §452).
 *
 * ★ timezone 은 전사 **`Asia/Seoul` 고정**이다.
 * ⛔ `Warehouse.timezone` 을 쓰지 않는다 — 그것은 display·외부연동·현지운영
 *    metadata 이며 재고 업무일자의 기준이 아니다 (`docs/19 §W-D29`).
 *    창고 timezone 이 `America/Los_Angeles` 여도 업무일자는 KST 로 계산한다.
 *
 * ★ 반환은 **`Date`** 다 — Prisma `@db.Date` 컬럼
 *   (`InventoryTransaction.businessDate` · `InventoryLedgerEntry.businessDate`)
 *   에 그대로 넣을 수 있는 UTC 자정 표현이다. `businessDateOf` 의 `string` 과
 *   용도가 다르다.
 *
 * ⛔ 새 계산을 만들지 않는다 — 위 두 함수의 합성일 뿐이다. 같은 규칙이 두 벌이
 *    되면 어느 쪽이 정본인지 알 수 없게 된다.
 *
 * @example
 * // KST 09:00 — UTC 자정이지만 같은 날이다
 * toKstDate(new Date('2026-09-01T00:00:00.000Z'))  // 2026-09-01T00:00:00.000Z
 * // KST 익일 00:00
 * toKstDate(new Date('2026-09-01T15:00:00.000Z'))  // 2026-09-02T00:00:00.000Z
 */
export function toKstDate(occurredAt: Date): Date {
  return parseBusinessDate(businessDateOf(occurredAt, BUSINESS_TIME_ZONE));
}
