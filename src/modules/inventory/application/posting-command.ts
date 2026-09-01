import { z } from 'zod';

import { InventoryStatus, OutboundPurpose, TransactionType } from '@/generated/prisma/client';
import type { ActorContext } from '@/modules/auth/application';
import { isZero, toDecimal } from '@/shared/decimal';
import { ValidationError } from '@/shared/errors';

/**
 * Posting 입력 계약 + 구조 검증 ① (T2-5).
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.1(`PostingCommand`
 *    ·`PostingEntry`·`PostingResult`) · §8.2 ①(*"Zod: 필수값·타입·entries≥1·
 *    delta≠0"*) · §8.12 `validateStructure(cmd)`.
 *
 * ## T2-5 는 `post()` 를 만들지 않는다
 *
 * `docs/04 §8.12` 의 `post(cmd): Promise<PostingResult>` 는 검증 ①~⑳ 전체를
 * 담는 **완성형**이며 `T2-10` 소유다. 실제 첫 호출자(`docs/07:254` `T4-10`
 * *"승인 → OPENING_BALANCE 반영 (Posting Service 호출)"*)의 선행조건도 **T2-10**
 * 이다. T2-5 를 선행으로 갖는 `T2-6`·`T2-15` 는 `post()` 를 호출하지 않는다.
 *
 * 따라서 T2-5 는 **호출자가 없는 Phase-1 검증 진입점만** landing 한다 —
 * `src/modules/bom/application/validate-candidate.ts`(T07-2)가
 * *"T07-2 에는 아직 그 endpoint 들이 없다. T07-3/T07-5 가 이 함수를 호출한다"*
 * 로 세운 선례와 같은 구조다.
 *
 * ⛔ `post()` · `postInventoryTransaction()` · `class InventoryPostingService`
 *    를 만들지 않는다. throw-not-implemented placeholder 도 만들지 않는다.
 *
 * ## Decimal 은 십진 문자열이다
 *
 * ⛔ JSON number 를 받지 않는다 — `z.string()` 이 타입 단계에서 400 이다.
 *    BOM DTO(`modules/bom/application/dto.ts`)와 같은 규약이며,
 *    `Number()`·`parseFloat()`·`Math.round()` 는 전역 금지다.
 */

// ═══════════════════════════════════════════════════════════════
// 형식 상수
// ═══════════════════════════════════════════════════════════════

/** `DECIMAL(18,6)` — 정수부 12자리 + 소수부 6자리. 부호 있음. */
const SIGNED_DECIMAL_18_6 = /^-?\d{1,12}(?:\.\d{1,6})?$/;

/** `DECIMAL(18,6)` — 부호 없음. `originalQuantity`·`conversionFactor` 용. */
const UNSIGNED_DECIMAL_18_6 = /^\d{1,12}(?:\.\d{1,6})?$/;

export const LOT_NO_MAX_LENGTH = 100;
export const SERIAL_NO_MAX_LENGTH = 200;
export const OWNER_CODE_MAX_LENGTH = 30;
export const UOM_MAX_LENGTH = 20;
export const EXTERNAL_LINE_ID_MAX_LENGTH = 200;
export const SOURCE_DOCUMENT_TYPE_MAX_LENGTH = 50;
export const SOURCE_DOCUMENT_NO_MAX_LENGTH = 100;
export const REASON_CODE_MAX_LENGTH = 50;

/**
 * 원인문서 없이 posting 할 수 있는 유일한 거래유형 (`docs/04 §8.2` ④).
 *
 * > `OPENING_BALANCE` | 불필요(배치 자체가 근거) — `docs/04 §8.3`
 */
export const SOURCE_DOCUMENT_EXEMPT_TYPE: TransactionType = TransactionType.OPENING_BALANCE;

// ═══════════════════════════════════════════════════════════════
// 공용 조각
// ═══════════════════════════════════════════════════════════════

