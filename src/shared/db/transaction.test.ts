import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '@/generated/prisma/client';

import { withTransaction, type TransactionClient, type TransactionOptions } from './transaction';

/**
 * `withTransaction` 계약 테스트.
 *
 * 실제 PostgreSQL 없이 **래퍼의 계약**을 검증한다.
 *   - callback 에 트랜잭션 클라이언트가 전달되는가
 *   - 반환값이 보존되는가
 *   - 옵션이 지정된 키만 전달되는가
 *   - 예외가 원본 그대로 전파되는가
 *   - callback 이 정확히 한 번만 실행되는가 (자동 재시도 없음)
 *
 * 대역은 Prisma `$transaction(fn, options)` 의 의미론을 그대로 흉내낸다.
 * 성공 시 commit, 예외 시 rollback 후 원래 오류 재던짐.
 *
 * ⚠️ **실제 DB 의 commit/rollback 은 여기서 검증되지 않는다.** 이 테스트가
 *    보장하는 것은 "우리 래퍼가 Prisma 에 올바르게 위임한다"까지다.
 *    실제 롤백은 T0-9 의 Testcontainers 통합 테스트가 담당한다.
 */

interface FakeTransactionLog {
  /** `$transaction` 이 받은 옵션. 미전달이면 `undefined` 가 기록된다. */
  readonly optionsReceived: unknown[];
  /** callback 실행 횟수 */
  callbackRuns: number;
  committed: number;
  rolledBack: number;
}

/** 트랜잭션 클라이언트임을 식별하기 위한 표식. */
const TX_MARKER = Symbol('tx');

function createFakePrisma(): { client: PrismaClient; log: FakeTransactionLog } {
  const log: FakeTransactionLog = {
    optionsReceived: [],
    callbackRuns: 0,
    committed: 0,
    rolledBack: 0,
  };

  const txClient = { [TX_MARKER]: true, name: 'transaction-client' };

  const client = {
    // 루트 클라이언트에만 있는 메서드 — tx 클라이언트와 구분되는지 확인용
    $connect: () => Promise.resolve(),
    $disconnect: () => Promise.resolve(),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      log.optionsReceived.push(options);
      try {
        log.callbackRuns += 1;
        const result = await fn(txClient);
        log.committed += 1;
        return result;
      } catch (error) {
        log.rolledBack += 1;
        throw error;
      }
    },
  } as unknown as PrismaClient;

  return { client, log };
}

/** 타입 우회 없이 옵션을 넘기기 위한 헬퍼. */
function run<T>(
  callback: (tx: TransactionClient) => Promise<T>,
  options: TransactionOptions,
  client: PrismaClient,
): Promise<T> {
  return withTransaction(callback, options, client);
}

describe('withTransaction — 성공 경로', () => {
  it('callback 반환값을 그대로 보존한다', async () => {
    const { client } = createFakePrisma();
    const value = { id: 'txn-1', entries: 3 };

    const result = await withTransaction(async () => value, {}, client);

    expect(result).toBe(value);
  });

  it('원시값·null·undefined 반환값도 보존한다', async () => {
    const { client } = createFakePrisma();

    expect(await withTransaction(async () => 42, {}, client)).toBe(42);
    expect(await withTransaction(async () => '문자열', {}, client)).toBe('문자열');
    expect(await withTransaction(async () => null, {}, client)).toBeNull();
    expect(await withTransaction(async () => undefined, {}, client)).toBeUndefined();
  });

  it('성공하면 commit 되고 rollback 되지 않는다', async () => {
    const { client, log } = createFakePrisma();

    await withTransaction(async () => 'ok', {}, client);

    expect(log.committed).toBe(1);
    expect(log.rolledBack).toBe(0);
  });

  it('★ callback 에 트랜잭션 클라이언트가 전달된다', async () => {
    const { client } = createFakePrisma();
    let received: unknown;

    await withTransaction(
      async (tx) => {
        received = tx;
        return null;
      },
      {},
      client,
    );

    expect(received).toBeDefined();
    expect((received as Record<symbol, unknown>)[TX_MARKER]).toBe(true);
  });

  it('★ 전달된 트랜잭션 클라이언트는 루트 클라이언트가 아니다', async () => {
    const { client } = createFakePrisma();
    let received: unknown;

    await withTransaction(
      async (tx) => {
        received = tx;
        return null;
      },
      {},
      client,
    );

    // 루트 클라이언트에만 있는 커넥션 조작 메서드가 대역의 tx 에는 없다.
    // 실제 Prisma 에서는 ITXClientDenyList 로 타입 수준에서도 제거된다.
    expect(received).not.toBe(client);
    expect((received as Record<string, unknown>)['$transaction']).toBeUndefined();
    expect((received as Record<string, unknown>)['$connect']).toBeUndefined();
  });
});

