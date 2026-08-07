import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Vitest 구성 (T0-9) — **unit / db 2개 프로젝트**로 분리.
 *
 * ┌──────┬──────────────────────────────┬──────────┬─────────────────────────┐
 * │ 이름 │ 대상                         │ 병렬     │ DB                      │
 * ├──────┼──────────────────────────────┼──────────┼─────────────────────────┤
 * │ unit │ *-db.test.ts 를 제외한 전부  │ 파일 병렬│ 없음 (대역만)           │
 * │ db   │ *-db.test.ts + tests/db/**   │ 직렬     │ 일회용 PostgreSQL       │
 * └──────┴──────────────────────────────┴──────────┴─────────────────────────┘
 *
 * db 프로젝트는 tests/db/global-setup.ts 가 **일회용 PostgreSQL**(Testcontainers,
 * 또는 명시적 `DB_TEST_SERVER_URL` 서버의 임시 DB)을 기동해 migration 을 전량
 * 적용한다. `DATABASE_URL` 유무에 따른 **조건부 skip 이 없다** — DB 를 준비하지
 * 못하면 suite 가 실패한다.
 *
 * ## db 프로젝트만 직렬(fileParallelism: false)인 근거 — T0-9 실측
 *
 *   db 테스트 파일들은 **하나의 데이터베이스**를 공유하며
 *     (1) 정리 단계에서 `audit_log` 트리거를 잠시 DISABLE/ENABLE 한다
 *         (불변 로그의 테스트 잔여물 삭제에 필요) — 병렬이면 한 파일의 ENABLE 이
 *         다른 파일의 정리 DELETE 와 경합한다 (T0-8 에서 간헐 실패 1회 실측),
 *     (2) seed 행(system_setting singleton, 공통코드)을 서로 변경·검증한다.
 *   파일별 DB 격리(포크별 재-migrate)로 병렬화할 수 있으나, db 파일 6개 직렬
 *   총 소요가 수 초 수준이라 복잡도 대비 이득이 없다 — Testcontainers 도입 후
 *   재실측한 결정이다. unit 프로젝트는 전역 직렬화를 **제거**하고 병렬이다.
 */

const ALIAS = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
          exclude: [...configDefaults.exclude, '**/*-db.test.ts', 'tests/db/**', 'tests/e2e/**'],
          // 실측(T0-9): type-aware ESLint 를 실제 구동하는 테스트가 부하 시
          // 개별 5~8초. DB 기동과 무관한 컴파일 비용이므로 20초로 상한한다.
          testTimeout: 20_000,
        },
        resolve: { alias: ALIAS },
      },
      {
        test: {
          name: 'db',
          environment: 'node',
          include: ['src/**/*-db.test.ts', 'tests/db/**/*.test.ts'],
          globalSetup: './tests/db/global-setup.ts',
          // 근거는 파일 상단 주석 — 공유 DB + audit 트리거 토글 + seed 행 공유.
          // ⚠️ fileParallelism 은 프로젝트 단위로 적용되지 않아(T0-9 실측:
          //    설정해도 4개 파일이 병렬 실행되어 seed upsert 경합 재현),
          //    pool 을 단일 스레드로 고정해 파일을 직렬 실행한다.
          pool: 'threads',
          poolOptions: { threads: { singleThread: true } },
          // 실측(T0-9): db 테스트 개별 최대 ~2초, migration 재적용 테스트 ~3초.
          // 컨테이너 기동은 globalSetup 소관이라 test timeout 과 무관하다.
          testTimeout: 20_000,
        },
        resolve: { alias: ALIAS },
      },
    ],
  },
});
