import { describe, expect, it } from 'vitest';

import { EnvironmentError } from '@/shared/env';
import { aggregateStatus, getHealthStatus } from '@/shared/health';

import {
  DB_CHECK_NAME,
  extractAdapterErrorKind,
  runDatabaseCheck,
  summarizeDbError,
} from './check';

describe('summarizeDbError', () => {
  it('연결 거부를 분류한다', () => {
    expect(summarizeDbError(new Error('connect ECONNREFUSED 127.0.0.1:55432'))).toBe(
      '데이터베이스 연결이 거부되었습니다.',
    );
  });

  it('호스트 조회 실패를 분류한다', () => {
    expect(summarizeDbError(new Error('getaddrinfo ENOTFOUND db.example'))).toBe(
      '데이터베이스 호스트를 찾을 수 없습니다.',
    );
  });

  it('타임아웃을 분류한다', () => {
    expect(summarizeDbError(new Error('ETIMEDOUT'))).toBe('데이터베이스 응답 시간 초과.');
  });

  it('인증 실패를 분류한다', () => {
    expect(summarizeDbError(new Error('password authentication failed for user "postgres"'))).toBe(
      '데이터베이스 인증에 실패했습니다.',
    );
  });

  it('존재하지 않는 DB 를 분류한다', () => {
    expect(summarizeDbError(new Error('database "nope" does not exist'))).toBe(
      '대상 데이터베이스가 존재하지 않습니다.',
    );
  });

  it('분류되지 않은 오류는 일반 문구로 대체한다', () => {
    expect(summarizeDbError(new Error('something odd'))).toBe('데이터베이스 연결에 실패했습니다.');
  });

  it('★ 원본 오류 메시지의 연결 문자열·비밀번호를 노출하지 않는다', () => {
    const leaky = new Error(
      'failed: postgresql://postgres:supersecret@db.internal:5432/prod ECONNREFUSED',
    );
    const summary = summarizeDbError(leaky);
    expect(summary).not.toContain('supersecret');
    expect(summary).not.toContain('postgresql://');
    expect(summary).not.toContain('db.internal');
  });

  it('EnvironmentError 는 원인 파악에 필요하므로 메시지를 유지한다', () => {
    const err = new EnvironmentError('DATABASE_URL', '환경변수가 설정되지 않았습니다.');
    expect(summarizeDbError(err)).toContain('DATABASE_URL');
  });

  it('Error 가 아닌 값도 처리한다', () => {
    expect(summarizeDbError('문자열 오류')).toBe('데이터베이스 연결에 실패했습니다.');
    expect(summarizeDbError(undefined)).toBe('데이터베이스 연결에 실패했습니다.');
  });
});

describe('runDatabaseCheck', () => {
  it('쿼리가 성공하면 ok', async () => {
    const check = await runDatabaseCheck(async () => [{ '?column?': 1 }]);
    expect(check).toEqual({ name: DB_CHECK_NAME, status: 'ok' });
  });

  it('쿼리가 실패하면 down 과 분류된 사유', async () => {
    const check = await runDatabaseCheck(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:55432');
    });
    expect(check.name).toBe(DB_CHECK_NAME);
    expect(check.status).toBe('down');
    expect(check.detail).toBe('데이터베이스 연결이 거부되었습니다.');
  });

  it('환경변수 오류도 down 으로 잡는다', async () => {
    const check = await runDatabaseCheck(async () => {
      throw new EnvironmentError('DIRECT_URL', '환경변수가 설정되지 않았습니다.');
    });
    expect(check.status).toBe('down');
    expect(check.detail).toContain('DIRECT_URL');
  });

  it('타임아웃 시 down 으로 처리한다', async () => {
    const never = () => new Promise<unknown>(() => {});
    const check = await runDatabaseCheck(never, 20);
    expect(check.status).toBe('down');
    expect(check.detail).toBe('데이터베이스 응답 시간 초과.');
  });
});

describe('헬스체크 통합 규칙', () => {
  it('DB 정상이면 전체 상태 ok', async () => {
    const checks = [await runDatabaseCheck(async () => 1)];
    expect(getHealthStatus(checks).status).toBe('ok');
  });

  it('★ DB 연결 실패 시 전체 상태가 down 이 된다', async () => {
    const checks = [
      await runDatabaseCheck(async () => {
        throw new Error('ECONNREFUSED');
      }),
    ];
    const status = getHealthStatus(checks);
    expect(status.checks[0]?.status).toBe('down');
    expect(status.status).toBe('down');
    expect(aggregateStatus(checks)).toBe('down');
  });

  it('★ 헬스체크 응답 어디에도 연결 문자열이 담기지 않는다', async () => {
    const checks = [
      await runDatabaseCheck(async () => {
        throw new Error('postgresql://postgres:pw@host:5432/db ECONNREFUSED');
      }),
    ];
    const serialized = JSON.stringify(getHealthStatus(checks));
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('pw@');
    expect(serialized).not.toMatch(/DATABASE_URL\s*=/);
  });
});

