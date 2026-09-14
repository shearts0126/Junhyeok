/**
 * 수동 enqueue CLI: 정기 실행과 같은 큐에 작업을 넣는다(HTTP 실행 API 없음).
 *   pnpm enqueue --account <uuid> --collector <key> --from 2026-09-12 --to 2026-09-12 --request-id <id> [--mode SCHEDULED|VERIFICATION]
 *   pnpm enqueue --resync        # DB 에만 남은 작업(큐 등록 실패·응답 유실)을 같은 jobId 로 재등록
 * 종료 코드: 0 등록, 2 사용법, 3 같은 요청 ID 재전송(새 작업 없음; 등록 기록이 없었으면 재등록), 5 요청 ID 충돌(다른 내용),
 *           6 DB 작업은 생성됐으나 큐 등록 실패(--resync 로 재등록), 7 정기 모드에 등록 불가한 수집기.
 */
import { defaultRegistry } from '../src/collectors/index';
import { createPool } from '../src/db/client';
import {
  createQueue,
  createRedis,
  enqueueCollection,
  resyncUnqueuedJobs,
} from '../src/queue/queue';

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
  if (argv.includes('--resync')) {
    const pool = createPool(dbUrl);
    const redis = createRedis(redisUrl);
    const queue = createQueue(redis);
    try {
      const done = await resyncUnqueuedJobs(pool, queue);
      out(
        `resync: ${done.length}건 재등록${done.map((d) => ` job=${d.jobId} status=${d.status}`).join('')}`,
      );
      return 0;
    } finally {
      await queue.close();
      await redis.quit().catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
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
    const r = await enqueueCollection(
      pool,
      queue,
      {
        requestId,
        sourceAccountId: account,
        collectorKey: collector,
        periodFrom: from,
        periodTo: to,
        mode,
      },
      defaultRegistry(),
    );
    if (r.enqueued) {
      out(`enqueued job=${r.job.id} request=${requestId} mode=${mode}`);
      return 0;
    }
    switch (r.reason) {
      case 'DUPLICATE_REQUEST_ID':
        out(
          `duplicate request-id: 기존 job=${r.job.id} status=${r.job.status} (새 작업 없음${r.requeued ? ', 큐 등록 기록이 없어 같은 jobId 로 재등록' : ''})`,
        );
        return 3;
      case 'REQUEST_ID_CONFLICT':
        out(
          `request-id conflict: 같은 요청 ID 가 다른 계정·기간·모드·수집기로 이미 존재 job=${r.job.id} (거부)`,
        );
        return 5;
      case 'QUEUE_REGISTRATION_FAILED':
        out(
          `queue registration failed (${r.errorClass}): DB 작업 job=${r.job.id} 는 남아 있음. enqueue --resync 로 재등록`,
        );
        return 6;
      case 'NOT_SCHEDULABLE':
        out(
          'not schedulable: 정기(SCHEDULED) 모드에 등록할 수 없는 수집기(미구현 단계 또는 공식 명세 미확인). --mode VERIFICATION 만 가능',
        );
        return 7;
    }
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
