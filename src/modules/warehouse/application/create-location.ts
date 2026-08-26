import { z } from 'zod';

import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError, ValidationError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { translateLocationWriteError } from './constraint-errors';
import {
  WAREHOUSE_LOCATION_ENTITY_TYPE,
  type WarehouseMutateDependencies,
} from './create-warehouse';
import { parseWarehouseId, type CreateLocationInput } from './dto';
import { IN_TRANSIT_WAREHOUSE_CODE, WAREHOUSE_UPDATE_PERMISSION } from './policy';
import { warehouseNotFound } from './refs';
import { toLocationView, type LocationView } from './views';

/**
 * `POST /api/warehouses/{id}/locations` — 로케이션 추가 (T08-2).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D34 · §W-D9(예약 코드) ·
 *    §W-D12(IN_TRANSIT) · §W-D23(권한) · §W-D36(멱등).
 *
 * ⚠️ **2차 권한 가드.** `warehouse.update` 를 재검사한다 — location 전용
 *    permission 을 만들지 않는다 (§W-D23). 로케이션은 창고의 하위 구조다.
 *
 * ⛔ `locationCode === 'DEFAULT'`(case-insensitive)는 DTO 가 400 으로 막는다
 *    (§W-D9) — 자동 생성만이 DEFAULT 의 owner 다.
 * ⛔ `PATCH`·`DELETE` endpoint 가 없다 (§W-D10) — 따라서 DEFAULT 의 rename·
 *    deactivate·delete 기능도 존재하지 않는다.
 */

/** 멱등 scope (§W-D36) — **실제 warehouseId 를 포함**한다. */
export function locationCreateRouteScope(warehouseId: string): string {
  return `warehouse:${warehouseId}:location:create`;
}

export interface CreateLocationResult {
  readonly location: LocationView;
  readonly replayed: boolean;
}

const locationSnapshotSchema = z.looseObject({
  id: z.uuid(),
  warehouseId: z.uuid(),
  locationCode: z.string(),
});

export function parseLocationSnapshot(raw: unknown): LocationView {
  const result = locationSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 LocationView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as LocationView;
}

async function performCreateLocation(
  tx: TransactionClient,
  actor: ActorContext,
  warehouseId: string,
  input: CreateLocationInput,
  logger: WarehouseMutateDependencies['auditLogger'] & object,
): Promise<LocationView> {
  let created;
  try {
    created = await tx.warehouseLocation.create({
      data: {
        warehouseId,
        locationCode: input.locationCode,
        locationName: input.locationName,
        locationType: input.locationType ?? null,
        // ★ `active` 는 입력 대상이 아니다 — DB default `true` 를 쓴다 (§W-D33).
      },
    });
  } catch (error) {
    translateLocationWriteError(error, input.locationCode);
  }

  const view = toLocationView(created);

  // ★ 같은 트랜잭션 — 로그 실패 시 생성도 롤백된다 (§W-D35).
  await logger.write(tx, {
    actor,
    entityType: WAREHOUSE_LOCATION_ENTITY_TYPE,
    entityId: created.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: view,
  });

  return view;
}

export async function createWarehouseLocation(
  actor: ActorContext,
  rawWarehouseId: string,
  input: CreateLocationInput,
  dependencies: WarehouseMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreateLocationResult> {
  // ★ 멱등 replay 보다 먼저 — 권한을 잃은 actor 는 replay 도 403 이다.
  assertPermission(actor, WAREHOUSE_UPDATE_PERMISSION);
  const warehouseId = parseWarehouseId(rawWarehouseId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true, warehouseCode: true },
    });
    if (warehouse === null) throw warehouseNotFound(warehouseId);

    // ★ IN_TRANSIT 창고에는 추가 로케이션을 만들지 않는다 — DEFAULT 만 쓴다
    //   (§W-D12).
    if (warehouse.warehouseCode === IN_TRANSIT_WAREHOUSE_CODE) {
      throw new ValidationError(
        [
          {
            path: 'warehouseId',
            message: `'${IN_TRANSIT_WAREHOUSE_CODE}' 는 시스템 예약 창고라 로케이션을 추가할 수 없습니다.`,
          },
        ],
        { message: '로케이션 등록 요청이 올바르지 않습니다.' },
      );
    }

    if (idempotencyKey === undefined) {
      return {
        location: await performCreateLocation(tx, actor, warehouseId, input, logger),
        replayed: false,
      };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        routeScope: locationCreateRouteScope(warehouseId),
        idempotencyKey,
      },
      requestHashOf(input),
      async () => ({
        responseStatus: 201,
        responseBody: await performCreateLocation(tx, actor, warehouseId, input, logger),
      }),
      parseLocationSnapshot,
    );

    return { location: outcome.responseBody, replayed: outcome.replayed };
  });
}
