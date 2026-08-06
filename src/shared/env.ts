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
