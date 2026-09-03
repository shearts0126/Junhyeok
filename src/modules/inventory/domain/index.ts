/**
 * 재고 도메인 규칙 (T2-6) — **순수 함수만.**
 *
 * ⚠️ 근거: `docs/07_개발백로그와_테스트전략_v0.2.md:377` 이 **"도메인 순수 함수 —
 *    상태전이, ✏️ 재고키 그룹화, 순환탐지, 바코드 정규화, `business_date` 파생"**
 *    으로 재고키 그룹화를 이 계층에 배정했다. `sku/domain` · `bom/domain` 과
 *    같은 자리다.
 *
 * ⛔ DB·요청·프레임워크에 의존하지 않는다. Prisma 접근 0 · `$transaction` 0.
 * ⛔ application 계층을 import 하지 않는다 — 필요한 외부 값은 호출자가 넘긴다.
 *
 * ## 아직 없는 것
 *
 * ⛔ 잠금·음수재고·balance (**T2-9**) · 거래/원장/감사 INSERT (**T2-10**).
 */

/**
 * ## T2-6 공개 함수는 정확히 5개다
 *
 * `docs/07:154` 가 명명한 4개 + `normalizeEntries`(**Deviation #76** — T2-6 이
 * `lineNo = index + 1` 을 소유하는데 `normalizeStockKey` 는 재고키 정규화
 * 함수라 그 pass 를 담을 자리가 필요하다).
 *
 * ⛔ 센티넬 상수·헬퍼(`EMPTY_SENTINEL` · `DEFAULT_OWNER_CODE` ·
 *    `EXPIRY_KEY_SENTINEL_TEXT` · `expiryKeySentinel`)를 export 하지 않는다 —
 *    T2-2 가 DB 에 고정한 값의 **구현 세부사항**이며, 외부가 직접 써야 한다는
 *    정본 근거가 없다. 정규화 결과는 `normalizeStockKey()` 로만 얻는다.
 *
 * 타입 6종은 위 공개 함수의 signature 를 표현하기 위한 것이며 새 business
 * concept 가 아니다.
 */
export {
  groupByStockKey,
  hashStockKey,
  netQuantityDelta,
  normalizeEntries,
  normalizeStockKey,
  type NormalizedEntry,
  type QuantityBearing,
  type StockKey,
  type StockKeyDraft,
  type StockKeyGroup,
  type StockKeyNormalizationContext,
} from './stock-key';

/**
 * ## T2-7 공개 함수는 정확히 2개다
 *
 * `docs/04 §8.12` 가 이름까지 명명한 검증 ⑨·⑩ 두 개다.
 *
 * ⛔ 내부 헬퍼(`isTransitionAllowed` · `isStatusMoveType` · 전이표 ·
 *    거래유형 family 표 · 7열/5열 balance-key picker · 직렬화 구분자)를
 *    export 하지 않는다 — 전부 위 두 함수의 **구현 세부사항**이고, 외부가
 *    직접 써야 한다는 정본 근거가 없다. T2-6 이 센티넬에 내린 판단과 같다.
 * ⛔ 새 타입도 내보내지 않는다 — 두 함수의 signature 는 T2-6 의
 *    `StockKeyGroup` 과 Prisma enum 만으로 표현된다.
 */
export { assertBalancedIfStatusMove, assertStatusTransitionByNet } from './status-transition';

/**
 * ## T2-8 공개 함수는 정확히 2개다
 *
 * `docs/04 §8.12:575·580` 이 이름까지 명명한 검증 ⑦·⑦' 두 개다.
 *
 * ⛔ 내부 헬퍼(입고 거래유형 집합 · LOT/유통기한/시리얼 개별 판정)를 export
 *    하지 않는다. 특히 **입고 여부 판정 함수**를 공개하지 않는다 — 정본은
 *    `docs/04 §8.5` 에서 "입고" 라고만 쓰고 방향 판정을 공개 계약으로 정하지
 *    않았으며, 방향에 의존하는 규칙은 `EXPIRED_INBOUND` 하나뿐이다.
 *
 * 타입 3종은 위 두 함수의 signature 를 표현하기 위한 것이며, ⛔ `ShelfLifePolicy`
 * 같은 새 business concept 가 아니다.
 */
export {
  assertLotExpirySerial,
  assertSerialNetQty,
  type LotExpirySerialContext,
  type LotExpirySerialEntry,
  type SkuTrackingFlags,
} from './lot-expiry-serial';
