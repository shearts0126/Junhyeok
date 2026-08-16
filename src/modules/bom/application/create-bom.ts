import { z } from 'zod';

import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { assertParentEligible, assertUomMatchesBase } from '../domain';

import { translateBomHeaderWriteError } from './constraint-errors';
import { assertPeriodOrder, parseDateOnly, type CreateBomInput } from './dto';
import { BOM_CREATE_PERMISSION } from './policy';
import { assertProductionPartnerExists, loadBomSkuRef } from './refs';
import { BOM_HEADER_VIEW_INCLUDE, toBomHeaderView, type BomHeaderView } from './views';

/**
 * `POST /api/boms` — BOM 생성 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-14(DTO) · §D-5(기간) · §D-11(UOM)
 *    · §D-12(상위 자격) · §D-16(audit) · §D-17(멱등) · §D-2(기본값).
 *
 * ⚠️ **2차 권한 가드** `bom.create`. ⛔ ADMIN bypass 없음.
 *    ★ FINANCE 는 BOM mutation 권한이 없다 — 가격과 다르다 (D-15).
 *
 * ## 생성 결과는 항상 `DRAFT` 다
 *
 * ```
 *   status = 'DRAFT' · createdBy = actor · approvedAt/By = null · activatedAt = null
 * ```
 *
 * ⛔ 승인·활성화를 하지 않는다. ⛔ 라인을 자동 생성하지 않는다 — 기본 구성품
 *    같은 것을 만들면 사용자가 넣지 않은 데이터가 BOM 에 들어간다. 라인은 별도
 *    endpoint 로만 만든다 (D-14).
 * ⛔ `effectiveFrom` 을 오늘로 채우지 않는다 — DTO 가 required 로 막는다 (D-5).
 *
 * ## eligibility
 *
 * - 상위 SKU 존재(soft-delete 제외) → 없으면 404
 * - 상위 SKU status **`DRAFT` 만 제외** → 422 `BOM_PARENT_NOT_ELIGIBLE` (D-12)
 *   ⛔ `manufacturable = true` 를 강제하지 않는다 · ⛔ `itemType` 제한 없음
 * - `outputUom` 생략 → parent `baseUom` 을 서버가 채운다. 명시했는데 다르면
 *   422 `BOM_UOM_MISMATCH` (D-11). ⛔ 환산하지 않는다.
 * - `productionPartnerId` 는 **실제 FK** 라 존재를 검증한다.
 *   ⛔ `destinationWarehouseId` 는 staged scalar — 존재 조회 없음 (D-32).
 *
 * ## 중복 버전
 *
 * `(parentSkuId, version)` UNIQUE 가 **최종 판정자**다 — 선조회로 대체하지
 * 않는다. 위반은 409 `BOM_VERSION_DUPLICATE` (D-29).
 *
 * ## 멱등성 (D-17)
 *
 * routeScope 는 docs/18 이 확정한 **`bom:create`** 다.
 */

export const BOM_HEADER_ENTITY_TYPE = 'BomHeader';

/** D-17 표의 exact routeScope. */
export const BOM_CREATE_ROUTE_SCOPE = 'bom:create';

export interface CreateBomResult {
  readonly bom: BomHeaderView;
  /** true 면 멱등 replay — 라우트는 201 이 아니라 200 으로 응답한다. */
  readonly replayed: boolean;
}

export interface BomMutateDependencies {
  readonly runInTransaction?: typeof withTransaction;
  readonly auditLogger?: AuditLogger;
}

const bomSnapshotSchema = z.looseObject({
  id: z.uuid(),
  parentSkuId: z.uuid(),
  version: z.string(),
  status: z.string(),
  effectiveFrom: z.string(),
});

export function parseBomHeaderViewSnapshot(raw: unknown): BomHeaderView {
  const result = bomSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 BomHeaderView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as BomHeaderView;
}

