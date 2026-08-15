import { describe, expect, it } from 'vitest';

import { ConflictError, DomainError, ERROR_CODES } from '@/shared/errors';

import { selectEffectiveBom } from './domain/effective-selection';
import {
  assertAllRequiredQuantitiesConfirmed,
  assertComponentEligible,
  assertNotSelfComponent,
  assertParentEligible,
  assertQuantityConsistency,
  assertUomMatchesBase,
  isPositiveDecimalString,
} from './domain/line-rules';

/**
 * BOM 도메인 검증규칙 단위 테스트 (T07-2).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-10(소요량) · §D-11(UOM) · §D-12(자격) · §D-22(선택).
 *
 * ⛔ docs/18 이 "강제하지 않는다"고 못박은 것(parent `manufacturable`, 구성품
 *    `itemType`, `inventoryManaged=false`, `SERVICE`)은 **통과해야 한다** —
 *    규칙을 발명하지 않았음을 이 파일이 고정한다.
 */

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as DomainError).code;
  }
  throw new Error('예외가 발생하지 않았다');
}

// ═══════════════════════════════════════════════════════════════
// D-10 — 소요량 · 상태 정합
// ═══════════════════════════════════════════════════════════════

describe('Decimal 문자열 판정 (D-10)', () => {
  it('★ 0 보다 큰 십진 문자열만 통과한다 — Number() 를 쓰지 않는다', () => {
    expect(isPositiveDecimalString('1')).toBe(true);
    expect(isPositiveDecimalString('0.033333')).toBe(true);
    expect(isPositiveDecimalString('  100  ')).toBe(true);
    expect(isPositiveDecimalString('0')).toBe(false);
    expect(isPositiveDecimalString('0.000000')).toBe(false);
    expect(isPositiveDecimalString('-1')).toBe(false);
    expect(isPositiveDecimalString('1e3')).toBe(false); // 지수표기 거부
    expect(isPositiveDecimalString('')).toBe(false);
    expect(isPositiveDecimalString('abc')).toBe(false);
  });
});

describe('★ quantityStatus ↔ quantityPer 정합 (D-10)', () => {
  it('UNKNOWN 은 quantityPer 가 null 이어야 한다', () => {
    expect(() =>
      assertQuantityConsistency({ quantityPer: null, quantityStatus: 'UNKNOWN' }),
    ).not.toThrow();
    expect(
      codeOf(() => assertQuantityConsistency({ quantityPer: '1', quantityStatus: 'UNKNOWN' })),
    ).toBe(ERROR_CODES.BOM_QTY_STATUS_MISMATCH);
  });

  it('SUGGESTED · CONFIRMED 는 quantityPer 가 필요하다', () => {
    for (const status of ['SUGGESTED', 'CONFIRMED'] as const) {
      expect(() =>
        assertQuantityConsistency({ quantityPer: '0.033333', quantityStatus: status }),
      ).not.toThrow();
      expect(
        codeOf(() => assertQuantityConsistency({ quantityPer: null, quantityStatus: status })),
      ).toBe(ERROR_CODES.BOM_QTY_STATUS_MISMATCH);
    }
  });

  it('★ 0 과 음수는 BOM_QTY_INVALID 다 (TC-BOM-002)', () => {
    expect(
      codeOf(() => assertQuantityConsistency({ quantityPer: '0', quantityStatus: 'CONFIRMED' })),
    ).toBe(ERROR_CODES.BOM_QTY_INVALID);
    expect(
      codeOf(() => assertQuantityConsistency({ quantityPer: '-1', quantityStatus: 'CONFIRMED' })),
    ).toBe(ERROR_CODES.BOM_QTY_INVALID);
  });

  it('★ 값을 채우지 않는다 — 자동 1 입력 금지 (TC-BOM-010)', () => {
    const line = { quantityPer: null, quantityStatus: 'UNKNOWN' as const };
    assertQuantityConsistency(line);
    // 판정 함수는 입력을 변형하지 않는다.
    expect(line.quantityPer).toBeNull();
  });
});

