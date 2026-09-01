import { toKstDate } from '@/shared/business-date';
import { DomainError, ERROR_CODES } from '@/shared/errors';

import type { PostingValidationDependencies } from './ports';
import type { PostingCommand, PostingCommandPayload, PostingEntry } from './posting-command';
import { SOURCE_DOCUMENT_EXEMPT_TYPE, validateStructure } from './posting-command';
import type { PostingReferences } from './refs';
import { assertAllExistAndUsable, loadReferences } from './refs';

/**
 * `InventoryPostingService` — Phase-1 검증 (T2-5).
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.2(검증 순서)
 *    · §8.12(의사코드 Phase 1) · `docs/07_개발백로그와_테스트전략_v0.2.md:153`
 *    (**T2-5** *"`InventoryPostingService` 골격 — 입력 DTO, 검증 ①~⑦
 *    (트랜잭션 밖) · 완료조건: 검증 실패 시 DB 무변경"*).
 *
 * ## `InventoryPostingService` 는 개념이고, 여기는 그 Phase-1 이다
 *
 * `docs/02:134` 의 핵심 불변식 *"재고를 변경하는 모든 경로는 반드시
 * `InventoryPostingService` 를 통과한다"* 는 유효하다. 다만 그 관문의 완성형
 * `post(cmd): Promise<PostingResult>`(`docs/04 §8.12`)는 검증 ①~⑳ 전체를 담는
 * **T2-10** 산출물이다.
 *
 * ⛔ T2-5 는 `post()` 를 만들지 않는다. 빈 skeleton 도, throw-not-implemented
 *    placeholder 도 만들지 않는다 — 그것이 있으면 "관문이 생겼다" 는 착시가
 *    생기고, 재고를 쓰지 못하는 관문은 관문이 아니다.
 *
 * ★ 호출자가 아직 없다. `src/modules/bom/application/validate-candidate.ts`
 *   (T07-2)가 세운 선례와 같다 — *"T07-2 에는 아직 그 endpoint 들이 없다.
 *   T07-3/T07-5 가 이 함수를 호출한다 — ⛔ 검증을 위해 production API
 *   placeholder 를 만들지 않는다."* 실제 첫 소비자 `T4-10` 의 선행조건은
 *   `T2-10` 이다(`docs/07:254`).
 *
 * ## DB 를 바꾸지 않는다
 *
 * ```
 * DB write        0
 * $transaction    0
 * PostingResult   생성 0 (타입 선언만)
 * ```
 *
 * 완료조건 *"검증 실패 시 DB 무변경"* 은 실패 경로뿐 아니라 **성공 경로에서도**
 * 성립한다 — Phase-1 은 읽기만 하기 때문이다.
 */

// ═══════════════════════════════════════════════════════════════
// Phase-1 산출물
// ═══════════════════════════════════════════════════════════════

/**
 * Phase-1 이 만들어 Phase-2 가 소비하는 값 — **정확히 2개**다.
 *
 * `docs/04 §8.12` Phase 1 의 지역변수 그대로다.
 *
 * ```typescript
 * const refs = await this.loadReferences(cmd);       // docs/04:529 — ⑯ 이 소비
 * const businessDate = toKstDate(cmd.occurredAt);    // docs/04:540 — ⑮ ⑯ 이 소비
 * ```
 *
 * ⛔ 여기에 다음을 담지 않는다 — 전부 후속 task 소유다.
 *    `normalizedEntries` · `groups` · `transactionNo` · `PostingResult` ·
 *    `balance` · `ledger` · `exceptions` · idempotency 결과.
 * ⛔ `PostingCommand` 를 변형해 되돌려주지 않는다 — `ValidatedPostingCommand`
 *    같은 개념은 정본에 없다.
 */
export interface PostingPhase1 {
  /** `(occurred_at AT TIME ZONE 'Asia/Seoul')::date` — UTC 자정 `Date`. */
  readonly businessDate: Date;
  /** 검증을 통과한 참조 데이터. Phase-2 가 재조회 없이 재사용한다. */
  readonly refs: PostingReferences;
}

// ═══════════════════════════════════════════════════════════════
// ④ 원인문서 (presence)
// ═══════════════════════════════════════════════════════════════

/** 원인문서 누락 — `docs/04 §8.2` ④. */
function missingSourceDocument(transactionType: string): DomainError {
  return new DomainError(ERROR_CODES.MISSING_SOURCE_DOCUMENT, {
    message: `'${transactionType}' 거래에는 원인문서가 필요합니다.`,
    publicDetails: { transactionType },
    publicHint: '거래의 근거가 되는 문서의 유형과 ID 를 함께 보내세요.',
  });
}

