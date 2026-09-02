import type { InventoryStatus } from '@/generated/prisma/client';
import { ZERO, add, toDecimal, type Decimal, type DecimalInput } from '@/shared/decimal';

/**
 * 재고키 정규화 · 해시 · 그룹화 (T2-6) — **순수 도메인 규칙.**
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.1(`StockKey` ·
 *    `StockKeyGroup`) · §8.5(정규화 규칙 5줄) · §8.12(`groupByStockKey` ·
 *    `hashStockKey` 본문) · `docs/07_개발백로그와_테스트전략_v0.2.md:154`
 *    (**T2-6** *"재고키 정규화 + 그룹화 — `normalizeStockKey`, `hashStockKey`
 *    (구분자 충돌 방지), `groupByStockKey`, `netQuantityDelta` 합산"*) ·
 *    `docs/00` **C-13**.
 *
 * ## 왜 필요한가 — C-13
 *
 * 하나의 `PostingCommand` 안에 **동일 재고키가 여러 entry 로 들어올 수 있다**
 * (엑셀 업로드 중복행, 세트 해체, 채널별 분할 출고). v0.1 은 entry 마다 잠금
 * 시점 잔량과 비교했기에 개별 검증은 통과하지만 최종 balance 가 음수가 되었다
 * — 현재고 10 에 `−6` / `−6` 이 각각 `10 − 6 = 4` 로 통과해 최종 `−2`.
 *
 * v0.2 는 **재고키별로 합산한 `netQuantityDelta`** 를 검증·갱신의 단위로 삼는다.
 * 이 파일은 그 합산까지를 만든다.
 *
 * ## 순수하다
 *
 * ```
 * Prisma        0
 * DB read/write 0
 * $transaction  0
 * ```
 *
 * ⛔ application 계층을 import 하지 않는다 — `PostingReferences` ·
 *    `PostingPhase1` · `PostingEntry` 어느 것도 참조하지 않는다. 상위 계층을
 *    아래에서 끌어오면 계층이 이름만 남는다. 필요한 외부 값은
 *    `defaultLocationId` **하나뿐**이며 호출자가 넘긴다.
 *
 * ## 여기 없는 것
 *
 * ⛔ 상태전이·거래균형 (**T2-7**) · LOT·유통기한·시리얼 검증 (**T2-8**) ·
 *    잠금·음수재고·balance 갱신 (**T2-9**) · 거래/원장/감사 INSERT (**T2-10**).
 *    `netQuantityDelta` 의 **부호를 해석**하는 것부터가 T2-7 이다.
 */

// ═══════════════════════════════════════════════════════════════
// 센티넬 — T2-2 가 DB 에 고정한 값과 같아야 한다
// ═══════════════════════════════════════════════════════════════

/**
 * ★ 아래 센티넬 상수·헬퍼는 **module-private** 다.
 *
 * T2-2 가 DB 에 고정한 값의 런타임 표현이며 **구현 세부사항**이다. 외부
 * consumer 가 이 값을 직접 써야 한다는 authoritative contract 가 없고, export
 * 하면 "센티넬을 밖에서 조립해도 된다" 는 신호가 된다. 정규화 결과는
 * `normalizeStockKey()` 를 통해서만 얻는다.
 */

/** `lotNo` · `serialNo` 미지정 센티넬 (`docs/00` **C-09**). */
const EMPTY_SENTINEL = '';

/** `ownerCode` 미지정 센티넬. */
const DEFAULT_OWNER_CODE = 'DEEPPOINT';

/** `expiryKey` 미지정 센티넬 — `9999-12-31`. */
const EXPIRY_KEY_SENTINEL_TEXT = '9999-12-31';

/**
 * `lotNo` · `serialNo` 에서 "미지정" 으로 취급하는 입력.
 *
 * `docs/04 §8.5` 원문: `null | undefined | '' | '-' → ''`
 *
 * ⛔ `ownerCode` 에 이 목록을 확장하지 않는다 — 정본은 `ownerCode` 에 대해
 *    `null | undefined` **2종만** 규정한다. `''` 와 `'-'` 는 값으로 보존된다.
 */
