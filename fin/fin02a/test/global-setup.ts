import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { migrate } from '../src/db/migrate';

/**
 * 시험용 일회용 데이터베이스. FIN02A_DATABASE_URL 의 서버(FIN-02A 전용 개발 DB)에
 * fin02a_test_<pid> 를 만들고 마이그레이션을 전량 적용한 뒤, 종료 시 삭제한다.
 * SCM/WMS 의 DATABASE_URL 을 사용하지 않는다(환경변수 이름이 다르다).
 */
export default async function setup(): Promise<() => Promise<void>> {
  const adminUrl = process.env['FIN02A_DATABASE_URL'];
  if (!adminUrl)
    throw new Error('FIN02A_DATABASE_URL 이 필요합니다(예: scripts/dev-db.sh start 출력값).');
  const dbName = `fin02a_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${dbName}`;
  process.env['FIN02A_TEST_DATABASE_URL'] = testUrl.toString();

  const pool = new pg.Pool({ connectionString: testUrl.toString() });
  await migrate(pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'));
  await pool.end();

  return async () => {
    const drop = new pg.Client({ connectionString: adminUrl });
    await drop.connect();
    await drop.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await drop.end();
  };
}
