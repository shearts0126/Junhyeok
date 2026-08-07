import { describe, expect, it } from 'vitest';

import { DomainError, ERROR_CODES } from '@/shared/errors';

import {
  assertSkuArchivable,
  assertSkuCodeChangeAllowed,
  assertSkuStatusTransition,
  canArchiveSku,
  canChangeSkuCode,
  canTransitionSkuStatus,
  SKU_STATUS_TRANSITIONS,
  SKU_STATUSES,
  skuArchiveBlockers,
  type SkuStatusValue,
} from './domain';

/**
 * SKU 도메인 불변식 테스트 (T1-2) — DB 없이 순수 함수만.
 *
 * TC-SKU-007 (코드 변경 차단) / TC-SKU-008 (ARCHIVED 자격) / 상태전이 matrix.
 */

// ═══════════════════════════════════════════════════════════════
// 상태 전이 — 7×7 전체 matrix
// ═══════════════════════════════════════════════════════════════

/** 문서 근거가 있는 허용 전이의 전체 목록 (이 테이블이 기대값의 단일 기준). */
const DOCUMENTED_ALLOWED: ReadonlyArray<readonly [SkuStatusValue, SkuStatusValue]> = [
  ['DRAFT', 'PENDING_APPROVAL'], // 05 v0.1 §11.2 승인요청
  ['DRAFT', 'ARCHIVED'],
  ['PENDING_APPROVAL', 'ACTIVE'], // 05 v0.2 approve (상태=PENDING)
  ['PENDING_APPROVAL', 'REJECTED'], // 05 v0.1 §11.3 PENDING → ACTIVE / REJECTED
  ['REJECTED', 'ARCHIVED'],
  ['ACTIVE', 'INACTIVE'], // 05 v0.1 §11.2 사용중지
  ['ACTIVE', 'ARCHIVED'],
  ['INACTIVE', 'ARCHIVED'],
  ['DISCONTINUED', 'ARCHIVED'],
];

function isDocumentedAllowed(from: SkuStatusValue, to: SkuStatusValue): boolean {
  return DOCUMENTED_ALLOWED.some(([f, t]) => f === from && t === to);
}

