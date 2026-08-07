import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

/**
 * DB 통합 테스트 하네스 (T0-9).
 *
 * **일회용(ephemeral) PostgreSQL** 을 준비하고, 빈 DB 에 실제 migration history 를
 * 전량 적용한 뒤 그 연결 문자열을 돌려준다.
 *
 * ## 원칙
 *
 *   - ⛔ 운영·스테이징 DB 를 절대 사용하지 않는다.
 *   - ⛔ 개발자의 기존 로컬 DB 를 삭제·reset 하지 않는다 — 하네스는 **자기가 만든
 *     데이터베이스만** 만들고 지운다.
 *   - ⛔ `.env` 의 `DATABASE_URL` 을 읽지 않는다. 테스트 대상 DB 는 하네스가
 *     직접 만들므로, 운영 자격증명이 테스트에 "자동 선택"되는 경로가 없다.
 *   - `prisma db push` 로 우회하지 않는다 — **`prisma migrate deploy`** 로
 *     migration history 를 처음부터 적용한다 (빈 DB → 전량 적용 재현 검증).
 *
 * ## 두 가지 서버 소스
 *
 *   1. **Testcontainers (기본)** — Docker 로 `postgres:16-alpine` 을 기동한다.
 *      docker-compose.yml 과 같은 이미지·메이저 버전이다. Docker 가 없으면
 *      **실패한다** — 조건부 skip 으로 green 을 만들지 않는다.
 *   2. **`DB_TEST_SERVER_URL` (명시적 대체)** — Docker 를 쓸 수 없는 환경에서
 *      운영자가 *명시적으로* 지정한 PostgreSQL **서버**(superuser, 로컬/일회용).
 *      하네스는 그 서버에 `scm_test_<random>` DB 를 새로 만들어 쓰고 끝나면
 *      DROP 한다. 지정된 서버의 기존 DB 는 건드리지 않는다.
 *      ⚠️ CI 는 이 변수를 설정하지 않는다 — CI 는 항상 Testcontainers 다.
 */

/** docker-compose.yml(postgres:16-alpine)과 동일 — 근거 없는 latest 금지. */
export const POSTGRES_IMAGE = 'postgres:16-alpine';

export interface EphemeralDatabase {
  /** 애플리케이션·테스트가 쓸 연결 문자열 (하네스가 만든 DB) */
  readonly url: string;
  /** 같은 서버의 관리용(postgres DB) 연결 문자열 — 추가 DB 생성/DROP 용 */
  readonly adminUrl: string;
  /** 하네스가 만든 데이터베이스 이름 */
  readonly databaseName: string;
  /** 서버 소스 — 보고·디버깅용 */
  readonly source: 'testcontainers' | 'external-server';
  stop(): Promise<void>;
}

function randomDbName(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

function withDatabase(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

/**
 * 빈 DB 에 migration history 를 전량 적용한다.
 *
 * ⚠️ `prisma migrate deploy` — `db push` 가 아니다. T0-2 이후의
 *    "처음부터 migration 재현 가능성"이 여기서 매 실행 검증된다.
 */
export function deployMigrations(directUrl: string): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DIRECT_URL: directUrl,
      DATABASE_URL: directUrl,
      // shadow 는 deploy 에 불필요 — 상속된 값이 있으면 오염되지 않게 비운다.
      SHADOW_DATABASE_URL: '',
    },
    stdio: 'pipe',
  });
}

/** Testcontainers 로 일회용 PostgreSQL 서버를 기동한다. */
async function startWithTestcontainers(): Promise<EphemeralDatabase> {
  // 동적 import — 외부 서버 모드에서는 testcontainers 를 로드조차 하지 않는다.
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');

  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('scm_test')
    .withUsername('scm_test')
    .withPassword('scm_test')
    .start();

  return {
    url: container.getConnectionUri(),
    adminUrl: withDatabase(container.getConnectionUri(), 'postgres'),
    databaseName: container.getDatabase(),
    source: 'testcontainers',
    stop: async () => {
      await container.stop();
    },
  };
}

/** 명시적 외부 서버에 일회용 데이터베이스를 만든다. */
async function startWithExternalServer(serverUrl: string): Promise<EphemeralDatabase> {
  const adminUrl = withDatabase(serverUrl, 'postgres');
  const databaseName = randomDbName('scm_test');
  await createDatabase(adminUrl, databaseName);

  return {
    url: withDatabase(serverUrl, databaseName),
    adminUrl,
    databaseName,
    source: 'external-server',
    stop: async () => {
      await dropDatabase(adminUrl, databaseName);
    },
  };
}

/**
 * 일회용 PostgreSQL 을 준비하고 migration 을 전량 적용한다.
 *
 * @param options.migrate false 면 **완전히 빈 DB** 를 돌려준다
 *   (drift 검사의 shadow DB 용 — diff 도구가 스스로 migration 을 적용한다).
 * @throws Docker 도 `DB_TEST_SERVER_URL` 도 없으면 — **skip 하지 않고 실패한다.**
 */
export async function startEphemeralDatabase(
  options: { migrate?: boolean } = {},
): Promise<EphemeralDatabase> {
  const externalServer = process.env['DB_TEST_SERVER_URL'];

  const database =
    externalServer !== undefined && externalServer !== ''
      ? await startWithExternalServer(externalServer)
      : await startWithTestcontainers();

  if (options.migrate === false) return database;

  try {
    deployMigrations(database.url);
  } catch (error) {
    await database.stop().catch(() => undefined);
    throw error;
  }

  return database;
}
