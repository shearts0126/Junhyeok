import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    // ⚠️ 파일 병렬 실행 금지. `*-db.test.ts` 들이 **같은 PostgreSQL** 을 공유하며
    //    정리 단계에서 audit_log 트리거를 잠시 내렸다 올린다 — 병렬이면 한 파일의
    //    ENABLE 이 다른 파일의 정리 DELETE 와 경합해 간헐 실패가 난다.
    //
    //    TODO(T0-9): Testcontainers 로 파일별 격리 DB 를 갖추면 병렬 복원을 재검토한다.
    //    (docs/07_개발백로그와_테스트전략_v0.2.md 의 T0-9 항목 참조)
    fileParallelism: false,
    // type-aware ESLint 를 실제로 구동하는 테스트(tests/eslint-rules/*)는 부하가 있으면
    // 기본 5초를 넘을 수 있다. 기능 대기가 아니라 컴파일 비용이므로 한도만 늘린다.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