/**
 * `quantityDelta` — 부호 있는 `DECIMAL(18,6)` 문자열, **`≠ 0`**.
 *
 * ★ `≠ 0` 은 **개별 entry 기준**이다 (`docs/04 §8.2` ① *"**개별**
 *   `quantityDelta ≠ 0`"*). 그룹 `netQuantityDelta` 는 0 일 수 있으며 그것은
 *   T2-6 이후의 개념이다. DB `CHECK ck_qty_nonzero` 가 같은 단위로 이중 방어한다.
 *
 * ⛔ `Number(value) !== 0` 으로 판정하지 않는다 — `'0.0000001'` 같은 값에서
 *    정밀도가 깨진다. Decimal 로 비교한다.
 */
const signedQuantityDelta = z
  .string()
  .regex(SIGNED_DECIMAL_18_6, {
    message: '수량은 부호를 포함한 소수점 6자리 이내 십진 문자열이어야 합니다.',
  })
  // 형식이 이미 틀린 값은 위 regex 오류로 보고되게 두고 여기서는 통과시킨다.
  .refine((value) => !SIGNED_DECIMAL_18_6.test(value) || !isZero(toDecimal(value)), {
    message: '수량 증감은 0 일 수 없습니다.',
  });

const unsignedDecimal = z.string().regex(UNSIGNED_DECIMAL_18_6, {
  message: '수량은 소수점 6자리 이내의 0 이상 십진 문자열이어야 합니다.',
});

/** `@db.Date` / `@db.Timestamptz` 입력 — ISO 문자열 또는 `Date`. */
const dateInput = z.coerce.date();

// ═══════════════════════════════════════════════════════════════
// PostingEntry — `docs/04 §8.1` 원문 17필드
// ═══════════════════════════════════════════════════════════════

/**
 * 원장 한 줄의 입력 (`docs/04:70-91`).
 *
 * ⛔ `lineNo` 는 **입력이 아니다.** `docs/04 §8.12` 는 `lineNo` 를 정규화 map
 *    안(`cmd.entries.map((e, i) => ({ ...normalizeStockKey(e, refs), lineNo: i+1 }))`)
 *    에서 만든다. 그 정규화는 **T2-6** 소유이므로 **파생도 T2-5 에서 하지 않는다.**
 *    실제 파생 owner 는 후속 task 가 확정한다.
 * ⛔ `expiryKey` 도 입력이 아니다 — `expiryDate ?? '9999-12-31'` 센티넬은
 *    `normalizeStockKey`(T2-6)의 산출물이다.
 * ⛔ `lotNo`·`serialNo`·`ownerCode` 의 센티넬 정규화(`''`·`'DEEPPOINT'`)도
 *    여기서 하지 않는다 — 형식만 본다.
 */
export const postingEntrySchema = z.strictObject({
  // ── 재고키 ─────────────────────────────────────────────────
  skuId: z.uuid(),
  warehouseId: z.uuid(),
  /** 미지정 시 창고 DEFAULT 로케이션 — 치환은 **T2-6** `normalizeStockKey`. */
  locationId: z.uuid().optional(),
  inventoryStatus: z.enum(InventoryStatus),
  lotNo: z.string().max(LOT_NO_MAX_LENGTH).optional(),
  expiryDate: dateInput.optional(),
  manufacturedDate: dateInput.optional(),
  serialNo: z.string().max(SERIAL_NO_MAX_LENGTH).optional(),
  ownerCode: z.string().max(OWNER_CODE_MAX_LENGTH).optional(),

  // ── 수량 ───────────────────────────────────────────────────
  quantityDelta: signedQuantityDelta,
  originalQuantity: unsignedDecimal.optional(),
  originalUom: z.string().max(UOM_MAX_LENGTH).optional(),
  conversionFactor: unsignedDecimal.optional(),

  // ── 출고 전용 ──────────────────────────────────────────────
  channelId: z.uuid().optional(),
  outboundPurpose: z.enum(OutboundPurpose).optional(),
  externalLineId: z.string().max(EXTERNAL_LINE_ID_MAX_LENGTH).optional(),
  note: z.string().optional(),
});

export type PostingEntry = z.infer<typeof postingEntrySchema>;

// ═══════════════════════════════════════════════════════════════
// PostingCommand — `docs/04 §8.1` 원문에서 승인 3필드를 뺀 형태
// ═══════════════════════════════════════════════════════════════

