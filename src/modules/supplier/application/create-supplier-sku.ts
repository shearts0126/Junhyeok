import { z } from 'zod';

import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { supplierSkuPeriodInvalid, translateSupplierSkuWriteError } from './constraint-errors';
import { SUPPLIER_SKU_ENTITY_TYPE, type SupplierMutateDependencies } from './create-supplier';
import { parseDateOnly, parseSupplierId, type CreateSupplierSkuInput } from './dto';
import { SUPPLIER_CREATE_PERMISSION } from './policy';
import { assertSkuUsable, assertSupplierExists } from './refs';
import { SUPPLIER_SKU_VIEW_INCLUDE, toSupplierSkuView, type SupplierSkuView } from './views';

/**
 * `POST /api/suppliers/{id}/skus` — 공급조건 등록 (T06-2, D-12~D-14·D-17·D-19).
 *
 * ⚠️ **2차 권한 가드.** `supplier.create` 를 재검사한다. ADMIN bypass 없음.
 *
 * - eligibility: parent Supplier 존재 · SKU 존재(`deletedAt IS NULL`) 뿐 (D-19).
 * - `[effectiveFrom, effectiveTo)` half-open — 종료일이 있으면 시작일보다
 *   **커야** 한다. 위반은 422 (DB CHECK 는 최종 방어선).
 * - 기간 중첩·동일 시작일·현행 대표 충돌은 **DB 가 최종 판정**한다 —
 *   선조회로 대체하지 않고 EXCLUDE/UNIQUE 위반을 409 로 번역한다.
 * ⛔ 대표 자동 교체 없음 (D-17) — 기존 현행 대표가 있으면 409 다.
 *
 * ## 멱등성 (D-24)
 *
 * scope 의 routeScope 에 **실제 supplierId 를 포함**한다:
 * `/api/suppliers/{uuid}/skus`. 같은 key 를 다른 supplier 에 쓰면 서로 다른
 * scope 라 독립 요청이다.
 */

export function supplierSkuCreateRouteScope(supplierId: string): string {
  return `/api/suppliers/${supplierId}/skus`;
}

export interface CreateSupplierSkuResult {
  readonly supplierSku: SupplierSkuView;
  readonly replayed: boolean;
}

const supplierSkuSnapshotSchema = z.looseObject({
  id: z.uuid(),
  supplierId: z.uuid(),
  skuId: z.uuid(),
  effectiveFrom: z.string(),
});

export function parseSupplierSkuViewSnapshot(raw: unknown): SupplierSkuView {
  const result = supplierSkuSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 SupplierSkuView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as SupplierSkuView;
}

/** `[from, to)` — 종료일이 있으면 시작일보다 커야 한다 (zero-length 금지). */
export function assertValidPeriod(effectiveFrom: Date, effectiveTo: Date | null): void {
  if (effectiveTo !== null && effectiveTo.getTime() <= effectiveFrom.getTime()) {
    throw supplierSkuPeriodInvalid(
      '종료 경계일(effectiveTo)은 시작일(effectiveFrom)보다 커야 합니다. ' +
        '[from, to) 반개구간이라 같은 날짜는 길이 0 구간입니다.',
    );
  }
}

async function performCreate(
  tx: TransactionClient,
  actor: ActorContext,
  supplierId: string,
  input: CreateSupplierSkuInput,
  logger: typeof auditLogger,
): Promise<SupplierSkuView> {
  await assertSupplierExists(tx, supplierId);
  await assertSkuUsable(tx, input.skuId);

  const effectiveFrom = parseDateOnly(input.effectiveFrom);
  const effectiveTo =
    input.effectiveTo === undefined || input.effectiveTo === null
      ? null
      : parseDateOnly(input.effectiveTo);
  assertValidPeriod(effectiveFrom, effectiveTo);

  let created;
  try {
    created = await tx.supplierSku.create({
      data: {
        supplierId,
        skuId: input.skuId,
        supplyType: input.supplyType,
        effectiveFrom,
        effectiveTo,
        supplierSkuCode: input.supplierSkuCode ?? null,
        supplierSkuName: input.supplierSkuName ?? null,
        moq: input.moq ?? null,
        orderMultiple: input.orderMultiple ?? null,
        leadTimeDays: input.leadTimeDays ?? null,
        purchaseUom: input.purchaseUom ?? null,
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        isPrimary: input.isPrimary ?? false,
        // ★ destinationWarehouseId 는 T08-1 전까지 항상 null (D-9).
      },
      include: SUPPLIER_SKU_VIEW_INCLUDE,
    });
  } catch (error) {
    translateSupplierSkuWriteError(error);
  }

  const view = toSupplierSkuView(created);

  // ★ 같은 트랜잭션 — 로그 실패 시 생성도 롤백된다 (D-25·D-27).
  await logger.write(tx, {
    actor,
    entityType: SUPPLIER_SKU_ENTITY_TYPE,
    entityId: created.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: view,
  });

  return view;
}

export async function createSupplierSku(
  actor: ActorContext,
  rawSupplierId: string,
  input: CreateSupplierSkuInput,
  dependencies: SupplierMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreateSupplierSkuResult> {
  // ★ 멱등 replay 보다 먼저.
  assertPermission(actor, SUPPLIER_CREATE_PERMISSION);
  const supplierId = parseSupplierId(rawSupplierId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    if (idempotencyKey === undefined) {
      return {
        supplierSku: await performCreate(tx, actor, supplierId, input, logger),
        replayed: false,
      };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        // ★ 실제 supplierId 포함 — 다른 supplier 의 같은 key 와 독립이다 (D-24).
        routeScope: supplierSkuCreateRouteScope(supplierId),
        idempotencyKey,
      },
      requestHashOf(input),
      async () => ({
        responseStatus: 201,
        responseBody: await performCreate(tx, actor, supplierId, input, logger),
      }),
      parseSupplierSkuViewSnapshot,
    );
    return { supplierSku: outcome.responseBody, replayed: outcome.replayed };
  });
}
