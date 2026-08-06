import { describe, expect, it } from 'vitest';

import {
  AppError,
  AuthorizationError,
  ConflictError,
  DomainError,
  EnvironmentError,
  SystemError,
  ValidationError,
  toAppError,
} from './app-error';
import {
  DEFAULT_HTTP_STATUS,
  ERROR_CODES,
  httpStatusForCode,
  isKnownErrorCode,
  publicMessageForCode,
} from './codes';
import { buildErrorLogEntry, maskCredentials } from './logger';
import { generateRequestId, REQUEST_ID_HEADER, resolveRequestId } from './request-id';
import { buildErrorResponse } from './response';

// ═══════════════════════════════════════════════════════════════
// 오류코드 카탈로그
// ═══════════════════════════════════════════════════════════════
describe('오류코드 카탈로그', () => {
  it('알려진 코드를 식별한다', () => {
    expect(isKnownErrorCode(ERROR_CODES.INSUFFICIENT_STOCK)).toBe(true);
    expect(isKnownErrorCode('NOT_A_REAL_CODE')).toBe(false);
  });

  it('HTTP 상태를 코드별로 매핑한다', () => {
    expect(httpStatusForCode(ERROR_CODES.VALIDATION_ERROR)).toBe(400);
    expect(httpStatusForCode(ERROR_CODES.UNAUTHORIZED)).toBe(401);
    expect(httpStatusForCode(ERROR_CODES.REAUTH_REQUIRED)).toBe(401);
    expect(httpStatusForCode(ERROR_CODES.FORBIDDEN)).toBe(403);
    expect(httpStatusForCode(ERROR_CODES.SELF_APPROVAL_FORBIDDEN)).toBe(403);
    expect(httpStatusForCode(ERROR_CODES.NOT_FOUND)).toBe(404);
    expect(httpStatusForCode(ERROR_CODES.CONFLICT)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.SERIALIZATION_FAILURE)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.IDEMPOTENCY_KEY_REUSED)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.INSUFFICIENT_STOCK)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.REVERSAL_OF_REVERSAL_NOT_ALLOWED)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.CLOSED_PERIOD_TRANSACTION)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.INTERNAL_ERROR)).toBe(500);
    expect(httpStatusForCode(ERROR_CODES.ENVIRONMENT_ERROR)).toBe(500);
  });

  it('★ 알 수 없는 코드는 500 으로 처리한다', () => {
    expect(httpStatusForCode('SOME_FUTURE_CODE')).toBe(DEFAULT_HTTP_STATUS);
    expect(httpStatusForCode('')).toBe(500);
  });

  it('모든 코드에 공개 메시지가 있다', () => {
    for (const code of Object.values(ERROR_CODES)) {
      const message = publicMessageForCode(code);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('★ 알 수 없는 코드는 고정 일반 문구를 반환한다', () => {
    expect(publicMessageForCode('SOME_FUTURE_CODE')).toBe('요청을 처리하지 못했습니다.');
  });
});

// ═══════════════════════════════════════════════════════════════
// 오류 클래스
// ═══════════════════════════════════════════════════════════════
describe('오류 클래스', () => {
  it('DomainError 는 예상 가능한 오류다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe('DomainError');
    expect(err.expected).toBe(true);
    expect(err.httpStatus).toBe(422);
  });

  it('AuthorizationError 는 기본이 FORBIDDEN', () => {
    const err = new AuthorizationError();
    expect(err.code).toBe(ERROR_CODES.FORBIDDEN);
    expect(err.httpStatus).toBe(403);
    expect(err.expected).toBe(true);
  });

  it('ConflictError 는 기본적으로 재시도 가능하다', () => {
    expect(new ConflictError().retryable).toBe(true);
    expect(new ConflictError(ERROR_CODES.CONFLICT, { retryable: false }).retryable).toBe(false);
  });

  it('ValidationError 는 필드 오류를 담는다', () => {
    const err = new ValidationError([{ path: 'skuCode', message: '필수' }]);
    expect(err.httpStatus).toBe(400);
    expect(err.fieldErrors).toHaveLength(1);
    expect(err.fieldErrors[0]?.path).toBe('skuCode');
  });

  it('★ SystemError 는 예상하지 못한 오류다', () => {
    const err = new SystemError({ message: '내부 상세' });
    expect(err.expected).toBe(false);
    expect(err.httpStatus).toBe(500);
    expect(err.code).toBe(ERROR_CODES.INTERNAL_ERROR);
  });

  it('메시지 미지정 시 코드별 공개 문구를 사용한다', () => {
    expect(new DomainError(ERROR_CODES.INSUFFICIENT_STOCK).message).toBe('재고가 부족합니다.');
  });

  it('cause 를 보존한다', () => {
    const cause = new Error('원인');
    expect(new SystemError({ cause }).cause).toBe(cause);
  });
});

