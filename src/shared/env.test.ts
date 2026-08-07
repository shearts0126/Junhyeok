import { describe, expect, it } from 'vitest';

import {
  assertPostgresUrl,
  describeConnection,
  EnvironmentError,
  loadAppEnv,
  loadDatabaseEnv,
} from './env';

const VALID_POOLED =
  'postgresql://postgres:secretpw@127.0.0.1:55432/deeppoint_scm?pgbouncer=true&connection_limit=1';
const VALID_DIRECT = 'postgresql://postgres:secretpw@127.0.0.1:55432/deeppoint_scm';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('describeConnection', () => {
  it('비밀번호와 쿼리스트링을 제거한다', () => {
    const described = describeConnection(VALID_POOLED);
    expect(described).toBe('postgresql://***@127.0.0.1:55432/deeppoint_scm');
  });

  it('비밀정보가 결과에 남지 않는다', () => {
    const described = describeConnection(VALID_POOLED);
    expect(described).not.toContain('secretpw');
    expect(described).not.toContain('postgres:');
    expect(described).not.toContain('pgbouncer');
  });

  it('사용자 정보가 없으면 자격증명 표기를 생략한다', () => {
    expect(describeConnection('postgresql://localhost:5432/app')).toBe(
      'postgresql://localhost:5432/app',
    );
  });

  it('파싱 불가한 값도 예외를 던지지 않는다', () => {
    expect(describeConnection('not-a-url')).toBe('(파싱 불가)');
  });
});

describe('assertPostgresUrl', () => {
  it('정상 연결 문자열을 통과시킨다', () => {
    expect(() => assertPostgresUrl('DATABASE_URL', VALID_DIRECT)).not.toThrow();
  });

  it('postgres:// 스킴도 허용한다', () => {
    expect(() => assertPostgresUrl('DATABASE_URL', 'postgres://h:5432/db')).not.toThrow();
  });

  it('URL 형식이 아니면 EnvironmentError', () => {
    expect(() => assertPostgresUrl('DATABASE_URL', 'localhost:5432')).toThrow(EnvironmentError);
  });

  it('PostgreSQL 이 아닌 프로토콜이면 EnvironmentError', () => {
    expect(() => assertPostgresUrl('DATABASE_URL', 'mysql://h:3306/db')).toThrow(
      /프로토콜이 'mysql:'/,
    );
  });

  it('데이터베이스 이름이 없으면 EnvironmentError', () => {
    expect(() => assertPostgresUrl('DIRECT_URL', 'postgresql://127.0.0.1:5432')).toThrow(
      /데이터베이스 이름이 없습니다/,
    );
  });

  it('오류 메시지에 비밀번호를 노출하지 않는다', () => {
    let message = '';
    try {
      assertPostgresUrl('DATABASE_URL', 'mysql://user:secretpw@host:3306/db');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('secretpw');
  });

  it('변수명을 EnvironmentError 에 담는다', () => {
    try {
      assertPostgresUrl('DIRECT_URL', 'nope');
      expect.unreachable('예외가 발생해야 한다');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvironmentError);
      expect((e as EnvironmentError).variable).toBe('DIRECT_URL');
      expect((e as EnvironmentError).name).toBe('EnvironmentError');
    }
  });
});

