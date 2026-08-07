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

    // drift 검사(prisma migrate diff --from-migrations) 전용 shadow DB.
    // ⚠️ 반드시 **일회용(ephemeral) DB** 를 지정한다 — CI 는 Testcontainers 가
    //    만든 빈 DB 를 넣는다. 운영·스테이징 DB 를 shadow 로 쓰지 않는다.
    //    평소(migrate dev/deploy)에는 필요 없으므로 설정되어 있을 때만 전달한다.
    ...(process.env['SHADOW_DATABASE_URL'] !== undefined &&
    process.env['SHADOW_DATABASE_URL'] !== ''
      ? { shadowDatabaseUrl: env('SHADOW_DATABASE_URL') }
      : {}),
  },
});
