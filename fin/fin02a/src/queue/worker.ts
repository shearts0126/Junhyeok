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
  requeueJob,
  setJobStatusFenced,
} from './jobs';
import { acquireLease, bindLeaseRun, heartbeat, releaseLease } from './lease';
import { enqueueDelayed, QUEUE_NAME, type CollectionJobData } from './queue';
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
  | { kind: 'DEFERRED'; jobId: string; reason: 'LOCK_HELD' }
  | {
      kind: 'SKIPPED';
      jobId: string;
      reason: 'JOB_NOT_FOUND' | 'JOB_NOT_STARTABLE' | 'COLLECTOR_NOT_REGISTERED';
    };

/**
 * 큐 작업 처리기(순수 함수에 가깝게 분리해 시험에서 직접 호출 가능).
 *
 * 순서: 작업 조회 → 시작 가능 상태 확인 → 수집기 등록 확인 → 계정 잠금 획득(실패 시 지연 재투입, 시도 수 미포함)
 *      → 시도 시작 → runCollection(실행 ID 생기면 시도·잠금에 연결) → 결과에 따른 작업 상태(펜스) → 잠금 해제.
 * 큐 전달 보장은 "정확히 한 번" 이 아니다. 중복 전달은 (a) 작업 상태(QUEUED/RETRY_SCHEDULED 만 시작), (b) 계정 잠금,
 * (c) 관측 커밋 펜스(잠금 세대), (d) 작업 상태 펜스(current_run_id) 네 겹으로 막는다.
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

  let attempt: { attemptNo: number; attemptId: string };
  try {
    attempt = await beginAttempt(deps.pool, {
      jobId: job.id,
      workerId: deps.workerId,
      generation: lease.generation,
    });
  } catch {
    await releaseLease(deps.pool, lease, 'not-startable');
    return { kind: 'SKIPPED', jobId: job.id, reason: 'JOB_NOT_STARTABLE' };
  }

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
        if (fenced)
          await enqueueDelayed(
            deps.queue,
            { jobId: job.id, requestId: job.requestId, attemptHint: attempt.attemptNo + 1 },
            `a${attempt.attemptNo + 1}`,
            d.delayMs,
          );
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

async function defer(
  deps: WorkerDeps,
  jobId: string,
  data: CollectionJobData,
): Promise<ProcessResult> {
  const wait = deps.lockWaitMs ?? 15_000;
  await requeueJob(deps.pool, jobId, new Date(Date.now() + wait));
  await enqueueDelayed(deps.queue, data, `w${Date.now()}`, wait);
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
