import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { isSchedulable } from '../collector/pipeline';
import type { Queryable } from '../db/client';
import type { RunMode } from '../runs/repo';

import { createJob, listUnqueuedJobs, markQueued, type CollectionJob } from './jobs';
import type { CollectorRegistry } from './registry';

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
  /** 같은 요청 ID·같은 내용의 재전송. 큐 등록 기록이 없던 경우(응답 유실)에는 같은 jobId 로 다시 등록했음을 requeued 로 알린다 */
  | { enqueued: false; reason: 'DUPLICATE_REQUEST_ID'; job: CollectionJob; requeued: boolean }
  /** 같은 요청 ID 를 다른 계정·기간·모드·수집기로 재사용: 명시적 충돌. 새 작업도, 큐 등록도 없다 */
  | { enqueued: false; reason: 'REQUEST_ID_CONFLICT'; job: CollectionJob }
  /** DB 작업은 만들어졌으나 큐 등록이 실패함. 작업은 QUEUED/queued_at=NULL 로 남고 resyncUnqueuedJobs 가 재등록한다 */
  | { enqueued: false; reason: 'QUEUE_REGISTRATION_FAILED'; job: CollectionJob; errorClass: string }
  /** 정기(SCHEDULED) 모드에 등록할 수 없는 수집기(미구현 단계 또는 명세 미확인). DB 작업을 만들지 않는다 */
  | { enqueued: false; reason: 'NOT_SCHEDULABLE' };

const initialJobId = (requestId: string): string => `req__${safeId(requestId)}`;

async function addInitial(queue: Queue<CollectionJobData>, job: CollectionJob): Promise<void> {
  // BullMQ 는 같은 jobId 가 이미 있으면(대기·지연·완료 보관 중) 새로 추가하지 않는다. 그래서 재등록은 안전하다.
  await queue.add(
    'collect',
    { jobId: job.id, requestId: job.requestId },
    { jobId: initialJobId(job.requestId), removeOnComplete: 1000, removeOnFail: 1000 },
  );
}

const sameRequest = (a: CollectionJob, b: EnqueueInput): boolean =>
  a.sourceAccountId === b.sourceAccountId &&
  a.collectorKey === b.collectorKey &&
  a.periodFrom === b.periodFrom &&
  a.periodTo === b.periodTo &&
  a.mode === b.mode;

/**
 * 수동·정기 공통 enqueue. 순서: (정기 게이트) → DB 작업 생성(요청 ID 멱등) → 큐 등록 → queued_at 기록.
 * 실패 경계:
 * - DB 생성 성공 후 큐 등록 실패 → QUEUE_REGISTRATION_FAILED. 작업은 DB 에 남고(queued_at NULL) resyncUnqueuedJobs 로 재등록한다.
 * - 큐 등록 성공 후 응답 유실로 같은 요청이 다시 오면 → DUPLICATE_REQUEST_ID. queued_at 이 비어 있으면 같은 jobId 로 재등록(중복 없음).
 * - 같은 요청 ID 를 다른 내용으로 재사용 → REQUEST_ID_CONFLICT (거부).
 * 큐 자체의 "정확히 한 번" 은 전제하지 않는다. 중복 전달은 worker 의 작업 상태·계정 잠금·커밋 펜스가 막는다.
 */
export async function enqueueCollection(
  db: Queryable,
  queue: Queue<CollectionJobData>,
  input: EnqueueInput,
  registry?: CollectorRegistry,
): Promise<EnqueueResult> {
  if (registry && input.mode === 'SCHEDULED') {
    const c = registry.get(input.collectorKey);
    if (!c || !isSchedulable(c)) return { enqueued: false, reason: 'NOT_SCHEDULABLE' };
  }
  const r = await createJob(db, input);
  if (!r.created) {
    if (!sameRequest(r.existing, input))
      return { enqueued: false, reason: 'REQUEST_ID_CONFLICT', job: r.existing };
    let requeued = false;
    if (r.existing.status === 'QUEUED' && r.existing.queuedAt === null) {
      await addInitial(queue, r.existing);
      await markQueued(db, r.existing.id);
      requeued = true;
    }
    return { enqueued: false, reason: 'DUPLICATE_REQUEST_ID', job: r.existing, requeued };
  }
  try {
    await addInitial(queue, r.job);
  } catch (e) {
    return {
      enqueued: false,
      reason: 'QUEUE_REGISTRATION_FAILED',
      job: r.job,
      errorClass: e instanceof Error ? e.constructor.name : typeof e,
    };
  }
  await markQueued(db, r.job.id);
  return { enqueued: true, job: r.job };
}

