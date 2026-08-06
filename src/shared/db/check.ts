import type { HealthCheck } from '@/shared/health';

/**
 * 데이터베이스 연결 점검.
 *
 * 실제 쿼리 실행 함수를 주입받아 DB 없이도 단위 테스트가 가능하도록 한다.
 * 프로덕션 경로는 `checkDatabase()` 가 Prisma 클라이언트를 사용한다.
 */

export const DB_CHECK_NAME = 'database';
export const DB_CHECK_TIMEOUT_MS = 3_000;

export type SelectOneFn = () => Promise<unknown>;

const MAX_CAUSE_DEPTH = 10;

/**
 * Prisma driver adapter 오류 종류 → 사용자 메시지.
 *
 * Prisma 7 은 어댑터 오류를 `error.meta.driverAdapterError.cause.kind` 에 담는다.
 * 문자열 매칭보다 이 값이 정확하므로 우선 사용한다.
 *
 * ⚠️ `cause` 에는 host·port 가 함께 들어오지만 `kind` 만 읽고 나머지는 버린다.
 */
const ADAPTER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  DatabaseNotReachable: '데이터베이스에 연결할 수 없습니다.',
  ConnectionClosed: '데이터베이스 연결이 끊어졌습니다.',
  SocketTimeout: '데이터베이스 응답 시간 초과.',
  AuthenticationFailed: '데이터베이스 인증에 실패했습니다.',
  DatabaseAccessDenied: '데이터베이스 접근 권한이 없습니다.',
  DatabaseDoesNotExist: '대상 데이터베이스가 존재하지 않습니다.',
  TlsConnectionError: '데이터베이스 TLS 연결에 실패했습니다.',
  TooManyConnections: '데이터베이스 커넥션 한도를 초과했습니다.',
};

/**
 * Prisma 오류에서 driver adapter 오류 종류를 추출한다.
 * 구조가 맞지 않으면 undefined 를 반환한다.
 */
export function extractAdapterErrorKind(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;

  const meta = (error as Error & { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;

  const adapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null) return undefined;

  const cause = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;

  const kind = (cause as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * 오류와 그 cause 체인에서 분류에 쓸 신호(message, code)를 모은다.
 *
 * Prisma 는 driver adapter 오류를 감싸므로 최상위 message 만 보면
 * `ECONNREFUSED` 같은 원인 코드가 사라진다. cause 를 따라가야 한다.
 */
function collectErrorSignals(error: unknown): string {
  const signals: string[] = [];
  let current: unknown = error;

  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof Error) {
      signals.push(current.message);
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === 'string') signals.push(code);
      current = current.cause;
    } else {
      signals.push(String(current));
      break;
    }
  }

  return signals.join(' ');
}

/**
 * 오류 객체에서 사람이 읽을 수 있는 요약을 뽑는다.
 *
 * ⚠️ 연결 문자열·비밀번호가 오류 메시지에 섞여 들어올 수 있으므로
 *    원문을 그대로 노출하지 않고 **분류된 고정 문장만** 반환한다.
 */
export function summarizeDbError(error: unknown): string {
  // 환경변수 누락·형식 오류는 원인을 알려주는 편이 유용하다.
  // EnvironmentError 메시지는 값을 포함하지 않도록 작성되어 있다.
  if (error instanceof Error && error.name === 'EnvironmentError') {
    return error.message;
  }

  // 1순위: Prisma driver adapter 의 구조화된 오류 종류
  const kind = extractAdapterErrorKind(error);
  if (kind !== undefined) {
    return ADAPTER_ERROR_MESSAGES[kind] ?? '데이터베이스 연결에 실패했습니다.';
  }

  // 2순위: 오류·cause 체인의 message / code 문자열 매칭
  const raw = collectErrorSignals(error);

  if (raw.includes('ECONNREFUSED')) return '데이터베이스 연결이 거부되었습니다.';
  if (raw.includes('ENOTFOUND') || raw.includes('EAI_AGAIN'))
    return '데이터베이스 호스트를 찾을 수 없습니다.';
  if (raw.includes('ETIMEDOUT') || raw.includes('timeout')) return '데이터베이스 응답 시간 초과.';
  if (raw.includes('password authentication failed') || raw.includes('28P01'))
    return '데이터베이스 인증에 실패했습니다.';
  if (raw.includes('does not exist') || raw.includes('3D000'))
    return '대상 데이터베이스가 존재하지 않습니다.';

  return '데이터베이스 연결에 실패했습니다.';
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ETIMEDOUT')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 주입받은 쿼리 함수로 연결을 점검한다.
 *
 * @param selectOne `SELECT 1` 을 실행하는 함수
 * @param timeoutMs 응답 대기 상한
 */
export async function runDatabaseCheck(
  selectOne: SelectOneFn,
  timeoutMs: number = DB_CHECK_TIMEOUT_MS,
): Promise<HealthCheck> {
  try {
    await withTimeout(selectOne(), timeoutMs);
    return { name: DB_CHECK_NAME, status: 'ok' };
  } catch (error) {
    return {
      name: DB_CHECK_NAME,
      status: 'down',
      detail: summarizeDbError(error),
    };
  }
}
