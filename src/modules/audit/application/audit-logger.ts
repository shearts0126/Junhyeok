import type { ActorContext } from '@/modules/auth/application';
import type { TransactionClient } from '@/shared/db';

import { serializeAuditValue } from '../infrastructure/serialize';

/**
 * AuditLogger (T0-7).
 *
 * ## 트랜잭션 클라이언트를 반드시 주입받는다
 *
 * 첫 인자가 `TransactionClient` 이므로 **트랜잭션 밖에서는 타입상 호출할 수 없다.**
 * 루트 `PrismaClient` 는 `$transaction` 등이 있어 `TransactionClient` 에 대입되지
 * 않는다(Prisma 의 `ITXClientDenyList`).
 *
 * 이렇게 강제하는 이유: 업무 변경과 감사로그가 다른 트랜잭션에 있으면
 *
 *   - 업무는 커밋됐는데 로그가 실패해 **기록 없는 변경**이 남거나,
 *   - 업무는 롤백됐는데 로그가 남아 **일어나지 않은 일**이 기록된다.
 *
 * 둘 다 감사 기록을 근거로 쓸 수 없게 만든다.
 *
 * ## 메타데이터는 ActorContext 에서만
 *
 * `actorId`·`requestId`·`sessionId`·`ipAddress` 를 요청 본문에서 받지 않는다.
 * `occurredAt` 도 호출부가 지정할 수 없다 — DB 기본값(`now()`)을 쓴다.
 * 수행자와 시각을 호출부가 정할 수 있으면 감사로그가 아니라 그냥 메모다.
 *
 * ## 자동 감시를 만들지 않는다
 *
 * 전체 Prisma mutation 을 가로채는 middleware·extension 을 쓰지 않는다.
 * 각 Application Service 가 **명시적으로** 호출한다. 자동 감시는 무엇이
 * 기록되는지 코드에서 보이지 않고, 업무 의미(action·reason·승인자)를 담지 못한다.
 */

export interface AuditWriteInput {
  /** 검증된 수행자. 요청 본문에서 만들 수 없다. */
  readonly actor: ActorContext;
  /** 대상 엔티티 종류. 예: `SystemSetting`, `Sku` */
  readonly entityType: string;
  readonly entityId: string;
  /** 업무 행위. 예: `CREATE`, `UPDATE`, `APPROVE` */
  readonly action: string;
  readonly beforeValue?: unknown;
  readonly afterValue?: unknown;
  readonly reason?: string;
  /** 승인 행위인 경우의 승인자 ID. 승인이 아니면 생략한다. */
  readonly approvedBy?: string;
}

export interface AuditLogRecord {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly actorId: string;
}

/**
 * 감사로그를 기록한다.
 *
 * ⚠️ 첫 인자는 **트랜잭션 클라이언트**다. 업무 변경과 같은 트랜잭션에서 호출해야
 *    한쪽만 남는 상황이 생기지 않는다.
 *
 * ```ts
 * await withTransaction(async (tx) => {
 *   const before = await tx.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
 *   const after = await tx.systemSetting.update({ ... });
 *   await auditLogger.write(tx, {
 *     actor, entityType: 'SystemSetting', entityId: '1',
 *     action: 'UPDATE', beforeValue: before, afterValue: after,
 *   });
 *   return after;
 * });
 * ```
 */
async function write(tx: TransactionClient, input: AuditWriteInput): Promise<AuditLogRecord> {
  const created = await tx.auditLog.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      beforeValue: serializeAuditValue(input.beforeValue) as never,
      afterValue: serializeAuditValue(input.afterValue) as never,
      // ★ ActorContext 에서만 취득한다.
      actorId: input.actor.userId,
      requestId: input.actor.requestId,
      ...(input.actor.sessionId !== undefined ? { sessionId: input.actor.sessionId } : {}),
      ...(input.actor.ipAddress !== undefined ? { ipAddress: input.actor.ipAddress } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.approvedBy !== undefined ? { approvedBy: input.approvedBy } : {}),
      // ★ occurredAt 을 지정하지 않는다 — DB 기본값(now())을 쓴다.
    },
    select: { id: true, entityType: true, entityId: true, action: true, actorId: true },
  });

  return created;
}

export const auditLogger = { write };
export type AuditLogger = typeof auditLogger;
