import { execSync } from 'node:child_process';

/**
 * Playwright 전역 준비 — DB 픽스처는 tsx 자식 프로세스로 돌린다.
 * (Playwright 의 TS 로더가 Prisma 생성 클라이언트를 로드하지 못하기 때문)
 */
export default function globalSetup(): void {
  execSync('pnpm exec tsx tests/e2e/setup-db.ts', { stdio: 'inherit' });
}