const BLANK_LOT_SERIAL_INPUTS: readonly string[] = ['', '-'];

/**
 * `@db.Date` 센티넬의 런타임 표현 — UTC 자정 `Date`.
 *
 * ★ 호출마다 **새 인스턴스**를 만든다. `Date` 는 가변이므로 공유 인스턴스를
 *   돌려주면 호출자가 `setFullYear()` 로 센티넬을 오염시킬 수 있다.
 *
 * ⛔ `toKstDate()` 를 쓰지 않는다 — `expiryKey` 는 `businessDate` 와 **다른
 *    개념**이다. 유통기한은 timezone 파생값이 아니라 그 자체가 날짜다.
 */
function expiryKeySentinel(): Date {
  return new Date(`${EXPIRY_KEY_SENTINEL_TEXT}T00:00:00.000Z`);
}

// ═══════════════════════════════════════════════════════════════
// 타입
// ═══════════════════════════════════════════════════════════════

/**
 * 정규화된 재고키 — **8개 컬럼 전부가 키를 구성한다** (`docs/04:98-107`).
 *
 * 필드 순서는 `prisma/schema.prisma` 의 `@@unique(..., map: "stock_key")` 8열,
 * 그리고 `hashStockKey` 의 직렬화 순서와 **모두 같다.** 셋이 어긋나면 runtime
 * 그룹 identity 와 DB UNIQUE identity 가 달라진다.
 *
 * ⛔ 여기에 `lineNo` · `quantityDelta` · `channelId` · `outboundPurpose` ·
 *    `manufacturedDate` · `note` 를 넣지 않는다 — 재고키가 아니다.
 */
export interface StockKey {
  readonly skuId: string;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly inventoryStatus: InventoryStatus;
  /** `''` 정규화 완료 */
  readonly lotNo: string;
  /** `9999-12-31` 정규화 완료 */
  readonly expiryKey: Date;
  /** `''` 정규화 완료 */
  readonly serialNo: string;
  /** `'DEEPPOINT'` 정규화 완료 */
  readonly ownerCode: string;
}

/**
 * 정규화 **전** entry 에서 재고키를 이룰 수 있는 부분.
 *
 * ★ 구조적 타입이다 — application 의 `PostingEntry` 를 import 하지 않는다.
 *   `PostingEntry` 가 이 형태를 만족하므로 호출자는 그대로 넘길 수 있다.
 */
export interface StockKeyDraft {
  readonly skuId: string;
  readonly warehouseId: string;
  readonly locationId?: string | null | undefined;
  readonly inventoryStatus: InventoryStatus;
  readonly lotNo?: string | null | undefined;
  readonly expiryDate?: Date | null | undefined;
  readonly serialNo?: string | null | undefined;
  readonly ownerCode?: string | null | undefined;
}

/**
 * `normalizeStockKey` 가 스스로 알 수 없는 외부 값.
 *
 * ★ `defaultLocationId` **하나뿐**이다 (`docs/04 §8.5` — `locationId: null →
 *   warehouse.defaultLocationId`). 그 이상을 요구하면 domain 이 application 의
 *   조회 결과에 묶인다.
 */
export interface StockKeyNormalizationContext {
  readonly defaultLocationId: string;
}

/**
 * 정규화된 entry — 재고키 8열이 확정되고 `lineNo` 가 붙은 원본 entry.
 *
 * ★ **원본 필드를 전부 보존한다.** `docs/04 §8.1` 의 핵심 구분:
 *   `entries` = 원장에 기록되는 **사실의 단위**(감사·추적용, 원본 보존) ·
 *   `groups` = 검증과 balance 갱신의 **계산 단위**.
 *   따라서 `expiryDate`(표시용 원본) · `note` · `channelId` 같은 값은
 *   정규화 뒤에도 그대로 남는다.
 */
export type NormalizedEntry<TEntry extends StockKeyDraft = StockKeyDraft> = Omit<
  TEntry,
  keyof StockKey
> &
  StockKey & {
    /** 1-based 원본 순서. ⛔ 재고키가 아니다 — `hashStockKey` 에 들어가지 않는다. */
    readonly lineNo: number;
  };

