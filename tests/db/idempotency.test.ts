import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  SKU_CREATE_PERMISSION,
  SKU_READ_PERMISSION,
  SKU_UPDATE_PERMISSION,
  createSku,
  parseCreateSkuInput,
} from '@/modules/sku/application';
import { disconnectPrisma, getPrismaClient, withTransaction } from '@/shared/db';
import { executeWithIdempotency, requestHashOf } from '@/shared/idempotency';

import { seedCommonCodes } from '../../prisma/seed/common-codes';
import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * 공용 멱등성 DB 테스트 (T1-3 보완) — 실제 PostgreSQL.
 *
 * 대역으로 재현할 수 없는 것:
 *   - `INSERT ... ON CONFLICT DO NOTHING` claim 의 실제 UNIQUE 직렬화 (동시 요청)
 *   - claim 을 포함한 실 트랜잭션 롤백 → 재시도 claim
 *   - DB CHECK / UNIQUE / FK RESTRICT 제약
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TSI-${RUN}-${suffix}`;
const KEY = (suffix: string) => `tsi-${RUN}-${suffix}`;

const ACTOR_A_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const ACTOR_B_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa2';

function actorOf(userId: string): ActorContext {
  return createActorContext({
    userId,
    email: `idem-${userId.slice(-1)}@deeppoint.test`,
    name: '멱등 테스트 액터',
    active: true,
    roles: ['SCM_STAFF'],
    permissions: [SKU_READ_PERMISSION, SKU_CREATE_PERMISSION, SKU_UPDATE_PERMISSION],
    requestId: 'req-idem-db',
  });
}

const ACTOR_A = actorOf(ACTOR_A_ID);
const ACTOR_B = actorOf(ACTOR_B_ID);

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id IN ($1::uuid, $2::uuid)`,
    ACTOR_A_ID,
    ACTOR_B_ID,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({
    where: { actorId: { in: [ACTOR_A_ID, ACTOR_B_ID] } },
  });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TSI-' } } });
  await client.user.deleteMany({ where: { id: { in: [ACTOR_A_ID, ACTOR_B_ID] } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
    await seedCommonCodes(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: [
      { id: ACTOR_A_ID, email: 'idem-a@deeppoint.test', name: '멱등 액터 A' },
      { id: ACTOR_B_ID, email: 'idem-b@deeppoint.test', name: '멱등 액터 B' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

function minimalBody(skuCode: string) {
  return { skuCode, skuName: '멱등 테스트', itemType: 'FINISHED' };
}

async function counts(skuCode: string, actorId: string) {
  const client = getPrismaClient();
  const [skus, records] = await Promise.all([
    client.sku.count({ where: { skuCode } }),
    client.idempotencyRecord.count({ where: { actorId } }),
  ]);
  const audits = await client.auditLog.count({
    where: { entityType: 'Sku', actorId, action: 'CREATE' },
  });
  return { skus, audits, records };
}

// ═══════════════════════════════════════════════════════════════
// POST /api/skus 계약 (application adapter 경유)
// ═══════════════════════════════════════════════════════════════
describe('★ createSku 멱등성 (실제 PostgreSQL)', () => {
  it('★ 최초 201(replayed=false) / 동일 key+body 재요청 200 replay — SKU·Audit·Record 각 1건, 같은 id', async () => {
    const skuCode = CODE('R1');
    const body = minimalBody(skuCode);
    const key = KEY('r1');

    const first = await createSku(ACTOR_A, parseCreateSkuInput(body), {}, key);
    expect(first.replayed).toBe(false);

    // property 순서만 다른 동일 본문 — canonical hash 로 같은 요청이다
    const replay = await createSku(
      ACTOR_A,
      parseCreateSkuInput({ itemType: body.itemType, skuName: body.skuName, skuCode }),
      {},
      key,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.sku.id).toBe(first.sku.id);
    expect(replay.sku.skuCode).toBe(skuCode);

    const after = await counts(skuCode, ACTOR_A_ID);
    expect(after.skus).toBe(1);
    expect(
      await getPrismaClient().auditLog.count({
        where: { entityType: 'Sku', entityId: first.sku.id, action: 'CREATE' },
      }),
    ).toBe(1);
    expect(
      await getPrismaClient().idempotencyRecord.count({
        where: { actorId: ACTOR_A_ID, idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('★ snapshot 은 업무 payload 만 — requestId 없음, responseStatus=201 저장', async () => {
    const key = KEY('snap');
    await createSku(ACTOR_A, parseCreateSkuInput(minimalBody(CODE('S1'))), {}, key);

    const record = await getPrismaClient().idempotencyRecord.findFirstOrThrow({
      where: { actorId: ACTOR_A_ID, idempotencyKey: key },
    });
    expect(record.httpMethod).toBe('POST');
    expect(record.routeScope).toBe('/api/skus');
    expect(record.responseStatus).toBe(201);
    expect(record.requestHash).toMatch(/^[0-9a-f]{64}$/);

    const body = record.responseBody as Record<string, unknown>;
    expect(body['skuCode']).toBe(CODE('S1'));
    // 요청별 transient metadata 는 snapshot 에 고정하지 않는다
    for (const transient of ['requestId', 'correlationId', 'sessionId', 'ip', 'ipAddress']) {
      expect(Object.keys(body), transient).not.toContain(transient);
    }
  });

  it('★ 동일 key + 다른 body → 409 IDEMPOTENCY_KEY_REUSED, 기존 SKU 유지·신규 없음', async () => {
    const key = KEY('reuse');
    const codeA = CODE('A1');
    await createSku(ACTOR_A, parseCreateSkuInput(minimalBody(codeA)), {}, key);
    const before = await counts(codeA, ACTOR_A_ID);

    await expect(
      createSku(ACTOR_A, parseCreateSkuInput(minimalBody(CODE('A2'))), {}, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 409 });

    const after = await counts(codeA, ACTOR_A_ID);
    expect(after.skus).toBe(1); // SKU A 유지
    expect(await getPrismaClient().sku.count({ where: { skuCode: CODE('A2') } })).toBe(0);
    expect(after.audits).toBe(before.audits); // 추가 AuditLog 없음
    expect(after.records).toBe(before.records); // 새 record 없음
  });

  it('★ actor 격리 — 다른 actor 의 동일 key 는 독립이며 서로의 응답을 replay 하지 않는다', async () => {
    const key = KEY('shared');
    const a = await createSku(ACTOR_A, parseCreateSkuInput(minimalBody(CODE('X1'))), {}, key);
    // 같은 key, 다른 body 지만 actor 가 다르므로 409 가 아니라 독립 생성이다
    const b = await createSku(ACTOR_B, parseCreateSkuInput(minimalBody(CODE('X2'))), {}, key);

    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(b.sku.id).not.toBe(a.sku.id);
    expect(b.sku.skuCode).toBe(CODE('X2'));
  });

  it('★ 다른 key + 같은 skuCode → replay 가 아니라 409 SKU_CODE_DUPLICATE', async () => {
    const skuCode = CODE('DUP');
    await createSku(ACTOR_A, parseCreateSkuInput(minimalBody(skuCode)), {}, KEY('dup-1'));

    await expect(
      createSku(ACTOR_A, parseCreateSkuInput(minimalBody(skuCode)), {}, KEY('dup-2')),
    ).rejects.toMatchObject({ code: 'SKU_CODE_DUPLICATE', httpStatus: 409 });

    expect(await getPrismaClient().sku.count({ where: { skuCode } })).toBe(1);
  });

  it('★ key 없는 생성은 기존 그대로 — IdempotencyRecord 를 만들지 않는다', async () => {
    const beforeRecords = await getPrismaClient().idempotencyRecord.count({
      where: { actorId: ACTOR_A_ID },
    });
    const result = await createSku(ACTOR_A, parseCreateSkuInput(minimalBody(CODE('NK'))), {});
    expect(result.replayed).toBe(false);

    expect(
      await getPrismaClient().idempotencyRecord.count({ where: { actorId: ACTOR_A_ID } }),
    ).toBe(beforeRecords);
  });

  it('★ 동시 동일 요청 2건 — UNIQUE 직렬화로 1건 생성 + 1건 replay, 같은 SKU id', async () => {
    const skuCode = CODE('CC');
    const key = KEY('cc');
    const input = parseCreateSkuInput(minimalBody(skuCode));

    const [r1, r2] = await Promise.all([
      createSku(ACTOR_A, input, {}, key),
      createSku(ACTOR_A, input, {}, key),
    ]);

    // 성공 응답 2건 — 최초 1건 + replay 1건
    const replayFlags = [r1.replayed, r2.replayed].sort();
    expect(replayFlags).toEqual([false, true]);
    expect(r1.sku.id).toBe(r2.sku.id);

    expect(await getPrismaClient().sku.count({ where: { skuCode } })).toBe(1);
    expect(
      await getPrismaClient().auditLog.count({
        where: { entityType: 'Sku', entityId: r1.sku.id, action: 'CREATE' },
      }),
    ).toBe(1);
    expect(
      await getPrismaClient().idempotencyRecord.count({
        where: { actorId: ACTOR_A_ID, idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('★ business 실패 시 claim 도 함께 롤백 — 실패한 요청이 key 를 점유하지 않고 재시도가 성공한다', async () => {
    const skuCode = CODE('RB');
    const key = KEY('rb');
    const input = parseCreateSkuInput(minimalBody(skuCode));

    await expect(
      createSku(
        ACTOR_A,
        input,
        {
          auditLogger: {
            write: async () => {
              throw new Error('감사로그 강제 실패');
            },
          },
        },
        key,
      ),
    ).rejects.toThrow('감사로그 강제 실패');

    // 전부 함께 롤백 — SKU 0 · AuditLog 0 · IdempotencyRecord 0
    expect(await getPrismaClient().sku.count({ where: { skuCode } })).toBe(0);
    expect(
      await getPrismaClient().idempotencyRecord.count({
        where: { actorId: ACTOR_A_ID, idempotencyKey: key },
      }),
    ).toBe(0);

    // 동일 key + 동일 body 재시도 → 정상 최초 생성 (replay 아님)
    const retry = await createSku(ACTOR_A, input, {}, key);
    expect(retry.replayed).toBe(false);
    expect(retry.sku.skuCode).toBe(skuCode);
  });
});

// ═══════════════════════════════════════════════════════════════
// 공용 infrastructure 계약 (endpoint 무관)
// ═══════════════════════════════════════════════════════════════
describe('★ executeWithIdempotency — scope 계약 (실제 PostgreSQL)', () => {
  it('★ 같은 actor·같은 key 라도 routeScope 가 다르면 독립이다', async () => {
    const key = KEY('scope');
    const runFor = (routeScope: string, payload: string) =>
      withTransaction((tx) =>
        executeWithIdempotency(
          tx,
          { actorId: ACTOR_A_ID, httpMethod: 'POST', routeScope, idempotencyKey: key },
          requestHashOf({ payload }),
          async () => ({ responseStatus: 201, responseBody: { payload } }),
          (raw) => raw as { payload: string },
        ),
      );

    // 다른 route scope + 다른 payload(=다른 hash) — 충돌 없이 각각 최초 실행
    const first = await runFor('/api/test-a', 'A');
    const second = await runFor('/api/test-b', 'B');
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);

    // 같은 scope 재실행은 replay
    const replay = await runFor('/api/test-a', 'A');
    expect(replay.replayed).toBe(true);
    expect(replay.responseBody).toEqual({ payload: 'A' });
  });
});

// ═══════════════════════════════════════════════════════════════
// DB 제약
// ═══════════════════════════════════════════════════════════════
describe('★ idempotency_record DB 제약 (실제 PostgreSQL)', () => {
  const rawInsert = (columns: { method?: string; scope?: string; key?: string; hash?: string }) =>
    getPrismaClient().$executeRawUnsafe(
      `INSERT INTO idempotency_record
         (id, actor_id, http_method, route_scope, idempotency_key, request_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5)`,
      ACTOR_A_ID,
      columns.method ?? 'POST',
      columns.scope ?? '/api/check-test',
      columns.key ?? KEY(`chk-${randomBytes(3).toString('hex')}`),
      columns.hash ?? requestHashOf({ chk: 1 }),
    );

  it('★ UNIQUE(actor_id, http_method, route_scope, idempotency_key) 가 유일 인덱스로 존재한다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'idempotency_record'
        AND indexname = 'idempotency_record_scope_key'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('UNIQUE INDEX');
    expect(rows[0]?.indexdef).toContain('actor_id');
    expect(rows[0]?.indexdef).toContain('http_method');
    expect(rows[0]?.indexdef).toContain('route_scope');
    expect(rows[0]?.indexdef).toContain('idempotency_key');

    // 실제 중복 INSERT 가 UNIQUE 로 거부된다
    const key = KEY('uniq');
    await rawInsert({ key });
    await expect(rawInsert({ key })).rejects.toThrow(/23505|idempotency_record_scope_key/);
  });

  it('★ 빈 값 CHECK — http_method / route_scope / idempotency_key', async () => {
    await expect(rawInsert({ method: ' ' })).rejects.toThrow(
      /idempotency_http_method_not_blank_check/,
    );
    await expect(rawInsert({ scope: '' })).rejects.toThrow(
      /idempotency_route_scope_not_blank_check/,
    );
    await expect(rawInsert({ key: '   ' })).rejects.toThrow(/idempotency_key_not_blank_check/);
  });

  it('★ request_hash 는 SHA-256 lowercase hex 64자만', async () => {
    await expect(rawInsert({ hash: 'deadbeef' })).rejects.toThrow(
      /idempotency_request_hash_sha256_check|value too long/,
    );
    await expect(rawInsert({ hash: 'Z'.repeat(64) })).rejects.toThrow(
      /idempotency_request_hash_sha256_check/,
    );
  });

  it('actor FK 는 RESTRICT — 멱등 기록은 사용자 삭제에 딸려 지워지지 않는다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ confdeltype: string }>>`
      SELECT confdeltype::text FROM pg_constraint
      WHERE conrelid = 'idempotency_record'::regclass AND contype = 'f'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confdeltype).toBe('r');

    // NOT NULL
    await expect(
      getPrismaClient().$executeRawUnsafe(
        `INSERT INTO idempotency_record
           (id, actor_id, http_method, route_scope, idempotency_key, request_hash)
         VALUES (gen_random_uuid(), NULL, 'POST', '/api/x', 'k', $1)`,
        requestHashOf({ n: 1 }),
      ),
    ).rejects.toThrow(/null value|violates not-null/i);
  });
});
