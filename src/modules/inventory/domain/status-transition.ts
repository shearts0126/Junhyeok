import type { InventoryStatus, TransactionType } from '@/generated/prisma/client';
import {
  ZERO,
  add,
  isGreaterThan,
  isNegative,
  isZero,
  toDecimalString,
  type Decimal,
} from '@/shared/decimal';
import { DomainError, ERROR_CODES } from '@/shared/errors';

import type { StockKey, StockKeyGroup } from './stock-key';

/**
 * 재고상태 전이 검증 · 거래유형별 균형 검증 (T2-7) — **순수 도메인 규칙.**
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.2(⑨ 상태전이 ·
 *    ⑩ 거래 균형) · §8.4(전이표 · 그룹 net 규칙) · §8.12(`assertStatusTransitionByNet`
 *    · `assertBalancedIfStatusMove` 본문) · `docs/07_개발백로그와_테스트전략_v0.2.md:155`
 *    (**T2-7**) · `docs/PENDING_v0.3_보완사항.md` **§5**(거래유형별 균형 검증
 *    Validation Strategy 분리) · `docs/00` **C-13**.
 *
 * ## 두 가지 검증을 담는다
 *
 * ```
 * ⑨ assertStatusTransitionByNet   그룹 net 부호로 from/to 를 판정하고 전이표 대조
 * ⑩ assertBalancedIfStatusMove    거래유형 family 별 balance-key 단위 Σ net = 0
 * ```
 *
 * 둘 다 T2-6 이 만든 `StockKeyGroup[]` 만 읽는다. `netQuantityDelta` 의
 * **부호를 해석**하는 것부터가 T2-7 이다.
 *
 * ## 순수하다
 *
 * ```
 * Prisma        0   (enum 은 type-only import — 런타임 의존이 아니다)
 * DB read/write 0
 * $transaction  0
 * ```
 *
 * ⛔ application 계층을 import 하지 않는다 — `PostingCommand` · `PostingPhase1` ·
 *    `PostingReferences` 어느 것도 참조하지 않는다. 인자는 `transactionType` 과
 *    `groups` **둘뿐**이다.
 *
 * ## 여기 없는 것
 *
 * ⛔ LOT·유통기한·시리얼 검증 (**T2-8**) · 잠금·음수재고·balance 갱신 (**T2-9**) ·
 *    거래/원장/감사 INSERT (**T2-10**) · `REVERSAL` 분기 (**T2-13**).
 */

// ═══════════════════════════════════════════════════════════════
// 상태이동 거래유형 · 균형 family
// ═══════════════════════════════════════════════════════════════

/**
 * 균형 검증 단위 — `PENDING_v0.3 §5` 가 거래유형별로 나눈 두 단계.
 *
 * ⛔ 여기 없는 거래유형은 **균형 검증 대상이 아니다**(exempt). 조립·분해와
 *    일반 입고·출고·조정이 그렇다 — §5 가 명시적으로 "전체 합계 0 을 요구하지
 *    않는다" / "균형 검증 대상 아님" 으로 확정했다.
 */
type BalanceLevel =
  /** 재고키 8열에서 `inventoryStatus` 만 뺀 **7열**. 같은 자리에서 상태만 옮긴다. */
  | 'STATUS_LEVEL'
  /** 7열에서 `warehouseId`·`locationId` 를 더 뺀 **5열**. 창고를 건너 옮긴다. */
  | 'WAREHOUSE_LEVEL';

