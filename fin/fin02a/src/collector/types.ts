import type { SourceAccount } from '../identity/repo';
import type { ObservationInput } from '../records/observe';
import type { SourceRun } from '../runs/repo';

/**
 * 수집기 공통 인터페이스. 인증 → 요청 → 응답 검증 → 정규화 → 대조 다섯 단계를 분리한다.
 * 구현하지 않은 단계는 예외가 아니라 NOT_IMPLEMENTED 를 명시적으로 반환해야 한다.
 * 공급자별 추정 필드는 이 공통 모델의 필수 사실이 아니다. 정규화 결과(ObservationInput.payload)는 공급자 원본 구조를
 * 그대로 담는 unknown 이며 표준 거래 모델로의 변환은 이 범위에 없다.
 */

export type StageResult<T> =
  | { status: 'OK'; value: T }
  | { status: 'NOT_IMPLEMENTED'; reason: string }
  | { status: 'FAILED'; errorCode: string; message: string };

export const notImplemented = (reason: string): StageResult<never> => ({
  status: 'NOT_IMPLEMENTED',
  reason,
});
export const failed = (errorCode: string, message: string): StageResult<never> => ({
  status: 'FAILED',
  errorCode,
  message,
});
export const ok = <T>(value: T): StageResult<T> => ({ status: 'OK', value });

/** 비밀값 제공자. 값은 호출 시점에만 메모리에 존재하며 파이프라인은 값을 저장·로그하지 않는다. */
export interface SecretProvider {
  get(name: string): string | undefined;
}

export interface CollectorContext {
  run: SourceRun;
  account: SourceAccount;
  secrets: SecretProvider;
}

/** 요청 단계 결과. bytes 는 변경 없이 원본으로 보관된다. */
export interface RawResponse {
  bytes: Uint8Array;
  contentType: string;
  request: { method: string; url: string; headers?: Record<string, string> };
  /** 원천이 응답에 기준 시각을 주면 설정, 아니면 반드시 null */
  sourceAsOf: Date | null;
}

/** 응답 검증 결과. receivedCount 는 원천이 건수를 명시한 경우에만 숫자, 아니면 null. */
export interface ValidatedResponse<Parsed> {
  parsed: Parsed;
  receivedCount: number | null;
}

export interface ReconcileSummary {
  rawCount: number | null;
  normalizedCount: number;
  detail: string;
}

export interface Collector<Auth = unknown, Parsed = unknown> {
  readonly sourceSystem: string;
  authenticate(ctx: CollectorContext): Promise<StageResult<Auth>>;
  request(ctx: CollectorContext, auth: Auth): Promise<StageResult<RawResponse>>;
  validate(
    ctx: CollectorContext,
    raw: RawResponse,
  ): Promise<StageResult<ValidatedResponse<Parsed>>>;
  normalize(
    ctx: CollectorContext,
    validated: ValidatedResponse<Parsed>,
  ): Promise<StageResult<ObservationInput[]>>;
  reconcile(
    ctx: CollectorContext,
    validated: ValidatedResponse<Parsed>,
    observations: ObservationInput[],
  ): Promise<StageResult<ReconcileSummary>>;
}
