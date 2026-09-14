import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type pg from 'pg';

import { withTx } from './client';

/**
 * 순수 SQL 마이그레이션 적용기. fin_schema_migrations 에 버전을 기록한다.
 * SCM/WMS 의 Prisma 마이그레이션과 완전히 분리되어 있으며 그 DB 를 대상으로 실행하지 않는다.
 */
export async function migrate(pool: pg.Pool, migrationsDir: string): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS fin_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM fin_schema_migrations')).rows.map(
      (r) => r.version,
    ),
  );
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    await withTx(pool, async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO fin_schema_migrations (version) VALUES ($1)', [f]);
    });
    done.push(f);
  }
  return done;
}
