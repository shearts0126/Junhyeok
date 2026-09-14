/**
 * 설정 검증. 값은 환경변수에서만 읽고, 연결 문자열은 어떤 로그·응답에도 노출하지 않는다.
 * 로그인 구현 전이므로 HTTP 바인딩은 루프백 인터페이스만 허용한다(외부 공개 금지).
 */

export interface AppConfig {
  databaseUrl: string;
  httpHost: string;
  httpPort: number;
  rawStoreDir: string;
  recoveryCandidateMinutes: number;
}

export class ConfigError extends Error {
  constructor(
    readonly code:
      | 'MISSING_DATABASE_URL'
      | 'INVALID_DATABASE_URL'
      | 'NON_LOOPBACK_HOST'
      | 'INVALID_PORT'
      | 'INVALID_MINUTES',
  ) {
    super(code);
    this.name = 'ConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const databaseUrl = env['FIN02A_DATABASE_URL'];
  if (!databaseUrl) throw new ConfigError('MISSING_DATABASE_URL');
  try {
    const u = new URL(databaseUrl);
    if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw new Error('protocol');
  } catch {
    throw new ConfigError('INVALID_DATABASE_URL');
  }
  const httpHost = env['FIN02A_HTTP_HOST'] ?? '127.0.0.1';
  if (!isLoopbackHost(httpHost)) throw new ConfigError('NON_LOOPBACK_HOST');
  const httpPort = Number(env['FIN02A_HTTP_PORT'] ?? '3400');
  if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535)
    throw new ConfigError('INVALID_PORT');
  const recoveryCandidateMinutes = Number(env['FIN02A_RECOVERY_CANDIDATE_MINUTES'] ?? '60');
  if (!Number.isInteger(recoveryCandidateMinutes) || recoveryCandidateMinutes < 1)
    throw new ConfigError('INVALID_MINUTES');
  return {
    databaseUrl,
    httpHost,
    httpPort,
    rawStoreDir: env['FIN02A_RAW_STORE_DIR'] ?? '.raw-store',
    recoveryCandidateMinutes,
  };
}
