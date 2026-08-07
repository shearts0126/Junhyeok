import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrismaClient } from '@/shared/db';

/**
 * 하네스 자체 검증 (T0-9).
 *
 * global-setup 이 기동한 일회용 PostgreSQL 에 대해
 * 연결·migration 전량 적용·쿼리·불변 트리거가 실제로 동작하는지 고정한다.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

afterAll(async () => {
  await disconnectPrisma().catch(() => undefined);
});

describe('★ DB 하네스 (일회용 PostgreSQL)', () => {
  it('★ 테스트 DB 는 하네스가 만든 것이다 — .env 의 DB 가 아니다', () => {
    // 운영·개발 자격증명이 테스트에 자동 선택되는 경로가 없음을 고정한다.
    expect(process.env['DB_TEST_HARNESS']).toMatch(/^(testcontainers|external-server)$/);
    const databaseName = process.env['DB_TEST_DATABASE_NAME'] ?? '';
    expect(databaseName).toMatch(/^scm_test/);
    expect(process.env['DATABASE_URL']).toContain(databaseName);
    expect(process.env['DIRECT_URL']).toContain(databaseName);
  });

  it('연결과 기본 쿼리가 동작한다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    expect(rows[0]?.ok).toBe(1);
  });

  it('★ PostgreSQL 메이저 버전이 프로젝트 기준(16)과 같다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{ server_version: string }>
    >`SHOW server_version`;
    // docker-compose.yml 의 postgres:16-alpine 과 메이저 일치 — 근거 없는 latest 금지.
    expect(rows[0]?.server_version.split('.')[0]).toBe('16');
  });

  it('★ 빈 DB 에 migration history 가 전량 적용되었다', async () => {
    const migrationDirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    expect(migrationDirs.length).toBeGreaterThanOrEqual(6);

    const applied = await getPrismaClient().$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
    >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;

    // 파일시스템의 migration 디렉터리와 적용 기록이 1:1 이고 전부 완료됐다.
    expect(applied.map((row) => row.migration_name)).toEqual(
      migrationDirs.map((entry) => entry.name).sort(),
    );
    for (const row of applied) {
      expect(row.finished_at, row.migration_name).not.toBeNull();
      expect(row.rolled_back_at, row.migration_name).toBeNull();
    }
  });

  it('수기 SQL 로 만든 객체(불변 트리거·CHECK)도 살아 있다', async () => {
    const client = getPrismaClient();

    // audit_log 불변 트리거 — migration SQL 로만 만들어지는 대표 객체
    await expect(
      client.$executeRawUnsafe(`DELETE FROM audit_log WHERE entity_type = 'never'`),
    ).resolves.toBe(0); // 0건 삭제는 트리거가 행 단위라 통과

    const triggers = await client.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal
      ORDER BY tgname`;
    expect(triggers.map((row) => row.tgname)).toEqual([
      'audit_log_no_delete',
      'audit_log_no_truncate',
      'audit_log_no_update',
    ]);

    // system_setting singleton CHECK
    await expect(
      client.$executeRawUnsafe(`INSERT INTO system_setting(id, updated_at) VALUES (2, now())`),
    ).rejects.toThrow(/system_setting_singleton_check/);
  });
});
