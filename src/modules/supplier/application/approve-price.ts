import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { assertApprovalActor } from '@/modules/settings/domain/self-approval';
import { withTransaction, type TransactionClient } from '@/shared/db';

import { SUPPLIER_SKU_PRICE_ENTITY_TYPE } from './create-price';
import type { SupplierMutateDependencies } from './create-supplier';
import { SUPPLIER_PRICE_APPROVE_PERMISSION } from './policy';
import { parseSupplierSkuPriceId, type ApprovePriceInput } from './price-dto';
import {
  toSupplierSkuPriceView,
  type SupplierSkuPriceRow,
  type SupplierSkuPriceView,
} from './price-views';
import { supplierSkuPriceNotFound } from './refs';

/**
 * `POST /api/supplier-sku-prices/{id}/approve` — 가격 승인 = **발효** (T06-3).
 *
 * ⚠️ **2차 권한 가드.** `supplier_price.approve` 를 재검사한다 (A·L·F —
 *    SCM_STAFF 없음). ADMIN bypass 없음.
 *
 * 가격이 operational price chain 에 들어가는 유일한 시점이다 (§4). 기존 승인
 * 가격 auto-close 와 target `effectiveTo` 계산은 **이 트랜잭션에서만** 일어난다.
 *
 * ## chain algorithm (D-13·D-14, target.effectiveFrom = T)
 *
 * 같은 supplierSkuId 의 **승인된 가격만** 대상으로 (pending 제외):
 *
 *   predecessor = from < T 중 최대 from (DESC, id DESC, LIMIT 1)
 *   successor   = from > T 중 최소 from (ASC,  id ASC,  LIMIT 1)
 *
 *   predecessor 존재 → predecessor.effectiveTo = T
 *   target.effectiveTo = successor?.effectiveFrom ?? null
 *   target.approvedBy  = actor.userId
 *
 * historical insertion(중간 삽입)·future 선승인 모두 이 한 알고리즘으로 맞아
 * 들어간다 (D-12·D-24).
 *
 * ## 동시성 (D-32)
 *
 * parent `supplier_sku` row 를 `FOR UPDATE` 로 잠근 **뒤** target·chain 을
 * 다시 읽는다 — 같은 SupplierSku 의 동시 승인은 직렬화되고, 어느 순서로
 * 커밋되어도 chain 은 일관된 상태로 수렴한다.
 *
 * ## eligibility 최소 (D-21)
 *
 * ① price 존재 ② `approvedBy IS NULL` — 이 둘뿐이다. Supplier/SKU status ·
 * current-only · `effectiveFrom <= today` 제약을 발명하지 않는다. future ·
 * historical 승인 모두 허용이다.
 *
 * ## repeat approve (D-18)
 *
 * 이미 승인된 가격은 **200 + 현재 view** — DB write 0 · Audit 0 · chain
 * 재계산 0. 다른 actor 가 승인했어도 동일하다. 별도 ALREADY_APPROVED 없음.
 *
 * ## AuditLog (§42)
 *
 *   - predecessor close: 실제 값이 변한 경우에만 `UPDATE` 1건 (before/after
 *     full view, reason = note).
 *   - target: `APPROVE` 정확히 1건 (before approvedBy null / after 계산 완료
 *     view, reason = note, approvedBy = actor). 별도 UPDATE 를 겹쳐 쓰지 않는다.
 *
 * 멱등 계약 없음 — repeat approve 가 자연 멱등이다 (D-30).
 */

