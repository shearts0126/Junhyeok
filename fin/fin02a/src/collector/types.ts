import type { SourceAccount } from '../identity/repo';
import type { ObservationInput } from '../records/observe';
import type { SourceRun } from '../runs/repo';

/**
 * 수집기 공통 인터페이스. 인증 → 요청 → 응답 검증 → 정규화 → 대조 다섯 단계를 분리한다.
 * 구현하지 않은 단계는 예외가 아니라 NOT_IMPLEMENTED 를 명시적으로 반환한다.
 *
 * 비밀값 경계: 단계 결과에는 식별자 코드만 담는다(자유 문자열 없음). 외부 예외 메시지·URL·헤더 값은
 * 파이프라인이 영속화하지 않으며, 수집기도 이 타입으로는 전달할 수 없다.
 * 공급자별 추정 필드는 공통 모델의 필수 사실이 아니다. ObservationInput.payload 는 공급자 원본 구조를 담는 unknown 이다.
 */

/** 실패 원인 분류. 재시도 로직이 영구 미구현·자격 부족을 반복하지 않도록 구분한다. */
export type FailureKind =
  'NOT_IMPLEMENTED' | 'CREDENTIALS' | 'TRANSIENT' | 'PERMANENT' | 'STORAGE' | 'UNKNOWN';

export type StageResult<T> =
  | { status: 'OK'; value: T }
  /** code: 식별자(예: VALIDATE_NOT_IMPLEMENTED). 자유 문장 금지 */
  | { status: 'NOT_IMPLEMENTED'; code: string }
  /** errorCode: 식별자. kind: 원인 분류. 외부 메시지는 포함하지 않는다 */
  | { status: 'FAILED'; errorCode: string; kind: Exclude<FailureKind, 'NOT_IMPLEMENTED'> };

export const notImplemented = (code: string): StageResult<never> => ({
  status: 'NOT_IMPLEMENTED',
  code,
});
export const failed = (
  errorCode: string,
  kind: Exclude<FailureKind, 'NOT_IMPLEMENTED'>,
): StageResult<never> => ({ status: 'FAILED', errorCode, kind });
export const ok = <T>(value: T): StageResult<T> => ({ status: 'OK', value });

/** 비밀값 제공자. 값은 호출 시점에만 메모리에 있으며 파이프라인은 값을 저장·로그하지 않는다. */
export interface SecretProvider {
  get(name: string): string | undefined;
}

export interface CollectorContext {
  run: SourceRun;
  account: SourceAccount;
  secrets: SecretProvider;
}

/**
 * 요청 단계 결과. bytes 는 변경 없이 원본으로 보관된다.
 * endpoint 는 안전한 템플릿('GET /path/{placeholder}')이며 실제 URL 이 아니다. 쿼리 문자열·자격값을 넣을 수 없다.
 * 인증 응답(토큰 발급 응답 등)은 이 타입으로 반환하면 안 된다. 파이프라인은 사용한 비밀값의 반사와 토큰 필드를 검사해
 * 저장을 중단한다.
 */
export interface RawResponse {
  bytes: Uint8Array;
  contentType: string;
  endpoint: string;
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
}

export interface Collector<Auth = unknown, Parsed = unknown> {
  readonly sourceSystem: string;
  /**
   * 이 수집기가 영속화에 쓰는 엔드포인트 템플릿 상수 목록. RawResponse.endpoint 는 이 목록의 원소와 정확히 일치해야 한다.
   * 요청 시점에 문자열을 조립하면(값 삽입) 목록과 달라져 거부되므로, 인증키·계정 ID 가 요약에 들어갈 수 없다(구조적 경계).
   */
  readonly endpointTemplates: readonly string[];
  /**
   * 구현된 단계 선언. 정기 자동 수집(SCHEDULED)은 다섯 단계가 전부 선언된 수집기만 허용하며,
   * 미구현 수집기가 지정되면 외부 요청 전에 거부한다. 검증 모드(VERIFICATION, 명시적 지정)에서만 부분 구현 실행을 허용한다.
   */
  readonly implementedStages: readonly (
    'authenticate' | 'request' | 'validate' | 'normalize' | 'reconcile'
  )[];
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
