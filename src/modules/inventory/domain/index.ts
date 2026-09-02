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
 * ⛔ 상태전이·거래균형 (**T2-7**) — `netQuantityDelta` 의 **부호를 해석**하는
 *    순간부터 T2-7 이다. `PENDING_v0.3 §5`(거래유형별 균형 검증 전략 분리)가
 *    T2-7 착수 전 별도 Recovery 대상이다.
 * ⛔ LOT·유통기한·시리얼 검증 (**T2-8**) · 잠금·음수재고·balance (**T2-9**) ·
 *    거래/원장/감사 INSERT (**T2-10**).
 */

/**
 * ## 공개 함수는 정확히 5개다
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
