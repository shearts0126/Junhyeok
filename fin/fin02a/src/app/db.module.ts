import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';

import { createPool } from '../db/client';

import type { AppConfig } from './config';
import { APP_CONFIG, DB_POOL } from './tokens';

export type DbCheck =
  | { ok: true; migrations: number }
  | { ok: false; code: 'DB_UNREACHABLE' | 'SCHEMA_MISSING' | 'DB_TIMEOUT' };

/** readiness 용 DB 점검. 연결 문자열·호스트·예외 메시지는 결과에 넣지 않는다(고정 코드만). */
@Injectable()
export class DbHealthService {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async check(timeoutMs = 3000): Promise<DbCheck> {
    const timeout = new Promise<DbCheck>((resolve) =>
      setTimeout(() => resolve({ ok: false, code: 'DB_TIMEOUT' }), timeoutMs).unref(),
    );
    const query = (async (): Promise<DbCheck> => {
      try {
        await this.pool.query('SELECT 1');
      } catch {
        return { ok: false, code: 'DB_UNREACHABLE' };
      }
      try {
        const r = await this.pool.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM fin_schema_migrations',
        );
        const n = Number(r.rows[0]?.n ?? '0');
        return n > 0 ? { ok: true, migrations: n } : { ok: false, code: 'SCHEMA_MISSING' };
      } catch {
        return { ok: false, code: 'SCHEMA_MISSING' };
      }
    })();
    return Promise.race([query, timeout]);
  }
}

@Injectable()
export class DbPoolLifecycle implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}
  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}

@Module({
  providers: [
    {
      provide: DB_POOL,
      useFactory: (cfg: AppConfig) => createPool(cfg.databaseUrl),
      inject: [APP_CONFIG],
    },
    DbHealthService,
    DbPoolLifecycle,
  ],
  exports: [DB_POOL, DbHealthService],
})
export class DbModule {}
