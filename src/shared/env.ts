/**
 * 환경변수 로딩·검증.
 *
 * 잘못된 연결 문자열은 런타임 깊숙한 곳에서 모호한 오류로 터지는 대신
 * 기동 시점에 원인을 특정할 수 있는 메시지로 실패해야 한다.
 *
 * ⚠️ 오류 메시지에 비밀번호·전체 URL 을 절대 포함하지 않는다.
 *    이 값들은 로그·헬스체크 응답·오류 추적 시스템으로 흘러갈 수 있다.
 *
 * T0-3 에서 `EnvironmentError` 는 공통 오류 체계(`@/shared/errors`)로 편입되었다.
 * 변수명은 서버 로그(`context.variable`)에만 남고 운영 응답에는 나가지 않는다.
 */

import { EnvironmentError } from '@/shared/errors/app-error';

export { EnvironmentError };

export interface DatabaseEnv {
  /** 애플리케이션 런타임용 pooled connection */
  readonly databaseUrl: string;
  /** 마이그레이션·워커 전용 direct connection */
  readonly directUrl: string;
}

const POSTGRES_PROTOCOLS = ['postgresql:', 'postgres:'];

/**
 * 연결 문자열에서 비밀정보를 제거한 요약을 만든다.
 * 로그·오류 메시지에는 반드시 이 형태만 노출한다.
 *
 * `postgresql://user:pw@host:5432/db?x=1` → `postgresql://***@host:5432/db`
 */
export function describeConnection(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const credentials = url.username ? '***@' : '';
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol}//${credentials}${url.hostname}${port}${url.pathname}`;
  } catch {
    return '(파싱 불가)';
  }
}

/**
 * PostgreSQL 연결 문자열 형식을 검증한다.
 *
 * @throws {EnvironmentError} 형식이 잘못된 경우
 */
export function assertPostgresUrl(variable: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvironmentError(
      variable,
      '연결 문자열 형식이 올바르지 않습니다. ' +
        '`postgresql://<user>:<password>@<host>:<port>/<database>` 형태여야 합니다. ' +
        '(값은 보안상 표시하지 않습니다)',
    );
  }

  if (!POSTGRES_PROTOCOLS.includes(url.protocol)) {
    throw new EnvironmentError(
      variable,
      `PostgreSQL 연결 문자열이어야 합니다. 프로토콜이 '${url.protocol}' 입니다. ` +
        `'postgresql://' 또는 'postgres://' 를 사용하세요.`,
    );
  }

  if (!url.hostname) {
    throw new EnvironmentError(variable, '호스트가 비어 있습니다.');
  }

  // pathname 은 '/dbname' 형태. '/' 만 있으면 데이터베이스명이 없는 것.
  if (url.pathname === '' || url.pathname === '/') {
    throw new EnvironmentError(
      variable,
      `데이터베이스 이름이 없습니다. 호스트 뒤에 '/<database>' 를 지정하세요. ` +
        `(현재: ${describeConnection(value)})`,
    );
  }

  return url;
}

function readRequired(source: NodeJS.ProcessEnv, variable: string): string {
  const value = source[variable];
  if (value === undefined || value.trim() === '') {
    throw new EnvironmentError(
      variable,
      '환경변수가 설정되지 않았습니다. `.env.example` 을 `.env.local` 로 복사하고 값을 채우세요. ' +
        '(`cp .env.example .env.local`)',
    );
  }
  return value.trim();
}

/**
 * 데이터베이스 환경변수를 읽고 검증한다.
 *
 * `DATABASE_URL` 은 런타임용 pooled connection,
 * `DIRECT_URL` 은 마이그레이션·워커용 direct connection 이다.
 * 서버리스 환경에서 커넥션 폭증을 막기 위해 둘을 분리한다.
 */
export function loadDatabaseEnv(source: NodeJS.ProcessEnv = process.env): DatabaseEnv {
  const databaseUrl = readRequired(source, 'DATABASE_URL');
  const directUrl = readRequired(source, 'DIRECT_URL');

  assertPostgresUrl('DATABASE_URL', databaseUrl);
  assertPostgresUrl('DIRECT_URL', directUrl);

  return { databaseUrl, directUrl };
}

// ═══════════════════════════════════════════════════════════════
// 환경 식별자 — dev / stg / prod 3분리 (T0-9)
// ═══════════════════════════════════════════════════════════════

/**
 * 애플리케이션 환경 식별자.
 *
 * `NODE_ENV` 는 빌드 모드(development/production/test)라서 **staging 을 표현하지
 * 못한다** — staging 도 production 빌드로 돌기 때문이다. 그래서 배포 환경은
 * `APP_ENV` 로 구분한다.
 *
 * ┌─────────────┬──────────────┬───────────────────────────────────────────┐
 * │ APP_ENV     │ NODE_ENV     │ 값 주입 위치                              │
 * ├─────────────┼──────────────┼───────────────────────────────────────────┤
 * │ development │ development  │ .env.local (개발자 로컬)                  │
 * │ staging     │ production   │ 호스팅 환경변수 (.env.staging.example 참고)│
 * │ production  │ production   │ 호스팅 환경변수 (.env.production.example) │
 * └─────────────┴──────────────┴───────────────────────────────────────────┘
 *
 * ⚠️ staging·production 값(DB URL, Supabase 키)은 저장소·CI 에 두지 않는다.
 *    호스팅(예: Vercel) 환경변수로만 주입한다. 저장소에는 example 만 있다.
 * ⚠️ 테스트는 이 값과 무관하게 **하네스가 만든 일회용 DB** 만 쓴다
 *    (tests/db/harness.ts) — 운영 자격증명이 테스트에 자동 선택될 경로가 없다.
 */
export const APP_ENVS = ['development', 'staging', 'production'] as const;

export type AppEnv = (typeof APP_ENVS)[number];

/**
 * 환경 식별자를 읽고 검증한다.
 *
 * - `APP_ENV` 미설정: `NODE_ENV=production` 이면 `production`, 아니면 `development`.
 *   **staging 은 반드시 명시**해야 한다 — 기본값으로 staging 이 되는 일은 없다.
 * - `staging`/`production` 은 `NODE_ENV=production`(production 빌드)을 요구한다.
 *   개발 빌드가 운영 환경 행세를 하는 조합을 기동 시점에 거부한다.
 */
export function loadAppEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const raw = source['APP_ENV']?.trim();
  const nodeEnv = source['NODE_ENV'] ?? 'development';

  if (raw === undefined || raw === '') {
    return nodeEnv === 'production' ? 'production' : 'development';
  }

  if (!(APP_ENVS as readonly string[]).includes(raw)) {
    throw new EnvironmentError(
      'APP_ENV',
      `허용되지 않은 값 '${raw}' 입니다. development | staging | production 중 하나여야 합니다.`,
    );
  }
  const appEnv = raw as AppEnv;

  if ((appEnv === 'staging' || appEnv === 'production') && nodeEnv !== 'production') {
    throw new EnvironmentError(
      'APP_ENV',
      `APP_ENV='${appEnv}' 는 production 빌드(NODE_ENV=production)에서만 허용됩니다. ` +
        `(현재 NODE_ENV='${nodeEnv}')`,
    );
  }

  return appEnv;
}
