import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import type { Queryable } from '../db/client';
import type { RunMode } from '../runs/repo';

import { createJob, type CollectionJob } from './jobs';

export const QUEUE_NAME = 'fin02a-collection';

/** BullMQ 사용자 지정 jobId 는 ':' 를 허용하지 않는다. 요청 ID 의 비허용 문자를 '_' 로 바꾼다(DB 의 request_id 는 원문 유지). */
export function safeId(requestId: string): string {
  return requestId.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export interface CollectionJobData {
  jobId: string;
  requestId: string;
  /** 재시도·잠금 대기 재투입 시 구분용 */
  attemptHint?: number;
}

export function createRedis(url: string): IORedis {
  // BullMQ 요구사항: maxRetriesPerRequest null
  return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export function createQueue(connection: IORedis, prefix = 'fin02a'): Queue<CollectionJobData> {
  return new Queue<CollectionJobData>(QUEUE_NAME, { connection, prefix });
}

export interface EnqueueInput {
  requestId: string;
  sourceAccountId: string;
  collectorKey: string;
  periodFrom: string;
  periodTo: string;
  mode: RunMode;
  maxAttempts?: number;
}

export type EnqueueResult =
  | { enqueued: true; job: CollectionJob }
  | { enqueued: false; reason: 'DUPLICATE_REQUEST_ID'; job: CollectionJob };

/**
 * 수동·정기 공통 enqueue. 요청 ID 로 DB 에 멱등 생성한 뒤에만 큐에 넣는다.
 * 같은 요청 ID 재전송: DB UNIQUE 로 거부(중복 작업 없음). BullMQ jobId 도 요청 ID 라 큐 단계에서도 중복되지 않는다.
 * 의도한 재수집은 새 요청 ID 로 허용된다.
 */
export async function enqueueCollection(
  db: Queryable,
  queue: Queue<CollectionJobData>,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  const r = await createJob(db, input);
  if (!r.created) return { enqueued: false, reason: 'DUPLICATE_REQUEST_ID', job: r.existing };
  await queue.add(
    'collect',
    { jobId: r.job.id, requestId: input.requestId },
    { jobId: `req__${safeId(input.requestId)}`, removeOnComplete: 1000, removeOnFail: 1000 },
  );
  return { enqueued: true, job: r.job };
}

/** 재시도·잠금 대기 재투입(지연). jobId 에 접미사를 붙여 이전 큐 항목과 충돌하지 않게 한다. */
export async function enqueueDelayed(
  queue: Queue<CollectionJobData>,
  data: CollectionJobData,
  suffix: string,
  delayMs: number,
): Promise<void> {
  await queue.add('collect', data, {
    jobId: `req__${safeId(data.requestId)}__${suffix}`,
    delay: Math.max(0, delayMs),
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });
}
