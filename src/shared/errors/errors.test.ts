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
import { buildErrorLogEntry } from './logger';
import {
  isSensitiveKey,
  maskCredentials,
  maskSecretsInString,
  redactRecord,
  redactSecrets,
} from './redact';
import {
  generateRequestId,
  REQUEST_ID_HEADER,
  resolveCorrelationId,
  resolveRequestContext,
} from './request-id';
import { buildErrorResponse } from './response';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      expect(publicMessageForCode(code).length).toBeGreaterThan(0);
    }
  });

  it('★ 알 수 없는 코드는 고정 일반 문구를 반환한다', () => {
    expect(publicMessageForCode('SOME_FUTURE_CODE')).toBe('요청을 처리하지 못했습니다.');
  });

  // 조립·분해는 자재 감소와 완제품 증가가 BOM 소요량으로 환산되어 균형을 이룬다.
  // 단순 전체 증감 합계 0 검증이 아니므로 "증감 합계"라는 표현을 쓰지 않는다.
  it('★ UNBALANCED_TRANSACTION 은 "수량 균형" 표현을 쓴다', () => {
    const message = publicMessageForCode(ERROR_CODES.UNBALANCED_TRANSACTION);
    expect(message).toBe('거래의 수량 균형이 맞지 않습니다.');
    expect(message).not.toContain('증감 합계');
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

  it('★ 내부 details 와 공개 publicDetails 를 별도 필드로 보관한다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      details: { internalSkuId: 'uuid-1' },
      context: { dbHost: 'db.internal' },
      publicDetails: { available: '10' },
      publicHint: '수량을 줄이세요.',
    });
    expect(err.details?.['internalSkuId']).toBe('uuid-1');
    expect(err.context?.['dbHost']).toBe('db.internal');
    expect(err.publicDetails?.['available']).toBe('10');
    expect(err.publicHint).toBe('수량을 줄이세요.');
  });

  it('부가정보를 넘기지 않으면 네 필드 모두 undefined 다', () => {
    const err = new DomainError(ERROR_CODES.NOT_FOUND);
    expect(err.details).toBeUndefined();
    expect(err.context).toBeUndefined();
    expect(err.publicDetails).toBeUndefined();
    expect(err.publicHint).toBeUndefined();
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
// Request ID ↔ Correlation ID 분리
// ═══════════════════════════════════════════════════════════════
describe('Request ID ↔ Correlation ID 분리', () => {
  it('requestId 는 UUID 형식이다', () => {
    expect(generateRequestId()).toMatch(UUID_PATTERN);
    expect(resolveRequestContext().requestId).toMatch(UUID_PATTERN);
  });

  it('매번 다른 값을 생성한다', () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });

  it('★ 외부 x-request-id 를 시스템 requestId 로 쓰지 않는다', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'client-req-123' });
    const context = resolveRequestContext(headers);
    expect(context.requestId).not.toBe('client-req-123');
    expect(context.requestId).toMatch(UUID_PATTERN);
    expect(context.correlationId).toBe('client-req-123');
  });

  it('★ 동일한 외부 x-request-id 를 반복 전송해도 서버 requestId 는 매번 다르다', () => {
    const headers = { [REQUEST_ID_HEADER]: 'same-external-id' };
    const ids = new Set<string>();

    for (let i = 0; i < 20; i += 1) {
      const context = resolveRequestContext(headers);
      // correlationId 는 그대로 유지되어 외부 추적과 연결된다
      expect(context.correlationId).toBe('same-external-id');
      ids.add(context.requestId);
    }

    expect(ids.size).toBe(20);
  });

  it('x-vercel-id 를 correlationId 대체 소스로 쓴다', () => {
    const context = resolveRequestContext(new Headers({ 'x-vercel-id': 'icn1::abcde-123' }));
    expect(context.correlationId).toBe('icn1::abcde-123');
    expect(context.requestId).toMatch(UUID_PATTERN);
  });

  it('x-request-id 가 x-vercel-id 보다 우선한다', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'explicit', 'x-vercel-id': 'vercel' });
    expect(resolveCorrelationId(headers)).toBe('explicit');
  });

  it('★ 외부 헤더가 없으면 correlationId 는 생략된다', () => {
    expect(resolveRequestContext(new Headers()).correlationId).toBeUndefined();
    expect(resolveRequestContext().correlationId).toBeUndefined();
    expect(resolveCorrelationId()).toBeUndefined();
  });

  // `Headers` 생성자는 제어문자를 자체적으로 거부하므로,
  // 위조 시도가 실제 도달할 수 있는 경로인 객체 형태 헤더로 검증한다.
  it('★ correlationId 의 제어문자·개행을 제거해 로그 위조를 막는다', () => {
    const resolved = resolveCorrelationId({
      [REQUEST_ID_HEADER]: 'abc\r\ndef\tINFO fake-log-line',
    });
    expect(resolved).not.toContain('\n');
    expect(resolved).not.toContain('\r');
    expect(resolved).not.toContain('\t');
    expect(resolved).toBe('abcdefINFO fake-log-line');
  });

  it('★ 과도하게 긴 correlationId 를 잘라낸다', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'x'.repeat(5000) });
    expect(resolveCorrelationId(headers)?.length).toBeLessThanOrEqual(200);
  });

  it('빈 값·공백이면 correlationId 를 생략한다', () => {
    expect(resolveCorrelationId(new Headers({ [REQUEST_ID_HEADER]: '   ' }))).toBeUndefined();
  });

  it('일반 객체 형태 헤더도 지원한다', () => {
    expect(resolveCorrelationId({ 'x-request-id': 'obj-123' })).toBe('obj-123');
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

  it('ValidationError 의 필드 오류를 포함한다', () => {
    const err = new ValidationError([{ path: 'skuCode', message: '필수 항목입니다.' }]);
    expect(buildErrorResponse(err, prod).fieldErrors).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// ★ 내부 details / 공개 publicDetails 분리
// ═══════════════════════════════════════════════════════════════
describe('★ 내부 details / 공개 publicDetails 분리', () => {
  const prod = { requestId: 'req-p', isProduction: true };
  const dev = { requestId: 'req-d', isProduction: false };

  it('★ details 에 DB URL·비밀번호·내부 사용자 ID 가 있어도 운영 응답에 노출되지 않는다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      details: {
        databaseUrl: 'postgresql://scm_user:Sup3rS3cret@db.internal:5432/prod',
        password: 'Sup3rS3cret',
        internalUserId: 'usr_0f8c2a41-internal',
        tableName: 'inventory_ledger_entry',
      },
    });

    const body = buildErrorResponse(err, prod);
    const serialized = JSON.stringify(body);

    expect(body).not.toHaveProperty('details');
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('Sup3rS3cret');
    expect(serialized).not.toContain('usr_0f8c2a41-internal');
    expect(serialized).not.toContain('inventory_ledger_entry');
    expect(serialized).not.toContain('databaseUrl');
  });

  it('★ details 는 개발환경 응답에도 노출되지 않는다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      details: { internalUserId: 'usr_0f8c2a41-internal', password: 'Sup3rS3cret' },
    });
    const serialized = JSON.stringify(buildErrorResponse(err, dev));
    expect(serialized).not.toContain('usr_0f8c2a41-internal');
    expect(serialized).not.toContain('Sup3rS3cret');
  });

  it('★ context 는 개발·운영 응답 모두에 노출되지 않는다', () => {
    const err = new DomainError(ERROR_CODES.FORBIDDEN, {
      context: { internalUserId: 'uuid-1', dbHost: 'db.internal', tableName: 'sku' },
    });

    for (const options of [prod, dev]) {
      const serialized = JSON.stringify(buildErrorResponse(err, options));
      expect(serialized).not.toContain('db.internal');
      expect(serialized).not.toContain('internalUserId');
      expect(serialized).not.toContain('tableName');
      expect(serialized).not.toContain('context');
    }
  });

  it('★ publicDetails·publicHint 만 운영 응답에 노출된다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      details: { internalSkuId: 'uuid-secret' },
      context: { dbHost: 'db.internal' },
      publicDetails: { available: '10.000000', requestedNet: '12.000000' },
      publicHint: '동일 재고키 2개 항목이 합산되었습니다.',
    });

    const body = buildErrorResponse(err, prod);
    expect(body.publicDetails?.['available']).toBe('10.000000');
    expect(body.publicHint).toContain('합산');

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('uuid-secret');
    expect(serialized).not.toContain('db.internal');
  });

  it('★ 예상하지 못한 오류는 publicDetails 가 전달돼도 노출하지 않는다', () => {
    for (const options of [prod, dev]) {
      const err = new SystemError({
        publicDetails: { shouldNotAppear: 'leaked-value' },
        publicHint: '이 힌트도 나가면 안 된다',
      });
      const body = buildErrorResponse(err, options);
      expect(body.publicDetails).toBeUndefined();
      expect(body.publicHint).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('leaked-value');
    }
  });

  it('★ EnvironmentError 도 publicDetails 를 노출하지 않는다', () => {
    const err = new EnvironmentError('DATABASE_URL', '형식이 잘못되었습니다.', {
      publicDetails: { variable: 'DATABASE_URL' },
    });
    const serialized = JSON.stringify(buildErrorResponse(err, prod));
    expect(serialized).not.toContain('DATABASE_URL');
  });

  it('응답 본문에 details·hint 라는 키 자체가 존재하지 않는다', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      details: { a: 1 },
      publicDetails: { b: 2 },
      publicHint: 'x',
    });
    const keys = Object.keys(buildErrorResponse(err, prod));
    expect(keys).not.toContain('details');
    expect(keys).not.toContain('hint');
    expect(keys).toContain('publicDetails');
    expect(keys).toContain('publicHint');
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
});

