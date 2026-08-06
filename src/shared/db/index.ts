import type { HealthCheck } from '@/shared/health';

import { DB_CHECK_TIMEOUT_MS, runDatabaseCheck } from './check';
import { getPrismaClient } from './prisma';

export { getPrismaClient, disconnectPrisma } from './prisma';
export { DB_CHECK_NAME, DB_CHECK_TIMEOUT_MS, runDatabaseCheck, summarizeDbError } from './check';

/**
 * 실제 데이터베이스에 `SELECT 1` 을 실행해 연결을 점검한다.
 *
 * 환경변수 누락·잘못된 연결 문자열도 여기서 down 으로 잡힌다
 * (getPrismaClient 가 EnvironmentError 를 던지고 runDatabaseCheck 가 포착).
 */
export async function checkDatabase(timeoutMs: number = DB_CHECK_TIMEOUT_MS): Promise<HealthCheck> {
  return runDatabaseCheck(async () => {
    const prisma = getPrismaClient();
    return prisma.$queryRaw`SELECT 1`;
  }, timeoutMs);
}
