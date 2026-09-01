import type { TransactionType } from '@/generated/prisma/client';
import type { ActorContext } from '@/modules/auth/application';

import type { PostingSourceDocument } from './posting-command';
import type { PostingDbClient } from './refs';

/**
 * Phase-1 검증 port (T2-5).
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.2 · §8.12.
 *
 * ## 왜 port 인가
 *
 * 검증 ①~⑦ 중 일부는 **참조할 정본·모델이 아직 없다.** 그렇다고 조용히 건너뛰면
 * 안전장치가 사라지고, 억지로 concrete 를 만들면 문서에 없는 규칙을 코드로
 * 굳히게 된다. 그래서 **호출 위치와 책임만 고정**하고 구현은 소유 task 로 넘긴다.
 *
 * | port | 왜 concrete 가 아닌가 | 소유 |
 * |---|---|---|
 * | `assertChannelUsable` | `Channel` 모델이 없다. `InventoryLedgerEntry.channelId` 가 `common_code.id`(group `CHANNEL`)를 가리킨다는 authoritative relation 문장도 없다 | 미배정 |
 * | `assertPostingPermission` | `TransactionType` 24종 중 권한 매핑이 **explicit 15 · inferred 4 · absent 5** 다. 부분 catalog 를 seed 에 올리면 비대칭 보안 계약이 굳는다 | 미배정 |
 * | `assertSourceDocumentState` | 원인문서 9종의 모델이 **0개** 존재한다 (TB-1·TB-5·TB-10 은 R1b, 나머지는 R2/R3) | 각 document task |
 * | `assertPeriodOpen` | `InventoryClose` 모델이 없다 (`TB-19`) | **T2-15** |
 *
 * ⛔ 여기에 default 구현(no-op·throw-not-implemented)을 두지 않는다. 호출자가
 *    port 를 반드시 주입하게 만들어야 "검증이 있는 줄 알았는데 없었다" 를 막는다.
 *
 * ⛔ 검증 ⑦(LOT·유통기한·시리얼) port 는 **여기에 없다.** `docs/04 §8.12` 의
 *    `assertLotExpirySerial(sku, e)` 는 `normalizeStockKey` 를 거친 entry 를
 *    받고, `assertSerialNetQty(groups, refs)` 는 group 을 받는다. 두 타입 모두
 *    **T2-6** 산출물이므로, 지금 signature 를 정하면 **T2-8** 이 그것을 깨야 한다.
 *    → `validate-posting-command.ts` 에 **경계 표시만** 남긴다.
 */

/**
 * ② 채널 — `channelId` 가 주어졌을 때 존재·사용가능 검증.
 *
 * ⛔ 구현체가 `channelId` 를 `CommonCode.id` 로 단정하지 않도록 이 계약은
 *    **참조 대상을 말하지 않는다.** 관계 계약이 확정된 뒤 adapter 가 붙는다.
 *
 * @throws 검증 실패 시 도메인 오류 (코드는 구현체가 정한다)
 */
export type AssertChannelUsable = (channelId: string) => Promise<void> | void;

/**
 * ③ 권한 — 이 actor 가 이 거래유형을 posting 할 수 있는가.
 *
 * ★ 이름이 `docs/04 §8.12` 의 `assertPermission` 과 다른 이유: 저장소에 이미
 *   `assertPermission(actor, permissionKey)` 가 있고(`modules/auth/domain/permission.ts`),
 *   그것은 **권한 키 하나**를 받는 다른 계약이다. 동명으로 만들면 두 개념이
 *   섞인다.
 *
 * ⛔ 구현체도 ADMIN 을 코드로 통과시키지 않는다 — `RolePermission` 데이터로만
 *    판정한다 (`prisma/seed/roles.ts:13`).
 * ⛔ `REVERSAL` 의 *"원거래 유형과 동일 권한"*(`docs/04 §8.3`)은 원거래 조회가
 *    필요하므로 **T2-13** 이다. 이 port 는 그것을 알지 못한다.
 *
 * @throws `FORBIDDEN`(403)
 */
export type AssertPostingPermission = (
  actor: ActorContext,
  transactionType: TransactionType,
) => Promise<void> | void;

/**
 * ④ 원인문서 **상태** — 문서가 실재하고 posting 가능한 상태인가.
 *
 * ★ 필수 여부·`type`/`id` non-blank 는 **concrete** 다(`validate-posting-command.ts`).
 *   이 port 는 그 다음 단계인 존재·상태만 본다.
 *
 * ⛔ 구현체를 `switch (sourceDocument.type)` 로 만들지 않는다 — 9종 모델이
 *    전부 미래 task 이며, `type` 은 자유문자열이다(allowlist 없음).
 */
export type AssertSourceDocumentState = (
  sourceDocument: PostingSourceDocument,
) => Promise<void> | void;

/**
 * ⑤ 마감기간 — `businessDate` 가 속한 월이 마감되지 않았는가.
 *
 * ★ signature 가 `(businessDate, actor)` 로 확정된 이유: `docs/04 §8.12` 는
 *   `assertPeriodOpen(businessDate, cmd.allowClosedPeriod, cmd.actor)` 였으나
 *   `allowClosedPeriod` 는 `PENDING_v0.3 §2` 가 supersede 했고 T2-5 DTO 에
 *   존재하지 않는다. 승인 예외 인자는 승인요청 모델과 함께 **T2-15/T2-14** 가
 *   더한다 — optional 인자 추가는 breaking change 가 아니다.
 *
 * @throws `CLOSED_PERIOD_TRANSACTION`(422)
 */
export type AssertPeriodOpen = (businessDate: Date, actor: ActorContext) => Promise<void> | void;

/**
 * `validatePostingCommand()` 의 주입 의존성.
 *
 * 저장소 관례(`HasBomUsageDependencies`)와 같은 flat `<Name>Dependencies` 형태다.
 *
 * ⛔ default 값을 두지 않는다 — port 를 빠뜨린 호출이 조용히 통과하면 안 된다.
 */
export interface PostingValidationDependencies {
  /** 좁힌 read-only client. ⛔ 쓰기·트랜잭션 없음. */
  readonly db: PostingDbClient;
  readonly assertChannelUsable: AssertChannelUsable;
  readonly assertPostingPermission: AssertPostingPermission;
  readonly assertSourceDocumentState: AssertSourceDocumentState;
  readonly assertPeriodOpen: AssertPeriodOpen;
}
