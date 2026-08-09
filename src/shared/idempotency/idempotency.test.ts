import { describe, expect, it } from 'vitest';

import { toDecimal } from '@/shared/decimal';
import { ValidationError } from '@/shared/errors';

import { canonicalJson, requestHashOf } from './canonical';
import { IDEMPOTENCY_KEY_MAX_LENGTH, parseIdempotencyKeyHeader } from './idempotency';

/**
 * 공용 멱등성 — canonical hash·헤더 검증 (T1-3 보완).
 *
 * claim/replay/409 계약과 동시성은 실제 PostgreSQL 이 필요하므로
 * `tests/db/idempotency.test.ts` 에서 검증한다.
 */

describe('canonicalJson · requestHashOf', () => {
  it('★ 객체 key 순서가 달라도 같은 hash — property 순서만 다른 요청은 같은 요청', () => {
    const a = { skuCode: 'A', skuName: 'B', itemType: 'C' };
    const b = { itemType: 'C', skuCode: 'A', skuName: 'B' };
    expect(requestHashOf(a)).toBe(requestHashOf(b));
    expect(canonicalJson(a)).toBe('{"itemType":"C","skuCode":"A","skuName":"B"}');
  });

  it('중첩 객체도 재귀 정렬, 배열 순서는 보존한다', () => {
    expect(requestHashOf({ x: { b: 1, a: 2 }, list: [1, 2] })).toBe(
      requestHashOf({ list: [1, 2], x: { a: 2, b: 1 } }),
    );
    expect(requestHashOf({ list: [1, 2] })).not.toBe(requestHashOf({ list: [2, 1] }));
  });

  it("★ 입력 의미는 정규화하지 않는다 — 'ABC' 와 'abc' 는 다른 hash", () => {
    expect(requestHashOf({ skuCode: 'ABC' })).not.toBe(requestHashOf({ skuCode: 'abc' }));
  });

  it('undefined 프로퍼티는 생략된다 (JSON.stringify 와 동일)', () => {
    expect(requestHashOf({ a: 1, b: undefined })).toBe(requestHashOf({ a: 1 }));
    expect(requestHashOf({ a: 1, b: null })).not.toBe(requestHashOf({ a: 1 }));
  });

  it('shared Decimal 은 응답 계약과 같은 문자열로 직렬화된다', () => {
    // '2.500000' 과 '2.5' 는 같은 Decimal 값 → 같은 canonical 표현
    expect(requestHashOf({ q: toDecimal('2.500000') })).toBe(
      requestHashOf({ q: toDecimal('2.5') }),
    );
    expect(canonicalJson(toDecimal('2.500000'))).toBe('"2.5"');
  });

  it('hash 는 SHA-256 lowercase hex 64자다', () => {
    expect(requestHashOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('JSON 표현이 없는 값은 거부한다', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('parseIdempotencyKeyHeader', () => {
  it('헤더 없음 → undefined (멱등 비활성, 일반 처리)', () => {
    expect(parseIdempotencyKeyHeader(null)).toBeUndefined();
  });

  it('★ 빈 값·공백뿐인 값은 400', () => {
    for (const bad of ['', '   ']) {
      expect(() => parseIdempotencyKeyHeader(bad)).toThrow(ValidationError);
    }
  });

  it(`★ ${IDEMPOTENCY_KEY_MAX_LENGTH}자 초과는 400`, () => {
    expect(parseIdempotencyKeyHeader('k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).toHaveLength(
      IDEMPOTENCY_KEY_MAX_LENGTH,
    );
    expect(() => parseIdempotencyKeyHeader('k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1))).toThrow(
      ValidationError,
    );
  });

  it('★ silent normalization 없음 — 받은 값 그대로가 key 다', () => {
    expect(parseIdempotencyKeyHeader(' K1 ')).toBe(' K1 ');
    expect(parseIdempotencyKeyHeader('Key-A')).toBe('Key-A');
    expect(parseIdempotencyKeyHeader('key-a')).toBe('key-a');
    expect(parseIdempotencyKeyHeader(' K1 ')).not.toBe(parseIdempotencyKeyHeader('K1'));
  });
});
