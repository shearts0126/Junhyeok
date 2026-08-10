import { z } from 'zod';

import { Prisma, type SkuBarcode } from '@/generated/prisma/client';
import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { parseSkuId } from '@/modules/sku/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { resolveBarcodeUniqueViolation } from './constraint-errors';
import type { BarcodeMutateDependencies } from './create-barcode';
import { BARCODE_ENTITY_TYPE } from './create-barcode';
import { BARCODE_STATUS_PENDING_DUPLICATE, type RequestDuplicateCandidateInput } from './dto';
import {
  countActualDuplicates,
  duplicateCandidateExists,
  duplicateExceptionNotApplicable,
} from './duplicate-exception';
import { resolveBarcodeInput } from './normalize-input';
import { assertParentSkuExists } from './parent-sku';
import { BARCODE_REQUEST_DUPLICATE_PERMISSION } from './policy';
import { toSkuBarcodeView, type SkuBarcodeView } from './views';

/**
 * `POST /api/skus/{skuId}/barcodes/duplicate-candidates` — 중복 예외 **요청** (T04-4A).
 *
 * ⚠️ 근거: `docs/11_설계복구_Barcode중복예외승인.md` §2·§5·§6·§7·§9·§10·§11.
 *
 * ## 왜 별도 endpoint 인가
 *
 * 일반 `POST /api/skus/{skuId}/barcodes` 의 계약은 **그대로 유지**된다 —
 * 동일 ACTIVE 바코드가 있으면 409 `BARCODE_DUPLICATE` 이고 행을 만들지 않는다.
 * 사용자가 의도적으로 바코드 공유를 요청할 때만 이 endpoint 를 호출한다.
 *
 * ## 처리 순서
 *
 *   1. 권한(`barcode.request_duplicate`) → 2. 경로 UUID → 3. 부모 SKU 404
 *   → 4. 정규화(T04-2/T04-3 경로 재사용) → 5. **실제 중복 확인**(cross-SKU ACTIVE)
 *   → 6. 기존 후보 확인 → 7. 트랜잭션: 멱등 claim → candidate INSERT → AuditLog → snapshot
 *
 * ★ candidate 는 `status='PENDING_DUPLICATE'` 로 만들어진다. 이 상태는
 *   `ux_barcode_active`·`ux_barcode_primary` predicate **밖**이라 중복 상태로
 *   존재할 수 있으며, 승인 전까지 어떤 활성 효력도 갖지 않는다.
 *
 * ⛔ `duplicateException` 을 여기서 true 로 만들지 않는다 — 승인 endpoint 전용이다.
 * ⛔ 별도 `requestedBy` 컬럼을 만들지 않는다 — 요청 행위는 AuditLog 가 보존한다.
 */

export const BARCODE_REQUEST_DUPLICATE_ACTION = 'REQUEST_DUPLICATE';

/** 멱등 scope 의 route template — raw UUID 를 넣지 않는다. */
export const BARCODE_CANDIDATE_ROUTE_SCOPE = '/api/skus/{id}/barcodes/duplicate-candidates';

export type RequestDuplicateCandidateResult = {
  readonly barcode: SkuBarcodeView;
  /** true 면 멱등 replay — 라우트는 201 이 아니라 200 으로 응답한다. */
  readonly replayed: boolean;
  /** true 면 동일 내용의 기존 후보를 그대로 돌려준 것 — 새 row·AuditLog 없음. */
  readonly existing: boolean;
};

const candidateSnapshotSchema = z.looseObject({
  id: z.uuid(),
  skuId: z.uuid(),
  barcode: z.string(),
  status: z.string(),
});

function parseCandidateSnapshot(raw: unknown): SkuBarcodeView {
  const result = candidateSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 SkuBarcodeView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as SkuBarcodeView;
}

/**
 * 검증된 요청의 canonical request hash.
 *
 * ★ 경로의 `skuId` 를 포함하고 **정규화 전 원 입력**을 해싱한다 — T04-3 과 동일 정책.
 */
export function barcodeCandidateRequestHash(
  skuId: string,
  input: RequestDuplicateCandidateInput,
): string {
  return requestHashOf({ skuId, ...input });
}

/** 기존 후보와 업무 필드가 완전히 같은가 (§9). */
function sameCandidateFields(row: SkuBarcode, input: RequestDuplicateCandidateInput): boolean {
  return row.barcodeType === input.barcodeType && row.isPrimary === (input.isPrimary ?? false);
}