/**
 * DB 에만 남은 작업 재등록(등록 실패·응답 유실·지연 재투입 실패). QUEUED 는 즉시, RETRY_SCHEDULED 는 next_attempt_at 까지 지연.
 * 같은 jobId 규칙을 쓰므로 실제로는 등록돼 있던 작업이라도 중복되지 않는다. 상태 전이는 없다.
 */
export async function resyncUnqueuedJobs(
  db: Queryable,
  queue: Queue<CollectionJobData>,
): Promise<{ jobId: string; requestId: string; status: string }[]> {
  const out: { jobId: string; requestId: string; status: string }[] = [];
  for (const job of await listUnqueuedJobs(db)) {
    if (job.status === 'QUEUED') await addInitial(queue, job);
    else
      await enqueueDelayed(
        queue,
        { jobId: job.id, requestId: job.requestId, attemptHint: job.attemptCount + 1 },
        `a${job.attemptCount + 1}`,
        job.nextAttemptAt ? job.nextAttemptAt.getTime() - Date.now() : 0,
      );
    await markQueued(db, job.id);
    out.push({ jobId: job.id, requestId: job.requestId, status: job.status });
  }
  return out;
}

const LIVE_STATES = new Set(['delayed', 'waiting', 'prioritized', 'active', 'waiting-children']);

/**
 * 조기 전달 처리: 예정 시각(nextAttemptAt)에 실행될 큐 항목을 보존하거나 안전하게 다시 예약한다.
 * - 원래 예약 항목(__a<attemptHint>) 이나 같은 예정 시각의 재예약 항목(__t<예정시각 ms>) 이 살아 있으면 아무것도 추가하지 않는다.
 * - 없으면 남은 대기시간(remainingMs, DB 시각 기준)으로 __t<예정시각 ms> 를 추가한다. 예정 시각이 같은 반복 조기 전달은
 *   같은 jobId 로 모여 하나만 남는다. 그 항목이 이미 소비됐으면(시계 차이로 다시 조기 도착) 시각 접미사를 붙여 한 번 더 예약한다.
 * - next_attempt_at·attempt_count·시도 이력은 건드리지 않는다(대기시간 재계산 없음).
 */
export async function ensureScheduledEntry(
  queue: Queue<CollectionJobData>,
  data: CollectionJobData,
  nextAttemptAt: Date,
  remainingMs: number,
  attemptHint: number,
): Promise<{ preserved: boolean; entryId: string }> {
  const base = initialJobId(data.requestId);
  const candidates = [`${base}__a${attemptHint}`, `${base}__t${nextAttemptAt.getTime()}`];
  for (const id of candidates) {
    const existing = await queue.getJob(id);
    if (existing && LIVE_STATES.has(await existing.getState()))
      return { preserved: true, entryId: id };
  }
  let id = candidates[1]!;
  if (await queue.getJob(id)) id = `${id}_${Date.now()}`; // 같은 예정 시각 항목이 이미 소비됨
  await queue.add(
    'collect',
    { ...data, attemptHint },
    { jobId: id, delay: Math.max(0, remainingMs), removeOnComplete: 1000, removeOnFail: 1000 },
  );
  return { preserved: false, entryId: id };
}

/** 재시도·잠금 대기 재투입(지연). jobId 에 접미사를 붙여 이전 큐 항목과 충돌하지 않게 한다. 등록 성공 후 호출자가 markQueued 한다. */
export async function enqueueDelayed(
  queue: Queue<CollectionJobData>,
  data: CollectionJobData,
  suffix: string,
  delayMs: number,
): Promise<void> {
  await queue.add('collect', data, {
    jobId: `${initialJobId(data.requestId)}__${suffix}`,
    delay: Math.max(0, delayMs),
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });
}
