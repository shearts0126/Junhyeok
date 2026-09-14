import type pg from 'pg';

import { withTx } from '../db/client';
import { getSourceAccount } from '../identity/repo';
import { storeRawObject } from '../raw/repo';
import type { RawStore } from '../raw/store';
import { observe, type ObserveSummary } from '../records/observe';
import { redactText, summarizeRequest } from '../redact';
import {
  finishRun,
  getRun,
  startRun,
  type SourceRun,
  type StageName,
  type Stages,
} from '../runs/repo';

import type { Collector, RawResponse, SecretProvider, StageResult } from './types';

export interface PipelineDeps {
  pool: pg.Pool;
  rawStore: RawStore;
  secrets: SecretProvider;
  /** 비밀값 제거 후 호출된다. 기본은 무출력 */
  log?: (line: string) => void;
}

export interface CollectionOutcome {
  run: SourceRun;
  rawObjectId: string | null;
  observations: ObserveSummary | null;
}

/**
 * 수집 실행 파이프라인.
 * 상태 규칙(네트워크 성공 ≠ 수집 완료):
 * - SUCCEEDED: 다섯 단계 전부 OK.
 * - PARTIAL: 한 단계라도 NOT_IMPLEMENTED (예: 원문 수신만 하고 파싱·대조 미구현).
 * - FAILED: 요청·검증·정규화·대조 중 실패. 원문은 수신된 경우 보관한다.
 * - BLOCKED: 인증 단계 실패 또는 미구현(자격 없음 등).
 * received_count: 정규화가 OK 이면 관측 건수(실제 0건 = 0). 그 전에 끝나면 검증 단계가 명시한 건수, 없으면 null.
 * source_as_of: 요청 단계가 준 값. 없으면 null.
 */
export async function runCollection<Auth, Parsed>(
  deps: PipelineDeps,
  collector: Collector<Auth, Parsed>,
  input: { sourceAccountId: string; periodFrom: string; periodTo: string },
): Promise<CollectionOutcome> {
  const log = (line: string): void => deps.log?.(redactText(line));
  const account = await getSourceAccount(deps.pool, input.sourceAccountId);
  if (!account) throw new Error(`원천 계정 없음: ${input.sourceAccountId}`);
  if (account.sourceSystem !== collector.sourceSystem) {
    throw new Error(
      `수집기(${collector.sourceSystem})와 계정 원천(${account.sourceSystem}) 불일치`,
    );
  }
  const run = await startRun(deps.pool, input);
  const ctx = { run, account, secrets: deps.secrets };
  const stages: Stages = {};
  let rawObjectId: string | null = null;
  let sourceAsOf: Date | null = null;
  let receivedCount: number | null = null;
  let observations: ObserveSummary | null = null;

  const finish = async (
    status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'BLOCKED',
    extra: { errorCode?: string; errorMessage?: string; note?: string } = {},
  ): Promise<CollectionOutcome> => {
    const finished = await finishRun(deps.pool, run.id, {
      status,
      stages,
      sourceAsOf,
      receivedCount,
      ...extra,
    });
    log(
      `[run ${run.id}] ${account.alias} ${status} stages=${JSON.stringify(stages)} received=${String(receivedCount)} asOf=${sourceAsOf?.toISOString() ?? 'null'}${extra.errorCode ? ` error=${extra.errorCode}` : ''}`,
    );
    return { run: finished, rawObjectId, observations };
  };

  const step = async <T>(
    name: StageName,
    fn: () => Promise<StageResult<T>>,
  ): Promise<StageResult<T>> => {
    try {
      const r = await fn();
      stages[name] = r.status;
      return r;
    } catch (e) {
      stages[name] = 'FAILED';
      return {
        status: 'FAILED',
        errorCode: `UNHANDLED_${name.toUpperCase()}`,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  };

  // 1) 인증
  const auth = await step('authenticate', () => collector.authenticate(ctx));
  if (auth.status !== 'OK') {
    markSkipped(stages, ['request', 'validate', 'normalize', 'reconcile']);
    return finish(
      'BLOCKED',
      auth.status === 'FAILED'
        ? { errorCode: auth.errorCode, errorMessage: auth.message }
        : { errorCode: 'AUTH_NOT_IMPLEMENTED', note: auth.reason },
    );
  }

  // 2) 요청 → 원문 보관(검증 전에 저장)
  const req = await step('request', () => collector.request(ctx, auth.value));
  if (req.status !== 'OK') {
    markSkipped(stages, ['validate', 'normalize', 'reconcile']);
    return req.status === 'FAILED'
      ? finish('FAILED', { errorCode: req.errorCode, errorMessage: req.message })
      : finish('BLOCKED', { errorCode: 'REQUEST_NOT_IMPLEMENTED', note: req.reason });
  }
  const raw: RawResponse = req.value;
  sourceAsOf = raw.sourceAsOf;
  const rawObject = await storeRawObject(deps.pool, deps.rawStore, {
    sourceRunId: run.id,
    bytes: raw.bytes,
    contentType: raw.contentType,
    requestSummary: summarizeRequest(raw.request.method, raw.request.url, raw.request.headers),
  });
  rawObjectId = rawObject.id;

  // 3) 응답 검증(파싱)
  const validated = await step('validate', () => collector.validate(ctx, raw));
  if (validated.status !== 'OK') {
    markSkipped(stages, ['normalize', 'reconcile']);
    return validated.status === 'FAILED'
      ? finish('FAILED', { errorCode: validated.errorCode, errorMessage: validated.message })
      : finish('PARTIAL', { note: `원문 수신·보관만 완료. 응답 검증 미구현: ${validated.reason}` });
  }
  receivedCount = validated.value.receivedCount;

  // 4) 정규화 → 관측 저장
  const normalized = await step('normalize', () => collector.normalize(ctx, validated.value));
  if (normalized.status !== 'OK') {
    markSkipped(stages, ['reconcile']);
    return normalized.status === 'FAILED'
      ? finish('FAILED', { errorCode: normalized.errorCode, errorMessage: normalized.message })
      : finish('PARTIAL', { note: `원문 수신·검증까지 완료. 정규화 미구현: ${normalized.reason}` });
  }
  observations = await withTx(deps.pool, (tx) =>
    observe(
      tx,
      { sourceAccountId: account.id, sourceRunId: run.id, rawObjectId: rawObject.id },
      normalized.value,
    ),
  );
  receivedCount = normalized.value.length;

  // 5) 대조
  const reconciled = await step('reconcile', () =>
    collector.reconcile(ctx, validated.value, normalized.value),
  );
  if (reconciled.status === 'FAILED')
    return finish('FAILED', { errorCode: reconciled.errorCode, errorMessage: reconciled.message });
  if (reconciled.status === 'NOT_IMPLEMENTED')
    return finish('PARTIAL', { note: `관측 저장까지 완료. 대조 미구현: ${reconciled.reason}` });
  return finish('SUCCEEDED', { note: reconciled.value.detail });
}

function markSkipped(stages: Stages, names: StageName[]): void {
  for (const n of names) stages[n] = 'SKIPPED';
}

export { getRun };