/** 수량을 가진 entry — 그룹 합산의 최소 요건. */
export interface QuantityBearing {
  readonly quantityDelta: DecimalInput;
}

/**
 * 동일 재고키 entry 들을 묶은 그룹 — 검증·balance 갱신의 단위 (`docs/04:110-115`).
 *
 * ⛔ **정확히 4필드다.** `currentBalance` · `balanceAfter` · `lockVersion` ·
 *    전이 판정 결과 · 예외 정보를 미리 넣지 않는다 — 전부 후속 task 소유다.
 */
export interface StockKeyGroup<TEntry> {
  readonly key: StockKey;
  /** 8개 값 직렬화 (정렬·조회용). */
  readonly hash: string;
  /** 원본 entry 들 (원장행 저장용). 합쳐지지 않는다. */
  readonly entries: readonly TEntry[];
  /** ★ `Σ entries.quantityDelta`. **0일 수 있다.** */
  readonly netQuantityDelta: Decimal;
}

// ═══════════════════════════════════════════════════════════════
// 정규화
// ═══════════════════════════════════════════════════════════════

/** `lotNo` · `serialNo` — `null | undefined | '' | '-'` → `''`. 그 외는 그대로. */
function normalizeLotOrSerial(value: string | null | undefined): string {
  if (value === null || value === undefined) return EMPTY_SENTINEL;
  // ⛔ trim·대소문자 변환을 하지 않는다 — 정본에 없다. `' LOT1 '` 은 `' LOT1 '`
  //    그대로이고, 그래서 `'LOT1'` 과 다른 재고키가 된다.
  return BLANK_LOT_SERIAL_INPUTS.includes(value) ? EMPTY_SENTINEL : value;
}

/**
 * 재고키 8열 정규화 (`docs/04 §8.5`).
 *
 * ```
 * lotNo    : null | undefined | '' | '-' → ''
 * serialNo : null | undefined | '' | '-' → ''
 * ownerCode: null | undefined           → 'DEEPPOINT'
 * expiryKey: expiryDate ?? DATE '9999-12-31'
 * locationId: null → warehouse.defaultLocationId
 * ```
 *
 * ★ `locationId` 는 정본이 `null` 만 적었으나 **`undefined` 도 같은 "미지정"**
 *   으로 처리한다 — 실제 입력 타입이 `locationId?: string` 이라 생략 시
 *   `undefined` 가 오기 때문이다. 정본의 의도(미지정 → 창고 기본 로케이션)를
 *   그대로 따른다.
 *
 * ⛔ `''` 와 잘못된 UUID 는 여기서 다루지 않는다 — T2-5 의 구조 검증 ①
 *    (`z.uuid()`)이 이미 400 으로 막는다. 문서에 없는 fallback 을 만들지 않는다.
 *
 * ⛔ `manufacturedDate` · `channelId` · `outboundPurpose` 는 재고키가 아니므로
 *    건드리지 않는다.
 *
 * ★ 입력을 **변형하지 않는다** — 새 객체를 반환한다.
 */
export function normalizeStockKey(
  draft: StockKeyDraft,
  context: StockKeyNormalizationContext,
): StockKey {
  return {
    skuId: draft.skuId,
    warehouseId: draft.warehouseId,
    // 미지정이면 창고 DEFAULT 로케이션. ⛔ 여기서 존재 검증을 하지 않는다(T2-5 ②).
    locationId: draft.locationId ?? context.defaultLocationId,
    inventoryStatus: draft.inventoryStatus,
    lotNo: normalizeLotOrSerial(draft.lotNo),
    expiryKey: draft.expiryDate ?? expiryKeySentinel(),
    serialNo: normalizeLotOrSerial(draft.serialNo),
    // ⛔ `''`·`'-'` 는 default 로 바뀌지 않는다 — 정본은 null/undefined 2종만 규정한다.
    ownerCode: draft.ownerCode ?? DEFAULT_OWNER_CODE,
  };
}

