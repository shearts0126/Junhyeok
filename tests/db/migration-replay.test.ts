import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { deployMigrations } from './harness';

/**
 * 빈 PostgreSQL → migration 전량 적용 재현 테스트 (T0-9).
 *
 * 하네스가 이미 한 번 적용했지만, 여기서는 **별도의 완전히 빈 데이터베이스**를
 * 하나 더 만들어 `prisma migrate deploy` 가 처음부터 끝까지 성공하는지
 * 독립적으로 재현한다. T0-2 이후 수동으로만 확인하던 "처음부터 재현 가능성"을
 * 자동 검증으로 고정한다. (`db push` 우회 아님 — 실제 migration history)
 */

describe('★ 빈 DB → migrations 전량 적용 (실제 PostgreSQL)', () => {
  it('★ 완전히 빈 데이터베이스에 migrate deploy 가 성공한다', async () => {
    const adminUrl = process.env['DB_TEST_ADMIN_URL'];
    expect(adminUrl, 'global-setup 이 DB_TEST_ADMIN_URL 을 제공해야 한다').toBeTruthy();

    const replayName = `scm_replay_${randomBytes(6).toString('hex')}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${replayName}"`);

      const url = new URL(adminUrl as string);
      url.pathname = `/${replayName}`;
      const replayUrl = url.toString();

      // 빈 DB 에 전량 적용 — 실패하면 여기서 던진다.
      deployMigrations(replayUrl);

      // 적용 결과 확인: 대표 테이블·트리거·시드 없음(빈 상태 그대로)
      const target = new Client({ connectionString: replayUrl });
      await target.connect();
      try {
        const tables = await target.query(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
        );
        const names = (tables.rows as Array<{ tablename: string }>).map((row) => row.tablename);
        for (const expected of [
          'user',
          'role',
          'permission',
          'system_setting',
          'audit_log',
          'common_code_group',
          'common_code',
        ]) {
          expect(names, expected).toContain(expected);
        }

        const migrations = await target.query(
          `SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
        );
        expect((migrations.rows[0] as { count: number }).count).toBeGreaterThanOrEqual(6);

        // migrate deploy 는 seed 를 수행하지 않는다 — 코드사전은 비어 있어야 정상.
        const codes = await target.query(`SELECT count(*)::int AS count FROM common_code`);
        expect((codes.rows[0] as { count: number }).count).toBe(0);
      } finally {
        await target.end();
      }
    } finally {
      await admin
        .query(`DROP DATABASE IF EXISTS "${replayName}" WITH (FORCE)`)
        .catch(() => undefined);
      await admin.end();
    }
  }, 60_000); // migrate deploy 프로세스 호출 포함 — 파일 단위로 넉넉히
});
