import { startEphemeralDatabase, type EphemeralDatabase } from './harness';

/**
 * `db` 프로젝트 전역 준비 (T0-9).
 *
 * 일회용 PostgreSQL 을 기동하고 migration 을 전량 적용한 뒤, 연결 문자열을
 * `DATABASE_URL`/`DIRECT_URL` 로 노출한다. 워커 프로세스는 이 env 를 상속한다.
 *
 * ⚠️ `.env` 의 값을 **덮어쓴다** — DB 통합 테스트가 개발자·운영 DB 로 향하는
 *    경로를 구조적으로 차단한다. 테스트가 보는 DB 는 항상 하네스가 만든 DB 다.
 *
 * teardown 에서 컨테이너(또는 임시 데이터베이스)를 정리한다.
 */

let database: EphemeralDatabase | undefined;

export async function setup(): Promise<void> {
  database = await startEphemeralDatabase();

  process.env['DATABASE_URL'] = database.url;
  process.env['DIRECT_URL'] = database.url;
  // 하네스 출처 표식 — 테스트가 "운영 자격증명 자동 선택 불가"를 검증할 때 쓴다.
  process.env['DB_TEST_HARNESS'] = database.source;
  process.env['DB_TEST_DATABASE_NAME'] = database.databaseName;
  // 추가 일회용 DB(migration 재적용·shadow)를 만들 관리 URL
  process.env['DB_TEST_ADMIN_URL'] = database.adminUrl;

  console.log(
    `[db-harness] ${database.source} — ${database.databaseName} 준비 완료 (migrations 적용됨)`,
  );
}

export async function teardown(): Promise<void> {
  await database?.stop();
  database = undefined;
}
