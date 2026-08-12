import { z } from 'zod';

import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { translateSupplierWriteError } from './constraint-errors';
import type { CreateSupplierInput } from './dto';
import { SUPPLIER_CREATE_PERMISSION } from './policy';
import { toSupplierView, type SupplierView } from './views';

/**
 * `POST /api/suppliers` — 거래처 생성 (T06-2, D-4).
 *
 * ⚠️ **2차 권한 가드.** `supplier.create` 를 재검사한다. ADMIN bypass 없음.
 *    권한 검사는 멱등 replay 보다 먼저다.
 *
 * ★ server-managed — 입력과 무관하게 강제된다 (DTO 가 이미 400 처리):
 *   `status` = DB default `'ACTIVE'` (D-6) · `defaultWarehouseId` = null (D-9).
 *
 * 중복 `supplierCode` 는 DB UNIQUE 가 최종 판정한다 — 선조회로 대체하지 않고
 * P2002 를 409 `SUPPLIER_CODE_DUPLICATE` 로 번역한다.
 *
 * 생성 + AuditLog(CREATE) + (멱등 시) snapshot 은 **한 트랜잭션**이다 (D-27).
 */

export const SUPPLIER_ENTITY_TYPE = 'Supplier';
export const SUPPLIER_SKU_ENTITY_TYPE = 'SupplierSku';

/** 멱등 scope 의 route template — raw URL 이 아니다. */
export const SUPPLIER_CREATE_ROUTE_SCOPE = '/api/suppliers';

export interface SupplierMutateDependencies {
  readonly auditLogger?: AuditLogger;
  readonly runInTransaction?: <T>(callback: (tx: TransactionClient) => Promise<T>) => Promise<T>;
}

export interface CreateSupplierResult {
  readonly supplier: SupplierView;
  /** true 면 멱등 replay — 라우트는 201 이 아니라 200 으로 응답한다. */
  readonly replayed: boolean;
}

/** replay snapshot 의 최소 무결성 검증 — DB JSON 을 무조건 신뢰하지 않는다. */
const supplierViewSnapshotSchema = z.looseObject({
  id: z.uuid(),
  supplierCode: z.string(),
  status: z.string(),
});

export function parseSupplierViewSnapshot(raw: unknown): SupplierView {
  const result = supplierViewSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 SupplierView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as SupplierView;
}

async function performCreate(
  tx: TransactionClient,
  actor: ActorContext,
  input: CreateSupplierInput,
  logger: AuditLogger,
): Promise<SupplierView> {
  let created;
  try {
    created = await tx.supplier.create({
      data: {
        supplierCode: input.supplierCode,
        supplierName: input.supplierName,
        supplierType: input.supplierType,
        businessRegistrationNo: input.businessRegistrationNo ?? null,
        contactName: input.contactName ?? null,
        contactPhone: input.contactPhone ?? null,
        contactEmail: input.contactEmail ?? null,
        defaultLeadTimeDays: input.defaultLeadTimeDays ?? null,
        note: input.note ?? null,
        // ★ server-managed — status 는 DB default(ACTIVE), warehouse 는 staged null.
      },
    });
  } catch (error) {
    translateSupplierWriteError(error, input.supplierCode);
  }

  const view = toSupplierView(created);

  // ★ 같은 트랜잭션 — 로그 실패 시 생성도 롤백된다 (D-25·D-27).
  await logger.write(tx, {
    actor,
    entityType: SUPPLIER_ENTITY_TYPE,
    entityId: created.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: view,
  });

  return view;
}

export async function createSupplier(
  actor: ActorContext,
  input: CreateSupplierInput,
  dependencies: SupplierMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreateSupplierResult> {
  // ★ 멱등 replay 보다 먼저 — 권한을 잃은 actor 는 replay 도 403 이다.
  assertPermission(actor, SUPPLIER_CREATE_PERMISSION);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    if (idempotencyKey === undefined) {
      return { supplier: await performCreate(tx, actor, input, logger), replayed: false };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        routeScope: SUPPLIER_CREATE_ROUTE_SCOPE,
        idempotencyKey,
      },
      requestHashOf(input),
      async () => ({
        responseStatus: 201,
        responseBody: await performCreate(tx, actor, input, logger),
      }),
      parseSupplierViewSnapshot,
    );
    return { supplier: outcome.responseBody, replayed: outcome.replayed };
  });
}
