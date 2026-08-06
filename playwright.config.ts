import { defineConfig, devices } from '@playwright/test';

/**
 * E2E 구성 (T0-8).
 *
 * - Supabase 스텁(54321) + Next dev 서버(3100) 를 함께 띄운다.
 * - 앱은 운영과 같은 인증 경로(@supabase/ssr → getClaims)를 탄다.
 *   테스트 분기·백도어가 앱 코드에 없다 — 스텁은 환경변수로만 연결된다.
 * - E2E 파일 확장자는 `.e2e.ts` — vitest 의 `*.{test,spec}.ts` 와 겹치지 않는다.
 * - DB 상태를 공유하므로 순차 실행한다 (workers: 1).
 */

const APP_PORT = 3100;
const STUB_PORT = 54321;

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:55432/deeppoint_scm';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'retain-on-failure',
    locale: 'ko-KR',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // 이 컨테이너의 사전 설치 Chromium 을 쓴다. `playwright install` 금지 —
        // 버전이 달라 재다운로드가 필요한 경우 executablePath 로 우회한다.
        launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
      },
    },
  ],
  webServer: [
    {
      command: `pnpm exec tsx tests/e2e/supabase-stub.ts`,
      port: STUB_PORT,
      reuseExistingServer: true,
      env: { STUB_PORT: String(STUB_PORT) },
    },
    {
      command: `pnpm exec next dev --port ${APP_PORT}`,
      port: APP_PORT,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        DATABASE_URL,
        DIRECT_URL: process.env['DIRECT_URL'] ?? DATABASE_URL,
        NEXT_PUBLIC_SUPABASE_URL: `http://localhost:${STUB_PORT}`,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e_stub',
      },
    },
  ],
});
