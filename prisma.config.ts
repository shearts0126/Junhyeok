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
  // ⚠️ datasource 는 **환경변수가 있을 때만** 구성한다.
  //    `env()` 는 변수가 없으면 config 로딩 자체를 실패시키는데,
  //    `prisma generate`(postinstall·CI)는 연결 URL 이 필요 없다 — .env 가 없는
  //    CI 에서 install 이 여기서 죽으면 안 된다. migrate 계열 명령은 항상
  //    DIRECT_URL 을 명시해 실행한다 (하네스·drift 스크립트가 주입).
  ...(process.env['DIRECT_URL'] !== undefined && process.env['DIRECT_URL'] !== ''
    ? {
        datasource: {
          url: env('DIRECT_URL'),

          // drift 검사(prisma migrate diff --from-migrations) 전용 shadow DB.
          // ⚠️ 반드시 **일회용(ephemeral) DB** 를 지정한다 — CI 는 Testcontainers 가
          //    만든 빈 DB 를 넣는다. 운영·스테이징 DB 를 shadow 로 쓰지 않는다.
          ...(process.env['SHADOW_DATABASE_URL'] !== undefined &&
          process.env['SHADOW_DATABASE_URL'] !== ''
            ? { shadowDatabaseUrl: env('SHADOW_DATABASE_URL') }
            : {}),
        },
      }
    : {}),
});