async function performCreate(
  tx: TransactionClient,
  actor: ActorContext,
  input: CreateBomInput,
  logger: AuditLogger,
): Promise<BomHeaderView> {
  // ★ 적용기간 순서는 **서비스 경계에서도** 본다 (D-5).
  //   DTO 가 이미 400 으로 막지만, 이 서비스는 REST 이외의 경로(T07-5 clone·
  //   import 등 내부 호출)에서도 불린다. 여기서 막지 않으면 DB CHECK
  //   `bom_header_effective_period_check`(23514)까지 내려가 **500** 이 된다.
  //   ⛔ 정상 입력이 DB CHECK 에 도달하는 경로를 남기지 않는다 — CHECK 는
  //      application invariant 가 뚫렸을 때의 최후 방어선이어야 한다.
  assertPeriodOrder(input.effectiveFrom, input.effectiveTo ?? null);

  const parent = await loadBomSkuRef(tx, input.parentSkuId);
  assertParentEligible({ skuId: parent.id, status: parent.status });

  // D-11 — 생략 시 parent baseUom, 명시했으면 반드시 같아야 한다.
  const outputUom = input.outputUom ?? parent.baseUom;
  assertUomMatchesBase({ uom: outputUom, baseUom: parent.baseUom, skuId: parent.id });

  if (input.productionPartnerId !== undefined && input.productionPartnerId !== null) {
    await assertProductionPartnerExists(tx, input.productionPartnerId);
  }

  let created;
  try {
    created = await tx.bomHeader.create({
      data: {
        parentSkuId: input.parentSkuId,
        bomType: input.bomType,
        version: input.version,
        // ★ 서버 통제 — 요청은 여기에 관여할 수 없다 (DTO 가 400).
        status: 'DRAFT',
        outputQty: input.outputQty ?? '1',
        outputUom,
        effectiveFrom: parseDateOnly(input.effectiveFrom),
        effectiveTo:
          input.effectiveTo === undefined || input.effectiveTo === null
            ? null
            : parseDateOnly(input.effectiveTo),
        productionPartnerId: input.productionPartnerId ?? null,
        // ★ staged scalar — UUID 를 그대로 저장한다 (T08 미착수).
        destinationWarehouseId: input.destinationWarehouseId ?? null,
        overallLossRate: input.overallLossRate ?? null,
        description: input.description ?? null,
        changeReason: input.changeReason ?? null,
        createdBy: actor.userId,
        approvedAt: null,
        approvedBy: null,
        activatedAt: null,
      },
      include: BOM_HEADER_VIEW_INCLUDE,
    });
  } catch (error) {
    translateBomHeaderWriteError(error, input.version);
  }

  // 방금 만든 BOM 은 라인이 없다 — 조회하지 않고 0 을 쓴다.
  const view = toBomHeaderView(created, { lineCount: 0, unconfirmedCount: 0 });

  // ★ 같은 트랜잭션 — 로그 실패 시 생성도 롤백된다.
  await logger.write(tx, {
    actor,
    entityType: BOM_HEADER_ENTITY_TYPE,
    entityId: created.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: view,
  });

  return view;
}

export async function createBom(
  actor: ActorContext,
  input: CreateBomInput,
  dependencies: BomMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreateBomResult> {
  // ★ 멱등 replay 보다 먼저 — 권한을 잃은 actor 는 replay 도 403 이다.
  assertPermission(actor, BOM_CREATE_PERMISSION);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    if (idempotencyKey === undefined) {
      return { bom: await performCreate(tx, actor, input, logger), replayed: false };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        routeScope: BOM_CREATE_ROUTE_SCOPE,
        idempotencyKey,
      },
      requestHashOf(input),
      async () => ({
        responseStatus: 201,
        responseBody: await performCreate(tx, actor, input, logger),
      }),
      parseBomHeaderViewSnapshot,
    );
    return { bom: outcome.responseBody, replayed: outcome.replayed };
  });
}