// ═══════════════════════════════════════════════════════════════
// 자격증명 마스킹 — 문자열 패턴
// ═══════════════════════════════════════════════════════════════
describe('마스킹 — 문자열 패턴', () => {
  it('연결 문자열의 사용자명·비밀번호를 가린다', () => {
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

  it('★ Bearer 토큰을 가린다', () => {
    const masked = maskSecretsInString(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP',
    );
    expect(masked).toBe('Authorization: Bearer ***');
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('★ Basic 인증값을 가린다', () => {
    const masked = maskSecretsInString('Authorization: Basic YWRtaW46c3VwZXJzZWNyZXQ=');
    expect(masked).toBe('Authorization: Basic ***');
    expect(masked).not.toContain('YWRtaW46');
  });

  it('★ 한 문자열에 섞인 여러 형태를 동시에 가린다', () => {
    const masked = maskSecretsInString(
      'fetch postgresql://scm:pw123@db.internal/prod with Bearer abc.def.ghi failed',
    );
    expect(masked).not.toContain('pw123');
    expect(masked).not.toContain('abc.def.ghi');
    // 호스트는 남는다 — 로그 디버깅에 필요하다
    expect(masked).toContain('db.internal');
  });
});

// ═══════════════════════════════════════════════════════════════
// 자격증명 마스킹 — 키 기반 재귀
// ═══════════════════════════════════════════════════════════════
describe('마스킹 — 키 기반 재귀', () => {
  it('민감한 키 이름을 식별한다', () => {
    for (const key of [
      'password',
      'passwd',
      'secret',
      'clientSecret',
      'token',
      'accessToken',
      'refreshToken',
      'authorization',
      'Authorization',
      'cookie',
      'set-cookie',
      'apiKey',
      'API_KEY',
      'DATABASE_URL',
      'DIRECT_URL',
      'connectionString',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('일반 키는 그대로 둔다', () => {
    for (const key of ['skuId', 'warehouseCode', 'quantity', 'available', 'route']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('★ 최상위 민감 키를 가린다', () => {
    const redacted = redactRecord({
      skuId: 'uuid-1',
      password: 'Sup3rS3cret',
      DATABASE_URL: 'postgresql://u:p@h/d',
    });
    expect(redacted['skuId']).toBe('uuid-1');
    expect(redacted['password']).toBe('***');
    expect(redacted['DATABASE_URL']).toBe('***');
  });

  it('★ 중첩 객체 내부까지 가린다', () => {
    const redacted = redactRecord({
      request: { headers: { authorization: 'Bearer abc.def', 'x-trace': 'ok' } },
      db: { connectionString: 'postgresql://u:p@h/d', host: 'db.internal' },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('abc.def');
    expect(serialized).not.toContain('postgresql://u:p@h/d');
    expect(serialized).toContain('x-trace');
    expect(serialized).toContain('db.internal');
  });

  it('★ 배열 원소 내부까지 가린다', () => {
    const redacted = redactRecord({
      accounts: [
        { id: 1, password: 'first' },
        { id: 2, apiKey: 'second' },
      ],
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('first');
    expect(serialized).not.toContain('second');
    expect(serialized).toContain('"id":1');
  });

  it('★ Error cause 체인 내부까지 가린다', () => {
    const root = new Error('connect failed postgresql://scm:rootpw@db.internal:5432/prod');
    const middle = new Error('adapter failed', { cause: root });
    const top = new Error('query failed', { cause: middle });

    const serialized = JSON.stringify(redactSecrets({ error: top }));
    expect(serialized).not.toContain('rootpw');
    expect(serialized).toContain('***:***@');
    expect(serialized).toContain('query failed');
    expect(serialized).toContain('adapter failed');
  });

  it('★ Error 에 붙은 민감한 속성도 가린다', () => {
    const err = Object.assign(new Error('auth failed'), { accessToken: 'tok_live_123' });
    expect(JSON.stringify(redactSecrets(err))).not.toContain('tok_live_123');
  });

  it('★ 문자열 값에 섞인 자격증명도 가린다 (키가 민감하지 않아도)', () => {
    const redacted = redactRecord({
      lastQuery: 'connect to postgresql://scm:hidden@db.internal/prod',
      header: 'Bearer eyJhbGciOi.payload.sig',
    });
    expect(JSON.stringify(redacted)).not.toContain('hidden');
    expect(JSON.stringify(redacted)).not.toContain('eyJhbGciOi.payload.sig');
  });

  it('순환 참조에서 무한 재귀하지 않는다', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;
    expect(() => JSON.stringify(redactRecord(node))).not.toThrow();
    expect(JSON.stringify(redactRecord(node))).toContain('순환 참조');
  });

  it('깊이 제한을 넘으면 잘라낸다', () => {
    let deep: Record<string, unknown> = { password: 'leaf' };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redactRecord(deep))).not.toContain('leaf');
  });

  it('원본 객체를 변형하지 않는다', () => {
    const original = { password: 'keep-me' };
    redactRecord(original);
    expect(original.password).toBe('keep-me');
  });
});

// ═══════════════════════════════════════════════════════════════
// 서버 로그
// ═══════════════════════════════════════════════════════════════
describe('서버 로그', () => {
  it('★ context 와 details 를 로그에는 담는다 (응답과 반대)', () => {
    const err = new DomainError(ERROR_CODES.INSUFFICIENT_STOCK, {
      details: { internalSkuId: 'uuid-1' },
      context: { skuId: 'uuid-1', warehouseId: 'uuid-2' },
    });
    const entry = buildErrorLogEntry(err, { requestId: 'req-3' });
    expect(entry.details?.['internalSkuId']).toBe('uuid-1');
    expect(entry.context?.['skuId']).toBe('uuid-1');
    expect(entry.requestId).toBe('req-3');
  });

  it('★ correlationId 를 로그에 남긴다', () => {
    const entry = buildErrorLogEntry(new SystemError(), {
      requestId: 'server-uuid',
      correlationId: 'client-trace-1',
    });
    expect(entry.requestId).toBe('server-uuid');
    expect(entry.correlationId).toBe('client-trace-1');
  });

  it('correlationId 가 없으면 생략한다', () => {
    expect(buildErrorLogEntry(new SystemError(), { requestId: 'r' }).correlationId).toBeUndefined();
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

  it('★ 로그의 message 에서도 비밀번호는 마스킹한다', () => {
    const err = new SystemError({
      message: 'connect failed postgresql://postgres:supersecret@db.internal:5432/prod',
    });
    const entry = buildErrorLogEntry(err, { requestId: 'r' });
    expect(entry.message).not.toContain('supersecret');
    expect(entry.message).toContain('***:***@');
    // 호스트는 로그에 남는다 — 신뢰 경계 안이며 디버깅에 필요하다
    expect(entry.message).toContain('db.internal');
  });

  it('★ 로그의 details·context 도 재귀적으로 마스킹한다', () => {
    const err = new SystemError({
      details: { config: { DATABASE_URL: 'postgresql://u:pw@h/d' } },
      context: { headers: [{ authorization: 'Bearer abc.def.ghi' }] },
    });
    const serialized = JSON.stringify(buildErrorLogEntry(err, { requestId: 'r' }));
    expect(serialized).not.toContain('pw@h');
    expect(serialized).not.toContain('abc.def.ghi');
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
      publicDetails: { available: '10' },
      details: { internalSkuId: 'uuid-secret' },
      context: { dbHost: 'db.internal', connectionString: 'postgresql://u:p@h/d' },
    });

    const response = JSON.stringify(
      buildErrorResponse(err, { requestId: 'server-uuid', isProduction: true }),
    );
    const log = buildErrorLogEntry(err, {
      requestId: 'server-uuid',
      correlationId: 'client-trace',
    });

    // 응답: 공개 문구 + publicDetails 만
    expect(response).toContain('재고가 부족합니다.');
    expect(response).toContain('"available":"10"');
    expect(response).not.toContain('OLPUN');
    expect(response).not.toContain('uuid-secret');
    expect(response).not.toContain('db.internal');
    expect(response).not.toContain('client-trace');

    // 로그: 상세 메시지 + details + context (자격증명은 마스킹)
    expect(log.message).toContain('OLPUN');
    expect(log.details?.['internalSkuId']).toBe('uuid-secret');
    expect(log.context?.['dbHost']).toBe('db.internal');
    expect(log.context?.['connectionString']).toBe('***');
    expect(log.correlationId).toBe('client-trace');

    // 로그의 requestId 로 응답과 연결된다
    expect(log.requestId).toBe('server-uuid');
  });
});
