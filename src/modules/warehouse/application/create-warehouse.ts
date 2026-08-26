import { z } from 'zod';

import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError, ValidationError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { insertWarehouseWithDefaultLocation } from './atomic-create';
import { translateWarehouseWriteError } from './constraint-errors';
import { DEFAULT_TIMEZONE, isReservedWarehouseInput, type CreateWarehouseInput } from './dto';
import { IN_TRANSIT_WAREHOUSE_CODE, WAREHOUSE_CREATE_PERMISSION } from './policy';
import { assertExternalSystemExists, assertSupplierRefExists } from './refs';
import { toLocationView, toWarehouseView, type LocationView, type WarehouseView } from './views';

/**
 * `POST /api/warehouses` — 창고 생성 (T08-2).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D7(트랜잭션) · §W-D12(IN_TRANSIT) ·
 *    §W-D13(supplier runtime 규칙) · §W-D24(DTO) · §W-D35(audit) · §W-D36(멱등).
 *
 * ⚠️ **2차 권한 가드.** `warehouse.create` 를 재검사한다. ADMIN bypass 없음.
 *    권한 검사는 멱등 replay 보다 먼저다.
 *
 * ★ 창고 + DEFAULT 로케이션 + audit 2건 + (멱등 시) snapshot 이 **한 트랜잭션**
 *   이다. 어느 하나라도 실패하면 전부 롤백되고 **중간 warehouse row 가 남지
 *   않는다** (§W-D7).
 */

export const WAREHOUSE_ENTITY_TYPE = 'Warehouse';
export const WAREHOUSE_LOCATION_ENTITY_TYPE = 'WarehouseLocation';

/** 멱등 scope (§W-D36) — BOM 의 `'bom:create'` 와 같은 형태다. */
export const WAREHOUSE_CREATE_ROUTE_SCOPE = 'warehouse:create';

export interface WarehouseMutateDependencies {
  readonly auditLogger?: AuditLogger;
  readonly runInTransaction?: <T>(callback: (tx: TransactionClient) => Promise<T>) => Promise<T>;
}

export interface CreateWarehouseResult {
  readonly warehouse: WarehouseView;
  readonly defaultLocation: LocationView;
  /** true 면 멱등 replay — 라우트는 201 이 아니라 200 으로 응답한다. */
  readonly replayed: boolean;
}

/** replay snapshot 의 최소 무결성 검증 — DB JSON 을 무조건 신뢰하지 않는다. */
const createSnapshotSchema = z.looseObject({
  warehouse: z.looseObject({
    id: z.uuid(),
    warehouseCode: z.string(),
    defaultLocationId: z.uuid(),
  }),
  defaultLocation: z.looseObject({ id: z.uuid(), locationCode: z.string() }),
});

export function parseCreateWarehouseSnapshot(raw: unknown): {
  readonly warehouse: WarehouseView;
  readonly defaultLocation: LocationView;
} {
  const result = createSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 창고 생성 결과 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as { warehouse: WarehouseView; defaultLocation: LocationView };
}

/**
 * ★ **runtime supplier 규칙** (§W-D13).
 *
 * DB CHECK 는 one-way(`supplier_id IS NULL OR type = 'SUPPLIER_SITE'`) 뿐이지만,
 * **public API 는 양방향으로 strict** 하다:
 *
 *   - `SUPPLIER_SITE` 인데 `supplierId` 없음 → 400
 *   - `SUPPLIER_SITE` 가 아닌데 `supplierId` 있음 → 400
 *
 * ⚠️ seed 는 이 규칙을 따르지 않는다 — 11개 `SUPPLIER_SITE` 창고가 마이그레이션
 *    Phase 7(`T4-19`) 전까지 `supplierId = null` 인 transitional state 로 존재해야
 *    하기 때문이다. DB 가 그 상태를 표현할 수 있다는 것이 **사용자가 unlinked
 *    `SUPPLIER_SITE` 를 새로 만들어도 된다는 뜻은 아니다**.
 */
