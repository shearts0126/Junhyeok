import { z } from 'zod';

import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { translateSupplierPriceWriteError } from './constraint-errors';
import type { SupplierMutateDependencies } from './create-supplier';
import { parseDateOnly, parseSupplierSkuId } from './dto';
import { SUPPLIER_PRICE_CREATE_PERMISSION } from './policy';
import type { CreatePriceInput } from './price-dto';
import { toSupplierSkuPriceView, type SupplierSkuPriceView } from './price-views';
import { supplierSkuNotFound } from './refs';

/**
 * `POST /api/supplier-skus/{id}/prices` — 가격 등록 (T06-3, §4·§37).
 *
 * ⚠️ **2차 권한 가드.** `supplier_price.create` 를 재검사한다. ADMIN bypass 없음.
 *
 * ## 가격 등록 ≠ 가격 발효 — 이 API 는 **미승인 제안행 생성**뿐이다
 *
 * 신규 row 는 항상:
 *
 *   approvedBy = null (미승인) · createdBy = actor.userId · effectiveTo = null
 *
 * POST 순간에는 **아무것도 닫지 않는다** — 기존 승인 가격 `effectiveTo` 변경
 * 금지 · chain 변경 금지 · asOf 결과 변경 금지. predecessor/successor 조회조차
 * 하지 않는다. 발효(chain 편입)는 오직 APPROVE 트랜잭션의 몫이다 (D-13·D-14).
 *
 * - eligibility: parent SupplierSku 존재뿐 (§48). 과거/미래 기간·Supplier/SKU
 *   status 를 등록 제한으로 쓰지 않는다.
 * - `effectiveFrom` 은 과거(backfill)·오늘·미래(예약가) 모두 허용 (D-10).
 * - 동일 시작일은 DB UNIQUE`(supplier_sku_id, effective_from)` 가 최종 판정 —
 *   409 `SUPPLIER_PRICE_EFFECTIVE_FROM_DUPLICATE`. 미승인 행도 시작일을
 *   선점한다 — known limitation (D-15).
 *
 * ## 멱등성 (D-30)
 *
 * routeScope 에 **실제 supplierSkuId** 를 포함한다:
 * `/api/supplier-skus/{uuid}/prices`. 같은 key 를 다른 SupplierSku 에 쓰면
 * 서로 다른 scope 라 독립 요청이다.
 */

export const SUPPLIER_SKU_PRICE_ENTITY_TYPE = 'SupplierSkuPrice';

export function supplierSkuPriceCreateRouteScope(supplierSkuId: string): string {
  return `/api/supplier-skus/${supplierSkuId}/prices`;
}

export interface CreatePriceResult {
  readonly price: SupplierSkuPriceView;
  /** true 면 멱등 replay — 라우트는 201 이 아니라 200 으로 응답한다. */
  readonly replayed: boolean;
}

const priceSnapshotSchema = z.looseObject({
  id: z.uuid(),
  supplierSkuId: z.uuid(),
  unitPrice: z.string(),
  effectiveFrom: z.string(),
});

export function parseSupplierSkuPriceViewSnapshot(raw: unknown): SupplierSkuPriceView {
  const result = priceSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 SupplierSkuPriceView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as SupplierSkuPriceView;
}

async function performCreate(
  tx: TransactionClient,
  actor: ActorContext,
  supplierSkuId: string,
  input: CreatePriceInput,
  logger: AuditLogger,
): Promise<SupplierSkuPriceView> {
  const parent = await tx.supplierSku.findUnique({
    where: { id: supplierSkuId },
    select: { id: true },
  });
  if (parent === null) throw supplierSkuNotFound(supplierSkuId);

  let created;
  try {
    created = await tx.supplierSkuPrice.create({
      data: {
        supplierSkuId,
        unitPrice: input.unitPrice,
        currency: input.currency,
        vatIncluded: input.vatIncluded,
        effectiveFrom: parseDateOnly(input.effectiveFrom),
        sourceDocument: input.sourceDocument,
        // ★ 등록/발효 분리 (§4) — 항상 미승인·open-ended 로 태어난다.
        effectiveTo: null,
        approvedBy: null,
        createdBy: actor.userId,
        // ★ attachmentId 는 staged — 항상 null (D-26).
      },
    });
  } catch (error) {
    translateSupplierPriceWriteError(error);
  }

  const view = toSupplierSkuPriceView(created);

  // ★ 같은 트랜잭션 — 로그 실패 시 생성도 롤백된다.
  await logger.write(tx, {
    actor,
    entityType: SUPPLIER_SKU_PRICE_ENTITY_TYPE,
    entityId: created.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: view,
  });

  return view;
}

export async function createSupplierSkuPrice(
  actor: ActorContext,
  rawSupplierSkuId: string,
  input: CreatePriceInput,
  dependencies: SupplierMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreatePriceResult> {
  // ★ 멱등 replay 보다 먼저 — 권한을 잃은 actor 는 replay 도 403 이다.
  assertPermission(actor, SUPPLIER_PRICE_CREATE_PERMISSION);
  const supplierSkuId = parseSupplierSkuId(rawSupplierSkuId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    if (idempotencyKey === undefined) {
      return {
        price: await performCreate(tx, actor, supplierSkuId, input, logger),
        replayed: false,
      };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        // ★ 실제 supplierSkuId 포함 — 다른 SupplierSku 의 같은 key 와 독립 (D-30).
        routeScope: supplierSkuPriceCreateRouteScope(supplierSkuId),
        idempotencyKey,
      },
      requestHashOf(input),
      async () => ({
        responseStatus: 201,
        responseBody: await performCreate(tx, actor, supplierSkuId, input, logger),
      }),
      parseSupplierSkuPriceViewSnapshot,
    );
    return { price: outcome.responseBody, replayed: outcome.replayed };
  });
}
