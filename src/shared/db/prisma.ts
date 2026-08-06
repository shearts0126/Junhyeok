import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '@/generated/prisma/client';
import { loadDatabaseEnv } from '@/shared/env';

/**
 * PrismaClient 싱글턴.
 *
 * Prisma 7 은 datasource URL 을 스키마가 아니라 driver adapter 로 받는다.
 * 런타임에는 pooled connection(DATABASE_URL)을 사용한다.
 * 마이그레이션용 direct connection(DIRECT_URL)은 prisma.config.ts 가 담당한다.
 *
 * 개발 환경의 HMR 로 커넥션이 누적되지 않도록 globalThis 에 캐시한다.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const { databaseUrl } = loadDatabaseEnv();

  const adapter = new PrismaPg({ connectionString: databaseUrl });

  return new PrismaClient({
    adapter,
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export function getPrismaClient(): PrismaClient {
  globalForPrisma.prisma ??= createPrismaClient();
  return globalForPrisma.prisma;
}

/** 테스트에서 캐시된 클라이언트를 끊기 위한 헬퍼. */
export async function disconnectPrisma(): Promise<void> {
  if (globalForPrisma.prisma) {
    await globalForPrisma.prisma.$disconnect();
    globalForPrisma.prisma = undefined;
  }
}
