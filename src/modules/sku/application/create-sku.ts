import { Prisma } from '@/generated/prisma/client';
import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { ConflictError, ERROR_CODES } from '@/shared/errors';

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
 */

export interface SkuMutateDependencies {
  readonly auditLogger?: AuditLogger;
  readonly runInTransaction?: <T>(callback: (tx: TransactionClient) => Promise<T>) => Promise<T>;
}

export const SKU_ENTITY_TYPE = 'Sku';

export function duplicateSkuCode(skuCode: string): ConflictError {
  return new ConflictError(ERROR_CODES.SKU_CODE_DUPLICATE, {
    message: `SKU 코드 '${skuCode}' 이(가) 이미 사용 중입니다.`,
    publicDetails: { skuCode },
    publicHint: '다른 코드를 사용하거나 기존 SKU 를 확인하세요.',
    retryable: false,
  });
}

export async function createSku(
  actor: ActorContext,
  input: CreateSkuInput,
  dependencies: SkuMutateDependencies = {},
): Promise<SkuView> {
  assertPermission(actor, SKU_CREATE_PERMISSION);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
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
  });
}
