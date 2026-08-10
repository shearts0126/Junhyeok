import { z } from 'zod';

import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { translateMappingWriteError } from './constraint-errors';
import type { CreateMappingInput } from './dto';
import { normalizeIdentifiers } from './normalize';
import { EXTERNAL_MAPPING_CREATE_PERMISSION } from './policy';
import { assertExternalSystemExists, assertSkuExists } from './refs';
import { deriveMappingStatus, MAPPING_STATUS_MATCHED, primaryRequiresMatched } from './status';
import {
  EXTERNAL_MAPPING_VIEW_INCLUDE,
  toExternalMappingView,
  type ExternalMappingView,
} from './views';

/**
 * `POST /api/external-mappings` — 외부 매핑 생성 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §4·§5·§6·§7·§9·§10·§13·§14.
 *
 * ⚠️ **2차 권한 가드.** `external_mapping.create` 를 재검사한다. ADMIN bypass 없음.
 *    권한 검사는 **멱등 replay 보다 먼저**다.
 *
 * ## 처리 순서
 *
 *   1. 권한 → 2. DTO(이미 라우트에서) → 3. 정규화(422/400 은 여기서 종료)
 *   → 4. 트랜잭션: 멱등 claim → SKU/ExternalSystem 404 → 상태 파생 → 대표 검증
 *      → INSERT → AuditLog → snapshot
 *
 * ★ 정규화 실패(422)·DTO 오류(400)는 **claim 이전에 종료**된다 — mutation 이
 *   시작되지 않은 요청은 IdempotencyRecord 를 만들지 않는다. 반대로 404/422 같은
 *   business 판정 실패는 claim 과 **함께 롤백**되므로 실패한 요청이 key 를
 *   점유하지 않는다 (T04-4A 와 동일 원칙).
 *
 * ⛔ `mappingStatus` 는 입력이 아니라 파생값이다. ⛔ `warehouseId` 는 항상 `null`.
 * ⛔ 기존 대표를 자동으로 내리지 않는다. ⛔ `Sku.skuName` 을 건드리지 않는다.
 */

export const EXTERNAL_MAPPING_ENTITY_TYPE = 'SkuExternalMapping';

/** 멱등 scope 의 route template — 경로 파라미터가 없다. */
export const EXTERNAL_MAPPING_CREATE_ROUTE_SCOPE = '/api/external-mappings';

export interface MappingMutateDependencies {
  readonly auditLogger?: AuditLogger;
  readonly runInTransaction?: <T>(callback: (tx: TransactionClient) => Promise<T>) => Promise<T>;
}

export interface CreateMappingResult {
  readonly mapping: ExternalMappingView;
  /** true 면 멱등 replay — 라우트는 201 이 아니라 200 으로 응답한다. */
  readonly replayed: boolean;
}

const mappingViewSnapshotSchema = z.looseObject({
  id: z.uuid(),
  skuId: z.uuid(),
  externalSystemId: z.uuid(),
  mappingStatus: z.string(),
});

function parseMappingViewSnapshot(raw: unknown): ExternalMappingView {
  const result = mappingViewSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 ExternalMappingView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as ExternalMappingView;
}

/**
 * 검증된 요청의 canonical request hash.
 *
 * ★ **정규화 전 validated raw DTO** 를 해싱한다 — 기존 정책(T1-3·T04-3·T04-4A)과
 *   동일하다. 따라서 `'  P001 '` 과 `'P001'` 은 정규화 결과가 같아도 서로 다른
 *   요청이며, 같은 key 면 409 `IDEMPOTENCY_KEY_REUSED` 다.
 */
export function mappingCreateRequestHash(input: CreateMappingInput): string {
  return requestHashOf({ ...input });
}

export async function createExternalMapping(
  actor: ActorContext,
  input: CreateMappingInput,
  dependencies: MappingMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreateMappingResult> {
  // ★ 멱등 replay 보다 먼저 — 권한을 잃은 actor 는 replay 도 403 이다.
  assertPermission(actor, EXTERNAL_MAPPING_CREATE_PERMISSION);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  // ★ 정규화는 트랜잭션 밖에서 끝난다 — 400/422 는 claim 이전에 종료된다.
  const identifiers = normalizeIdentifiers(input);
  const externalProductCode = identifiers.externalProductCode ?? null;
  const externalProductName = identifiers.externalProductName ?? null;
  const externalBarcode = identifiers.externalBarcode ?? null;
  const note = input.note === undefined ? null : input.note;
  const isPrimary = input.isPrimary ?? false;

  const performCreate = async (tx: TransactionClient): Promise<ExternalMappingView> => {
    await assertSkuExists(tx, input.skuId);
    await assertExternalSystemExists(tx, input.externalSystemId);

    // ★ server-derived. 식별자가 하나도 없으면 여기서 422 다.
    const mappingStatus = deriveMappingStatus({
      externalProductCode,
      externalProductName,
      externalBarcode,
    });

    // 상품명 기반(REVIEW_REQUIRED) 매핑은 대표가 될 수 없다.
    if (isPrimary && mappingStatus !== MAPPING_STATUS_MATCHED) throw primaryRequiresMatched();

    let created;
    try {
      created = await tx.skuExternalMapping.create({
        data: {
          skuId: input.skuId,
          externalSystemId: input.externalSystemId,
          // ⛔ T08-1 전까지 항상 null — Warehouse FK 가 없어 검증할 수 없다.
          warehouseId: null,
          externalProductCode,
          externalProductName,
          externalBarcode,
          mappingStatus,
          isPrimary,
          note,
        },
        include: EXTERNAL_MAPPING_VIEW_INCLUDE,
      });
    } catch (error) {
      // 동시 생성 경합 포함 — T05-1 조건부 UNIQUE 2종이 최종 판정한다.
      translateMappingWriteError(error, {
        skuId: input.skuId,
        externalSystemId: input.externalSystemId,
        externalProductCode,
      });
    }

    const view = toExternalMappingView(created);

    // ★ 같은 트랜잭션. 로그 실패 시 생성도 롤백된다.
    await logger.write(tx, {
      actor,
      entityType: EXTERNAL_MAPPING_ENTITY_TYPE,
      entityId: created.id,
      action: 'CREATE',
      beforeValue: null,
      afterValue: view,
    });

    return view;
  };

  return run(async (tx) => {
    if (idempotencyKey === undefined) {
      return { mapping: await performCreate(tx), replayed: false };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        routeScope: EXTERNAL_MAPPING_CREATE_ROUTE_SCOPE,
        idempotencyKey,
      },
      mappingCreateRequestHash(input),
      async () => ({ responseStatus: 201, responseBody: await performCreate(tx) }),
      parseMappingViewSnapshot,
    );
    return { mapping: outcome.responseBody, replayed: outcome.replayed };
  });
}
