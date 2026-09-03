import type { TransactionType } from '@/generated/prisma/client';
import {
  ZERO,
  add,
  isEqual,
  isGreaterThanOrEqual,
  isLessThanOrEqual,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '@/shared/decimal';
import { DomainError, ERROR_CODES } from '@/shared/errors';

import type { StockKeyGroup } from './stock-key';

/**
 * LOT · 유통기한 · 시리얼 검증 (T2-8) — **순수 도메인 규칙.**
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.2(⑦) ·
 *    **§8.5 표**(규칙 7종) · §8.12:575·580(호출 지점) ·
 *    `docs/05_API와_화면설계_v0.2.md` §10.18:351-354(오류 7종 · 전부 422) ·
 *    `docs/07_개발백로그와_테스트전략_v0.2.md:156`(**T2-8**, 단위, `TC-INV-018`).
 *
 * ## 두 지점에서 검증한다
 *
 * ```
 * ⑦  assertLotExpirySerial   entry 단위 — 그룹화(⑧) **이전**
 * ⑦' assertSerialNetQty      그룹 net 단위 — 그룹화(⑧) **직후**
 * ```
 *
 * 시리얼 수량 규칙이 둘로 갈리는 이유다 — 개별 entry 는 반드시 `±1` 이지만,
 * 같은 시리얼이 여러 entry 로 들어오면 **합쳐진 뒤에야** 중복 차감이 보인다
 * (`docs/CHANGELOG_v0.2.md:72`).
 *
 * ## 순수하다
 *
 * ```
 * Prisma        0   (enum 은 type-only import — 런타임 의존이 아니다)
 * DB read/write 0
 * $transaction  0
 * ```
 *
 * ⛔ application 계층을 import 하지 않는다. `docs/04 §8.12:580` 의
 *    `assertSerialNetQty(groups, refs)` 에서 `refs` 는 application 의
 *    `PostingReferences` 지만, 그것을 domain 이 직접 참조하면 T2-6·T2-7 이
 *    지켜 온 계층 방향이 깨진다. 여기서는 **순수 lookup 함수**를 받는다 —
 *    의사코드는 architecture-neutral 로 읽고, 실제 배선은 orchestration
 *    소유자가 adapter 로 잇는다.
 *
 * ## 여기 없는 것
 *
 * ⛔ `INSUFFICIENT_SHELF_LIFE` — 차단/경고 여부와 설정 키가 정본에 없다
 *    (`04 v0.1 §8.5` *"(경고 또는 차단, 설정)"*, `05` 카탈로그 부재).
 *    `minimumRemainingDays` 도 함께 유예한다.
 * ⛔ `SERIAL_DUPLICATE` — "이미 **양수 잔량**" 은 현재고 조회를 요구한다.
 *    한 거래 **안의** 시리얼 중복은 `assertSerialNetQty` 가 잡는다.
 * ⛔ `DIRECT_LOT_EDIT_FORBIDDEN` — 카탈로그가 **`조정`**(`TB-2`) 소유로 명시.
 * ⛔ 잠금·음수재고 (**T2-9**) · 거래/원장/감사 INSERT (**T2-10**) ·
 *    `REVERSAL` 분기 (**T2-13**).
 */

// ═══════════════════════════════════════════════════════════════
// 입력 계약
// ═══════════════════════════════════════════════════════════════

/**
 * SKU 의 추적 관리 여부 — **정확히 3개.**
 *
 * `prisma/schema.prisma:372-374` 의 `lotManaged`·`expiryManaged`·`serialManaged`
 * 와 같은 이름·의미다.
 *
 * ⛔ `inventoryManaged` 를 넣지 않는다 — ⑥(**T2-5**) 소유이며 이미 landing 했다.
 * ⛔ `minimumRemainingDays`·`defaultShelfLifeDays` 를 넣지 않는다 — 이번 7규칙에
 *    쓰이지 않는 값을 미리 실으면 선구현이다.
 */
export interface SkuTrackingFlags {
  readonly lotManaged: boolean;
  readonly expiryManaged: boolean;
  readonly serialManaged: boolean;
}

/**
 * ⑦ 이 읽는 entry 값 — **정규화된 재고키 일부 + 수량.**
 *
 * ★ `lotNo`·`serialNo` 는 T2-6 이 이미 정규화한 값이다(`null|undefined|''|'-'`
 *   → `''`). ⛔ 여기서 다시 정규화하지 않고 trim·대소문자 변환도 하지 않는다.
 *
 * ★ `expiryDate` 는 **원본**이다. T2-6 의 `NormalizedEntry` 는
 *   `Omit<TEntry, keyof StockKey>` 이고 `expiryDate` 는 재고키 8열이 아니므로
 *   그대로 살아남는다. 필수 여부는 `expiryKey` 센티넬(`9999-12-31`)이 아니라
 *   이 원본으로 판정해야 한다 — 센티넬은 "미지정" 과 "실제 9999-12-31" 을
 *   구분하지 못한다.
 */
export interface LotExpirySerialEntry {
  readonly lotNo: string;
  readonly serialNo: string;
  readonly expiryDate?: Date | null | undefined;
  readonly quantityDelta: DecimalInput;
}

/** ⑦ 이 entry 밖에서 필요로 하는 값 — 정확히 2개. */
export interface LotExpirySerialContext {
  readonly transactionType: TransactionType;
  /** ★ 업무 발생 **일시**(UTC). ⛔ `businessDate`(T2-4 KST 파생)가 아니다. */
  readonly occurredAt: Date;
}

// ═══════════════════════════════════════════════════════════════
// 입고 거래유형 (`docs/03 v0.1:420`)
// ═══════════════════════════════════════════════════════════════

/**
 * 입고 거래유형 — **정확히 7종.**
 *
 * ⚠️ 근거: `docs/03_ERD와_Prisma스키마.md:420` 이 24종을 입고 7 / 출고 11 /
 *    조정·상태 6 으로 나눈다(라벨의 "22종" 은 집계 오기이며 실제 목록은 24개로
 *    schema enum 과 집합이 완전히 일치한다). v0.2 `docs/03` 에는 이 분류표가
 *    없어 v0.1 이 유일 정본이다.
 *
 * ⛔ module-private 다 — `docs/04 §8.5` 가 "입고" 라고만 쓰고 방향 판정 함수를
 *    공개 계약으로 정하지 않았다. 방향에 의존하는 규칙은 `EXPIRED_INBOUND`
 *    하나뿐이므로 24종 matrix 를 만들지 않는다.
 */
const INBOUND_TRANSACTION_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>([
  'OPENING_BALANCE',
  'PURCHASE_RECEIPT',
  'PRODUCTION_RECEIPT',
  'RETURN_RECEIPT',
  'WAREHOUSE_TRANSFER_IN',
  'ASSEMBLY_RECEIPT',
  'DISASSEMBLY_RECEIPT',
]);

const EMPTY_SENTINEL = '';
const ONE = toDecimal('1');
const MINUS_ONE = toDecimal('-1');

// ═══════════════════════════════════════════════════════════════
// ⑦ entry 단위 검증
// ═══════════════════════════════════════════════════════════════

/**
 * 검증 ⑦ — **entry 하나**의 LOT·유통기한·시리얼 (`docs/04 §8.5` · §8.12:575).
 *
 * | SKU 설정 | 규칙 | 오류 |
 * |---|---|---|
 * | `lotManaged = true` | `lotNo ≠ ''` | `LOT_REQUIRED_MISSING` |
 * | `lotManaged = false` | `lotNo` 가 들어오면 거부 | `LOT_NOT_ALLOWED` |
 * | `expiryManaged = true` | `expiryDate` 필수 | `EXPIRY_REQUIRED_MISSING` |
 * | `expiryManaged = true` + **입고** | `expiryDate > occurredAt` | `EXPIRED_INBOUND` |
 * | `serialManaged = true` | `serialNo ≠ ''` | `SERIAL_REQUIRED_MISSING` |
 * | `serialManaged = true` | 개별 `|quantityDelta| = 1` | `SERIAL_QTY_INVALID` |
 *
 * ⛔ `expiryManaged = false` 인데 `expiryDate` 가 들어온 경우를 거부하지 않는다 —
 *    `EXPIRY_NOT_ALLOWED` 규칙이 정본에 **없다**. `serialManaged = false` +
 *    `serialNo` 도 같다. LOT 만 명시적 거부 규칙(`LOT_NOT_ALLOWED`)을 가진다.
 *
 * ⛔ 규칙 간 **판정 순서를 계약으로 고정하지 않는다** — 정본이 정하지 않았다.
 *    아래 구현 순서는 기계적인 것이며 여러 규칙이 동시에 깨졌을 때 어느 것이
 *    먼저 던져지는지는 계약이 아니다.
 *
 * @throws {DomainError} 위 6종 중 하나 (전부 422)
 */
export function assertLotExpirySerial(
  sku: SkuTrackingFlags,
  entry: LotExpirySerialEntry,
  context: LotExpirySerialContext,
): void {
  assertLot(sku, entry);
  assertExpiry(sku, entry, context);
  assertSerialEntry(sku, entry);
}

function assertLot(sku: SkuTrackingFlags, entry: LotExpirySerialEntry): void {
  if (sku.lotManaged) {
    if (entry.lotNo === EMPTY_SENTINEL) {
      throw new DomainError(ERROR_CODES.LOT_REQUIRED_MISSING);
    }
    return;
  }

  // `lotManaged = false` 에서 LOT 이 들어오면 버킷이 쪼개져 재고가 흩어진다.
  if (entry.lotNo !== EMPTY_SENTINEL) {
    throw new DomainError(ERROR_CODES.LOT_NOT_ALLOWED);
  }
}

function assertExpiry(
  sku: SkuTrackingFlags,
  entry: LotExpirySerialEntry,
  context: LotExpirySerialContext,
): void {
  if (!sku.expiryManaged) return;

  const expiryDate = entry.expiryDate;
  if (expiryDate === null || expiryDate === undefined) {
    throw new DomainError(ERROR_CODES.EXPIRY_REQUIRED_MISSING);
  }

  if (!INBOUND_TRANSACTION_TYPES.has(context.transactionType)) return;

  // ★ `>` 다 — 같은 시각이면 차단한다(`docs/04 §8.5:304`). ⛔ `>=` 로 완화하지
  //   않고, 비교 기준도 `occurredAt` 이지 `businessDate` 가 아니다.
  if (expiryDate.getTime() > context.occurredAt.getTime()) return;

  throw new DomainError(ERROR_CODES.EXPIRED_INBOUND);
}

function assertSerialEntry(sku: SkuTrackingFlags, entry: LotExpirySerialEntry): void {
  if (!sku.serialManaged) return;

  if (entry.serialNo === EMPTY_SENTINEL) {
    throw new DomainError(ERROR_CODES.SERIAL_REQUIRED_MISSING);
  }

  // 개별 entry 는 정확히 ±1. `1.000000` 도 1 이다 — Decimal 비교이므로 표기와
  // 무관하게 값으로 판정한다. ⛔ Number 변환·epsilon 비교를 하지 않는다.
  const quantityDelta = toDecimal(entry.quantityDelta);
  if (isEqual(quantityDelta, ONE) || isEqual(quantityDelta, MINUS_ONE)) return;

  throw new DomainError(ERROR_CODES.SERIAL_QTY_INVALID);
}

// ═══════════════════════════════════════════════════════════════
// ⑦' 그룹 net 단위 검증
// ═══════════════════════════════════════════════════════════════

/**
 * 검증 ⑦' — **시리얼 그룹의 net 수량** (`docs/04 §8.5:307` · §8.12:580).
 *
 * ```
 * serialManaged = true 인 재고키 그룹은  |netQuantityDelta| ≤ 1
 * ```
 *
 * ## 왜 ⑦ 만으로는 부족한가
 *
 * ⑦ 은 entry 하나씩만 본다. 개별 entry 가 전부 `±1` 이어도 **같은 시리얼이 두 번**
 * 들어오면 합계가 `±2` 가 된다 —
 *
 * ```
 * SERIAL-001 +1
 * SERIAL-001 +1      개별로는 둘 다 |1| ✅ / net = +2 ❌
 * ```
 *
 * 그래서 T2-6 그룹화 **직후**에 한 번 더 본다(`CHANGELOG_v0.2.md:72`).
 *
 * ★ `net = 0`(`+1` / `−1`)은 **통과**한다 — `|0| ≤ 1` 이다. T2-6 이 zero-net
 *   그룹을 보존하는 계약과 정합하며, ⛔ 여기서 그룹을 제거·변형하지 않는다.
 *
 * @param groups T2-6 `groupByStockKey()` 의 결과.
 * @param getSkuTracking 검증된 SKU 의 추적 flag 를 돌려주는 **순수 lookup**.
 *   ⛔ DB 를 읽지 않는다. SKU 존재 검증은 ②(**T2-5**)가 이미 끝냈으므로
 *   여기서 미존재 SKU 의 business behavior 를 새로 정의하지 않는다.
 * @throws {DomainError} `SERIAL_NET_QTY_INVALID`(422)
 */
export function assertSerialNetQty<TEntry>(
  groups: readonly StockKeyGroup<TEntry>[],
  getSkuTracking: (skuId: string) => SkuTrackingFlags,
): void {
  for (const group of groups) {
    if (!getSkuTracking(group.key.skuId).serialManaged) continue;

    const net: Decimal = add(ZERO, group.netQuantityDelta);
    if (isLessThanOrEqual(net, ONE) && isGreaterThanOrEqual(net, MINUS_ONE)) continue;

    throw new DomainError(ERROR_CODES.SERIAL_NET_QTY_INVALID);
  }
}