/**
 * 검증 ④ 전반 — 원인문서 **존재 여부**(`docs/04:531` `assertSourceDocument`).
 *
 * ```
 * OPENING_BALANCE  → 불필요 (배치 자체가 근거, docs/04 §8.3)
 * 그 외 23종        → 필수. type·id 가 non-blank 여야 한다
 * ```
 *
 * ⛔ `type` 을 allowlist·enum·CHECK 로 닫지 않는다 — `docs/04 §8.3` 에 9개
 *    이름이 흩어져 있으나 authoritative enum 이 없고 DB 도 자유문자열이다.
 * ★ 문서의 **존재·상태** 검증은 별도 port 다(`assertSourceDocumentState`).
 *
 * @throws {DomainError} `MISSING_SOURCE_DOCUMENT`(422)
 */
export function assertSourceDocument(command: PostingCommandPayload): void {
  if (command.transactionType === SOURCE_DOCUMENT_EXEMPT_TYPE) return;

  const sourceDocument = command.sourceDocument;
  if (sourceDocument === undefined) throw missingSourceDocument(command.transactionType);

  // ★ non-blank 판정은 ① 이 아니라 여기가 소유한다. 공백뿐인 `type`/`id` 는
  //   "형식이 틀렸다"(400)가 아니라 "원인문서가 사실상 없다"(422)이며,
  //   `docs/04 §8.2` 가 이 사실에 `MISSING_SOURCE_DOCUMENT` 를 지정했다.
  if (sourceDocument.type.trim() === '' || sourceDocument.id.trim() === '') {
    throw missingSourceDocument(command.transactionType);
  }
}

// ═══════════════════════════════════════════════════════════════
// ⑥ SKU 재고관리 대상
// ═══════════════════════════════════════════════════════════════

/**
 * 검증 ⑥ — 재고관리 대상 SKU 인가 (`docs/04:546` `assertInventoryManaged`).
 *
 * 무형상품·임가공비처럼 `inventoryManaged = false` 인 SKU 는 원장 대상이 아니다.
 *
 * ★ **정규화가 필요 없다.** `docs/04 §8.12` 는 이 검사를 정규화된 entry 루프
 *   안에서 하지만, 읽는 값은 `skuId` 뿐이고 `skuId` 는 정규화 대상이 아니다
 *   (`lotNo`·`serialNo`·`ownerCode`·`expiryKey`·`locationId` 만 정규화된다).
 *   그래서 ⑥ 은 T2-5 에서 concrete 로 가능하고, ⑦ 은 T2-6 이후여야 한다.
 *   `docs/07` 이 T2-8 의 선행조건을 T2-5 가 아니라 **T2-6** 으로 둔 이유다.
 *
 * ⛔ SKU lifecycle status 를 함께 보지 않는다. v0.1 §8.2 의
 *    *"SKU는 `ACTIVE` 또는 `DISCONTINUED`(출고만)"* 는 **v0.2 §8.2 에서 해당
 *    칸이 비어 있고** CHANGELOG 에도 변경 기록이 없다. 정본이 정하지 않은
 *    동작을 허용으로도 금지로도 고정하지 않는다.
 *
 * @throws {DomainError} `SKU_NOT_INVENTORY_MANAGED`(422)
 */
export function assertInventoryManaged(entry: PostingEntry, refs: PostingReferences): void {
  const sku = refs.sku(entry.skuId);
  // ② 가 이미 존재를 보장한다. 여기서 다시 404 를 던지지 않는다.
  if (sku === undefined || sku.inventoryManaged) return;

  throw new DomainError(ERROR_CODES.SKU_NOT_INVENTORY_MANAGED, {
    message: `SKU '${entry.skuId}' 은(는) 재고관리 대상이 아닙니다.`,
    publicDetails: { skuId: entry.skuId },
    publicHint: '무형상품·임가공비 등은 재고 원장의 대상이 아닙니다.',
  });
}

// ═══════════════════════════════════════════════════════════════
// Phase-1 orchestration
// ═══════════════════════════════════════════════════════════════