/**
 * 원인문서 참조 (`docs/04 §8.1`).
 *
 * ⛔ `type` 에 enum·allowlist·CHECK 를 만들지 않는다. `docs/04 §8.3` 에 9개
 *    이름이 흩어져 있으나 authoritative enum 이 없고, DB 도
 *    `source_document_type String?` 자유문자열이다. **존재·상태 검증은 port**
 *    다(각 document model 이 landing 한 뒤 concrete 가 붙는다).
 *
 * ★ **`type`·`id` 의 non-blank 는 여기(①)가 아니라 ④가 판정한다.** 원인문서
 *   누락은 형식 오류(400)가 아니라 업무규칙 위반이며 `docs/04 §8.2` 가
 *   `MISSING_SOURCE_DOCUMENT`(422)로 지정했다. ① 에서 `.min(1)` 로 막으면
 *   `{type:'   '}` 가 400 이 되어 같은 사실이 두 코드로 갈린다. 규칙 하나에
 *   소유자 하나다.
 */
export const postingSourceDocumentSchema = z.strictObject({
  type: z.string().max(SOURCE_DOCUMENT_TYPE_MAX_LENGTH),
  id: z.string().max(SOURCE_DOCUMENT_NO_MAX_LENGTH),
  no: z.string().max(SOURCE_DOCUMENT_NO_MAX_LENGTH).optional(),
});

export type PostingSourceDocument = z.infer<typeof postingSourceDocumentSchema>;

/** 외부시스템 유입 정보 (`docs/04 §8.1`). T2-5 에서는 **타입뿐**이다. */
export const postingExternalSchema = z.strictObject({
  systemId: z.uuid(),
  transactionId: z.string().max(EXTERNAL_LINE_ID_MAX_LENGTH),
  importedAt: dateInput.optional(),
});

export type PostingExternal = z.infer<typeof postingExternalSchema>;

/**
 * `PostingCommand` 에서 **`actor` 를 제외한** 부분.
 *
 * ★ `actor` 를 Zod 로 검증하지 않는 이유: `ActorContext` 는 요청 본문·헤더에서
 *   오는 값이 **아니다**(`modules/auth/domain/actor.ts` — *"요청 본문이나
 *   헤더에서 actor 정보를 받지 않는다"*). 서버가 검증된 Supabase 사용자와 DB
 *   조회로만 만든다. 구조 검증 대상에 넣으면 client 입력처럼 보이게 된다.
 *   저장소의 다른 서비스(`createWarehouse`·`submitSku` …)도 전부 actor 를
 *   payload 밖 별도 인자로 다룬다.
 *
 * ⚠️ `z.strictObject` — 미지원 키는 조용히 무시하지 않고 **400** 이다.
 */
export const postingCommandPayloadSchema = z.strictObject({
  transactionType: z.enum(TransactionType),
  /** 업무 발생 일시(UTC). `businessDate` 는 서비스가 KST 로 파생한다. */
  occurredAt: dateInput,
  /** 최소 1개. ★ 동일 재고키 중복 허용 — 합산은 T2-6. */
  entries: z.array(postingEntrySchema).min(1, { message: '원장 라인이 최소 1건 필요합니다.' }),

  sourceDocument: postingSourceDocumentSchema.optional(),
  external: postingExternalSchema.optional(),
  idempotencyKey: z.string().max(SOURCE_DOCUMENT_NO_MAX_LENGTH).optional(),

  reasonCode: z.string().max(REASON_CODE_MAX_LENGTH).optional(),
  reasonDetail: z.string().optional(),
  attachmentGroupId: z.uuid().optional(),

  reversalOfId: z.uuid().optional(),
});

export type PostingCommandPayload = z.infer<typeof postingCommandPayloadSchema>;

