/**
 * `SupplyType` 표시 계약 — **저장소 전체에서 유일한 한글 라벨 정의**다.
 *
 * ⚠️ 이 파일에는 import 가 없다. 순수 상수·순수 함수만 두어 서버(route·service)와
 *    클라이언트 번들 양쪽에서 안전하게 쓰인다. Prisma 런타임을 끌고 오는
 *    `@/modules/supplier/application` barrel 과는 별개 경로다.
 *
 * ## 왜 화면 밖에 있나
 *
 * 라벨은 원래 T06-4 관리화면 전용 모듈(`app/master/suppliers/[id]/terms-form.ts`)
 * 에 있었다. T1-6B4 가 SKU 상세 ⑥ 공급조건 탭에서 같은 라벨을 쓰게 되면서
 * 같은 매핑이 두 화면에 복제됐고, "값이 같음"을 테스트로 고정하는 것은
 * **하나의 source of truth 가 아니다**. 두 화면이 언제든 갈릴 수 있기 때문이다.
 * 그래서 표시 전용 helper 만 supplier 모듈의 presentation 계층으로 옮겼다.
 *
 * 값 자체는 T06-4 가 확정한 것 그대로이며 의미 변경이 없다.
 * 근거: `docs/01:161`·`docs/03:48` 의 `사급/턴키` 표기와 enum 선언 순서.
 *
 * ⛔ API payload 에는 **enum 원문**(`SELF_SUPPLIED`/`TURNKEY`)을 쓴다 —
 *    라벨은 표시 전용이며 요청·응답에 절대 들어가지 않는다.
 * ⛔ 세 번째 값을 발명하지 않는다 (T06-1 `SupplyType` enum 과 동일한 2종).
 */

/** 선언 순서 = 화면 select 의 옵션 순서다. */
export const SUPPLY_TYPE_VALUES = ['SELF_SUPPLIED', 'TURNKEY'] as const;

export type SupplyTypeValue = (typeof SUPPLY_TYPE_VALUES)[number];

/** ★ 저장소 유일한 한글 라벨 매핑. 복제본을 만들지 않는다. */
export const SUPPLY_TYPE_LABELS: Readonly<Record<SupplyTypeValue, string>> = {
  SELF_SUPPLIED: '사급',
  TURNKEY: '턴키',
};

/** 알 수 없는 값은 **원문 그대로** — 임의 라벨을 만들지 않는다. */
export function supplyTypeLabel(value: string): string {
  return (SUPPLY_TYPE_LABELS as Record<string, string | undefined>)[value] ?? value;
}
