import pg from 'pg';

export type Queryable = Pick<pg.PoolClient, 'query'>;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 4 });
}

/** 트랜잭션 헬퍼. 자동 재시도 없음(SCM/WMS 의 withTransaction 과 같은 원칙). */
export async function withTx<T>(pool: pg.Pool, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
