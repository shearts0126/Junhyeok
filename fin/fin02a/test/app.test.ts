import 'reflect-metadata';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/app/config';
import { createApp } from '../src/app/main';
import { startRun } from '../src/runs/repo';
import { runRecoveryCli } from '../scripts/recovery';

import { seedAccount, testPool, truncateAll } from './helpers';

/**
 * FIN-02B: 설정 검증, liveness/readiness(정상·DB 연결 실패·스키마 없음), 수동 복구 CLI 미리보기/적용 분리.
 * 시험용 일회용 PostgreSQL 기준. 앱은 127.0.0.1 의 임의 포트에만 바인딩한다.
 */

let pool: pg.Pool;
let testUrl: string;
let rawDir: string;

beforeAll(() => {
  pool = testPool();
  testUrl = process.env['FIN02A_TEST_DATABASE_URL'] ?? '';
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-app-'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
});

async function listen(app: NestExpressApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

describe('설정 검증', () => {
  it('DB URL 필수·형식 검사, 루프백 외 호스트 거부, 기본값', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ FIN02A_DATABASE_URL: 'mysql://x' })).toThrow(/INVALID_DATABASE_URL/);
    expect(() => loadConfig({ FIN02A_DATABASE_URL: testUrl, FIN02A_HTTP_HOST: '0.0.0.0' })).toThrow(
      /NON_LOOPBACK_HOST/,
    );
    expect(() =>
      loadConfig({ FIN02A_DATABASE_URL: testUrl, FIN02A_HTTP_HOST: '10.0.0.5' }),
    ).toThrow(/NON_LOOPBACK_HOST/);
    expect(() => loadConfig({ FIN02A_DATABASE_URL: testUrl, FIN02A_HTTP_PORT: '99999' })).toThrow(
      /INVALID_PORT/,
    );
    const c = loadConfig({ FIN02A_DATABASE_URL: testUrl });
    expect(c).toMatchObject({
      httpHost: '127.0.0.1',
      httpPort: 3400,
      rawStoreDir: '.raw-store',
      recoveryCandidateMinutes: 60,
    });
    expect(loadConfig({ FIN02A_DATABASE_URL: testUrl, FIN02A_HTTP_HOST: '::1' }).httpHost).toBe(
      '::1',
    );
  });
});

describe('liveness / readiness', () => {
  it('정상 DB: live 200, ready 200 + 마이그레이션 수. 응답에 연결 문자열 없음', async () => {
    const app = await createApp(
      loadConfig({ FIN02A_DATABASE_URL: testUrl, FIN02A_RAW_STORE_DIR: rawDir }),
    );
    try {
      const base = await listen(app);
      const live = await fetch(`${base}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ status: 'ok', service: 'fin-dashboard-core' });
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(200);
      const body = (await ready.json()) as {
        status: string;
        checks: { name: string; status: string; migrations: number }[];
      };
      expect(body.status).toBe('ready');
      expect(body.checks[0]).toMatchObject({ name: 'database', status: 'ok' });
      expect(body.checks[0]!.migrations).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(body)).not.toContain('5433');
    } finally {
      await app.close();
    }
  });

  it('DB 연결 실패: live 200, ready 503 DB_UNREACHABLE (호스트·예외 미노출)', async () => {
    const app = await createApp(
      loadConfig({
        FIN02A_DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/nodb',
        FIN02A_RAW_STORE_DIR: rawDir,
      }),
    );
    try {
      const base = await listen(app);
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(503);
      const body = (await ready.json()) as {
        status: string;
        checks: { name: string; status: string; code: string }[];
      };
      expect(body).toEqual({
        status: 'not_ready',
        checks: [{ name: 'database', status: 'down', code: 'DB_UNREACHABLE' }],
      });
      expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|nobody/);
    } finally {
      await app.close();
    }
  });

  it('DB 는 연결되나 스키마 없음: ready 503 SCHEMA_MISSING', async () => {
    const adminUrl = process.env['FIN02A_DATABASE_URL'] ?? ''; // 서버 기본 DB(postgres)에는 fin_ 스키마가 없다
    const app = await createApp(
      loadConfig({ FIN02A_DATABASE_URL: adminUrl, FIN02A_RAW_STORE_DIR: rawDir }),
    );
    try {
      const base = await listen(app);
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(503);
      expect(((await ready.json()) as { checks: { code: string }[] }).checks[0]!.code).toBe(
        'SCHEMA_MISSING',
      );
    } finally {
      await app.close();
    }
  });
});

describe('수동 복구 CLI', () => {
  it('preview 는 상태를 바꾸지 않고, close 는 --confirm 없이는 드라이런, --confirm 으로만 적용한다', async () => {
    const acc = await seedAccount(pool);
    const stale = await startRun(pool, {
      sourceAccountId: acc.id,
      periodFrom: '2026-09-12',
      periodTo: '2026-09-12',
    });
    await pool.query(
      "UPDATE fin_source_runs SET started_at = now() - interval '2 hours' WHERE id = $1",
      [stale.id],
    );
    const env = { FIN02A_DATABASE_URL: testUrl, FIN02A_RAW_STORE_DIR: rawDir };
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };

    expect(await runRecoveryCli(['preview'], env, io)).toBe(0);
    const preview = JSON.parse(out[0]!) as {
      staleRunCandidates: { runId: string; startedAt: string }[];
    };
    expect(preview.staleRunCandidates.map((c) => c.runId)).toEqual([stale.id]);
    expect(
      (await pool.query('SELECT status FROM fin_source_runs WHERE id = $1', [stale.id])).rows[0]
        .status,
    ).toBe('RUNNING');

    const startedAt = preview.staleRunCandidates[0]!.startedAt;
    expect(
      await runRecoveryCli(
        [
          'close',
          '--run',
          stale.id,
          '--started-at',
          startedAt,
          '--actor',
          'ops-a',
          '--reason',
          '프로세스 종료 확인',
        ],
        env,
        io,
      ),
    ).toBe(3); // 드라이런
    expect(
      (await pool.query('SELECT status FROM fin_source_runs WHERE id = $1', [stale.id])).rows[0]
        .status,
    ).toBe('RUNNING');

    expect(
      await runRecoveryCli(['close', '--run', stale.id, '--started-at', startedAt], env, io),
    ).toBe(2); // 사용법 오류
    expect(
      await runRecoveryCli(
        [
          'close',
          '--run',
          stale.id,
          '--started-at',
          startedAt,
          '--actor',
          'ops-a',
          '--reason',
          '프로세스 종료 확인',
          '--confirm',
        ],
        env,
        io,
      ),
    ).toBe(0);
    const row = await pool.query<{ status: string; closed_by: string; error_code: string }>(
      'SELECT status, closed_by, error_code FROM fin_source_runs WHERE id = $1',
      [stale.id],
    );
    expect(row.rows[0]).toEqual({
      status: 'FAILED',
      closed_by: 'ops-a',
      error_code: 'RECOVERY_MANUAL_CLOSE',
    });
    expect(
      await runRecoveryCli(
        [
          'close',
          '--run',
          stale.id,
          '--started-at',
          startedAt,
          '--actor',
          'ops-a',
          '--reason',
          '재시도',
          '--confirm',
        ],
        env,
        io,
      ),
    ).toBe(4); // 이미 종료됨
    expect(out.join('\n')).not.toContain(testUrl);
  });
});
