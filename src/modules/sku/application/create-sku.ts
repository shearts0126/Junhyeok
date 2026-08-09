import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { ConflictError, ERROR_CODES, SystemError } from '@/shared/errors';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { assertValidCodeRefs } from './code-ref-validation';
import { toSkuColumnData } from './column-data';
import type { CreateSkuInput } from './dto';
import { SKU_CREATE_PERMISSION } from './policy';
import { SKU_VIEW_INCLUDE, toSkuView, type SkuView } from './views';

/**
 * SKU 생성 (T1-3).
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `sku.create` 를 재검사한다.
 *    ADMIN bypass 없음 — RolePermission 데이터로만 판정한다.
 *    권한 검사는 **멱등 replay 보다 먼저**다 — 권한을 잃은 사용자가
 *    과거 key 재요청으로 저장 결과를 우회 취득할 수 없다.
 *
 * ⚠️ 생성과 감사로그 INSERT 는 **같은 트랜잭션**이다. 감사로그가 실패하면
 *    생성도 롤백된다.
 *
 * ★ server-managed 필드는 입력과 무관하게 강제된다 (DTO 가 이미 400 처리):
 *   `status=DRAFT` · `hasTransaction=false` · `createdBy/updatedBy=actor.userId` ·
 *   `approvedAt/approvedBy/deletedAt=null`.
 *
 * 중복 `skuCode` 는 DB UNIQUE(`sku_sku_code_key`) 가 최종 판정한다 —
 * application 선조회로 대체하지 않고 P2002 를 409 로 번역한다.
 *
 * ## 멱등성 (T1-3 보완)
 *
 * `idempotencyKey` 가 주어지면 공용 인프라(`shared/idempotency`)의 계약을
 * 적용한다: claim → 생성 → 감사로그 → snapshot 저장이 **한 트랜잭션**이다.
 *
 *   - 동일 key + 동일 body 재요청 → 저장 결과 replay (`replayed=true`, SKU·AuditLog 각 1건)
 *   - 동일 key + 다른 body → 409 IDEMPOTENCY_KEY_REUSED
 *   - key 없음 → 일반 생성 (IdempotencyRecord 없음)
 *
 * skuCode UNIQUE 는 멱등성의 대체재가 아니다 — **다른** key 로 같은 skuCode 를
 * 생성하면 replay 가 아니라 409 SKU_CODE_DUPLICATE 다.
 * request hash 는 검증된 DTO 기준이며 server-managed 강제값은 포함되지 않는다.
 */

export interface SkuMutateDependencies {
  readonly auditLogger?: AuditLogger;
  readonly runInTransaction?: <T>(callback: (tx: TransactionClient) => Promise<T>) => Promise<T>;
}

export const SKU_ENTITY_TYPE = 'Sku';

/** 멱등 scope 의 route template — raw URL 이 아니다. */
export const SKU_CREATE_ROUTE_SCOPE = '/api/skus';

export interface CreateSkuResult {
  readonly sku: SkuView;
  /** true 면 멱등 replay — 라우트는 201 이 아니라 200 으로 응답한다. */
  readonly replayed: boolean;
}

export function duplicateSkuCode(skuCode: string): ConflictError {
  return new ConflictError(ERROR_CODES.SKU_CODE_DUPLICATE, {
    message: `SKU 코드 '${skuCode}' 이(가) 이미 사용 중입니다.`,
    publicDetails: { skuCode },
    publicHint: '다른 코드를 사용하거나 기존 SKU 를 확인하세요.',
    retryable: false,
  });
}

/**
 * replay snapshot 의 최소 무결성 검증 — DB JSON 을 무조건 신뢰하지 않는다.
 * (전체 SkuView 스키마 중복 정의 대신 식별 핵심 필드만 확인한다.)
 */
const skuViewSnapshotSchema = z.looseObject({
  id: z.uuid(),
  skuCode: z.string(),
  status: z.string(),
});

function parseSkuViewSnapshot(raw: unknown): SkuView {
  const result = skuViewSnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new SystemError({
      message: '멱등 응답 snapshot 이 SkuView 형태가 아닙니다.',
      context: { snapshotIssueCount: result.error.issues.length },
    });
  }
  return raw as SkuView;
}

/** 검증된 CreateSkuInput 의 canonical request hash. */
export function skuCreateRequestHash(input: CreateSkuInput): string {
  return requestHashOf(input);
}

async function performCreate(
  tx: TransactionClient,
  actor: ActorContext,
  input: CreateSkuInput,
  logger: AuditLogger,
): Promise<SkuView> {
  // group 정체성 + 활성 검증 (T1-1 limitation 해소). DB FK 는 존재성만 본다.
  await assertValidCodeRefs(tx, input);

  let created;
  try {
    created = await tx.sku.create({
      data: {
        ...toSkuColumnData(input),
        skuCode: input.skuCode,
        skuName: input.skuName,
        itemType: input.itemType,
        // ★ server-managed — 입력이 아니라 서버가 정한다.
        status: 'DRAFT',
        hasTransaction: false,
        createdBy: actor.userId,
        updatedBy: actor.userId,
        approvedAt: null,
        approvedBy: null,
        deletedAt: null,
      },
      include: SKU_VIEW_INCLUDE,
    });
  } catch (error) {
    // 동시 생성 경합 포함 — DB UNIQUE 가 최종 판정한다.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw duplicateSkuCode(input.skuCode);
    }
    throw error;
  }

  const view = toSkuView(created);

  // ★ 같은 트랜잭션. 로그 실패 시 생성도 롤백된다.
  await logger.write(tx, {
    actor,
    entityType: SKU_ENTITY_TYPE,
    // ⚠️ 실제 Sku UUID — 표시용 skuCode 문자열이 아니다.
    entityId: created.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: view,
  });

  return view;
}

export async function createSku(
  actor: ActorContext,
  input: CreateSkuInput,
  dependencies: SkuMutateDependencies = {},
  idempotencyKey?: string,
): Promise<CreateSkuResult> {
  // ★ 멱등 replay 보다 먼저 — 권한을 잃은 actor 는 replay 도 403 이다.
  assertPermission(actor, SKU_CREATE_PERMISSION);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    if (idempotencyKey === undefined) {
      // 일반 호출 — IdempotencyRecord 를 만들지 않는다.
      return { sku: await performCreate(tx, actor, input, logger), replayed: false };
    }

    const outcome = await executeWithIdempotency(
      tx,
      {
        actorId: actor.userId,
        httpMethod: 'POST',
        routeScope: SKU_CREATE_ROUTE_SCOPE,
        idempotencyKey,
      },
      skuCreateRequestHash(input),
      async () => ({
        responseStatus: 201,
        // snapshot 은 업무 payload(SkuView)만 — requestId 등 요청별 metadata 없음.
        responseBody: await performCreate(tx, actor, input, logger),
      }),
      parseSkuViewSnapshot,
    );
    return { sku: outcome.responseBody, replayed: outcome.replayed };
  });
}