describe('★ submit 게이트 (D-10)', () => {
  it('isRequired 라인이 전부 CONFIRMED 면 통과한다', () => {
    expect(() =>
      assertAllRequiredQuantitiesConfirmed([
        { quantityPer: '1', quantityStatus: 'CONFIRMED', isRequired: true, lineNo: 1 },
        { quantityPer: '2', quantityStatus: 'CONFIRMED', lineNo: 2 }, // isRequired 기본 true
      ]),
    ).not.toThrow();
  });

  it('미확정 라인이 있으면 BOM_QTY_UNCONFIRMED 다', () => {
    const code = codeOf(() =>
      assertAllRequiredQuantitiesConfirmed([
        { quantityPer: '1', quantityStatus: 'CONFIRMED', lineNo: 1 },
        { quantityPer: null, quantityStatus: 'UNKNOWN', lineNo: 2 },
      ]),
    );
    expect(code).toBe(ERROR_CODES.BOM_QTY_UNCONFIRMED);
  });

  it('★ isRequired=false 라인은 게이트 대상이 아니다', () => {
    expect(() =>
      assertAllRequiredQuantitiesConfirmed([
        { quantityPer: '1', quantityStatus: 'CONFIRMED', isRequired: true, lineNo: 1 },
        { quantityPer: null, quantityStatus: 'UNKNOWN', isRequired: false, lineNo: 2 },
      ]),
    ).not.toThrow();
  });

  it('SUGGESTED 도 확정이 아니다 — 사람이 수락해야 CONFIRMED 다', () => {
    expect(
      codeOf(() =>
        assertAllRequiredQuantitiesConfirmed([
          { quantityPer: '0.033333', quantityStatus: 'SUGGESTED', lineNo: 1 },
        ]),
      ),
    ).toBe(ERROR_CODES.BOM_QTY_UNCONFIRMED);
  });

  it('빈 라인 목록은 통과한다', () => {
    expect(() => assertAllRequiredQuantitiesConfirmed([])).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// D-11 — UOM
// ═══════════════════════════════════════════════════════════════

describe('★ UOM 은 SKU baseUom 과 같아야 한다 (D-11)', () => {
  it('같으면 통과한다', () => {
    expect(() => assertUomMatchesBase({ uom: 'EA', baseUom: 'EA' })).not.toThrow();
  });

  it('다르면 BOM_UOM_MISMATCH 다 — 환산하지 않는다', () => {
    expect(codeOf(() => assertUomMatchesBase({ uom: 'BOX', baseUom: 'EA' }))).toBe(
      ERROR_CODES.BOM_UOM_MISMATCH,
    );
  });

  it('대소문자·공백도 다른 값이다 — 임의 정규화하지 않는다', () => {
    expect(codeOf(() => assertUomMatchesBase({ uom: 'ea', baseUom: 'EA' }))).toBe(
      ERROR_CODES.BOM_UOM_MISMATCH,
    );
    expect(codeOf(() => assertUomMatchesBase({ uom: 'EA ', baseUom: 'EA' }))).toBe(
      ERROR_CODES.BOM_UOM_MISMATCH,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// D-12 — 구성품 자격
// ═══════════════════════════════════════════════════════════════

describe('★ 자기참조 금지 (D-12 · TC-BOM-001)', () => {
  it('parent == component 면 BOM_SELF_COMPONENT 다', () => {
    expect(codeOf(() => assertNotSelfComponent({ parentSkuId: 'A', componentSkuId: 'A' }))).toBe(
      ERROR_CODES.BOM_SELF_COMPONENT,
    );
  });

  it('다르면 통과한다', () => {
    expect(() => assertNotSelfComponent({ parentSkuId: 'A', componentSkuId: 'B' })).not.toThrow();
  });
});

describe('상위 SKU 자격 (D-12)', () => {
  it('DRAFT 만 거부한다', () => {
    expect(codeOf(() => assertParentEligible({ skuId: 'A', status: 'DRAFT' }))).toBe(
      ERROR_CODES.BOM_PARENT_NOT_ELIGIBLE,
    );
  });

  it('★ 그 밖의 status 는 전부 허용한다 — ACTIVE 로 좁히지 않는다', () => {
    for (const status of ['PENDING', 'ACTIVE', 'INACTIVE', 'ARCHIVED', 'REJECTED']) {
      expect(() => assertParentEligible({ skuId: 'A', status })).not.toThrow();
    }
  });
});

describe('구성품 SKU 자격 (D-12)', () => {
  it('ARCHIVED 만 거부한다', () => {
    expect(codeOf(() => assertComponentEligible({ skuId: 'B', status: 'ARCHIVED' }))).toBe(
      ERROR_CODES.BOM_COMPONENT_NOT_ELIGIBLE,
    );
  });

  it('★ DRAFT 구성품도 허용한다 — 근거 없는 제한을 만들지 않는다', () => {
    for (const status of ['DRAFT', 'PENDING', 'ACTIVE', 'INACTIVE']) {
      expect(() => assertComponentEligible({ skuId: 'B', status })).not.toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// D-22 — 유효 BOM 선택
// ═══════════════════════════════════════════════════════════════

describe('★ 유효 BOM 선택 0/1/2+ (D-22)', () => {
  const ctx = { parentSkuId: 'A', asOf: '2026-08-15' };

  it('0건은 null 이다 — 오류가 아니다', () => {
    expect(selectEffectiveBom([], ctx)).toBeNull();
  });

  it('1건은 그대로 반환한다', () => {
    expect(selectEffectiveBom([{ id: 'bom-1' }], ctx)).toEqual({ id: 'bom-1' });
  });

  it('★ 2건 이상은 409 BOM_EFFECTIVE_CONFLICT 다 — LIMIT 1 로 숨기지 않는다', () => {
    let caught: unknown;
    try {
      selectEffectiveBom([{ id: 'bom-1' }, { id: 'bom-2' }], ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const error = caught as ConflictError;
    expect(error.code).toBe(ERROR_CODES.BOM_EFFECTIVE_CONFLICT);
    expect(error.httpStatus).toBe(409);
    // 손상이므로 재시도로 해소되지 않는다.
    expect(error.retryable).toBe(false);
    expect((error.context as { candidateIds: string[] }).candidateIds).toEqual(['bom-1', 'bom-2']);
  });
});