export function assertSupplierRule(input: {
  readonly warehouseType: string;
  readonly supplierId: string | null;
}): void {
  const isSupplierSite = input.warehouseType === 'SUPPLIER_SITE';

  if (isSupplierSite && input.supplierId === null) {
    throw new ValidationError(
      [{ path: 'supplierId', message: 'SUPPLIER_SITE 창고는 거래처를 지정해야 합니다.' }],
      { message: '창고 요청이 올바르지 않습니다.' },
    );
  }
  if (!isSupplierSite && input.supplierId !== null) {
    throw new ValidationError(
      [{ path: 'supplierId', message: 'SUPPLIER_SITE 창고에만 거래처를 지정할 수 있습니다.' }],
      { message: '창고 요청이 올바르지 않습니다.' },
    );
  }
}

async function performCreate(
  tx: TransactionClient,
  actor: ActorContext,
  input: CreateWarehouseInput,
  logger: AuditLogger,
): Promise<{ warehouse: WarehouseView; defaultLocation: LocationView }> {
  const supplierId = input.supplierId ?? null;
  const externalSystemId = input.externalSystemId ?? null;

  // ★ 참조 존재를 **미리** 확인한다 — raw FK 오류(P2003)가 새지 않게.
  if (supplierId !== null) await assertSupplierRefExists(tx, supplierId);
  if (externalSystemId !== null) await assertExternalSystemExists(tx, externalSystemId);

  let created;
  try {
    created = await insertWarehouseWithDefaultLocation(tx, {
      warehouseCode: input.warehouseCode,
      warehouseName: input.warehouseName,
      warehouseType: input.warehouseType,
      externalSystemId,
      supplierId,
      timezone: input.timezone ?? DEFAULT_TIMEZONE,
      address: input.address ?? null,
    });
  } catch (error) {
    translateWarehouseWriteError(error, input.warehouseCode);
  }

  const warehouse = toWarehouseView(created.warehouse);
  const defaultLocation = toLocationView(created.defaultLocation);

  // ★ 같은 트랜잭션 — 로그 실패 시 창고·로케이션도 롤백된다 (§W-D35).
  //   복합 생성은 **엔티티마다 1건**이다 (선례: clone = Header 1건 + Line N건).
  await logger.write(tx, {
    actor,
    entityType: WAREHOUSE_ENTITY_TYPE,
    entityId: created.warehouse.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: warehouse,
  });
  await logger.write(tx, {
    actor,
    entityType: WAREHOUSE_LOCATION_ENTITY_TYPE,
    entityId: created.defaultLocation.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: defaultLocation,
  });

  return { warehouse, defaultLocation };
}

export async function createWarehouse(
  actor: ActorContext,
  input: CreateWarehouseInput,
  dependencies: WarehouseMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreateWarehouseResult> {
  // ★ 멱등 replay 보다 먼저 — 권한을 잃은 actor 는 replay 도 403 이다.
  assertPermission(actor, WAREHOUSE_CREATE_PERMISSION);

  // ★ 시스템 예약 창고는 public API 로 만들 수 없다 (§W-D12) — seed 만이 owner.
  if (isReservedWarehouseInput(input)) {
    throw new ValidationError(
      [
        {
          path: 'warehouseType',
          message: `'${IN_TRANSIT_WAREHOUSE_CODE}' 는 시스템 예약 창고입니다.`,
        },
      ],
      { message: '창고 요청이 올바르지 않습니다.' },
    );
  }

  assertSupplierRule({
    warehouseType: input.warehouseType,
    supplierId: input.supplierId ?? null,
  });

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    if (idempotencyKey === undefined) {
      return { ...(await performCreate(tx, actor, input, logger)), replayed: false };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        routeScope: WAREHOUSE_CREATE_ROUTE_SCOPE,
        idempotencyKey,
      },
      requestHashOf(input),
      async () => ({
        responseStatus: 201,
        // ★ replay 때는 이 콜백이 실행되지 않는다 — DEFAULT child 가 다시
        //   만들어지지 않고 audit 도 재생성되지 않는다 (§W-D36).
        responseBody: await performCreate(tx, actor, input, logger),
      }),
      parseCreateWarehouseSnapshot,
    );

    return { ...outcome.responseBody, replayed: outcome.replayed };
  });
}
