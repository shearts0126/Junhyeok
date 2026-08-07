import { describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import type { TransactionClient } from '@/shared/db';
import { toDecimal } from '@/shared/decimal';

import { auditLogger, type AuditWriteInput } from './application/audit-logger';
import { CircularReferenceError, serializeAuditValue } from './infrastructure/serialize';

/**
 * AuditLogger 테스트 (T0-7).
 *
 * 트랜잭션 클라이언트 주입, actor 메타데이터 자동 반영, 직렬화, 마스킹.
 * 실제 DB 불변성은 `audit-log-db.test.ts` 가 검증한다.
 */

const ACTOR: ActorContext = createActorContext({
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'admin@deeppoint.test',
  name: '관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: ['system_setting.update'],
  requestId: 'req-audit-1',
  sessionId: 'sess-audit',
  ipAddress: '10.1.2.3',
});

interface CapturedCreate {
  data: Record<string, unknown>;
}

function createFakeTx(): { tx: TransactionClient; creates: CapturedCreate[] } {
  const creates: CapturedCreate[] = [];
  const tx = {
    auditLog: {
      create: async (args: CapturedCreate) => {
        creates.push(args);
        return {
          id: 'audit-uuid',
          entityType: args.data['entityType'],
          entityId: args.data['entityId'],
          action: args.data['action'],
          actorId: args.data['actorId'],
        };
      },
    },
  } as unknown as TransactionClient;
  return { tx, creates };
}

function baseInput(overrides: Partial<AuditWriteInput> = {}): AuditWriteInput {
  return {
    actor: ACTOR,
    entityType: 'SystemSetting',
    entityId: '1',
    action: 'UPDATE',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// 트랜잭션 주입
// ═══════════════════════════════════════════════════════════════
describe('★ AuditLogger — 트랜잭션 클라이언트 주입', () => {
  it('첫 인자로 받은 트랜잭션 클라이언트를 쓴다', async () => {
    const { tx, creates } = createFakeTx();
    await auditLogger.write(tx, baseInput());
    expect(creates).toHaveLength(1);
  });

  it('★ root PrismaClient 는 타입상 넘길 수 없다', () => {
    // TransactionClient 는 $transaction·$connect 등이 제거된 타입이므로
    // 루트 클라이언트는 대입되지 않는다 (Prisma 의 ITXClientDenyList).
    const root = { $transaction: () => undefined, $connect: () => undefined, auditLog: {} };

    // @ts-expect-error root PrismaClient 는 TransactionClient 가 아니다
    expect(() => auditLogger.write(root, baseInput())).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// actor 메타데이터
// ═══════════════════════════════════════════════════════════════
describe('★ AuditLogger — actor 메타데이터 자동 반영', () => {
  it('actorId·requestId·sessionId·ipAddress 를 ActorContext 에서 가져온다', async () => {
    const { tx, creates } = createFakeTx();
    await auditLogger.write(tx, baseInput());

    const data = creates[0]!.data;
    expect(data['actorId']).toBe(ACTOR.userId);
    expect(data['requestId']).toBe('req-audit-1');
    expect(data['sessionId']).toBe('sess-audit');
    expect(data['ipAddress']).toBe('10.1.2.3');
  });

  it('★ occurredAt 을 호출부가 지정할 수 없다 (DB 기본값 사용)', async () => {
    const { tx, creates } = createFakeTx();
    await auditLogger.write(tx, baseInput());

    expect('occurredAt' in creates[0]!.data).toBe(false);
  });

  it('★ 입력 타입에 actorId·requestId 필드가 없다', () => {
    // 요청 본문에서 받을 수 있는 자리가 타입에 존재하지 않는다.
    const input = baseInput();
    expect('actorId' in input).toBe(false);
    expect('requestId' in input).toBe(false);
    expect('occurredAt' in input).toBe(false);
  });

  it('sessionId·ipAddress 가 없는 actor 는 해당 키를 생략한다', async () => {
    const minimal = createActorContext({
      userId: ACTOR.userId,
      email: ACTOR.email,
      name: ACTOR.name,
      active: true,
      roles: [],
      permissions: [],
      requestId: 'req-min',
    });

    const { tx, creates } = createFakeTx();
    await auditLogger.write(tx, { ...baseInput(), actor: minimal });

    expect('sessionId' in creates[0]!.data).toBe(false);
    expect('ipAddress' in creates[0]!.data).toBe(false);
  });

  it('reason·approvedBy 는 지정했을 때만 담긴다', async () => {
    const { tx, creates } = createFakeTx();
    await auditLogger.write(tx, baseInput());
    expect('reason' in creates[0]!.data).toBe(false);
    expect('approvedBy' in creates[0]!.data).toBe(false);

    const second = createFakeTx();
    await auditLogger.write(
      second.tx,
      baseInput({ reason: '월마감 정정', approvedBy: '22222222-2222-4222-8222-222222222222' }),
    );
    expect(second.creates[0]!.data['reason']).toBe('월마감 정정');
    expect(second.creates[0]!.data['approvedBy']).toBe('22222222-2222-4222-8222-222222222222');
  });
});

// ═══════════════════════════════════════════════════════════════
// 직렬화
// ═══════════════════════════════════════════════════════════════
describe('★ 감사값 직렬화', () => {
  it('★ Decimal 을 문자열로 낸다', () => {
    expect(serializeAuditValue({ quantity: toDecimal('10.500000') })).toEqual({
      quantity: '10.5',
    });
  });

  it('★ Date 를 ISO 문자열로 낸다', () => {
    expect(serializeAuditValue({ at: new Date('2026-04-01T00:00:00.000Z') })).toEqual({
      at: '2026-04-01T00:00:00.000Z',
    });
  });

  it('★ BigInt 를 문자열로 낸다', () => {
    expect(serializeAuditValue({ count: 9007199254740993n })).toEqual({
      count: '9007199254740993',
    });
  });

  it('★ undefined 키를 제거한다', () => {
    const result = serializeAuditValue({ a: 1, b: undefined, c: null }) as Record<string, unknown>;
    expect('b' in result).toBe(false);
    expect(result['a']).toBe(1);
    expect(result['c']).toBeNull();
  });

  it('★ 순환 참조를 거부한다', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;
    expect(() => serializeAuditValue(node)).toThrow(CircularReferenceError);
  });

  it('배열 안의 순환 참조도 거부한다', () => {
    const inner: Record<string, unknown> = {};
    inner['list'] = [inner];
    expect(() => serializeAuditValue(inner)).toThrow(CircularReferenceError);
  });

  it('같은 객체를 형제로 두 번 참조하는 것은 허용한다', () => {
    const shared = { value: 1 };
    expect(serializeAuditValue({ a: shared, b: shared })).toEqual({
      a: { value: 1 },
      b: { value: 1 },
    });
  });

  it('★ 민감값을 저장 전에 마스킹한다', () => {
    const result = serializeAuditValue({
      email: 'a@b.c',
      password: 'plain-text',
      accessToken: 'tok_live_123',
      cookie: 'sb-access-token=abc',
      nested: { clientSecret: 'shh' },
    }) as Record<string, unknown>;

    expect(result['email']).toBe('a@b.c');
    expect(result['password']).toBe('***');
    expect(result['accessToken']).toBe('***');
    expect(result['cookie']).toBe('***');
    expect((result['nested'] as Record<string, unknown>)['clientSecret']).toBe('***');
  });

  it('★ 문자열 안에 섞인 자격증명도 마스킹한다', () => {
    const result = serializeAuditValue({
      note: 'connect postgresql://scm:pw123@db.internal/prod failed',
      header: 'Bearer eyJhbGciOi.payload.sig',
    }) as Record<string, unknown>;

    expect(String(result['note'])).not.toContain('pw123');
    expect(String(result['header'])).toBe('Bearer ***');
  });

  it('null·undefined 입력은 null 이 된다', () => {
    expect(serializeAuditValue(null)).toBeNull();
    expect(serializeAuditValue(undefined)).toBeNull();
  });

  it('중첩 배열·객체를 보존한다', () => {
    expect(serializeAuditValue({ lines: [{ sku: 'A', qty: toDecimal('1.5') }] })).toEqual({
      lines: [{ sku: 'A', qty: '1.5' }],
    });
  });

  it('★ 감사로그에 저장되는 값이 JSON 직렬화 가능하다', async () => {
    const { tx, creates } = createFakeTx();
    await auditLogger.write(
      tx,
      baseInput({
        beforeValue: { qty: toDecimal('1'), at: new Date('2026-01-01T00:00:00Z'), big: 1n },
        afterValue: { qty: toDecimal('2') },
      }),
    );

    // Prisma 가 JSONB 로 넣기 전에 JSON.stringify 가 가능해야 한다
    expect(() => JSON.stringify(creates[0]!.data['beforeValue'])).not.toThrow();
    expect(creates[0]!.data['beforeValue']).toEqual({
      qty: '1',
      at: '2026-01-01T00:00:00.000Z',
      big: '1',
    });
  });
});
