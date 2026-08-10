import { z } from 'zod';

import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { parseSkuId } from '@/modules/sku/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { translateBarcodeWriteError } from './constraint-errors';
import type { CreateBarcodeInput } from './dto';
import { resolveBarcodeInput } from './normalize-input';
import { assertParentSkuExists } from './parent-sku';
import { BARCODE_CREATE_PERMISSION } from './policy';
import { toSkuBarcodeView, type SkuBarcodeView } from './views';

/**
 * `POST /api/skus/{id}/barcodes` — 바코드 추가 (T04-3).
 *
 * ⚠️ 근거: `docs/10_설계복구_BarcodeCRUD.md` §12·§13·§16·§17·§18·§19.
 *
 * ⚠️ **2차 권한 가드.** `barcode.create` 를 재검사한다. ADMIN bypass 없음.
 *    권한 검사는 **멱등 replay 보다 먼저**다.
 *
 * ## 처리 순서
 *
 *   1. 권한 → 2. 경로 UUID → 3. 부모 SKU 404 → 4. 정규화·분류
 *   → 5. `EMPTY` 면 여기서 종료(204, 저장 없음) → 6. 트랜잭션:
 *      멱등 claim → INSERT → AuditLog → snapshot
 *
 * ★ `EMPTY`·422·400 은 **claim 이전에 종료**된다 — mutation 이 시작되지 않은
 *   요청은 IdempotencyRecord 를 만들지 않는다(T1-3 과 같은 원칙). 따라서
 *   사용자가 같은 key 로 정상 값을 다시 제출할 수 있다.
 *
 * ⛔ DataIssue 를 만들지 않는다. ⛔ `duplicateException`·`exceptionReason`·
 *    `approvedBy` 를 설정하지 않는다 (T04-4 전용). ⛔ 중복이 나도 자동으로
 *    예외 처리하거나 기존 대표를 해제하지 않는다.
 */

export const BARCODE_ENTITY_TYPE = 'SkuBarcode';

/** 멱등 scope 의 route template — raw UUID 를 넣지 않는다. */
export const BARCODE_CREATE_ROUTE_SCOPE = '/api/skus/{id}/barcodes';

export interface BarcodeMutateDependencies {
  readonly auditLogger?: AuditLogger;
  readonly runInTransaction?: <T>(callback: (tx: TransactionClient) => Promise<T>) => Promise<T>;
}

export type CreateBarcodeResult =
  /** 입력이 미입력 표시값이었다 — 저장·감사로그·멱등기록 모두 없음. 라우트는 204. */
  | { readonly kind: 'EMPTY' }
  | { readonly kind: 'CREATED'; readonly barcode: SkuBarcodeView; readonly replayed: boolean };

const barcodeViewSnapshotSchema = z.looseObject({
  id: z.uuid(),
  skuId: z.uuid(),
  barcode: z.string(),
  status: z.string(),
});

function parseBarcodeViewSnapshot(raw: unknown): SkuBarcodeView {
  const result = barcodeViewSnapshotSchema.safeParse(raw);
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
 * ★ 경로의 `skuId` 를 포함한다 — routeScope 는 template 이라 SKU 를 구분하지
 *   못하므로, 같은 key 로 다른 SKU 에 등록하면 hash 불일치(409)로 검출된다.
 * ★ **정규화 전 원 입력**을 해싱한다 — 기존 정책과 동일하게 semantic
 *   normalization 을 하지 않는다. 따라서 `'001-234'` 와 `'001234'` 는 정규화
 *   결과가 같아도 서로 다른 요청이며, 같은 key 면 409 IDEMPOTENCY_KEY_REUSED 다.
 */
export function barcodeCreateRequestHash(skuId: string, input: CreateBarcodeInput): string {
  return requestHashOf({ skuId, ...input });
}

async function performCreate(
  tx: TransactionClient,
  actor: ActorContext,
  skuId: string,
  barcode: string,
  input: CreateBarcodeInput,
  logger: AuditLogger,
): Promise<SkuBarcodeView> {
  let created;
  try {
    created = await tx.skuBarcode.create({
      data: {
        skuId,
        barcode,
        barcodeType: input.barcodeType,
        isPrimary: input.isPrimary ?? false,
        // ★ server-managed — 입력이 아니라 서버가 정한다 (DTO 가 이미 400 처리).
        status: 'ACTIVE',
        duplicateException: false,
        exceptionReason: null,
        approvedBy: null,
      },
    });
  } catch (error) {
    // 동시 생성 경합 포함 — T04-1 조건부 UNIQUE 2종이 최종 판정한다.
    translateBarcodeWriteError(error, { skuId, barcode });
  }

  const view = toSkuBarcodeView(created);

  // ★ 같은 트랜잭션. 로그 실패 시 생성도 롤백된다.
  await logger.write(tx, {
    actor,
    entityType: BARCODE_ENTITY_TYPE,
    entityId: created.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: view,
  });

  return view;
}

export async function createSkuBarcode(
  actor: ActorContext,
  rawSkuId: string,
  input: CreateBarcodeInput,
  dependencies: BarcodeMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreateBarcodeResult> {
  // ★ 멱등 replay 보다 먼저 — 권한을 잃은 actor 는 replay 도 403 이다.
  assertPermission(actor, BARCODE_CREATE_PERMISSION);
  const skuId = parseSkuId(rawSkuId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    await assertParentSkuExists(tx, skuId);

    // ★ claim 이전에 종료 — EMPTY·422·400 은 IdempotencyRecord 를 남기지 않는다.
    //   (여기서 벗어나는 경로에는 INSERT 가 없으므로 롤백할 변경도 없다.)
    const resolved = resolveBarcodeInput(input.barcode);
    if (resolved.kind === 'EMPTY') return { kind: 'EMPTY' as const };

    const barcode = resolved.barcode;

    if (idempotencyKey === undefined) {
      return {
        kind: 'CREATED' as const,
        barcode: await performCreate(tx, actor, skuId, barcode, input, logger),
        replayed: false,
      };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        routeScope: BARCODE_CREATE_ROUTE_SCOPE,
        idempotencyKey,
      },
      barcodeCreateRequestHash(skuId, input),
      async () => ({
        responseStatus: 201,
        responseBody: await performCreate(tx, actor, skuId, barcode, input, logger),
      }),
      parseBarcodeViewSnapshot,
    );
    return { kind: 'CREATED' as const, barcode: outcome.responseBody, replayed: outcome.replayed };
  });
}