/**
 * Posting 입력 (`docs/04 §8.1`).
 *
 * ⛔ **승인 관련 필드가 하나도 없다** — `approvedBy` · `allowNegativeStock` ·
 *    `allowClosedPeriod`. `docs/PENDING_v0.3_보완사항.md` **§2** 가
 *    *"승인자 ID 직접 입력 금지 — `PostingCommand.approvedBy` 문자열 신뢰 제거"*
 *    로 `docs/04 §8.1` 을 supersede 했고, 영향 작업에 **`T2-5`** 를 지목했다.
 *    같은 문서 §1·§6 은 이미 실행되어 `Sku.negativeStockAllowed` 제거와
 *    `allow_self_approval_sku`/`_bom` 분리로 정본·스키마를 바꾼 실적이 있다.
 *
 * ⛔ 대체 필드 `approvalRequestId` 도 넣지 않는다 — 가리킬 승인요청 모델이
 *    스키마·`docs/03`·`docs/07` 어디에도 없다. `docs/04:616` 이 스스로
 *    *"(아래 의사코드는 R1a-2 에서 예외요청 모델 기준으로 재작성한다)"* 로
 *    이 구간을 미확정으로 선언해 두었다.
 *
 * 승인요청 모델과 승인 재검증은 **T2-9 / T2-14 / T2-15** 가 실제 모델과 함께
 * 확정한다. 그때 optional 필드를 추가하는 것은 breaking change 가 아니다.
 */
export interface PostingCommand extends PostingCommandPayload {
  /** 서버가 만든 인증 주체. ⛔ 요청 본문에서 받지 않는다. */
  readonly actor: ActorContext;
}

// ═══════════════════════════════════════════════════════════════
// PostingResult — 타입 선언 전용
// ═══════════════════════════════════════════════════════════════

/** 재고키별 갱신 결과 (`docs/04 §8.1` `balancesAfter`). */
export interface StockKeyBalance {
  readonly stockKey: string;
  readonly quantity: string;
}

/**
 * Posting 결과 (`docs/04:117-124`).
 *
 * ⛔ **T2-5 는 이 타입을 선언만 한다.** 생성·반환하지 않으며 어떤 T2-5 함수의
 *    시그니처에도 나타나지 않는다. Phase-1 검증은 DB 에 아무것도 쓰지 않으므로
 *    `transactionId`·`entryIds`·`balancesAfter` 를 만들 방법 자체가 없다.
 *
 * ⛔ `transactionNo` 발번기를 만들지 않는다 — T2-2 에서 `generator = LATER` 로
 *    확정되었다. 타입 필드로만 남으므로 구현 의존성이 생기지 않는다.
 *
 * 이 값을 실제로 만들어 반환하는 것은 **T2-10** 의 `post()` 다.
 */
export interface PostingResult {
  readonly transactionId: string;
  readonly transactionNo: string;
  readonly entryIds: readonly string[];
  readonly balancesAfter: readonly StockKeyBalance[];
  readonly exceptionsCreated: readonly string[];
  readonly idempotent: boolean;
}

// ═══════════════════════════════════════════════════════════════
// ① 구조 검증
// ═══════════════════════════════════════════════════════════════

/** Zod issue → `ValidationError`(400). 저장소 공통 변환 방식이다. */
function toValidationError(issues: readonly z.core.$ZodIssue[], message: string): ValidationError {
  return new ValidationError(
    issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'body',
      message: issue.message,
    })),
    { message },
  );
}

/**
 * 검증 ① — 구조 (`docs/04 §8.2` ①, `docs/04:527` `validateStructure(cmd)`).
 *
 * `entries.length ≥ 1` · **개별** `quantityDelta ≠ 0` · 필수값·타입 ·
 * 미지원 키 거부. 실패는 `VALIDATION_ERROR`(400) 다.
 *
 * ★ `actor` 는 검사 대상이 아니다(위 `postingCommandPayloadSchema` 주석).
 *   destructuring 으로 떼어 낸 뒤 나머지만 `strictObject` 에 넣는다.
 *
 * @throws {ValidationError} `VALIDATION_ERROR` / HTTP 400
 */
export function validateStructure(command: PostingCommand): PostingCommandPayload {
  const { actor: _actor, ...payload } = command;

  const result = postingCommandPayloadSchema.safeParse(payload);
  if (!result.success) {
    throw toValidationError(result.error.issues, '재고 거래 요청이 올바르지 않습니다.');
  }
  return result.data;
}