describe('★ SKU 상태 전이 (T1-2)', () => {
  it('상태 7종이 빠짐없이 정의되어 있고 전이표가 전부를 키로 가진다', () => {
    expect(SKU_STATUSES).toEqual([
      'DRAFT',
      'PENDING_APPROVAL',
      'REJECTED',
      'ACTIVE',
      'INACTIVE',
      'DISCONTINUED',
      'ARCHIVED',
    ]);
    expect(Object.keys(SKU_STATUS_TRANSITIONS).sort()).toEqual([...SKU_STATUSES].sort());
  });

  // ★ 7×7 = 49 경로 전수 — 빠진 경로가 없도록 matrix 로 돈다.
  describe('★ 7×7 전체 matrix', () => {
    for (const from of SKU_STATUSES) {
      for (const to of SKU_STATUSES) {
        const allowed = isDocumentedAllowed(from, to);
        it(`${from} → ${to} : ${allowed ? '허용' : '차단'}`, () => {
          expect(canTransitionSkuStatus(from, to)).toBe(allowed);

          if (allowed) {
            expect(() => assertSkuStatusTransition(from, to)).not.toThrow();
          } else {
            try {
              assertSkuStatusTransition(from, to);
              expect.unreachable('차단되어야 한다');
            } catch (error) {
              expect(error).toBeInstanceOf(DomainError);
              const domainError = error as DomainError;
              expect(domainError.code).toBe(ERROR_CODES.INVALID_STATUS_TRANSITION);
              expect(domainError.httpStatus).toBe(422);
              expect(domainError.publicDetails).toEqual({ from, to });
            }
          }
        });
      }
    }
  });

  it('★ 동일 상태 → 동일 상태는 no-op 전이로 허용하지 않는다 (근거 없음)', () => {
    for (const status of SKU_STATUSES) {
      expect(canTransitionSkuStatus(status, status), status).toBe(false);
    }
  });

  it('★ ARCHIVED 는 terminal — 나가는 전이가 0개다 (복구 규칙 미문서화)', () => {
    expect(SKU_STATUS_TRANSITIONS.ARCHIVED).toEqual([]);
    for (const to of SKU_STATUSES) {
      expect(canTransitionSkuStatus('ARCHIVED', to), `ARCHIVED → ${to}`).toBe(false);
    }
  });

  it('★ DISCONTINUED — 문서 근거 있는 전이(→ ARCHIVED)만 허용, 진입 전이 없음', () => {
    // INACTIVE 별칭이 아니다: INACTIVE 와 전이 집합이 같아도 상태 자체는 구분된다.
    expect(SKU_STATUS_TRANSITIONS.DISCONTINUED).toEqual(['ARCHIVED']);
    // 진입 전이 미문서화 — 어느 상태에서도 DISCONTINUED 로 갈 수 없다.
    for (const from of SKU_STATUSES) {
      expect(canTransitionSkuStatus(from, 'DISCONTINUED'), `${from} → DISCONTINUED`).toBe(false);
    }
  });

  it('★ 미문서화 전이가 임의로 열려 있지 않다 (지시된 금지 목록)', () => {
    expect(canTransitionSkuStatus('REJECTED', 'DRAFT')).toBe(false);
    expect(canTransitionSkuStatus('REJECTED', 'PENDING_APPROVAL')).toBe(false);
    expect(canTransitionSkuStatus('INACTIVE', 'ACTIVE')).toBe(false);
    expect(canTransitionSkuStatus('ACTIVE', 'DISCONTINUED')).toBe(false);
    expect(canTransitionSkuStatus('DISCONTINUED', 'ACTIVE')).toBe(false);
  });

  it('차단 오류의 publicHint 가 가능한 전이를 안내한다', () => {
    try {
      assertSkuStatusTransition('ACTIVE', 'ACTIVE');
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).publicHint).toContain('이미 해당 상태');
    }
    try {
      assertSkuStatusTransition('INACTIVE', 'ACTIVE');
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).publicHint).toContain('ARCHIVED');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// TC-SKU-007 — 거래 발생 후 SKU 코드 변경 불가
// ═══════════════════════════════════════════════════════════════
describe('★ TC-SKU-007 — SKU 코드 불변식', () => {
  it('★ hasTransaction=false → 다른 코드로 변경 허용', () => {
    const input = {
      hasTransaction: false,
      currentSkuCode: 'FB-HC-SH-001',
      nextSkuCode: 'FB-HC-SH-002',
    };
    expect(canChangeSkuCode(input)).toBe(true);
    expect(() => assertSkuCodeChangeAllowed(input)).not.toThrow();
  });

  it('★ hasTransaction=true + 동일 코드 → "변경"이 아니므로 허용', () => {
    const input = {
      hasTransaction: true,
      currentSkuCode: 'FB-HC-SH-001',
      nextSkuCode: 'FB-HC-SH-001',
    };
    expect(canChangeSkuCode(input)).toBe(true);
    expect(() => assertSkuCodeChangeAllowed(input)).not.toThrow();
  });

  it('★ hasTransaction=true + 다른 코드 → SKU_CODE_IMMUTABLE / 422', () => {
    try {
      assertSkuCodeChangeAllowed({
        hasTransaction: true,
        currentSkuCode: 'FB-HC-SH-001',
        nextSkuCode: 'FB-HC-SH-999',
      });
      expect.unreachable('차단되어야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe(ERROR_CODES.SKU_CODE_IMMUTABLE);
      expect(domainError.httpStatus).toBe(422);
      expect(domainError.publicDetails).toEqual({ currentSkuCode: 'FB-HC-SH-001' });
    }
  });

  it('★ 대소문자·공백을 임의로 접지 않는다 — 정규화는 이 규칙의 책임이 아니다', () => {
    // 앞뒤 공백이 다르면 "다른 코드" — hasTransaction=true 면 차단된다.
    // (canonical 형식 자체는 DB CHECK · 입력 validation 책임)
    expect(
      canChangeSkuCode({
        hasTransaction: true,
        currentSkuCode: 'ABC',
        nextSkuCode: ' ABC ',
      }),
    ).toBe(false);

    // 대소문자가 다르면 "다른 코드"
    expect(
      canChangeSkuCode({
        hasTransaction: true,
        currentSkuCode: 'ABC',
        nextSkuCode: 'abc',
      }),
    ).toBe(false);

    // hasTransaction=false 라면 어느 쪽이든 도메인 규칙은 허용한다 (중복·형식은 DB/validation 몫)
    expect(
      canChangeSkuCode({
        hasTransaction: false,
        currentSkuCode: 'ABC',
        nextSkuCode: 'abc',
      }),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// TC-SKU-008 — ARCHIVED 는 거래·BOM 사용 이력 0건일 때만
// ═══════════════════════════════════════════════════════════════
describe('★ TC-SKU-008 — SKU 폐기 자격', () => {
  it('★ 거래X / BOMX → 폐기 가능', () => {
    const facts = { hasTransaction: false, hasBomUsage: false };
    expect(canArchiveSku(facts)).toBe(true);
    expect(skuArchiveBlockers(facts)).toEqual([]);
    expect(() => assertSkuArchivable(facts)).not.toThrow();
  });

  it('★ 거래O / BOMX → 차단 (blockers=[TRANSACTION])', () => {
    const facts = { hasTransaction: true, hasBomUsage: false };
    expect(canArchiveSku(facts)).toBe(false);
    try {
      assertSkuArchivable(facts);
      expect.unreachable();
    } catch (error) {
      const domainError = error as DomainError;
      expect(domainError.code).toBe(ERROR_CODES.SKU_ARCHIVE_BLOCKED);
      expect(domainError.httpStatus).toBe(422);
      expect(domainError.publicDetails).toEqual({ blockers: ['TRANSACTION'] });
    }
  });

  it('★ 거래X / BOMO → 차단 (blockers=[BOM_USAGE])', () => {
    const facts = { hasTransaction: false, hasBomUsage: true };
    expect(canArchiveSku(facts)).toBe(false);
    try {
      assertSkuArchivable(facts);
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).publicDetails).toEqual({ blockers: ['BOM_USAGE'] });
    }
  });

  it('★ 거래O / BOMO → 차단 (blockers 둘 다)', () => {
    const facts = { hasTransaction: true, hasBomUsage: true };
    expect(canArchiveSku(facts)).toBe(false);
    try {
      assertSkuArchivable(facts);
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).publicDetails).toEqual({
        blockers: ['TRANSACTION', 'BOM_USAGE'],
      });
    }
  });

  it('★ 상태 전이 허용과 폐기 자격은 별개다 — 둘 다 통과해야 폐기된다', () => {
    // 상태상 ACTIVE → ARCHIVED 전이는 허용되지만,
    expect(canTransitionSkuStatus('ACTIVE', 'ARCHIVED')).toBe(true);
    // 사용 이력이 있으면 자격 규칙이 차단한다.
    expect(canArchiveSku({ hasTransaction: true, hasBomUsage: false })).toBe(false);

    // 반대로 자격이 있어도 상태상 불가하면 (ARCHIVED → ARCHIVED) 전이 규칙이 차단한다.
    expect(canArchiveSku({ hasTransaction: false, hasBomUsage: false })).toBe(true);
    expect(canTransitionSkuStatus('ARCHIVED', 'ARCHIVED')).toBe(false);
  });
});
