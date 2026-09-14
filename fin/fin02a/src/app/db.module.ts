import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';

import { createPool } from '../db/client';
import { REQUIRED_MIGRATIONS } from '../db/migrations';

import type { AppConfig } from './config';
import { APP_CONFIG, DB_POOL } from './tokens';

export type DbCheck =
  | { ok: true; migrations: number }
  | { ok: false; code: 'DB_UNREACHABLE' | 'SCHEMA_MISSING' | 'DB_TIMEOUT' }
  /** 마이그레이션 기록은 있으나 현재 앱이 요구하는 ID 집합 중 일부가 없음(이전 단계 스키마). 개수만 같은 경우도 여기서 걸린다 */
  | { ok: false; code: 'SCHEMA_OUTDATED'; missingMigrations: number };

/** readiness 용 DB 점검. 연결 문자열·호스트·예외 메시지는 결과에 넣지 않는다(고정 코드만). */
@Injectable()
export class DbHealthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    private readonly required: readonly string[] = REQUIRED_MIGRATIONS,
  ) {}

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
      let applied: Set<string>;
      try {
        const r = await this.pool.query<{ version: string }>(
          'SELECT version FROM fin_schema_migrations WHERE version = ANY($1::text[])',
          [[...this.required]],
        );
        applied = new Set(r.rows.map((x) => x.version));
      } catch {
        return { ok: false, code: 'SCHEMA_MISSING' }; // 기록 테이블 자체가 없음
      }
      if (applied.size === 0) return { ok: false, code: 'SCHEMA_MISSING' };
      const missing = this.required.filter((v) => !applied.has(v)).length;
      if (missing > 0) return { ok: false, code: 'SCHEMA_OUTDATED', missingMigrations: missing };
      return { ok: true, migrations: applied.size };
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
    {
      provide: DbHealthService,
      useFactory: (pool: pg.Pool) => new DbHealthService(pool),
      inject: [DB_POOL],
    },
    DbPoolLifecycle,
  ],
  exports: [DB_POOL, DbHealthService],
})
export class DbModule {}
