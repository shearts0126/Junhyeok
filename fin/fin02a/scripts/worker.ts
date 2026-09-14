/**
 * 별도 worker 프로세스. 정기 스케줄 활성화는 하지 않는다(큐에 들어온 작업만 처리).
 *   FIN02A_DATABASE_URL=… FIN02A_REDIS_URL=… pnpm worker
 * 레지스트리에 등록된 수집기 키만 처리한다. 현재 등록: koreaexim-fx(실제 호출은 자격·네트워크 있을 때만).
 */
import { hostname } from 'node:os';

import { loadConfig } from '../src/app/config';
import { KoreaeximFxCollector } from '../src/collectors/koreaexim-fx';
import { createPool } from '../src/db/client';
import { FsRawStore } from '../src/raw/store';
import { createQueue, createRedis } from '../src/queue/queue';
import { CollectorRegistry } from '../src/queue/registry';
import { createCollectionWorker } from '../src/queue/worker';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const redisUrl = process.env['FIN02A_REDIS_URL'];
  if (!redisUrl) throw new Error('FIN02A_REDIS_URL 필요');
  const pool = createPool(cfg.databaseUrl);
  const connection = createRedis(redisUrl);
  const queue = createQueue(connection);
  const registry = new CollectorRegistry().register('koreaexim-fx', new KoreaeximFxCollector());
  const workerId = `${hostname()}:${process.pid}`;
  const worker = createCollectionWorker({
    pool,
    rawStore: new FsRawStore(cfg.rawStoreDir),
    secrets: { get: (n) => process.env[n] },
    registry,
    queue,
    connection,
    workerId,
    log: (l) => console.log(l),
  });
  console.log(
    `worker ${workerId} started; collectors=${registry.keys().join(',')}; scheduler=disabled`,
  );
  const stop = async (): Promise<void> => {
    await worker.close();
    await queue.close();
    await connection.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((e: unknown) => {
  console.error(`worker failed: ${e instanceof Error ? e.name : 'UNKNOWN'}`);
  process.exitCode = 1;
});
