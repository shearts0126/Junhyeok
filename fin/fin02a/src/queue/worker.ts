import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import type pg from 'pg';

import { runCollection, type CollectionOutcome } from '../collector/pipeline';
import type { SecretProvider } from '../collector/types';
import type { RawStore } from '../raw/store';

import {
  beginAttempt,
  bindAttemptRun,
  finishAttempt,
  getJob,
  markQueued,
  remainingUntilDue,
  requeueJob,
  setJobStatusFenced,
} from './jobs';
import { acquireLease, bindLeaseRun, heartbeat, releaseLease } from './lease';
import { enqueueDelayed, ensureScheduledEntry, QUEUE_NAME, type CollectionJobData } from './queue';
import type { CollectorRegistry } from './registry';
import { DEFAULT_RETRY_POLICY, decide, type RetryPolicy } from './retry';
import type { Queue } from 'bullmq';

export interface WorkerDeps {
  pool: pg.Pool;
  rawStore: RawStore;
  secrets: SecretProvider;
  registry: CollectorRegistry;
  queue: Queue<CollectionJobData>;
  connection: IORedis;
  workerId: string;
  /** heartbeat 간격(기본 30초) */
  heartbeatMs?: number;
  /** 같은 계정 잠금이 잡혀 있을 때 재투입 대기(기본 15초) */
  lockWaitMs?: number;
  retry?: RetryPolicy;
  concurrency?: number;
  prefix?: string;
  /** 실행 ID·상태·코드만 담긴 한 줄. 예외는 격리된다 */
  log?: (line: string) => void;
}

export type ProcessResult =
  | {
      kind: 'DONE';
      jobId: string;
      runId: string;
      jobStatus: string;
      retryScheduled: boolean;
      logFailed: boolean;
    }
  /** LOCK_HELD: 계정 잠금 대기. NOT_DUE: 재시도 예정 시각 이전 조기 전달(예약 보존·재예약, 시도 수 불변) */
  | { kind: 'DEFERRED'; jobId: string; reason: 'LOCK_HELD' }
  | { kind: 'DEFERRED'; jobId: string; reason: 'NOT_DUE'; nextAttemptAt: Date; preserved: boolean }
  | {
      kind: 'SKIPPED';
      jobId: string;
      reason:
        'JOB_NOT_FOUND' | 'JOB_NOT_STARTABLE' | 'COLLECTOR_NOT_REGISTERED' | 'INVALID_SCHEDULE';
    };

/**
 * 큐 작업 처리기(순수 함수에 가깝게 분리해 시험에서 직접 호출 가능).
 *
 * 순서: 작업 조회 → 시작 가능 상태 확인 → 수집기 등록 확인 → 계정 잠금 획득(실패 시 지연 재투입, 시도 수 미포함)
 *      → 시도 시작 → runCollection(실행 ID 생기면 시도·잠금에 연결) → 결과에 따른 작업 상태(펜스) → 잠금 해제.
 * 큐 전달 보장은 "정확히 한 번" 이 아니다. 중복 전달은 (a) 작업 상태(QUEUED/RETRY_SCHEDULED 만 시작), (b) 계정 잠금,
 * (c) 관측 커밋 펜스(잠금 세대), (d) 작업 상태 펜스(current_run_id) 네 겹으로 막는다.
 * 완료된(또는 RUNNING 으로 남은) 작업이 다시 전달되면 (a) 에서 SKIPPED 로 끝나며 외부 요청은 시작되지 않는다.
 * worker 가 시도 저장 후 중단되면 작업은 RUNNING, 잠금은 미해제로 남는다. 자동 정리는 없고 recovery close(담당자 확인)가
 * 실행·잠금·작업·시도를 한 트랜잭션으로 닫는다.
 */
