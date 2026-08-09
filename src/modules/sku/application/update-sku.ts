import { Prisma } from '@/generated/prisma/client';
import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { assertSkuCodeChangeAllowed } from '@/modules/sku/domain';
import { withTransaction } from '@/shared/db';
import { DomainError, ERROR_CODES } from '@/shared/errors';

import { assertValidCodeRefs } from './code-ref-validation';
import { toSkuColumnData } from './column-data';
import { duplicateSkuCode, SKU_ENTITY_TYPE, type SkuMutateDependencies } from './create-sku';
import { parseSkuId, type UpdateSkuInput } from './dto';
import { SKU_UPDATE_PERMISSION } from './policy';
import { SKU_VIEW_INCLUDE, toSkuView, type SkuView } from './views';

/**
 * SKU 수정 (T1-3) — partial PATCH.
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `sku.update` 를 재검사한다.
 *
 * - `status` 변경은 이 API 로 불가 — DTO 가 `status` 필드 자체를 400 처리한다.
 *   상태전이는 별도 워크플로 endpoint(T1-4 이후)의 몫이다.
 * - `skuCode` 변경은 T1-2 도메인 규칙 `assertSkuCodeChangeAllowed` 로만 판정한다
 *   (`hasTransaction=true` → 422 SKU_CODE_IMMUTABLE). 규칙을 여기 복제하지 않는다.
 * - 수정과 감사로그 INSERT 는 **같은 트랜잭션**이다.
 */

export function skuNotFound(id: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `SKU '${id}' 이(가) 없습니다.`,
    context: { skuId: id },
  });
}

export async function updateSku(
  actor: ActorContext,
  id: string,
  patch: UpdateSkuInput,
  dependencies: SkuMutateDependencies = {},
): Promise<SkuView> {
  assertPermission(actor, SKU_UPDATE_PERMISSION);
  const skuId = parseSkuId(id);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    // soft-delete 된 행은 처음부터 없는 것으로 취급한다 — 404.
    const row = await tx.sku.findFirst({
      where: { id: skuId, deletedAt: null },
      include: SKU_VIEW_INCLUDE,
    });
    if (row === null) throw skuNotFound(skuId);

    if (row.status === 'ACTIVE') {
      // TODO: ACTIVE mutable-field whitelist is not defined in the authoritative
      // docs. Do not relax this guard until the policy is explicitly approved.
      // (승인된 마스터가 무엇이든 수정 가능하다고 확정된 바 없어 보수적으로 전면
      //  차단한다. 다른 상태에는 이런 제한을 발명하지 않는다.)
      throw new DomainError(ERROR_CODES.SKU_ACTIVE_UPDATE_RESTRICTED, {
        message: `ACTIVE SKU '${row.skuCode}' 의 일반 수정은 허용 필드 정책 확정 전까지 차단된다.`,
        publicDetails: { status: row.status },
      });
    }

    // ★ T1-2 도메인 규칙 재사용 — 동일 코드는 변경이 아니므로 통과한다.
    if (patch.skuCode !== undefined) {
      assertSkuCodeChangeAllowed({
        hasTransaction: row.hasTransaction,
        currentSkuCode: row.skuCode,
        nextSkuCode: patch.skuCode,
      });
    }

    // 새로 설정되는 참조만 검증한다 — 기존 비활성 참조를 건드리지 않는 수정을
    // 막지 않는다.
    await assertValidCodeRefs(tx, patch);

    const beforeView = toSkuView(row);

    let updated;
    try {
      updated = await tx.sku.update({
        where: { id: row.id },
        data: {
          ...toSkuColumnData(patch),
          // ★ ActorContext 에서만.
          updatedBy: actor.userId,
        },
        include: SKU_VIEW_INCLUDE,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw duplicateSkuCode(patch.skuCode ?? row.skuCode);
      }
      throw error;
    }

    const afterView = toSkuView(updated);

    // ★ 같은 트랜잭션. 로그 실패 시 수정도 롤백된다.
    await logger.write(tx, {
      actor,
      entityType: SKU_ENTITY_TYPE,
      entityId: row.id,
      action: 'UPDATE',
      beforeValue: beforeView,
      afterValue: afterView,
    });

    return afterView;
  });
}
