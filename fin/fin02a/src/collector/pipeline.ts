import type pg from 'pg';

import { withTx } from '../db/client';
import { getSourceAccount } from '../identity/repo';
import { insertRawObject, putRawBytes } from '../raw/repo';
import type { RawStore } from '../raw/store';
import { observe, type ObserveSummary } from '../records/observe';
import { buildRequestSummary, findTokenField, isCode, reflectsCredential } from '../redact';
import {
  finishRun,
  startRun,
  type FinishRunInput,
  type SourceRun,
  type StageName,
  type Stages,
} from '../runs/repo';

import type { Collector, FailureKind, RawResponse, SecretProvider, StageResult } from './types';

export interface PipelineDeps {
  pool: pg.Pool;
  rawStore: RawStore;
  secrets: SecretProvider;
  /** 실행 ID·상태·코드만 담긴 고정 형식 한 줄. 외부 문자열은 포함되지 않는다 */
  log?: (line: string) => void;
}

export interface CollectionOutcome {
  runId: string;
  /** 종료 상태가 DB 에 기록됐는지. false 면 RUNNING 으로 남아 복구 대상(recovery.listUnfinishedRuns) */
  finalized: boolean;
  /** finalized=false 일 때: 원래 실패 코드와 종료 기록 실패의 예외 클래스 */
  unrecordedFailure?: { originalErrorCode: string; finishErrorClass: string };
  /** 마지막으로 알고 있는 실행 상태(finalized=false 면 시작 시점 값) */
  run: SourceRun;
  rawObjectId: string | null;
  observations: ObserveSummary | null;
}

/** 이번 실행에서 읽은 비밀값을 메모리에만 기억한다(응답 반사 검사용). 저장·로그하지 않는다. */
class TrackingSecrets implements SecretProvider {
  private readonly used = new Set<string>();
  constructor(private readonly inner: SecretProvider) {}
  get(name: string): string | undefined {
    const v = this.inner.get(name);
    if (v !== undefined && v !== '') this.used.add(v);
    return v;
  }
  values(): string[] {
    return [...this.used];
  }
}

/**
 * 수집 실행 파이프라인. 순서: 인증 → 요청 → 원본 보관 → 검증 → 정규화 → 대조 → (관측 저장 + SUCCEEDED 기록, 단일 트랜잭션).
 *
 * 상태 규칙:
 * - BLOCKED: 인증 단계 FAILED(자격·권한 부족). failure_kind=CREDENTIALS.
 * - PARTIAL: 어떤 단계든 NOT_IMPLEMENTED. stages 에 해당 단계와 코드 명시. failure_kind=NOT_IMPLEMENTED. 관측은 저장하지 않는다.
 * - FAILED: 실제 실행·파싱·저장·대조 실패. failure_kind 로 원인 구분. 수신된 원본은 보관한다.
 * - SUCCEEDED: 다섯 단계 OK 이고 관측 저장이 커밋됨. 대조를 통과한 데이터만 최신 관측이 된다.
 * 네트워크 요청 성공만으로 SUCCEEDED 가 되지 않는다.
 *
 * 오류 경계: 실행 생성 이후 전체를 감싼다. 원본 바이트 저장 실패(RAW_STORE_FAILED), 메타데이터 저장 실패(RAW_META_FAILED),
 * 관측 트랜잭션 실패(OBSERVE_STORE_FAILED)를 구분해 FAILED/STORAGE 로 기록한다. 종료 기록 자체가 실패하면 finalized=false 로
 * 돌려주고 복구 대상으로 남긴다. 프로세스 강제 종료는 이 경계로 해결되지 않으며 recovery.ts 절차가 담당한다.
 */