export async function processCollectionJob(
  deps: WorkerDeps,
  data: CollectionJobData,
): Promise<ProcessResult> {
  const safeLog = (line: string): boolean => {
    try {
      deps.log?.(line);
      return true;
    } catch {
      return false;
    }
  };
  const job = await getJob(deps.pool, data.jobId);
  if (!job) return { kind: 'SKIPPED', jobId: data.jobId, reason: 'JOB_NOT_FOUND' };
  if (job.status !== 'QUEUED' && job.status !== 'RETRY_SCHEDULED')
    return { kind: 'SKIPPED', jobId: job.id, reason: 'JOB_NOT_STARTABLE' };
  if (job.status === 'RETRY_SCHEDULED' && job.nextAttemptAt === null)
    return { kind: 'SKIPPED', jobId: job.id, reason: 'INVALID_SCHEDULE' }; // 즉시 실행으로 해석하지 않는다
  // 사전 확인(DB 시각 기준): 예정 시각 전이면 잠금·외부 요청 없이 예약을 보존하고 끝낸다. 최종 방어는 beginAttempt.
  const due = await remainingUntilDue(deps.pool, job.id);
  if (due && due.remainingMs > 0 && due.nextAttemptAt)
    return await deferNotDue(deps, job, data, due.nextAttemptAt, due.remainingMs);
  const collector = deps.registry.get(job.collectorKey);
  if (!collector) {
    // 외부 요청 없이 거부. 실행 ID 없이 시도 이력만 남긴다.
    const lease0 = await acquireLease(deps.pool, {
      sourceAccountId: job.sourceAccountId,
      workerId: deps.workerId,
      jobId: job.id,
    });
    if (!lease0) return await defer(deps, job.id, data);
    try {
      const a = await beginAttempt(deps.pool, {
        jobId: job.id,
        workerId: deps.workerId,
        generation: lease0.generation,
      });
      if (!a.ok) return await afterStartRefused(deps, job, data, a.reason, a.nextAttemptAt, lease0);
      await finishAttempt(deps.pool, a.attemptId, {
        outcome: 'COLLECTOR_NOT_REGISTERED',
        failureKind: 'PERMANENT',
        errorCode: 'COLLECTOR_NOT_REGISTERED',
      });
      await deps.pool.query(
        `UPDATE fin_collection_jobs SET status = 'FAILED', updated_at = now() WHERE id = $1 AND status = 'RUNNING'`,
        [job.id],
      );
    } finally {
      await releaseLease(deps.pool, lease0, 'collector-not-registered');
    }
    return { kind: 'SKIPPED', jobId: job.id, reason: 'COLLECTOR_NOT_REGISTERED' };
  }

  const lease = await acquireLease(deps.pool, {
    sourceAccountId: job.sourceAccountId,
    workerId: deps.workerId,
    jobId: job.id,
  });
  if (!lease) return await defer(deps, job.id, data);

  // 시작 확정(최종 방어): 조건부 UPDATE. 거부되면 자기 잠금만 해제하고 외부 요청 없이 끝낸다. DB 오류는 전파된다.
  const started = await beginAttempt(deps.pool, {
    jobId: job.id,
    workerId: deps.workerId,
    generation: lease.generation,
  });
  if (!started.ok)
    return await afterStartRefused(deps, job, data, started.reason, started.nextAttemptAt, lease);
  const attempt = { attemptNo: started.attemptNo, attemptId: started.attemptId };

  const hb = setInterval(() => {
    heartbeat(deps.pool, lease).then(
      (ok) => {
        if (!ok)
          safeLog(
            `worker=${deps.workerId} job=${job.id} heartbeat=LOST generation=${lease.generation}`,
          );
      },
      () => safeLog(`worker=${deps.workerId} job=${job.id} heartbeat=ERROR`),
    );
  }, deps.heartbeatMs ?? 30_000);
  hb.unref();

  let outcome: CollectionOutcome;
  try {
    outcome = await runCollection(
      {
        pool: deps.pool,
        rawStore: deps.rawStore,
        secrets: deps.secrets,
        ...(deps.log ? { log: deps.log } : {}),
      },
      collector,
      {
        sourceAccountId: job.sourceAccountId,
        periodFrom: job.periodFrom,
        periodTo: job.periodTo,
        mode: job.mode,
        lease,
        jobId: job.id,
        onRunStarted: async (runId) => {
          await bindAttemptRun(deps.pool, { jobId: job.id, attemptId: attempt.attemptId, runId });
          await bindLeaseRun(deps.pool, lease, runId);
        },
      },
    );
  } finally {
    clearInterval(hb);
  }

  let jobStatus: string;
  let retryScheduled = false;
  try {
    if (!outcome.finalized) {
      await finishAttempt(deps.pool, attempt.attemptId, {
        outcome: 'UNRECORDED',
        errorCode: outcome.unrecordedFailure?.originalErrorCode ?? null,
      });
      await setJobStatusFenced(deps.pool, {
        jobId: job.id,
        expectedRunId: outcome.runId,
        status: 'NEEDS_REVIEW',
      });
      jobStatus = 'NEEDS_REVIEW';
    } else {
      const d = decide(
        deps.retry ?? DEFAULT_RETRY_POLICY,
        outcome.run,
        attempt.attemptNo,
        outcome.retryAfterMs,
      );
      await finishAttempt(deps.pool, attempt.attemptId, {
        outcome: outcome.run.errorCode === 'OWNERSHIP_LOST' ? 'OWNERSHIP_LOST' : outcome.run.status,
        failureKind: outcome.run.failureKind,
        errorCode: outcome.run.errorCode,
        retryScheduled: d.action === 'RETRY',
      });
      if (d.action === 'RETRY') {
        const nextAt = new Date(Date.now() + d.delayMs);
        const fenced = await setJobStatusFenced(deps.pool, {
          jobId: job.id,
          expectedRunId: outcome.runId,
          status: 'RETRY_SCHEDULED',
          nextAttemptAt: nextAt,
        });
        if (fenced) {
          // 지연 재투입 등록이 실패하면 RETRY_SCHEDULED/queued_at NULL 로 남아 enqueue --resync 대상이 된다(예외는 호출자에게 전파).
          await enqueueDelayed(
            deps.queue,
            { jobId: job.id, requestId: job.requestId, attemptHint: attempt.attemptNo + 1 },
            `a${attempt.attemptNo + 1}`,
            d.delayMs,
          );
          await markQueued(deps.pool, job.id);
        }
        retryScheduled = fenced;
        jobStatus = 'RETRY_SCHEDULED';
      } else {
        await setJobStatusFenced(deps.pool, {
          jobId: job.id,
          expectedRunId: outcome.runId,
          status: d.jobStatus,
        });
        jobStatus = d.jobStatus;
      }
    }
  } finally {
    await releaseLease(deps.pool, lease, 'done');
  }
  const logOk = safeLog(
    `worker=${deps.workerId} job=${job.id} run=${outcome.runId} attempt=${attempt.attemptNo} run_status=${outcome.run.status} job_status=${jobStatus} retry=${retryScheduled}`,
  );
  return {
    kind: 'DONE',
    jobId: job.id,
    runId: outcome.runId,
    jobStatus,
    retryScheduled,
    logFailed: outcome.logFailed || !logOk,
  };
}