describe('withTransaction — 옵션 전달', () => {
  it('★ 옵션 미지정 시 Prisma 에 옵션을 넘기지 않는다 (기본값 사용)', async () => {
    const { client, log } = createFakePrisma();

    await withTransaction(async () => 'ok', {}, client);

    expect(log.optionsReceived).toEqual([undefined]);
  });

  it('인자를 아예 생략해도 옵션을 넘기지 않는다', async () => {
    const { client, log } = createFakePrisma();

    await withTransaction(async () => 'ok', undefined, client);

    expect(log.optionsReceived).toEqual([undefined]);
  });

  it('maxWait·timeout·isolationLevel 을 모두 전달한다', async () => {
    const { client, log } = createFakePrisma();

    await run(
      async () => 'ok',
      { maxWait: 3000, timeout: 15_000, isolationLevel: 'Serializable' },
      client,
    );

    expect(log.optionsReceived[0]).toEqual({
      maxWait: 3000,
      timeout: 15_000,
      isolationLevel: 'Serializable',
    });
  });

  it('★ 지정한 키만 전달한다 (미지정 키는 객체에 없다)', async () => {
    const { client, log } = createFakePrisma();

    await run(async () => 'ok', { timeout: 9000 }, client);

    const received = log.optionsReceived[0] as Record<string, unknown>;
    expect(received).toEqual({ timeout: 9000 });
    expect('maxWait' in received).toBe(false);
    expect('isolationLevel' in received).toBe(false);
  });

  it('격리수준 4종을 모두 전달할 수 있다', async () => {
    for (const level of [
      'ReadUncommitted',
      'ReadCommitted',
      'RepeatableRead',
      'Serializable',
    ] as const) {
      const { client, log } = createFakePrisma();
      await run(async () => 'ok', { isolationLevel: level }, client);
      expect(log.optionsReceived[0]).toEqual({ isolationLevel: level });
    }
  });
});

describe('withTransaction — 예외 경로', () => {
  class DomainSpecificError extends Error {
    constructor(readonly detail: string) {
      super('업무규칙 위반');
      this.name = 'DomainSpecificError';
    }
  }

  it('★ callback 예외를 원본 그대로 전파한다 (감싸지 않는다)', async () => {
    const { client } = createFakePrisma();
    const original = new DomainSpecificError('재고 부족');

    await expect(
      withTransaction(
        async () => {
          throw original;
        },
        {},
        client,
      ),
    ).rejects.toBe(original);
  });

  it('오류 타입과 부가 필드가 보존된다', async () => {
    const { client } = createFakePrisma();

    const caught = await withTransaction(
      async () => {
        throw new DomainSpecificError('재고 부족');
      },
      {},
      client,
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DomainSpecificError);
    expect((caught as DomainSpecificError).detail).toBe('재고 부족');
    expect((caught as DomainSpecificError).message).toBe('업무규칙 위반');
  });

  it('★ 예외 시 rollback 되고 commit 되지 않는다', async () => {
    const { client, log } = createFakePrisma();

    await withTransaction(
      async () => {
        throw new Error('boom');
      },
      {},
      client,
    ).catch(() => undefined);

    expect(log.rolledBack).toBe(1);
    expect(log.committed).toBe(0);
  });

  it('Error 가 아닌 값을 던져도 그대로 전파한다', async () => {
    const { client } = createFakePrisma();

    await expect(
      withTransaction(
        async () => {
          throw '문자열 예외';
        },
        {},
        client,
      ),
    ).rejects.toBe('문자열 예외');
  });
});

describe('★ withTransaction — 자동 재시도 없음', () => {
  it('성공 시 callback 이 정확히 한 번 실행된다', async () => {
    const { client, log } = createFakePrisma();

    await withTransaction(async () => 'ok', {}, client);

    expect(log.callbackRuns).toBe(1);
  });

  it('★ 직렬화 실패를 흉내내도 재시도하지 않는다', async () => {
    const { client, log } = createFakePrisma();
    let attempts = 0;

    // PostgreSQL 직렬화 실패(40001) 형태의 오류
    const serializationFailure = Object.assign(
      new Error('could not serialize access due to concurrent update'),
      { code: '40001' },
    );

    await withTransaction(
      async () => {
        attempts += 1;
        throw serializationFailure;
      },
      {},
      client,
    ).catch(() => undefined);

    // 재시도가 있었다면 2 이상이 된다.
    expect(attempts).toBe(1);
    expect(log.callbackRuns).toBe(1);
    expect(log.rolledBack).toBe(1);
  });

  it('★ 데드락을 흉내내도 재시도하지 않는다', async () => {
    const { client, log } = createFakePrisma();
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });

    await withTransaction(
      async () => {
        throw deadlock;
      },
      {},
      client,
    ).catch(() => undefined);

    expect(log.callbackRuns).toBe(1);
  });

  it('★ 재시도가 없으므로 부작용도 한 번만 발생한다', async () => {
    const { client } = createFakePrisma();
    const sideEffects: string[] = [];

    await withTransaction(
      async () => {
        // 실제 코드라면 외부 API 호출·파일 저장·메시지 발행이 여기 온다.
        // 롤백되지 않는 부작용이므로 중복 실행되면 안 된다.
        sideEffects.push('외부 호출');
        throw new Error('이후 단계 실패');
      },
      {},
      client,
    ).catch(() => undefined);

    expect(sideEffects).toEqual(['외부 호출']);
  });

  it('$transaction 자체도 한 번만 호출된다', async () => {
    const { client, log } = createFakePrisma();

    await withTransaction(
      async () => {
        throw new Error('boom');
      },
      {},
      client,
    ).catch(() => undefined);

    expect(log.optionsReceived).toHaveLength(1);
  });
});
