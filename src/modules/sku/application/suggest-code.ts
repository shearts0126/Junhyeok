import { z } from 'zod';

import type { PrismaClient } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { findCommonCodeRefs } from '@/modules/common-code/application';
import {
  SKU_CODE_POLICY,
  SKU_SERIAL_MAX,
  buildSkuCodePrefix,
  formatSkuSerial,
  nextSkuSerial,
  skuSerialExhausted,
  usedSkuSerials,
} from '@/modules/sku/domain';
import { SystemError, ValidationError } from '@/shared/errors';

import { assertValidCodeRefs } from './code-ref-validation';
import { SKU_SUGGEST_CODE_PERMISSION } from './policy';

/**
 * SKU 코드 추천 (T03-7) — `STANDARD_PRODUCT_V1`.
 *
 * ⚠️ 규칙의 유일한 근거는 `docs/09_설계복구_SKU코드추천.md` (2026-08-09 설계복구).
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `sku.suggest_code` 를
 *    재검사한다. ADMIN bypass 없음.
 *
 * ## 완전한 read-only
 *
 * ⛔ Sku INSERT/UPDATE · AuditLog · IdempotencyRecord · serial 예약 ·
 *    SystemSetting/CommonCode 변경이 **하나도 없다.** 추천은 예약이 아니므로
 *    reservation/counter/sequence 테이블도 advisory lock 도 만들지 않는다.
 *    동시 호출이 같은 코드를 받는 것은 허용되며, 실제 생성 시 `sku_code` 전역
 *    UNIQUE(T1-3, 409 SKU_CODE_DUPLICATE)가 최종 방어선이다.
 *
 * ⛔ 입력에 `skuId` 가 없다 — 추천은 기존 SKU 수정이 아니므로 `hasTransaction`
 *    도 보지 않는다. 추천 결과를 실제 PATCH 하는 시점에 T1-2 guard 가 적용된다.
 */

/** 요청 DTO — 3개 모두 필수, unknown field 는 400. */
export const suggestSkuCodeSchema = z.strictObject({
  brandId: z.uuid(),
  majorId: z.uuid(),
  minorId: z.uuid(),
});

export type SuggestSkuCodeInput = z.infer<typeof suggestSkuCodeSchema>;

export function parseSuggestSkuCodeInput(body: unknown): SuggestSkuCodeInput {
  const result = suggestSkuCodeSchema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : 'body',
        message: issue.message,
      })),
      { message: 'SKU 코드 추천 요청이 올바르지 않습니다.' },
    );
  }
  return result.data;
}

export interface SuggestSkuCodeResult {
  readonly suggestedCode: string;
  /** `Sku.serialNumber` 에 그대로 넣을 수 있는 3자리 문자열. UI 가 재파싱하지 않도록 함께 낸다. */
  readonly serialNumber: string;
}

/** 조회에 필요한 최소 클라이언트. 테스트에서 대역을 주입한다. */
export type SuggestCodeClient = Pick<PrismaClient, 'sku' | 'commonCode'>;

export interface SuggestCodeDependencies {
  readonly db?: SuggestCodeClient;
}

async function defaultClient(): Promise<SuggestCodeClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

/**
 * `POST /api/skus/suggest-code` — 다음 일련번호를 추천한다. **저장하지 않는다.**
 *
 * 1. 권한 → 2. CommonCode 검증(존재·그룹·active) → 3. prefix 조립 →
 * 4. prefix 를 공유하는 **모든 Sku**(soft-delete·전 status 포함)에서 사용 serial
 *    수집 → 5. MAX+1 (gap 재사용 없음) → 6. 후보 중복 방어 → 7. 반환.
 */
export async function suggestSkuCode(
  actor: ActorContext,
  input: SuggestSkuCodeInput,
  dependencies: SuggestCodeDependencies = {},
): Promise<SuggestSkuCodeResult> {
  assertPermission(actor, SKU_SUGGEST_CODE_PERMISSION);

  const db = dependencies.db ?? (await defaultClient());

  // ── CommonCode 검증 — T1-3 인프라 재사용 (요청 필드명으로 오류 경로 표기) ──
  await assertValidCodeRefs(
    db,
    { brandId: input.brandId, majorCategoryId: input.majorId, minorCategoryId: input.minorId },
    { paths: { majorCategoryId: 'majorId', minorCategoryId: 'minorId' } },
  );

  const refs = await findCommonCodeRefs(db, [input.brandId, input.majorId, input.minorId]);
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  const brand = byId.get(input.brandId);
  const major = byId.get(input.majorId);
  const minor = byId.get(input.minorId);
  if (brand === undefined || major === undefined || minor === undefined) {
    // 위 검증을 통과했다면 도달할 수 없다 (동시 삭제 등 비정상 상태).
    throw new SystemError({ message: '공통코드 조회 결과가 검증 결과와 일치하지 않습니다.' });
  }

  // ★ CommonCode.code 를 그대로 쓴다 — 대소문자 변환·trim·alias 치환 없음.
  const prefix = buildSkuCodePrefix({
    brandCode: brand.code,
    majorCode: major.code,
    minorCode: minor.code,
  });

  // ★ soft-delete 와 모든 status 를 포함한다 — 삭제·상태 변경으로 serial 이
  //   재사용되면 안 되므로 `deletedAt`·`status` 필터를 걸지 않는다.
  const rows = await db.sku.findMany({
    where: { skuCode: { startsWith: `${prefix}-` } },
    select: { skuCode: true },
  });
  const used = new Set(
    usedSkuSerials(
      prefix,
      rows.map((row) => row.skuCode),
    ),
  );

  // ── MAX+1 + 후보 중복 방어 ────────────────────────────────
  // 정상 흐름에서는 첫 후보가 곧 답이다. 동시 INSERT 등으로 후보가 이미
  // 존재하면 같은 cycle 안에서 다음 번호를 시도하고, 999 를 넘으면 소진이다.
  for (;;) {
    const serial = nextSkuSerial(used);
    if (serial === null) throw skuSerialExhausted(prefix);

    const serialNumber = formatSkuSerial(serial);
    const suggestedCode = `${prefix}-${serialNumber}`;

    const existing = await db.sku.findUnique({
      where: { skuCode: suggestedCode },
      select: { id: true },
    });
    if (existing === null) return { suggestedCode, serialNumber };

    used.add(serial);
  }
}

/** 정책 식별자 — 응답 계약 변경 없이 로그·문서 참조용으로 노출한다. */
export { SKU_CODE_POLICY, SKU_SERIAL_MAX };