/** 잠금 획득 후 시작 확정이 거부된 경우: 자기 worker_id·generation 잠금만 해제하고 사유별로 처리한다. */
async function afterStartRefused(
  deps: WorkerDeps,
  job: { id: string; requestId: string; attemptCount: number },
  data: CollectionJobData,
  reason: 'NOT_STARTABLE' | 'NOT_DUE' | 'INVALID_SCHEDULE',
  nextAttemptAt: Date | null,
  lease: Parameters<typeof releaseLease>[1],
): Promise<ProcessResult> {
  await releaseLease(deps.pool, lease, reason === 'NOT_DUE' ? 'not-due' : 'not-startable');
  if (reason === 'NOT_DUE' && nextAttemptAt) {
    const due = await remainingUntilDue(deps.pool, job.id);
    return await deferNotDue(deps, job, data, nextAttemptAt, due?.remainingMs ?? 0);
  }
  return {
    kind: 'SKIPPED',
    jobId: job.id,
    reason: reason === 'INVALID_SCHEDULE' ? 'INVALID_SCHEDULE' : 'JOB_NOT_STARTABLE',
  };
}

/**
 * 조기 전달: 예정 시각 전에 도착한 전달은 시도·외부 요청 없이 끝내고, 예정 시각에 실행될 큐 항목을 보존하거나 남은
 * 대기시간으로 다시 예약한다. next_attempt_at 은 덮어쓰지 않는다(대기시간 재계산·연장 없음). worker 안에서 기다리지 않는다.
 */
async function deferNotDue(
  deps: WorkerDeps,
  job: { id: string; requestId: string; attemptCount: number },
  data: CollectionJobData,
  nextAttemptAt: Date,
  remainingMs: number,
): Promise<ProcessResult> {
  const r = await ensureScheduledEntry(
    deps.queue,
    { jobId: job.id, requestId: job.requestId },
    nextAttemptAt,
    remainingMs,
    job.attemptCount + 1,
  );
  await markQueued(deps.pool, job.id);
  return {
    kind: 'DEFERRED',
    jobId: job.id,
    reason: 'NOT_DUE',
    nextAttemptAt,
    preserved: r.preserved,
  };
}

async function defer(
  deps: WorkerDeps,
  jobId: string,
  data: CollectionJobData,
): Promise<ProcessResult> {
  // 잠금 대기: 시도를 시작하지 않았으므로 attempt_count 와 시도 이력은 그대로다(재시도 횟수를 소진하지 않는다).
  const wait = deps.lockWaitMs ?? 15_000;
  await requeueJob(deps.pool, jobId, new Date(Date.now() + wait));
  await enqueueDelayed(deps.queue, data, `w${Date.now()}`, wait);
  await markQueued(deps.pool, jobId);
  return { kind: 'DEFERRED', jobId, reason: 'LOCK_HELD' };
}

/** BullMQ Worker 생성(별도 프로세스 scripts/worker.ts 또는 시험에서 in-process). */
export function createCollectionWorker(deps: WorkerDeps): Worker<CollectionJobData, ProcessResult> {
  return new Worker<CollectionJobData, ProcessResult>(
    QUEUE_NAME,
    (job: Job<CollectionJobData>) => processCollectionJob(deps, job.data),
    {
      connection: deps.connection,
      prefix: deps.prefix ?? 'fin02a',
      concurrency: deps.concurrency ?? 2,
      // BullMQ 자체 재시도는 쓰지 않는다(재시도는 DB 시도 이력과 새 실행 ID 로 관리).
    },
  );
}