/**
 * 검증 ①~⑦ (트랜잭션 밖) — `docs/04 §8.2` 순서 그대로.
 *
 * ```
 * ①  구조 (Zod)                      CONCRETE
 * ②  SKU·창고·로케이션                CONCRETE
 * ②  채널                             PORT
 * ③  권한                             PORT
 * ④  원인문서 presence                CONCRETE
 * ④  원인문서 existence/state         PORT
 *     businessDate = toKstDate(...)   CONCRETE
 * ⑤  마감기간                         PORT
 *     ── T2-6 정규화 경계 ──
 * ⑥  SKU 재고관리 대상                CONCRETE
 *     ── T2-8 검증 경계 ──
 * ⑦  LOT·유통기한·시리얼              (T2-8)
 * ```
 *
 * ⛔ 작성자≠승인자(`assertApproverSeparation`)는 여기 없다.
 *    `PENDING_v0.3 §2` 가 분리 재검증을 *"같은 DB 트랜잭션 안에서"* 로
 *    규정했고 Phase-1 은 트랜잭션을 열지 않는다. 승인 필드 자체도 DTO 에
 *    없으므로 이 단계에서 분리할 대상이 존재하지 않는다.
 *
 * @returns Phase-2 가 재사용할 `{ businessDate, refs }`
 * @throws {ValidationError} `VALIDATION_ERROR`(400) — ①
 * @throws {DomainError} `NOT_FOUND`(404) · `WAREHOUSE_INACTIVE`(422) — ②
 * @throws {DomainError} `MISSING_SOURCE_DOCUMENT`(422) — ④
 * @throws {DomainError} `SKU_NOT_INVENTORY_MANAGED`(422) — ⑥
 * @throws port 가 던지는 오류 — ② 채널 · ③ `FORBIDDEN` · ④ 상태 ·
 *         ⑤ `CLOSED_PERIOD_TRANSACTION`
 */
export async function validatePostingCommand(
  deps: PostingValidationDependencies,
  command: PostingCommand,
): Promise<PostingPhase1> {
  // ① 구조 검증 — entries≥1, 개별 delta≠0, 미지원 키 400
  const payload = validateStructure(command);

  // ② 참조 무결성 — SKU / 창고 / 로케이션
  const refs = await loadReferences(deps.db, payload);
  assertAllExistAndUsable(refs);

  // ② 참조 무결성 — 채널 (port)
  //    ⛔ `channelId` 를 FK 처럼 직접 조회하지 않는다. `Channel` 모델이 없고
  //       `common_code` 참조라는 authoritative 문장도 없다.
  for (const entry of payload.entries) {
    if (entry.channelId === undefined) continue;
    await deps.assertChannelUsable(entry.channelId);
  }

  // ③ 권한 (port)
  //    ⛔ 24종 concrete map 을 만들지 않는다 — explicit 15 · inferred 4 ·
  //       absent 5 인 상태에서 추정 매핑은 문서에 없는 규칙을 만드는 것이다.
  await deps.assertPostingPermission(command.actor, payload.transactionType);

  // ④ 원인문서 — presence 는 concrete, existence/state 는 port
  assertSourceDocument(payload);
  if (payload.sourceDocument !== undefined) {
    await deps.assertSourceDocumentState(payload.sourceDocument);
  }

  // 업무일자 파생 — occurredAt 이 유일한 원천 (T2-4 frozen contract)
  // ⛔ Warehouse.timezone 을 쓰지 않는다 (docs/19 §W-D29).
  const businessDate = toKstDate(payload.occurredAt);

  // ⑤ 마감기간 (port) — concrete 는 T2-15 (`InventoryClose` 는 TB-19)
  await deps.assertPeriodOpen(businessDate, command.actor);

  // ── T2-6 경계 ────────────────────────────────────────────────
  //    normalizeStockKey / hashStockKey / groupByStockKey / netQuantityDelta
  //    그리고 `lineNo` 파생이 여기에 들어온다.
  //    ⛔ T2-5 는 정규화하지 않는다. placeholder 함수도 fake 타입
  //       (`NormalizedEntry`·`StockKeyGroup`)도 만들지 않는다.
  //    ★ 재료는 준비되어 있다 — `refs.warehouse(id).defaultLocationId`.

  // ⑥ 재고관리 대상 — 정규화와 무관하다 (skuId 는 정규화 대상이 아님)
  for (const entry of payload.entries) {
    assertInventoryManaged(entry, refs);
  }

  // ── T2-8 경계 ────────────────────────────────────────────────
  //    ⑦ assertLotExpirySerial(sku, normalizedEntry)
  //      + assertSerialNetQty(groups, refs)
  //    ⛔ port 타입조차 선언하지 않는다. 두 함수는 T2-6 이 만드는
  //       normalized/group 타입을 입력으로 받으므로, 지금 signature 를
  //       고정하면 T2-8 이 그것을 깨야 한다.
  //    ⛔ LOT_REQUIRED_MISSING 등 오류코드 8종도 T2-8 이 landing 한다.

  return { businessDate, refs };
}
