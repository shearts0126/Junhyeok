import { Prisma } from '@/generated/prisma/client';
import type { TransactionClient } from '@/shared/db';
import { ConflictError, ERROR_CODES, SystemError, ValidationError } from '@/shared/errors';

/**
 * 공용 멱등성 실행기 (T1-3 보완) — **shared infrastructure.**
 *
 * 특정 모듈(SKU 등) 전용이 아니다. 멱등 대상 endpoint 의 application adapter 가
 * 이 실행기를 호출한다. 이번 범위에서 실제로 연결된 endpoint 는
 * `POST /api/skus` 하나뿐이며, 미래 endpoint 를 선행 구현하지 않는다.
 *
 * ## 전역 계약
 *
 *   - 동일 scope + 동일 key + 동일 request hash → 저장된 최초 결과 replay
 *     (신규 business row 없음 · 신규 AuditLog 없음)
 *   - 동일 scope + 동일 key + 다른 request hash → 409 IDEMPOTENCY_KEY_REUSED
 *
 * ## scope
 *
 * `(actorId, httpMethod, routeScope, idempotencyKey)` — key 단독이 아니다.
 * 다른 actor·다른 endpoint 의 동일 key 는 서로 독립이며, **다른 사용자의
 * 응답이 replay 되는 일이 없다.** `routeScope` 는 raw URL 이 아니라 정규화된
 * route template("/api/skus")이다.
 *
 * ## 원자성 — claim 알고리즘
 *
 * 호출부의 **business 트랜잭션 안**에서 실행된다:
 *
 *   1. `INSERT ... ON CONFLICT DO NOTHING RETURNING id` 로 reservation claim.
 *      SELECT-then-INSERT 가 아니다 — PostgreSQL UNIQUE 가 최종 동시성 방어선이다.
 *      동시 요청은 상대 트랜잭션의 commit/rollback 까지 UNIQUE 대기로 직렬화된다.
 *   2. claim 성공 → `execute()` (business 작업) → response snapshot UPDATE → commit.
 *      중간 어디서 실패해도 reservation 을 포함해 전부 함께 롤백된다 —
 *      실패한 요청이 key 를 영구 점유하지 않고, 재시도가 정상 claim 한다.
 *      (그래서 영속 IN_PROGRESS 상태·TTL 이 필요 없다.)
 *   3. claim 실패(이미 있음) → 기존 행 조회 → hash 비교 → replay 또는 409.
 */

export interface IdempotencyScope {
  readonly actorId: string;
  readonly httpMethod: string;
  /** 정규화된 route template (예: '/api/skus'). raw URL 금지. */
  readonly routeScope: string;
  readonly idempotencyKey: string;
}

export interface IdempotentExecution<T> {
  readonly responseStatus: number;
  readonly responseBody: T;
}

