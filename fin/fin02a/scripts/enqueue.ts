/**
 * 수동 enqueue CLI: 정기 실행과 같은 큐에 작업을 넣는다(HTTP 실행 API 없음).
 *   pnpm enqueue --account <uuid> --collector <key> --from 2026-09-12 --to 2026-09-12 --request-id <id> [--mode SCHEDULED|VERIFICATION]
 * 같은 --request-id 재전송은 중복 작업을 만들지 않는다(종료 코드 3). 의도한 재수집은 새 --request-id.
 */
import { createPool } from '../src/db/client';
import { createQueue, createRedis, enqueueCollection } from '../src/queue/queue';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runEnqueueCli(
  argv: string[],
  env: Record<string, string | undefined>,
  out: (l: string) => void,
): Promise<number> {
  const dbUrl = env['FIN02A_DATABASE_URL'];
  const redisUrl = env['FIN02A_REDIS_URL'];
  if (!dbUrl || !redisUrl) {
    out('FIN02A_DATABASE_URL, FIN02A_REDIS_URL 이 필요합니다');
    return 2;
  }
  const account = arg(argv, '--account');
  const collector = arg(argv, '--collector');
  const from = arg(argv, '--from');
  const to = arg(argv, '--to');
  const requestId = arg(argv, '--request-id');
  const mode = (arg(argv, '--mode') ?? 'SCHEDULED') as 'SCHEDULED' | 'VERIFICATION';
  if (
    !account ||
    !collector ||
    !from ||
    !to ||
    !requestId ||
    !['SCHEDULED', 'VERIFICATION'].includes(mode)
  ) {
    out(
      '사용법: enqueue --account <uuid> --collector <key> --from <date> --to <date> --request-id <id> [--mode SCHEDULED|VERIFICATION]',
    );
    return 2;
  }
  const pool = createPool(dbUrl);
  const redis = createRedis(redisUrl);
  const queue = createQueue(redis);
  try {
    const r = await enqueueCollection(pool, queue, {
      requestId,
      sourceAccountId: account,
      collectorKey: collector,
      periodFrom: from,
      periodTo: to,
      mode,
    });
    if (r.enqueued) {
      out(`enqueued job=${r.job.id} request=${requestId} mode=${mode}`);
      return 0;
    }
    out(`duplicate request-id: 기존 job=${r.job.id} status=${r.job.status} (새 작업 없음)`);
    return 3;
  } finally {
    await queue.close();
    await redis.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1] && /enqueue\.(ts|js)$/.test(process.argv[1])) {
  runEnqueueCli(process.argv.slice(2), process.env, (l) => console.log(l)).then(
    (c) => {
      process.exitCode = c;
    },
    (e: unknown) => {
      console.error(`enqueue failed: ${e instanceof Error ? e.name : 'UNKNOWN'}`);
      process.exitCode = 1;
    },
  );
}