/**
 * 정규화 pass — 재고키 정규화 + **`lineNo` 파생**을 한 번에 한다.
 *
 * ★ `docs/04 §8.12` 원문이 이 형태다:
 *
 * ```typescript
 * const entries = cmd.entries.map((e, i) => ({
 *   ...normalizeStockKey(e, refs),
 *   lineNo: i + 1,
 * }));
 * ```
 *
 * `lineNo` 는 **1-based 원본 순서**다 (`index 0 → 1`). `docs/04 §8.6` 의
 * `INSUFFICIENT_STOCK` 상세가 `g.entries.map(e => e.lineNo)` 로 **그룹 entry
 * 에서 읽으므로**(T2-9), 원장 INSERT(T2-10)까지 미룰 수 없다.
 *
 * ⛔ `lineNo` 는 재고키가 아니다 — `StockKey` 에 없고 `hashStockKey` 에도
 *    들어가지 않는다. `lineNo` 만 다른 두 entry 는 **같은 그룹**이다.
 *
 * ★ 정규화가 **그룹화보다 반드시 먼저** 실행되어야 한다 (`docs/04:296`) —
 *   그렇지 않으면 `lotNo=null` 과 `lotNo=''` 가 다른 그룹으로 잡혀 합산이 깨진다.
 *
 * @param entries 원본 순서의 entry 들
 * @param resolveContext entry 별 외부 context (창고마다 기본 로케이션이 다르다)
 */
export function normalizeEntries<TEntry extends StockKeyDraft>(
  entries: readonly TEntry[],
  resolveContext: (entry: TEntry) => StockKeyNormalizationContext,
): NormalizedEntry<TEntry>[] {
  return entries.map(
    (entry, index) =>
      ({
        ...entry,
        ...normalizeStockKey(entry, resolveContext(entry)),
        lineNo: index + 1,
      }) as NormalizedEntry<TEntry>,
  );
}

// ═══════════════════════════════════════════════════════════════
// 해시
// ═══════════════════════════════════════════════════════════════

/**
 * 재고키 직렬화 구분자.
 *
 * ⚠️ 근거: `docs/04 §8.12` — *"구분자는 재고키 값에 등장할 수 없는 문자를
 *    사용한다"* 이며 본문 `.join(...)` 이 이 문자를 쓴다.
 *
 * ★ **internal implementation detail 이다.** export 하지 않으며, 직렬화 결과
 *   문자열도 공개 계약이 아니다. `docs/CHANGELOG_v0.2.md` 는 같은 취지를
 *   `\x1F` 로 적었는데, 실행 정본인 `docs/04 §8.12` 본문이 이 문자를 쓰므로
 *   그쪽을 따랐다. 어느 쪽이든 **재고키 값에 등장할 수 없는 제어문자**라는
 *   성질이 계약이고 정확한 코드포인트는 아니다.
 */
const KEY_SEPARATOR = '\u0001';

/**
 * 재고키 → 그룹 identity 문자열 (`docs/04:757-763`).
 *
 * ★ **암호학적 해시가 아니다.** 8개 값을 고정 순서로 직렬화한 canonical key 다.
 *   ⛔ `crypto` · SHA · UUID · 새 의존성을 쓰지 않는다.
 *
 * ★ 단순 문자열 결합은 금지다 — `lotNo='AB'` + `serialNo='C'` 와
 *   `lotNo='A'` + `serialNo='BC'` 가 같은 문자열이 되어 **서로 다른 재고키가
 *   한 그룹으로 합쳐진다.** 구분자가 그것을 막는다.
 *
 * ★ `expiryKey` 는 **date-only(`YYYY-MM-DD`)** 로 넣는다 (`docs/04:761`).
 *   `@db.Date` 컬럼의 identity 와 일치시키기 위함이며, 시각 성분이 섞이면
 *   같은 날짜가 다른 그룹으로 갈라진다.
 *
 * ★ 결정적이다 — 필드 배열이 코드로 고정되어 있어 객체 속성 삽입 순서나
 *   실행 환경 locale·timezone 에 의존하지 않는다.
 *
 * ⛔ UUID 를 대·소문자 정규화하지 않는다 — 정본에 없다.
 */