describe('loadDatabaseEnv', () => {
  it('정상 환경변수를 읽어온다', () => {
    const result = loadDatabaseEnv(env({ DATABASE_URL: VALID_POOLED, DIRECT_URL: VALID_DIRECT }));
    expect(result.databaseUrl).toBe(VALID_POOLED);
    expect(result.directUrl).toBe(VALID_DIRECT);
  });

  it('DATABASE_URL 누락 시 안내 메시지와 함께 실패한다', () => {
    expect(() => loadDatabaseEnv(env({ DIRECT_URL: VALID_DIRECT }))).toThrow(
      /\[DATABASE_URL\].*설정되지 않았습니다/s,
    );
  });

  it('DIRECT_URL 누락 시 안내 메시지와 함께 실패한다', () => {
    expect(() => loadDatabaseEnv(env({ DATABASE_URL: VALID_POOLED }))).toThrow(
      /\[DIRECT_URL\].*설정되지 않았습니다/s,
    );
  });

  it('빈 문자열·공백은 누락으로 취급한다', () => {
    expect(() => loadDatabaseEnv(env({ DATABASE_URL: '   ', DIRECT_URL: VALID_DIRECT }))).toThrow(
      EnvironmentError,
    );
  });

  it('앞뒤 공백을 제거한다', () => {
    const result = loadDatabaseEnv(
      env({ DATABASE_URL: `  ${VALID_POOLED}  `, DIRECT_URL: VALID_DIRECT }),
    );
    expect(result.databaseUrl).toBe(VALID_POOLED);
  });

  it('잘못된 DIRECT_URL 은 변수명을 특정해 실패한다', () => {
    try {
      loadDatabaseEnv(env({ DATABASE_URL: VALID_POOLED, DIRECT_URL: 'redis://h:6379' }));
      expect.unreachable('예외가 발생해야 한다');
    } catch (e) {
      expect((e as EnvironmentError).variable).toBe('DIRECT_URL');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// APP_ENV — dev / stg / prod 3분리 (T0-9)
// ═══════════════════════════════════════════════════════════════
describe('loadAppEnv', () => {
  it('development — 기본값 (NODE_ENV=development, APP_ENV 미설정)', () => {
    expect(loadAppEnv(env({ NODE_ENV: 'development' }))).toBe('development');
    expect(loadAppEnv(env({}))).toBe('development');
  });

  it('production — NODE_ENV=production 이면 기본값이 production', () => {
    expect(loadAppEnv(env({ NODE_ENV: 'production' }))).toBe('production');
    expect(loadAppEnv(env({ NODE_ENV: 'production', APP_ENV: 'production' }))).toBe('production');
  });

  it('★ staging 은 기본값이 될 수 없다 — 반드시 명시해야 한다', () => {
    expect(loadAppEnv(env({ NODE_ENV: 'production', APP_ENV: 'staging' }))).toBe('staging');
    // 어떤 NODE_ENV 조합에서도 미설정 → staging 이 나오지 않는다.
    expect(loadAppEnv(env({ NODE_ENV: 'production' }))).not.toBe('staging');
    expect(loadAppEnv(env({ NODE_ENV: 'development' }))).not.toBe('staging');
  });

  it('★ 허용되지 않은 값은 EnvironmentError', () => {
    expect(() => loadAppEnv(env({ APP_ENV: 'qa' }))).toThrow(EnvironmentError);
    expect(() => loadAppEnv(env({ APP_ENV: 'prod' }))).toThrow(EnvironmentError);
  });

  it('★ 개발 빌드가 staging/production 행세를 할 수 없다', () => {
    expect(() => loadAppEnv(env({ NODE_ENV: 'development', APP_ENV: 'production' }))).toThrow(
      EnvironmentError,
    );
    expect(() => loadAppEnv(env({ NODE_ENV: 'test', APP_ENV: 'staging' }))).toThrow(
      EnvironmentError,
    );
  });

  it('★ 테스트 하네스는 APP_ENV·.env 와 무관하게 자체 DB 를 쓴다 (구조 계약)', () => {
    // tests/db/global-setup.ts 는 DATABASE_URL/DIRECT_URL 을 하네스가 만든
    // 일회용 DB 로 **덮어쓴다**. 여기서는 그 계약의 반대편 — loadAppEnv 가
    // DB 선택에 관여하지 않음을 고정한다: 반환값은 식별자일 뿐 연결 정보가 없다.
    const appEnv = loadAppEnv(env({ NODE_ENV: 'production', APP_ENV: 'production' }));
    expect(typeof appEnv).toBe('string');
    expect(appEnv).not.toContain('://');
  });
});
