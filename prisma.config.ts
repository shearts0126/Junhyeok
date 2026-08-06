import 'dotenv/config';

import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI 설정 (Prisma 7).
 *
 * Prisma 7 부터 datasource 의 연결 URL 은 스키마가 아니라 이 파일에서 지정한다.
 * 여기에 지정하는 URL 은 **마이그레이션 전용 direct connection** 이다.
 *
 * ┌─────────────────────┬──────────────┬────────────────────────────────────┐
 * │ 용도                │ 환경변수     │ 지정 위치                          │
 * ├─────────────────────┼──────────────┼────────────────────────────────────┤
 * │ prisma migrate / db │ DIRECT_URL   │ 이 파일                            │
 * │ 애플리케이션 런타임 │ DATABASE_URL │ PrismaClient driver adapter        │
 * └─────────────────────┴──────────────┴────────────────────────────────────┘
 *
 * transaction-mode pooler(Supavisor)는 DDL·advisory lock·prepared statement 가
 * 제한되므로 마이그레이션은 반드시 직결(DIRECT_URL)을 사용해야 한다.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DIRECT_URL'),
  },
});
