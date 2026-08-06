import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    // ⚠️ 파일 병렬 실행 금지. `*-db.test.ts` 들이 **같은 PostgreSQL** 을 공유하며
    //    정리 단계에서 audit_log 트리거를 잠시 내렸다 올린다 — 병렬이면 한 파일의
    //    ENABLE 이 다른 파일의 정리 DELETE 와 경합해 간헐 실패가 난다.
    fileParallelism: false,
    // T0-9 에서 Testcontainers(실제 PostgreSQL) 통합 테스트 프로젝트를 추가한다.
    // T0-1 은 DB 의존이 없는 순수 단위 테스트만 실행한다.
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
