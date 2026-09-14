import type { FailureKind } from '../collector/types';
import type { RunStatus } from '../runs/repo';

import type { JobStatus } from './jobs';

/**
 * 재시도 정책(개발 기본값).
 * - TRANSIENT 만 자동 재시도. 최초 실행 포함 최대 3회. 대기 1분, 5분. 공급자 Retry-After(retryAfterMs)가 있으면 우선.
 * - CREDENTIALS·NOT_IMPLEMENTED·PERMANENT: 자동 재시도 없음.
 * - STORAGE·UNKNOWN: 자동 재시도 없이 NEEDS_REVIEW(결과 확인 대상).
 * 재시도마다 새 수집 실행 ID 가 만들어지고 같은 작업의 시도 이력으로 연결된다(worker.ts).
 */
export interface RetryPolicy {
  maxAttempts: number;
  delaysMs: readonly number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, delaysMs: [60_000, 300_000] };

export type Decision =
  | { action: 'RETRY'; delayMs: number; jobStatus: 'RETRY_SCHEDULED' }
  | { action: 'STOP'; jobStatus: Exclude<JobStatus, 'QUEUED' | 'RUNNING' | 'RETRY_SCHEDULED'> };

export function decide(
  policy: RetryPolicy,
  run: { status: RunStatus; failureKind: FailureKind | null; errorCode: string | null },
  attemptNo: number,
  retryAfterMs?: number,
): Decision {
  if (run.status === 'SUCCEEDED') return { action: 'STOP', jobStatus: 'SUCCEEDED' };
  if (run.status === 'PARTIAL') return { action: 'STOP', jobStatus: 'PARTIAL' };
  if (run.status === 'BLOCKED') return { action: 'STOP', jobStatus: 'BLOCKED' };
  // FAILED
  if (run.errorCode === 'OWNERSHIP_LOST') return { action: 'STOP', jobStatus: 'NEEDS_REVIEW' };
  switch (run.failureKind) {
    case 'TRANSIENT': {
      if (attemptNo >= policy.maxAttempts) return { action: 'STOP', jobStatus: 'FAILED' };
      const base =
        policy.delaysMs[attemptNo - 1] ?? policy.delaysMs[policy.delaysMs.length - 1] ?? 60_000;
      return {
        action: 'RETRY',
        delayMs: retryAfterMs !== undefined ? Math.max(retryAfterMs, 0) : base,
        jobStatus: 'RETRY_SCHEDULED',
      };
    }
    case 'PERMANENT':
    case 'CREDENTIALS':
    case 'NOT_IMPLEMENTED':
      return {
        action: 'STOP',
        jobStatus: run.failureKind === 'CREDENTIALS' ? 'BLOCKED' : 'FAILED',
      };
    case 'STORAGE':
    case 'UNKNOWN':
    default:
      return { action: 'STOP', jobStatus: 'NEEDS_REVIEW' };
  }
}