export function hashStockKey(key: StockKey): string {
  return [
    key.skuId,
    key.warehouseId,
    key.locationId,
    key.inventoryStatus,
    key.lotNo,
    key.expiryKey.toISOString().slice(0, 10),
    key.serialNo,
    key.ownerCode,
  ].join(KEY_SEPARATOR);
}

// ═══════════════════════════════════════════════════════════════
// 합산 · 그룹화
// ═══════════════════════════════════════════════════════════════

/**
 * `Σ entries.quantityDelta` (`docs/04:749`).
 *
 * ⛔ `Number()` · `parseFloat()` · `parseInt()` · `Math.round()` 를 쓰지 않는다.
 *    `1/30` 같은 값에서 정밀도가 깨지고, 재고 수량은 `DECIMAL(18,6)` 이다.
 *    `eslint-rules/no-decimal-to-number.ts` 가 이를 강제한다.
 *
 * ★ 결과는 **0일 수 있다** — `−50` / `+50` 이 그렇다. 개별 entry 의
 *   `quantityDelta ≠ 0` (T2-5 ①, DB `ck_qty_nonzero`) 과는 다른 층위다.
 */
export function netQuantityDelta(entries: readonly QuantityBearing[]): Decimal {
  return entries.reduce<Decimal>(
    (total, entry) => add(total, toDecimal(entry.quantityDelta)),
    ZERO,
  );
}

/**
 * 정규화된 entry 들을 재고키별로 묶는다 (`docs/04:735-756`).
 *
 * ★ **동일 재고키 중복은 정상 입력이다** (C-13). 오류로 만들지 않는다 —
 *   엑셀 업로드 중복행·세트 해체·채널별 분할 출고에서 실제로 발생한다.
 *
 * ★ **entry 를 합치지 않는다.** 같은 재고키라도 `note`·`channelId` 가 다르면
 *   각각 `group.entries` 에 원본 그대로 남는다 — 원장행은 사실의 단위이고
 *   그룹은 계산의 단위다 (`docs/04 §8.1`).
 *
 * ★ **`netQuantityDelta = 0` 인 그룹도 제거하지 않는다** (`docs/04:753-754`) —
 *   원장행은 저장해야 하고 `last_transaction_id` 갱신도 필요하다.
 *   ⛔ `PENDING_v0.3 §4`(net=0 시 balance 미갱신)와 혼동하지 않는다 — 그것은
 *      **T2-9 의 balance 갱신 정책**이지 그룹 존속 여부가 아니다.
 *
 * ⛔ 반환 순서를 계약으로 삼지 않는다. 구현상 `Map` 삽입 순서(= 최초 등장
 *    순서)가 되지만 정본이 순서를 규정하지 않았다. 잠금 순서 정렬은
 *    **T2-9** 소유이므로 여기서 임의로 sort 하지 않는다.
 */
export function groupByStockKey<TEntry extends StockKey & QuantityBearing>(
  entries: readonly TEntry[],
): StockKeyGroup<TEntry>[] {
  const groups = new Map<string, { key: StockKey; hash: string; entries: TEntry[] }>();

  for (const entry of entries) {
    const key = pickStockKey(entry);
    const hash = hashStockKey(key);

    let group = groups.get(hash);
    if (group === undefined) {
      group = { key, hash, entries: [] };
      groups.set(hash, group);
    }
    group.entries.push(entry);
  }

  return [...groups.values()].map((group) => ({
    key: group.key,
    hash: group.hash,
    entries: group.entries,
    netQuantityDelta: netQuantityDelta(group.entries),
  }));
}

/**
 * 정규화된 entry 에서 재고키 8열만 뽑는다.
 *
 * ★ internal — `docs/07:154` 가 명명한 public 함수 4종에 없다.
 *   `groupByStockKey` 안에서만 쓰인다.
 */
function pickStockKey(entry: StockKey): StockKey {
  return {
    skuId: entry.skuId,
    warehouseId: entry.warehouseId,
    locationId: entry.locationId,
    inventoryStatus: entry.inventoryStatus,
    lotNo: entry.lotNo,
    expiryKey: entry.expiryKey,
    serialNo: entry.serialNo,
    ownerCode: entry.ownerCode,
  };
}