/**
 * 상태이동 거래유형 → 균형 단위. **이 표가 ⑨ 와 ⑩ 를 동시에 지배한다** —
 * 여기 키로 있는 거래유형만 상태이동(`isStatusMoveType`)이고, 그 값이 곧
 * ⑩ 의 balance-key 선택이다.
 *
 * ⚠️ 근거: `docs/04 §8.0:28` 이 상태이동 거래를 **`STATUS_CHANGE` ·
 *    `RESERVATION*` · `WAREHOUSE_TRANSFER_*` 정확히 3계열**로 열거한다.
 *    `PENDING_v0.3 §5` 가 그 3계열을 다시 7열/5열 두 단위로 나눈다.
 *
 * ⛔ `ASSEMBLY_*` · `DISASSEMBLY_*` 를 넣지 않는다 — §5 가 "전체 합계 0 을
 *    요구하지 않는다. **조립지시서 + BOM 기준 검증**" 으로 확정했고, 그 실제
 *    검증은 **R3(세트조립·해체 실행, `docs/00 v0.2 §1.4`)** 소유다. R1a-2 에
 *    호출자가 없으므로 port 도 만들지 않는다.
 * ⛔ `REVERSAL` 전용 분기를 넣지 않는다 — 원거래 semantics 와 함께 **T2-13**
 *    이 다룬다.
 */
const BALANCE_LEVEL_BY_TRANSACTION_TYPE: Readonly<Partial<Record<TransactionType, BalanceLevel>>> =
  {
    STATUS_CHANGE: 'STATUS_LEVEL',
    RESERVATION: 'STATUS_LEVEL',
    RESERVATION_RELEASE: 'STATUS_LEVEL',
    // 한 leg = 한 거래 = 두 원장행이며 그 안에서 상쇄된다 (`docs/00` **C-02**) —
    // 출발창고 `AVAILABLE −Q` + 이동중창고 `IN_TRANSIT +Q`. 창고가 다르므로
    // 7열로는 절대 상쇄되지 않고, 그래서 5열이다.
    WAREHOUSE_TRANSFER_OUT: 'WAREHOUSE_LEVEL',
    WAREHOUSE_TRANSFER_IN: 'WAREHOUSE_LEVEL',
  };

/** 상태이동 거래유형인가. ⑨ 와 ⑩ 가 같은 판정을 쓴다. */
function isStatusMoveType(transactionType: TransactionType): boolean {
  return BALANCE_LEVEL_BY_TRANSACTION_TYPE[transactionType] !== undefined;
}

// ═══════════════════════════════════════════════════════════════
// 허용 전이표 (`docs/04 §8.4`)
// ═══════════════════════════════════════════════════════════════

/**
 * 상태별 허용 next 상태 — **내부 `InventoryStatus` → `InventoryStatus` 전이만.**
 * 9개 상태 전부 키로 존재한다 (빠뜨림 방지, 테스트가 개수를 고정한다).
 *
 * 합계 **15종**이다.
 *
 * ⚠️ 전이표의 10번째 열 **`외부반출`** 은 `InventoryStatus` 가 아니라 재고가
 *    시스템 밖으로 나가는 사건이다. `(from, to)` 두 상태로 표현할 수 없으므로
 *    이 표에 넣지 않는다 — ⛔ `OUTSIDE`·`SHIPPED`·`EXTERNAL` 같은 pseudo status
 *    를 만들지 않고, `to` 를 `null` 로 두지도 않는다. `HOLD → 외부반출` 차단은
 *    **TB-12 / TC-INV-011** 소유다.
 *
 * ⚠️ 동일 상태 → 동일 상태는 표에서 `—` 이며 허용 근거가 없다 → **false**.
 *    (`docs/04 §8.4` 의 net 규칙상 같은 재고키에서는 애초에 불가능하고, 서로
 *    다른 재고키 사이에서만 나타날 수 있다. `NOT SPECIFIED ≠ ALLOWED`.)
 */
const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<InventoryStatus, readonly InventoryStatus[]>> = {
  AVAILABLE: ['RESERVED', 'HOLD', 'IN_TRANSIT'],
  RESERVED: ['AVAILABLE', 'OUTBOUND_PENDING'],
  OUTBOUND_PENDING: ['AVAILABLE'],
  HOLD: ['AVAILABLE', 'DEFECTIVE'],
  INSPECTION: ['AVAILABLE', 'DEFECTIVE'],
  DEFECTIVE: ['DISPOSAL_PENDING'],
  RETURN_PENDING: ['AVAILABLE', 'DEFECTIVE'],
  // 폐기 확정은 외부반출이며 내부 전이가 없다.
  DISPOSAL_PENDING: [],
  IN_TRANSIT: ['AVAILABLE', 'INSPECTION'],
};

