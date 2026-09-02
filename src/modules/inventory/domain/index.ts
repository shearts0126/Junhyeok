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

export {
  DEFAULT_OWNER_CODE,
  EMPTY_SENTINEL,
  EXPIRY_KEY_SENTINEL_TEXT,
  expiryKeySentinel,
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