export async function runCollection<Auth, Parsed>(
  deps: PipelineDeps,
  collector: Collector<Auth, Parsed>,
  input: { sourceAccountId: string; periodFrom: string; periodTo: string },
): Promise<CollectionOutcome> {
  const account = await getSourceAccount(deps.pool, input.sourceAccountId);
  if (!account) throw new Error(`원천 계정 없음: ${input.sourceAccountId}`);
  if (account.sourceSystem !== collector.sourceSystem) {
    throw new Error(
      `수집기(${collector.sourceSystem})와 계정 원천(${account.sourceSystem}) 불일치`,
    );
  }
  const run = await startRun(deps.pool, input);
  const secrets = new TrackingSecrets(deps.secrets);
  const ctx = { run, account, secrets };
  const stages: Stages = {};
  let rawObjectId: string | null = null;
  let sourceAsOf: Date | null = null;
  let receivedCount: number | null = null;

  const log = (status: string, code?: string): void =>
    deps.log?.(
      `run=${run.id} account=${account.alias} status=${status}${code ? ` code=${code}` : ''} stages=${JSON.stringify(stages)} received=${String(receivedCount)}`,
    );

  const finish = async (
    status: Exclude<FinishRunInput['status'], 'SUCCEEDED'>,
    err?: { code: string; kind: FailureKind; errorClass?: string },
    note?: string,
  ): Promise<CollectionOutcome> => {
    const payload: FinishRunInput = { status, stages, sourceAsOf, receivedCount };
    if (err) {
      payload.errorCode = err.code;
      payload.failureKind = err.kind;
      if (err.errorClass !== undefined) payload.errorClass = err.errorClass;
    }
    if (note !== undefined) payload.note = note;
    try {
      const finished = await finishRun(deps.pool, run.id, payload);
      log(status, err?.code);
      return { runId: run.id, finalized: true, run: finished, rawObjectId, observations: null };
    } catch (e) {
      const finishErrorClass = className(e);
      deps.log?.(
        `run=${run.id} account=${account.alias} status=UNRECORDED original=${err?.code ?? status} finishError=${finishErrorClass}`,
      );
      return {
        runId: run.id,
        finalized: false,
        unrecordedFailure: { originalErrorCode: err?.code ?? status, finishErrorClass },
        run,
        rawObjectId,
        observations: null,
      };
    }
  };

  type StepResult<T> = StageResult<T> & { errorClass?: string };
  const step = async <T>(
    name: StageName,
    fn: () => Promise<StageResult<T>>,
  ): Promise<StepResult<T>> => {
    try {
      const r = await fn();
      if (r.status === 'OK') stages[name] = { outcome: 'OK' };
      else if (r.status === 'NOT_IMPLEMENTED')
        stages[name] = {
          outcome: 'NOT_IMPLEMENTED',
          code: isCode(r.code) ? r.code : 'INVALID_CODE',
        };
      else
        stages[name] = {
          outcome: 'FAILED',
          code: isCode(r.errorCode) ? r.errorCode : 'INVALID_ERROR_CODE',
        };
      return r;
    } catch (e) {
      // 외부 예외 메시지는 영속화·로그하지 않는다. 클래스 이름만 남긴다.
      const code = `UNHANDLED_${name.toUpperCase()}`;
      stages[name] = { outcome: 'FAILED', code };
      return { status: 'FAILED', errorCode: code, kind: 'UNKNOWN', errorClass: className(e) };
    }
  };
  const skip = (...names: StageName[]): void => {
    for (const n of names) stages[n] = { outcome: 'SKIPPED' };
  };

  try {
    // 1) 인증
    const auth = await step('authenticate', () => collector.authenticate(ctx));
    if (auth.status === 'NOT_IMPLEMENTED') {
      skip('request', 'validate', 'normalize', 'reconcile');
      return finish(
        'PARTIAL',
        { code: 'AUTH_NOT_IMPLEMENTED', kind: 'NOT_IMPLEMENTED' },
        '인증 단계 미구현',
      );
    }
    if (auth.status === 'FAILED') {
      skip('request', 'validate', 'normalize', 'reconcile');
      return finish(
        'BLOCKED',
        {
          code: auth.errorCode,
          kind: auth.kind === 'UNKNOWN' ? 'UNKNOWN' : 'CREDENTIALS',
          ...errClass(auth),
        },
        '인증 실패(자격·권한)',
      );
    }

    // 2) 요청
    const req = await step('request', () => collector.request(ctx, auth.value));
    if (req.status === 'NOT_IMPLEMENTED') {
      skip('validate', 'normalize', 'reconcile');
      return finish(
        'PARTIAL',
        { code: 'REQUEST_NOT_IMPLEMENTED', kind: 'NOT_IMPLEMENTED' },
        '요청 단계 미구현',
      );
    }
    if (req.status === 'FAILED') {
      skip('validate', 'normalize', 'reconcile');
      return finish(
        'FAILED',
        { code: req.errorCode, kind: req.kind, ...errClass(req) },
        '외부 요청 실패',
      );
    }
    const raw: RawResponse = req.value;
    sourceAsOf = raw.sourceAsOf;

    // 2a) 비밀값 경계: 요청 요약 템플릿 검증, 인증값 반사·토큰 필드 검사. 위반 시 원본을 저장하지 않는다.
    // 구조적 검사: 수집기가 상수로 선언한 템플릿과 정확히 일치해야 하고, 형태 규칙(쿼리·값 금지)을 만족해야 하며,
    // 이번 실행에서 읽은 비밀값이 템플릿 안에 있으면 안 된다. 정규식 탐지가 아니라 선언된 상수와의 일치가 근거다.
    const summary =
      collector.endpointTemplates.includes(raw.endpoint) &&
      !secrets.values().some((v) => v.length >= 4 && raw.endpoint.includes(v))
        ? buildRequestSummary(collector.sourceSystem, raw.endpoint)
        : null;
    if (!summary) {
      skip('validate', 'normalize', 'reconcile');
      return finish(
        'FAILED',
        { code: 'REQUEST_SUMMARY_INVALID', kind: 'PERMANENT' },
        '요청 요약 템플릿 위반으로 원본 미저장',
      );
    }
    if (reflectsCredential(raw.bytes, secrets.values())) {
      skip('validate', 'normalize', 'reconcile');
      return finish(
        'FAILED',
        { code: 'RAW_CONTAINS_CREDENTIAL', kind: 'PERMANENT' },
        '응답에 인증값 반사, 원본 미저장',
      );
    }
    if (/json/i.test(raw.contentType)) {
      const field = tryParseJson(raw.bytes);
      if (field !== undefined && findTokenField(field) !== null) {
        skip('validate', 'normalize', 'reconcile');
        return finish(
          'FAILED',
          { code: 'RAW_TOKEN_FIELD', kind: 'PERMANENT' },
          '응답에 토큰 필드, 원본 미저장',
        );
      }
    }

    // 2b) 원본 보관: 바이트(변경 없음) → 메타데이터. 실패를 구분한다.
    let stored: { sha256: string; storageKey: string };
    try {
      stored = await putRawBytes(deps.rawStore, run.id, raw.bytes);
    } catch (e) {
      skip('validate', 'normalize', 'reconcile');
      return finish(
        'FAILED',
        { code: 'RAW_STORE_FAILED', kind: 'STORAGE', errorClass: className(e) },
        '원본 바이트 저장 실패',
      );
    }
    try {
      const rawObject = await insertRawObject(deps.pool, {
        sourceRunId: run.id,
        ...stored,
        byteSize: raw.bytes.byteLength,
        contentType: raw.contentType,
        requestSummary: summary,
      });
      rawObjectId = rawObject.id;
    } catch (e) {
      skip('validate', 'normalize', 'reconcile');
      return finish(
        'FAILED',
        { code: 'RAW_META_FAILED', kind: 'STORAGE', errorClass: className(e) },
        `원본 메타데이터 저장 실패, 고아 원본 후보 키 ${stored.storageKey}`,
      );
    }
    const storedRawObjectId = rawObjectId;

    // 3) 응답 검증(파싱)
    const validated = await step('validate', () => collector.validate(ctx, raw));
    if (validated.status === 'NOT_IMPLEMENTED') {
      skip('normalize', 'reconcile');
      return finish(
        'PARTIAL',
        { code: 'VALIDATE_NOT_IMPLEMENTED', kind: 'NOT_IMPLEMENTED' },
        '원문 수신·보관만 완료, 응답 검증 미구현',
      );
    }
    if (validated.status === 'FAILED') {
      skip('normalize', 'reconcile');
      return finish(
        'FAILED',
        { code: validated.errorCode, kind: validated.kind, ...errClass(validated) },
        '응답 검증 실패, 원문은 보관',
      );
    }
    receivedCount = validated.value.receivedCount;

    // 4) 정규화
    const normalized = await step('normalize', () => collector.normalize(ctx, validated.value));
    if (normalized.status === 'NOT_IMPLEMENTED') {
      skip('reconcile');
      return finish(
        'PARTIAL',
        { code: 'NORMALIZE_NOT_IMPLEMENTED', kind: 'NOT_IMPLEMENTED' },
        '원문 수신·검증까지 완료, 정규화 미구현',
      );
    }
    if (normalized.status === 'FAILED') {
      skip('reconcile');
      return finish(
        'FAILED',
        { code: normalized.errorCode, kind: normalized.kind, ...errClass(normalized) },
        '정규화 실패, 원문은 보관',
      );
    }

    // 5) 대조 — 통과한 데이터만 관측으로 반영한다.
    const reconciled = await step('reconcile', () =>
      collector.reconcile(ctx, validated.value, normalized.value),
    );
    if (reconciled.status === 'NOT_IMPLEMENTED') {
      return finish(
        'PARTIAL',
        { code: 'RECONCILE_NOT_IMPLEMENTED', kind: 'NOT_IMPLEMENTED' },
        '대조 미구현, 최신 관측 미갱신',
      );
    }
    if (reconciled.status === 'FAILED') {
      return finish(
        'FAILED',
        { code: reconciled.errorCode, kind: reconciled.kind, ...errClass(reconciled) },
        '대조 실패, 최신 관측 미갱신',
      );
    }

    // 6) 관측 저장 + SUCCEEDED 기록을 한 트랜잭션으로.
    receivedCount = normalized.value.length;
    let observations: ObserveSummary;
    let finished: SourceRun;
    try {
      const committed = await withTx(deps.pool, async (tx) => {
        const obs = await observe(
          tx,
          { sourceAccountId: account.id, sourceRunId: run.id, rawObjectId: storedRawObjectId },
          normalized.value,
        );
        const fin = await finishRun(tx, run.id, {
          status: 'SUCCEEDED',
          stages,
          sourceAsOf,
          receivedCount,
          note: '관측 저장 및 대조 완료',
        });
        return { obs, fin };
      });
      observations = committed.obs;
      finished = committed.fin;
    } catch (e) {
      return finish(
        'FAILED',
        { code: 'OBSERVE_STORE_FAILED', kind: 'STORAGE', errorClass: className(e) },
        '관측 저장 트랜잭션 실패(롤백)',
      );
    }
    log('SUCCEEDED');
    return { runId: run.id, finalized: true, run: finished, rawObjectId, observations };
  } catch (e) {
    return finish(
      'FAILED',
      { code: 'UNHANDLED_PIPELINE', kind: 'UNKNOWN', errorClass: className(e) },
      '파이프라인 예외',
    );
  }
}

function className(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

function errClass(r: { errorClass?: string }): { errorClass?: string } {
  return r.errorClass === undefined ? {} : { errorClass: r.errorClass };
}

function tryParseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
