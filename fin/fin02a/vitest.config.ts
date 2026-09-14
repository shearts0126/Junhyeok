import { defineConfig } from 'vitest/config';

/**
 * FIN-02A 테스트는 전부 시험용 PostgreSQL 을 사용한다(조건부 skip 없음).
 * global-setup 이 FIN02A_DATABASE_URL 의 서버에 일회용 데이터베이스를 만들고 마이그레이션을 적용한다.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: './test/global-setup.ts',
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