// ═══════════════════════════════════════════════════════════════
// EnvironmentError 편입 (T0-2 → T0-3)
// ═══════════════════════════════════════════════════════════════
describe('EnvironmentError 공통 체계 편입', () => {
  it('AppError 를 상속한다', () => {
    const err = new EnvironmentError('DATABASE_URL', '설정되지 않았습니다.');
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe('EnvironmentError');
    expect(err.code).toBe(ERROR_CODES.ENVIRONMENT_ERROR);
    expect(err.httpStatus).toBe(500);
  });

  it('★ 예상하지 못한 오류로 분류된다 (설정 실수는 사용자가 해결할 수 없음)', () => {
    expect(new EnvironmentError('DIRECT_URL', 'x').expected).toBe(false);
  });

  it('변수명을 필드와 로그 컨텍스트에 담는다', () => {
    const err = new EnvironmentError('DATABASE_URL', '설정되지 않았습니다.');
    expect(err.variable).toBe('DATABASE_URL');
    expect(err.context?.['variable']).toBe('DATABASE_URL');
  });

  it('내부 메시지에는 변수명이 포함된다 (개발 디버깅용)', () => {
    expect(new EnvironmentError('DATABASE_URL', '설정되지 않았습니다.').message).toContain(
      '[DATABASE_URL]',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// toAppError 정규화
// ═══════════════════════════════════════════════════════════════
describe('toAppError', () => {
  it('AppError 는 그대로 반환한다', () => {
    const err = new DomainError(ERROR_CODES.ALREADY_REVERSED);
    expect(toAppError(err)).toBe(err);
  });

  it('일반 Error 는 SystemError 로 정규화한다', () => {
    const result = toAppError(new TypeError('undefined 참조'));
    expect(result).toBeInstanceOf(SystemError);
    expect(result.expected).toBe(false);
    expect(result.cause).toBeInstanceOf(TypeError);
  });

  it('Error 가 아닌 값도 SystemError 로 정규화한다', () => {
    expect(toAppError('문자열').expected).toBe(false);
    expect(toAppError(undefined).httpStatus).toBe(500);
    expect(toAppError(null).code).toBe(ERROR_CODES.INTERNAL_ERROR);
  });
});

// ═══════════════════════════════════════════════════════════════
// Request ID
// ═══════════════════════════════════════════════════════════════
describe('Request ID', () => {
  it('UUID 형식을 생성한다', () => {
    expect(generateRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('매번 다른 값을 생성한다', () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });

  it('x-request-id 헤더를 전파한다', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'client-req-123' });
    expect(resolveRequestId(headers)).toBe('client-req-123');
  });

  it('x-vercel-id 를 대체 소스로 사용한다', () => {
    const headers = new Headers({ 'x-vercel-id': 'icn1::abcde-123' });
    expect(resolveRequestId(headers)).toBe('icn1::abcde-123');
  });

  it('x-request-id 가 x-vercel-id 보다 우선한다', () => {
    const headers = new Headers({
      [REQUEST_ID_HEADER]: 'explicit',
      'x-vercel-id': 'vercel',
    });
    expect(resolveRequestId(headers)).toBe('explicit');
  });

  it('헤더가 없으면 새로 생성한다', () => {
    expect(resolveRequestId(new Headers()).length).toBeGreaterThan(0);
    expect(resolveRequestId()).toMatch(/^[0-9a-f-]{36}$/i);
  });

  // `Headers` 생성자는 제어문자를 자체적으로 거부하므로,
  // 위조 시도가 실제 도달할 수 있는 경로인 객체 형태 헤더로 검증한다.
  it('★ 제어문자·개행을 제거해 로그 위조를 막는다', () => {
    const resolved = resolveRequestId({
      'x-request-id': 'abc\r\ndef\tINFO fake-log-line',
    });
    expect(resolved).not.toContain('\n');
    expect(resolved).not.toContain('\r');
    expect(resolved).not.toContain('\t');
    expect(resolved).toBe('abcdefINFO fake-log-line');
  });

  it('★ 과도하게 긴 값을 잘라낸다', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'x'.repeat(5000) });
    expect(resolveRequestId(headers).length).toBeLessThanOrEqual(200);
  });

  it('빈 값·공백이면 새로 생성한다', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: '   ' });
    expect(resolveRequestId(headers)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('일반 객체 형태 헤더도 지원한다', () => {
    expect(resolveRequestId({ 'x-request-id': 'obj-123' })).toBe('obj-123');
  });
});

// ═══════════════════════════════════════════════════════════════
// 외부 응답 — 운영환경
// ═══════════════════════════════════════════════════════════════
describe('외부 응답 — 운영환경', () => {
  const prod = { requestId: 'req-1', isProduction: true };

  it('표준 포맷을 갖춘다', () => {
    const body = buildErrorResponse(new DomainError(ERROR_CODES.INSUFFICIENT_STOCK), prod);
    expect(body.errorCode).toBe('INSUFFICIENT_STOCK');
    expect(body.message).toBe('재고가 부족합니다.');
    expect(body.requestId).toBe('req-1');
  });

  it('★ request ID 를 항상 포함한다', () => {
    for (const error of [
      new DomainError(ERROR_CODES.NOT_FOUND),
      new SystemError(),
      new TypeError('x'),
      'raw string',
    ]) {
      expect(buildErrorResponse(error, prod).requestId).toBe('req-1');
    }
  });

  it('★ 내부 상세 메시지 대신 고정 공개 문구를 쓴다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      message: '창고 OLPUN 의 SKU FB-OY-CW-001 가용 10, 요청 12',
    });
    const body = buildErrorResponse(err, prod);
    expect(body.message).toBe('재고가 부족합니다.');
    expect(body.message).not.toContain('OLPUN');
  });

  it('★ stack 을 노출하지 않는다', () => {
    const body = buildErrorResponse(new SystemError({ message: 'boom' }), prod);
    expect(body.debug).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('★ context(서버 로그 전용)를 노출하지 않는다', () => {
    const err = new DomainError(ERROR_CODES.FORBIDDEN, {
      context: { internalUserId: 'uuid-1', dbHost: 'db.internal', tableName: 'sku' },
    });
    const serialized = JSON.stringify(buildErrorResponse(err, prod));
    expect(serialized).not.toContain('db.internal');
    expect(serialized).not.toContain('internalUserId');
    expect(serialized).not.toContain('tableName');
  });

  it('★ 예상하지 못한 오류는 고정 문구 + 500', () => {
    const err = new SystemError({
      message: 'connect ECONNREFUSED postgresql://postgres:pw@db.internal:5432/prod',
    });
    const body = buildErrorResponse(err, prod);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('요청을 처리하지 못했습니다.');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('db.internal');
    expect(serialized).not.toContain('5432');
    expect(serialized).not.toContain('pw');
  });

  it('★ EnvironmentError 의 변수명을 운영 응답에 노출하지 않는다', () => {
    const err = new EnvironmentError('DATABASE_URL', '설정되지 않았습니다.');
    const serialized = JSON.stringify(buildErrorResponse(err, prod));
    expect(serialized).not.toContain('DATABASE_URL');
    expect(JSON.parse(serialized).message).toBe('서버 설정 오류가 발생했습니다.');
  });

  it('★ 알 수 없는 오류는 일반 문구 + 500', () => {
    const body = buildErrorResponse(new TypeError('Cannot read x of undefined'), prod);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('요청을 처리하지 못했습니다.');
    expect(JSON.stringify(body)).not.toContain('Cannot read');
  });

  it('도메인이 의도적으로 공개한 details·hint 는 포함한다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      details: { available: '10.000000', requestedNet: '12.000000' },
      hint: '동일 재고키 2개 항목이 합산되었습니다.',
    });
    const body = buildErrorResponse(err, prod);
    expect(body.details?.['available']).toBe('10.000000');
    expect(body.hint).toContain('합산');
  });

  it('★ 예상하지 못한 오류에는 details 가 붙지 않는다', () => {
    const body = buildErrorResponse(new SystemError({ details: { leak: 'x' } }), prod);
    expect(body.details).toBeUndefined();
  });

  it('ValidationError 의 필드 오류를 포함한다', () => {
    const err = new ValidationError([{ path: 'skuCode', message: '필수 항목입니다.' }]);
    expect(buildErrorResponse(err, prod).fieldErrors).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 외부 응답 — 개발환경
// ═══════════════════════════════════════════════════════════════
describe('외부 응답 — 개발환경', () => {
  const dev = { requestId: 'req-2', isProduction: false };

  it('예상 가능한 오류는 상세 메시지를 노출한다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      message: '창고 OLPUN 가용 10, 요청 12',
    });
    expect(buildErrorResponse(err, dev).message).toBe('창고 OLPUN 가용 10, 요청 12');
  });

  it('debug 블록에 스택을 담는다', () => {
    const body = buildErrorResponse(new DomainError(ERROR_CODES.NOT_FOUND), dev);
    expect(body.debug?.name).toBe('DomainError');
    expect(body.debug?.stack).toContain('DomainError');
  });

  it('cause 요약을 포함한다', () => {
    const err = new SystemError({ cause: new RangeError('범위 초과') });
    expect(buildErrorResponse(err, dev).debug?.cause).toBe('RangeError: 범위 초과');
  });

  it('★ 예상하지 못한 오류는 개발환경에서도 공개 문구를 쓴다', () => {
    const err = new SystemError({ message: 'postgresql://user:pw@host/db 실패' });
    const body = buildErrorResponse(err, dev);
    expect(body.message).toBe('요청을 처리하지 못했습니다.');
    // 단 debug.internalMessage 로는 확인 가능하다 (개발환경 한정)
    expect(body.debug?.internalMessage).toContain('postgresql://');
  });

  it('★ 개발환경에서도 context 는 노출하지 않는다', () => {
    const err = new DomainError(ERROR_CODES.FORBIDDEN, {
      context: { secretInternalId: 'should-not-leak' },
    });
    expect(JSON.stringify(buildErrorResponse(err, dev))).not.toContain('should-not-leak');
  });
});

