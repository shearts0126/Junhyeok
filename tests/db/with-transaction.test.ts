import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  disconnectPrisma,
  getPrismaClient,
  TransactionIsolationLevel,
  withTransaction,
} from '@/shared/db';

/**
 * `withTransaction` 실제 PostgreSQL 통합 테스트 (T0-9).
 *
 * 단위 테스트(src/shared/db/transaction.test.ts)는 대역으로 **래퍼의 계약**만
 * 검증했다. 여기서는 실제 DB 로 commit / rollback / 반환값 / 격리수준 옵션이
 * 진짜로 동작하는지 고정한다. 대역이 아니라 하네스의 일회용 PostgreSQL 이다.
 *
 * 대상 테이블은 `role` — 업무 의미가 없는 테스트 전용 행(TX_ 접두사)만 만들고 지운다.
 */

const CODE_COMMIT = 'TX_COMMIT_PROBE';
const CODE_ROLLBACK = 'TX_ROLLBACK_PROBE';

async function cleanup(): Promise<void> {
  await getPrismaClient().role.deleteMany({ where: { roleCode: { startsWith: 'TX_' } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

describe('★ withTransaction (실제 PostgreSQL)', () => {
  it('★ callback 정상 반환 → commit 되고 반환값이 그대로 전달된다', async () => {
    const result = await withTransaction(async (tx) => {
      const created = await tx.role.create({
        data: { roleCode: CODE_COMMIT, roleName: '커밋 검증' },
      });
      return { id: created.id, marker: 'commit-ok' as const };
    });

    expect(result.marker).toBe('commit-ok');

    // 트랜잭션 밖(새 쿼리)에서도 보인다 — 실제 커밋 증거.
    const row = await getPrismaClient().role.findUnique({ where: { roleCode: CODE_COMMIT } });
    expect(row?.id).toBe(result.id);
  });

  it('★ callback throw → rollback 되고 데이터가 잔존하지 않는다', async () => {
    await expect(
      withTransaction(async (tx) => {
        await tx.role.create({ data: { roleCode: CODE_ROLLBACK, roleName: '롤백 검증' } });
        // INSERT 가 트랜잭션 안에서는 보인다 — 이후 throw 로 전부 되돌린다.
        const inside = await tx.role.findUnique({ where: { roleCode: CODE_ROLLBACK } });
        expect(inside).not.toBeNull();
        throw new Error('의도된 실패');
      }),
    ).rejects.toThrow('의도된 실패');

    const after = await getPrismaClient().role.findUnique({ where: { roleCode: CODE_ROLLBACK } });
    expect(after).toBeNull();
  });

  it('★ 오류를 감싸지 않고 원래 타입 그대로 전파한다', async () => {
    class DomainProbeError extends Error {}
    await expect(
      withTransaction(async () => {
        throw new DomainProbeError('원형 유지');
      }),
    ).rejects.toBeInstanceOf(DomainProbeError);
  });

  it('★ isolationLevel 옵션이 실제 세션에 적용된다', async () => {
    // 기본값 — PostgreSQL 의 READ COMMITTED
    const defaultLevel = await withTransaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ transaction_isolation: string }>
      >`SELECT current_setting('transaction_isolation') AS transaction_isolation`;
      return rows[0]?.transaction_isolation;
    });
    expect(defaultLevel).toBe('read committed');

    // 명시 옵션 — Serializable 이 진짜로 적용되는지
    const serializable = await withTransaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ transaction_isolation: string }>
        >`SELECT current_setting('transaction_isolation') AS transaction_isolation`;
        return rows[0]?.transaction_isolation;
      },
      { isolationLevel: TransactionIsolationLevel.Serializable },
    );
    expect(serializable).toBe('serializable');
  });

  it('timeout 옵션 초과 시 트랜잭션이 롤백된다', async () => {
    await expect(
      withTransaction(
        async (tx) => {
          await tx.role.create({ data: { roleCode: 'TX_TIMEOUT_PROBE', roleName: '타임아웃' } });
          await tx.$queryRaw`SELECT pg_sleep(1)`;
          return 'unreachable';
        },
        { timeout: 300 },
      ),
    ).rejects.toThrow();

    const after = await getPrismaClient().role.findUnique({
      where: { roleCode: 'TX_TIMEOUT_PROBE' },
    });
    expect(after).toBeNull();
  });
});