async function performRequest(
  tx: TransactionClient,
  actor: ActorContext,
  skuId: string,
  barcode: string,
  input: RequestDuplicateCandidateInput,
  logger: AuditLogger,
): Promise<SkuBarcodeView> {
  const created = await tx.skuBarcode.create({
    data: {
      skuId,
      barcode,
      barcodeType: input.barcodeType,
      isPrimary: input.isPrimary ?? false,
      // ★ candidate 초기값 (docs/11 §5) — 승인 전에는 예외가 아니다.
      status: BARCODE_STATUS_PENDING_DUPLICATE,
      duplicateException: false,
      exceptionReason: null,
      approvedBy: null,
    },
  });

  const view = toSkuBarcodeView(created);

  await logger.write(tx, {
    actor,
    entityType: BARCODE_ENTITY_TYPE,
    entityId: created.id,
    action: BARCODE_REQUEST_DUPLICATE_ACTION,
    beforeValue: null,
    afterValue: view,
  });

  return view;
}

export async function requestDuplicateCandidate(
  actor: ActorContext,
  rawSkuId: string,
  input: RequestDuplicateCandidateInput,
  dependencies: BarcodeMutateDependencies = {},
  idempotencyKey?: string,
): Promise<RequestDuplicateCandidateResult> {
  assertPermission(actor, BARCODE_REQUEST_DUPLICATE_PERMISSION);
  const skuId = parseSkuId(rawSkuId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  // ★ 정규화는 트랜잭션 밖에서 끝난다 — 400/422 는 claim 이전에 종료된다.
  const resolved = resolveBarcodeInput(input.barcode);
  if (resolved.kind === 'EMPTY') {
    // 미입력 표시값에는 공유할 바코드 자체가 없다 → 중복 예외 대상이 아니다.
    throw duplicateExceptionNotApplicable(input.barcode);
  }
  const barcode = resolved.barcode;

  const { getPrismaClient } = await import('@/shared/db');
  const db = getPrismaClient();

  try {
    return await run(async (tx) => {
      await assertParentSkuExists(tx, skuId);

      // ★ 실제 중복(cross-SKU ACTIVE)이 없으면 후보를 만들지 않는다.
      if ((await countActualDuplicates(tx, { skuId, barcode })) === 0) {
        throw duplicateExceptionNotApplicable(barcode);
      }

      // 같은 SKU·바코드의 승인 대기 후보가 이미 있으면 새로 만들지 않는다.
      const existing = await tx.skuBarcode.findFirst({
        where: { skuId, barcode, status: BARCODE_STATUS_PENDING_DUPLICATE },
      });
      if (existing !== null) {
        if (!sameCandidateFields(existing, input)) throw duplicateCandidateExists(existing.id);
        // 내용까지 동일 — row·AuditLog·멱등기록 없이 기존 후보를 그대로 낸다.
        return { barcode: toSkuBarcodeView(existing), replayed: false, existing: true };
      }

      if (idempotencyKey === undefined) {
        return {
          barcode: await performRequest(tx, actor, skuId, barcode, input, logger),
          replayed: false,
          existing: false,
        };
      }

      const outcome = await executeWithIdempotency(
        tx,
        {
          actorId: actor.userId,
          httpMethod: 'POST',
          routeScope: BARCODE_CANDIDATE_ROUTE_SCOPE,
          idempotencyKey,
        },
        barcodeCandidateRequestHash(skuId, input),
        async () => ({
          responseStatus: 201,
          responseBody: await performRequest(tx, actor, skuId, barcode, input, logger),
        }),
        parseCandidateSnapshot,
      );
      return { barcode: outcome.responseBody, replayed: outcome.replayed, existing: false };
    });
  } catch (error) {
    // ★ 동시 요청 경합 — `ux_barcode_pending_duplicate` 가 최종 방어선이다.
    //   트랜잭션은 이미 abort 되었으므로 밖에서 다시 읽어 §9 규칙을 적용한다.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      resolveBarcodeUniqueViolation(error) === 'ux_barcode_pending_duplicate'
    ) {
      const existing = await db.skuBarcode.findFirst({
        where: { skuId, barcode, status: BARCODE_STATUS_PENDING_DUPLICATE },
      });
      if (existing !== null && sameCandidateFields(existing, input)) {
        return { barcode: toSkuBarcodeView(existing), replayed: false, existing: true };
      }
      throw duplicateCandidateExists(existing?.id ?? '');
    }
    throw error;
  }
}