// ═══════════════════════════════════════════════════════════════
// 서버 로그
// ═══════════════════════════════════════════════════════════════
describe('maskCredentials', () => {
  it('연결 문자열의 자격증명을 가린다', () => {
    expect(maskCredentials('postgresql://postgres:secret@host:5432/db')).toBe(
      'postgresql://***:***@host:5432/db',
    );
  });

  it('여러 개를 모두 가린다', () => {
    const masked = maskCredentials('a postgresql://u1:p1@h/d b redis://u2:p2@h2/0');
    expect(masked).not.toContain('p1');
    expect(masked).not.toContain('p2');
  });

  it('자격증명이 없으면 그대로 둔다', () => {
    expect(maskCredentials('postgresql://host:5432/db')).toBe('postgresql://host:5432/db');
  });
});

describe('서버 로그', () => {
  it('★ context 를 로그에는 담는다 (응답과 반대)', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      context: { skuId: 'uuid-1', warehouseId: 'uuid-2' },
    });
    const entry = buildErrorLogEntry(err, { requestId: 'req-3' });
    expect(entry.context?.['skuId']).toBe('uuid-1');
    expect(entry.requestId).toBe('req-3');
  });

  it('예상 가능한 오류는 warn, 예상하지 못한 오류는 error', () => {
    expect(
      buildErrorLogEntry(new DomainError(ERROR_CODES.NOT_FOUND), { requestId: 'r' }).level,
    ).toBe('warn');
    expect(buildErrorLogEntry(new SystemError(), { requestId: 'r' }).level).toBe('error');
  });

  it('예상하지 못한 오류만 스택을 남긴다', () => {
    expect(
      buildErrorLogEntry(new DomainError(ERROR_CODES.NOT_FOUND), { requestId: 'r' }).stack,
    ).toBeUndefined();
    expect(buildErrorLogEntry(new SystemError(), { requestId: 'r' }).stack).toBeDefined();
  });

  it('★ 로그에서도 비밀번호는 마스킹한다', () => {
    const err = new SystemError({
      message: 'connect failed postgresql://postgres:supersecret@db.internal:5432/prod',
    });
    const entry = buildErrorLogEntry(err, { requestId: 'r' });
    expect(entry.message).not.toContain('supersecret');
    expect(entry.message).toContain('***:***@');
    // 호스트는 로그에 남는다 — 신뢰 경계 안이며 디버깅에 필요하다
    expect(entry.message).toContain('db.internal');
  });

  it('라우트·메서드를 기록한다', () => {
    const entry = buildErrorLogEntry(new SystemError(), {
      requestId: 'r',
      route: '/api/skus',
      method: 'POST',
    });
    expect(entry.route).toBe('/api/skus');
    expect(entry.method).toBe('POST');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 응답 ↔ 로그 분리 (핵심 원칙)
// ═══════════════════════════════════════════════════════════════
describe('★ 내부 로그와 외부 응답 분리', () => {
  it('같은 오류가 로그에는 상세히, 응답에는 최소한으로 나간다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      message: '창고 OLPUN 의 FB-OY-CW-001 가용 10, 요청 12',
      details: { available: '10' },
      context: { dbHost: 'db.internal', connectionString: 'postgresql://u:p@h/d' },
    });

    const response = JSON.stringify(
      buildErrorResponse(err, { requestId: 'r', isProduction: true }),
    );
    const log = buildErrorLogEntry(err, { requestId: 'r' });

    // 응답: 공개 문구 + details 만
    expect(response).toContain('재고가 부족합니다.');
    expect(response).not.toContain('OLPUN');
    expect(response).not.toContain('db.internal');

    // 로그: 상세 메시지 + context
    expect(log.message).toContain('OLPUN');
    expect(log.context?.['dbHost']).toBe('db.internal');

    // 로그의 requestId 로 응답과 연결된다
    expect(log.requestId).toBe('r');
  });
});
