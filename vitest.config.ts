import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    // T0-9 에서 Testcontainers(실제 PostgreSQL) 통합 테스트 프로젝트를 추가한다.
    // T0-1 은 DB 의존이 없는 순수 단위 테스트만 실행한다.
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