async function lockParentSupplierSkuRow(tx: TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM supplier_sku WHERE id = ${id}::uuid FOR UPDATE`;
}

async function findPriceOr404(tx: TransactionClient, id: string): Promise<SupplierSkuPriceRow> {
  const row = await tx.supplierSkuPrice.findUnique({ where: { id } });
  if (row === null) throw supplierSkuPriceNotFound(id);
  return row;
}

export async function approveSupplierSkuPrice(
  actor: ActorContext,
  rawPriceId: string,
  input: ApprovePriceInput,
  dependencies: SupplierMutateDependencies = {},
): Promise<SupplierSkuPriceView> {
  assertPermission(actor, SUPPLIER_PRICE_APPROVE_PERMISSION);
  const priceId = parseSupplierSkuPriceId(rawPriceId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    // ① target 조회 — parent 식별용. 판정은 lock 후 재조회 값으로만 한다.
    const initial = await findPriceOr404(tx, priceId);

    // ②③ parent lock — 같은 SupplierSku 의 chain 변경을 직렬화한다.
    await lockParentSupplierSkuRow(tx, initial.supplierSkuId);

    // ④ lock 해제 후 최신 상태 재조회 — 동시 승인이 앞서 커밋됐을 수 있다.
    const target = await findPriceOr404(tx, priceId);

    // ⑤ repeat approve — no-op. DB write 0 / Audit 0 / chain 재계산 0 (D-18).
    if (target.approvedBy !== null) return toSupplierSkuPriceView(target);

    // ⑥⑦ 자가승인 — 클라이언트 값이 아니라 같은 트랜잭션의 최신 설정으로만 (D-19).
    if (target.createdBy !== null) {
      const settings = await tx.systemSetting.findUniqueOrThrow({
        where: { id: 1 },
        select: { allowSelfApprovalSku: true, allowSelfApprovalBom: true },
      });
      assertApprovalActor({
        requesterId: target.createdBy,
        approverId: actor.userId,
        workflow: 'SKU',
        settings,
      });
    }

    // ⑧⑨ 승인된 이웃만 본다 — pending 은 chain 계산에서 제외한다 (§39).
    const approvedNeighborWhere = {
      supplierSkuId: target.supplierSkuId,
      approvedBy: { not: null },
    } as const;
    const [predecessor, successor] = await Promise.all([
      tx.supplierSkuPrice.findFirst({
        where: { ...approvedNeighborWhere, effectiveFrom: { lt: target.effectiveFrom } },
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      }),
      tx.supplierSkuPrice.findFirst({
        where: { ...approvedNeighborWhere, effectiveFrom: { gt: target.effectiveFrom } },
        orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
      }),
    ]);

    // ⑩ predecessor close — 실제 값이 변한 경우에만 write + Audit UPDATE (§40).
    if (
      predecessor !== null &&
      (predecessor.effectiveTo === null ||
        predecessor.effectiveTo.getTime() !== target.effectiveFrom.getTime())
    ) {
      const predecessorBefore = toSupplierSkuPriceView(predecessor);
      const closed = await tx.supplierSkuPrice.update({
        where: { id: predecessor.id },
        data: { effectiveTo: target.effectiveFrom },
      });
      await logger.write(tx, {
        actor,
        entityType: SUPPLIER_SKU_PRICE_ENTITY_TYPE,
        entityId: predecessor.id,
        action: 'UPDATE',
        beforeValue: predecessorBefore,
        afterValue: toSupplierSkuPriceView(closed),
        ...(input.note !== null ? { reason: input.note } : {}),
      });
    }

    // ⑪⑫ target 발효 — effectiveTo 계산 + approvedBy 확정 (§41).
    const targetBefore = toSupplierSkuPriceView(target);
    const approved = await tx.supplierSkuPrice.update({
      where: { id: target.id },
      data: {
        effectiveTo: successor === null ? null : successor.effectiveFrom,
        approvedBy: actor.userId,
      },
    });
    const view = toSupplierSkuPriceView(approved);

    // ⑬ APPROVE 정확히 1건 — approvedBy/effectiveTo 변경에 UPDATE 를 겹치지 않는다.
    await logger.write(tx, {
      actor,
      entityType: SUPPLIER_SKU_PRICE_ENTITY_TYPE,
      entityId: target.id,
      action: 'APPROVE',
      beforeValue: targetBefore,
      afterValue: view,
      approvedBy: actor.userId,
      ...(input.note !== null ? { reason: input.note } : {}),
    });

    return view;
  });
}