export interface IdempotencyOutcome<T> {
  /** true 면 저장된 최초 결과의 replay — 라우트는 200 으로 응답한다. */
  readonly replayed: boolean;
  /** 최초 실행 시의 상태 (예: 201). replay 응답 상태는 라우트가 정한다. */
  readonly responseStatus: number;
  readonly responseBody: T;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * `Idempotency-Key` 요청 헤더.
 *
 * 헤더는 **선택**이다 — 없으면 일반(비멱등) 처리이며 IdempotencyRecord 를
 * 만들지 않는다. 값이 있으면: 빈 값 금지, 200자 이하. lowercase/uppercase/trim
 * 등 silent normalization 은 하지 않는다 — 받은 값 그대로가 key 다.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export function parseIdempotencyKeyHeader(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (value.trim().length === 0) {
    throw new ValidationError(
      [{ path: IDEMPOTENCY_KEY_HEADER, message: '빈 값은 허용되지 않습니다.' }],
      { message: 'Idempotency-Key 헤더가 올바르지 않습니다.' },
    );
  }
  if (value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ValidationError(
      [
        {
          path: IDEMPOTENCY_KEY_HEADER,
          message: `${IDEMPOTENCY_KEY_MAX_LENGTH}자 이하여야 합니다.`,
        },
      ],
      { message: 'Idempotency-Key 헤더가 올바르지 않습니다.' },
    );
  }
  return value;
}

function keyReused(scope: IdempotencyScope): ConflictError {
  return new ConflictError(ERROR_CODES.IDEMPOTENCY_KEY_REUSED, {
    message: `Idempotency-Key '${scope.idempotencyKey}' 가 다른 요청 내용으로 재사용되었습니다.`,
    publicHint: '새 요청에는 새 Idempotency-Key 를 사용하세요.',
    retryable: false,
  });
}

/** 커밋된 행이 미완이거나 claim 직후 사라진 비정상 경합 — 재시도 가능으로 처리. */
function claimRace(): ConflictError {
  return new ConflictError(ERROR_CODES.SERIALIZATION_FAILURE, {
    message: '멱등 기록 경합이 발생했습니다. 잠시 후 다시 시도하세요.',
    retryable: true,
  });
}

/**
 * 호출부 트랜잭션 안에서 멱등 계약을 적용해 `execute` 를 실행한다.
 *
 * @param tx          business 트랜잭션 클라이언트 — **같은 트랜잭션**이어야
 *                    reservation 이 business 작업과 함께 롤백된다.
 * @param scope       멱등 scope. `idempotencyKey` 는 검증된 값이어야 한다.
 * @param requestHash 검증된 DTO canonical JSON 의 SHA-256 hex (`requestHashOf`).
 * @param execute     최초 요청일 때 실행할 business 작업.
 * @param parseSnapshot replay 시 저장된 JSON snapshot 을 응답 타입으로 검증·복원.
 *                      오염된 snapshot 을 무조건 신뢰하지 않기 위한 최소 방어다.
 */
export async function executeWithIdempotency<T>(
  tx: TransactionClient,
  scope: IdempotencyScope,
  requestHash: string,
  execute: () => Promise<IdempotentExecution<T>>,
  parseSnapshot: (raw: unknown) => T,
): Promise<IdempotencyOutcome<T>> {
  if (!SHA256_HEX.test(requestHash)) {
    // DB CHECK 가 최종 방어하지만, 여기서 잡히면 호출부 버그다.
    throw new SystemError({ message: 'request hash 는 SHA-256 lowercase hex 여야 합니다.' });
  }

  // ★ SELECT-then-INSERT 금지 — UNIQUE 를 이용한 원자적 claim.
  const claimed = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO idempotency_record
      (id, actor_id, http_method, route_scope, idempotency_key, request_hash)
    VALUES
      (gen_random_uuid(), ${scope.actorId}::uuid, ${scope.httpMethod},
       ${scope.routeScope}, ${scope.idempotencyKey}, ${requestHash})
    ON CONFLICT (actor_id, http_method, route_scope, idempotency_key) DO NOTHING
    RETURNING id`;

  const reservation = claimed[0];
  if (reservation !== undefined) {
    // 최초 요청 — business 실행 후 같은 트랜잭션에서 snapshot 을 채운다.
    const result = await execute();
    await tx.idempotencyRecord.update({
      where: { id: reservation.id },
      data: {
        responseStatus: result.responseStatus,
        // snapshot 은 업무 payload 만 — requestId 등 요청별 metadata 는
        // 호출부가 애초에 responseBody 에 넣지 않아야 한다.
        responseBody: result.responseBody as Prisma.InputJsonValue,
      },
    });
    return { replayed: false, ...result };
  }

  // 이미 같은 scope 의 기록이 있다 — UNIQUE 대기 후 도달했으므로 커밋된 행이다.
  const existing = await tx.idempotencyRecord.findUnique({
    where: {
      actorId_httpMethod_routeScope_idempotencyKey: {
        actorId: scope.actorId,
        httpMethod: scope.httpMethod,
        routeScope: scope.routeScope,
        idempotencyKey: scope.idempotencyKey,
      },
    },
  });

  // 상대 트랜잭션이 rollback 되어 사라진 직후 — 재시도하면 정상 claim 된다.
  if (existing === null) throw claimRace();

  if (existing.requestHash !== requestHash) throw keyReused(scope);

  // 같은 트랜잭션에서 snapshot 까지 채워 커밋하므로 커밋된 행이 미완일 수 없다.
  if (existing.responseStatus === null) throw claimRace();

  return {
    replayed: true,
    responseStatus: existing.responseStatus,
    responseBody: parseSnapshot(existing.responseBody),
  };
}