/** 내부 상태 전이가 허용되는가. */
function isTransitionAllowed(from: InventoryStatus, to: InventoryStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

// ═══════════════════════════════════════════════════════════════
// ⑨ 상태전이 검증 (그룹 net 기준)
// ═══════════════════════════════════════════════════════════════

/**
 * 검증 ⑨ — **그룹 net 부호로 from/to 를 판정하고 전이표와 대조한다**
 * (`docs/04 §8.4` 규칙 1~4 · §8.12:766).
 *
 * ```
 * netQuantityDelta < 0  → from 버킷
 * netQuantityDelta > 0  → to   버킷
 * netQuantityDelta = 0  → 전이에 관여하지 않음 (pairing 에서 제외)
 * ```
 *
 * v0.1 의 "음수 entry 와 양수 entry 를 짝짓는" 방식은 같은 상태 버킷이 여러
 * entry 로 쪼개지면 방향을 오판했다. net 을 먼저 내면 한 버킷은 음수·양수·0
 * 셋 중 하나뿐이라 from 과 to 에 동시에 나타날 수 없다.
 *
 * ⛔ zero-net 그룹을 **삭제하지 않는다** — T2-6 계약(원장행 보존)이며 여기서는
 *    pairing 대상에서만 빠진다.
 *
 * @param transactionType 상태이동 유형이 아니면 아무것도 하지 않는다.
 * @param groups T2-6 `groupByStockKey()` 의 결과.
 * @throws {DomainError} `INVALID_STATUS_TRANSITION`(422)
 */
export function assertStatusTransitionByNet<TEntry>(
  transactionType: TransactionType,
  groups: readonly StockKeyGroup<TEntry>[],
): void {
  if (!isStatusMoveType(transactionType)) return;

  const froms = groups.filter((group) => isNegative(group.netQuantityDelta));
  const tos = groups.filter((group) => isGreaterThan(group.netQuantityDelta, ZERO));

  for (const from of froms) {
    for (const to of tos) {
      const fromStatus = from.key.inventoryStatus;
      const toStatus = to.key.inventoryStatus;
      if (isTransitionAllowed(fromStatus, toStatus)) continue;

      throw new DomainError(ERROR_CODES.INVALID_STATUS_TRANSITION, {
        message: `재고상태를 '${fromStatus}' 에서 '${toStatus}' 로 바꿀 수 없습니다.`,
        publicDetails: { from: fromStatus, to: toStatus },
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ⑩ 거래 균형 검증 (거래유형별 balance-key 단위)
// ═══════════════════════════════════════════════════════════════

/**
 * balance-key 직렬화 구분자. 재고키 값에 등장할 수 없는 제어문자다.
 *
 * ⛔ module-private 다 — 단순 문자열 결합은 `'AB'+'C'` 와 `'A'+'BC'` 가 충돌하므로
 *    구분자가 필요할 뿐이고, 그 **문자 자체는 계약이 아니다**(T2-6 `hashStockKey`
 *    와 같은 판단). 밖에서 이 형식에 의존하면 안 된다.
 */
const BALANCE_KEY_SEPARATOR = '\u0001';

/** `expiryKey` 는 재고키와 동일하게 **달력일** 정체성(`YYYY-MM-DD`)으로 본다. */
function expiryKeyText(expiryKey: Date): string {
  return expiryKey.toISOString().slice(0, 10);
}

/**
 * **7열** — `STATUS_CHANGE` · `RESERVATION` · `RESERVATION_RELEASE`.
 * 재고키 8열에서 `inventoryStatus` 만 뺀다.
 */
function statusLevelBalanceKey(key: StockKey): string {
  return [
    key.skuId,
    key.warehouseId,
    key.locationId,
    key.lotNo,
    expiryKeyText(key.expiryKey),
    key.serialNo,
    key.ownerCode,
  ].join(BALANCE_KEY_SEPARATOR);
}

/**
 * **5열** — `WAREHOUSE_TRANSFER_OUT` · `WAREHOUSE_TRANSFER_IN`.
 * 7열에서 `warehouseId`·`locationId` 를 더 뺀다 — 출발창고와 이동중창고는
 * `warehouseId` 가 다르기 때문이다.
 */
function warehouseLevelBalanceKey(key: StockKey): string {
  return [key.skuId, key.lotNo, expiryKeyText(key.expiryKey), key.serialNo, key.ownerCode].join(
    BALANCE_KEY_SEPARATOR,
  );
}

const BALANCE_KEY_PICKERS: Readonly<Record<BalanceLevel, (key: StockKey) => string>> = {
  STATUS_LEVEL: statusLevelBalanceKey,
  WAREHOUSE_LEVEL: warehouseLevelBalanceKey,
};

/**
 * 검증 ⑩ — **거래유형 family 의 balance-key 단위로 `Σ netQuantityDelta = 0`**
 * (`PENDING_v0.3 §5`).
 *
 * ## 왜 전역 합계가 아닌가
 *
 * `docs/04 §8.4` 규칙 5 와 §8.12 의 원래 의사코드는 **모든 그룹의 전역 Σ** 를
 * 봤다. 그러면 서로 무관한 두 재고가 상쇄되어 통과한다 —
 *
 * ```
 * STATUS_CHANGE
 *   SKU-A AVAILABLE −100
 *   SKU-B HOLD      +100      전역 Σ = 0 → v0.1 통과 ❌
 * ```
 *
 * §5 는 이 결함 때문에 "단순 전체 합계 0 검증 폐기" 를 지시했다. 균형은
 * **같은 재고가 자기 안에서 자리를 옮겼는가**를 묻는 것이므로, 그 "같은 재고"
 * 를 정의하는 key 단위로 따로 합산해야 한다.
 *
 * ## family 별 단위
 *
 * ```
 * STATUS_CHANGE · RESERVATION · RESERVATION_RELEASE   7열
 * WAREHOUSE_TRANSFER_OUT · WAREHOUSE_TRANSFER_IN      5열
 * ASSEMBLY_* · DISASSEMBLY_*                          면제 (R3 이 별도 검증)
 * 일반 입고·출고·조정                                  면제
 * ```
 *
 * ⛔ 두 창고이동 거래(`_OUT` ↔ `_IN`) **사이**의 불변식(도착 ≤ 출발)은 여기서
 *    보지 않는다 — 초과 도착은 `IN_TRANSIT` 버킷의 음수로 나타나며 **T2-9** 의
 *    ⑭ 음수재고 검증이 소유한다. 그래서 이 함수는 짝 거래를 조회하지 않는다.
 *
 * @param transactionType 균형 검증 대상이 아니면 아무것도 하지 않는다.
 * @param groups T2-6 `groupByStockKey()` 의 결과.
 * @throws {DomainError} `UNBALANCED_TRANSACTION`(422)
 */
export function assertBalancedIfStatusMove<TEntry>(
  transactionType: TransactionType,
  groups: readonly StockKeyGroup<TEntry>[],
): void {
  const level = BALANCE_LEVEL_BY_TRANSACTION_TYPE[transactionType];
  if (level === undefined) return;

  const pickBalanceKey = BALANCE_KEY_PICKERS[level];
  const sums = new Map<string, Decimal>();

  for (const group of groups) {
    const balanceKey = pickBalanceKey(group.key);
    sums.set(balanceKey, add(sums.get(balanceKey) ?? ZERO, group.netQuantityDelta));
  }

  for (const sum of sums.values()) {
    if (isZero(sum)) continue;

    throw new DomainError(ERROR_CODES.UNBALANCED_TRANSACTION, {
      // ★ detail 은 기존 계약 그대로 `{ sum }` 하나다. balanceKey·skuId·
      //   entryLineNos 를 발명하지 않는다.
      publicDetails: { sum: toDecimalString(sum) },
    });
  }
}