describe('cause 체인 분류 (Prisma driver adapter 대응)', () => {
  it('cause 에 담긴 ECONNREFUSED 를 찾아낸다', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:55432'), {
      code: 'ECONNREFUSED',
    });
    const wrapped = new Error('Invalid `prisma.$queryRaw()` invocation', { cause: inner });
    expect(summarizeDbError(wrapped)).toBe('데이터베이스 연결이 거부되었습니다.');
  });

  it('message 없이 code 만 있어도 분류한다', () => {
    const inner = Object.assign(new Error('connect failed'), { code: 'ENOTFOUND' });
    const wrapped = new Error('query failed', { cause: inner });
    expect(summarizeDbError(wrapped)).toBe('데이터베이스 호스트를 찾을 수 없습니다.');
  });

  it('2단계 이상 중첩된 cause 도 따라간다', () => {
    const root = Object.assign(new Error('socket error'), { code: 'ETIMEDOUT' });
    const mid = new Error('pool acquire failed', { cause: root });
    const top = new Error('prisma query failed', { cause: mid });
    expect(summarizeDbError(top)).toBe('데이터베이스 응답 시간 초과.');
  });

  it('순환 cause 에도 무한루프에 빠지지 않는다', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(summarizeDbError(b)).toBe('데이터베이스 연결에 실패했습니다.');
  });

  it('★ cause 체인의 연결 문자열도 응답에 노출되지 않는다', () => {
    const inner = new Error('postgresql://postgres:supersecret@db.internal:5432/prod refused');
    const wrapped = new Error('query failed', { cause: inner });
    const summary = summarizeDbError(wrapped);
    expect(summary).not.toContain('supersecret');
    expect(summary).not.toContain('db.internal');
  });
});

describe('Prisma driver adapter 오류 종류 (Prisma 7)', () => {
  function prismaError(kind: string, extra: Record<string, unknown> = {}) {
    return Object.assign(new Error('Invalid `prisma.$queryRaw()` invocation:'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { kind, ...extra },
        },
      },
    });
  }

  it('extractAdapterErrorKind 가 kind 를 추출한다', () => {
    expect(extractAdapterErrorKind(prismaError('DatabaseNotReachable'))).toBe(
      'DatabaseNotReachable',
    );
  });

  it('구조가 다르면 undefined 를 반환한다', () => {
    expect(extractAdapterErrorKind(new Error('plain'))).toBeUndefined();
    expect(extractAdapterErrorKind({ meta: {} })).toBeUndefined();
    expect(extractAdapterErrorKind(null)).toBeUndefined();
  });

  it('DatabaseNotReachable 을 분류한다 (실제 DB 중지 시 발생)', () => {
    const err = prismaError('DatabaseNotReachable', { host: '127.0.0.1', port: 55432 });
    expect(summarizeDbError(err)).toBe('데이터베이스에 연결할 수 없습니다.');
  });

  it('AuthenticationFailed 를 분류한다', () => {
    expect(summarizeDbError(prismaError('AuthenticationFailed'))).toBe(
      '데이터베이스 인증에 실패했습니다.',
    );
  });

  it('DatabaseDoesNotExist 를 분류한다', () => {
    expect(summarizeDbError(prismaError('DatabaseDoesNotExist'))).toBe(
      '대상 데이터베이스가 존재하지 않습니다.',
    );
  });

  it('알 수 없는 kind 는 일반 문구로 대체한다', () => {
    expect(summarizeDbError(prismaError('SomeFutureKind'))).toBe(
      '데이터베이스 연결에 실패했습니다.',
    );
  });

  it('★ meta 의 host·port 가 응답에 노출되지 않는다', async () => {
    const err = prismaError('DatabaseNotReachable', {
      host: 'db.internal.example',
      port: 55432,
    });
    const check = await runDatabaseCheck(async () => {
      throw err;
    });
    const serialized = JSON.stringify(check);
    expect(serialized).not.toContain('db.internal.example');
    expect(serialized).not.toContain('55432');
  });
});
