import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool } from '../src/db/client';
import { migrate } from '../src/db/migrate';

const url = process.env['FIN02A_DATABASE_URL'];
if (!url) {
  console.error(
    'FIN02A_DATABASE_URL 이 필요합니다(FIN-02A 전용 DB. SCM/WMS DATABASE_URL 을 넣지 마세요).',
  );
  process.exit(1);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const pool = createPool(url);
migrate(pool, dir)
  .then((done) => {
    console.log(done.length > 0 ? `적용: ${done.join(', ')}` : '적용할 마이그레이션 없음');
    return pool.end();
  })
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
    return pool.end();
  });
