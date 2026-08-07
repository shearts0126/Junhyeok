import { describe, expect, it } from 'vitest';

import { AppError, ERROR_CODES } from '@/shared/errors';

import {
  ALWAYS_SEPARATED_WORKFLOWS,
  APPROVAL_WORKFLOWS,
  assertApprovalActor,
  canSelfApprove,
  type ApprovalWorkflow,
  type SelfApprovalSettings,
} from './domain/self-approval';

/**
 * 자기승인 정책 테스트 (T0-7).
 *
 * 핵심은 **재고 3종이 설정을 읽지 않는다**는 것이다.
 * 설정으로 열 수 있게 두면 언젠가 열린다.
 */

const BOTH_OFF: SelfApprovalSettings = {
  allowSelfApprovalSku: false,
  allowSelfApprovalBom: false,
};
const BOTH_ON: SelfApprovalSettings = {
  allowSelfApprovalSku: true,
  allowSelfApprovalBom: true,
};

const REQUESTER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('canSelfApprove — SKU·BOM 은 설정을 따른다', () => {
  it('SKU 설정 false → 불가', () => {
    expect(canSelfApprove({ workflow: 'SKU', settings: BOTH_OFF })).toBe(false);
  });

  it('SKU 설정 true → 가능', () => {
    expect(canSelfApprove({ workflow: 'SKU', settings: BOTH_ON })).toBe(true);
  });

  it('BOM 설정 false → 불가', () => {
    expect(canSelfApprove({ workflow: 'BOM', settings: BOTH_OFF })).toBe(false);
  });

  it('BOM 설정 true → 가능', () => {
    expect(canSelfApprove({ workflow: 'BOM', settings: BOTH_ON })).toBe(true);
  });

  it('★ SKU 와 BOM 설정이 서로 독립이다', () => {
    const skuOnly: SelfApprovalSettings = {
      allowSelfApprovalSku: true,
      allowSelfApprovalBom: false,
    };
    expect(canSelfApprove({ workflow: 'SKU', settings: skuOnly })).toBe(true);
    expect(canSelfApprove({ workflow: 'BOM', settings: skuOnly })).toBe(false);

    const bomOnly: SelfApprovalSettings = {
      allowSelfApprovalSku: false,
      allowSelfApprovalBom: true,
    };
    expect(canSelfApprove({ workflow: 'SKU', settings: bomOnly })).toBe(false);
    expect(canSelfApprove({ workflow: 'BOM', settings: bomOnly })).toBe(true);
  });
});

describe('★ canSelfApprove — 재고 3종은 항상 false', () => {
  const ALWAYS_FALSE: readonly ApprovalWorkflow[] = [
    'INVENTORY_ADJUSTMENT',
    'NEGATIVE_STOCK_EXCEPTION',
    'INVENTORY_CLOSE_REOPEN',
  ];

  it.each(ALWAYS_FALSE)('%s 은 설정과 무관하게 false', (workflow) => {
    expect(canSelfApprove({ workflow, settings: BOTH_OFF })).toBe(false);
    expect(canSelfApprove({ workflow, settings: BOTH_ON })).toBe(false);
  });

  it('ALWAYS_SEPARATED_WORKFLOWS 목록과 일치한다', () => {
    expect([...ALWAYS_SEPARATED_WORKFLOWS]).toEqual([...ALWAYS_FALSE]);
  });

  it('워크플로 5종이 모두 정의되어 있다', () => {
    expect([...APPROVAL_WORKFLOWS]).toEqual([
      'SKU',
      'BOM',
      'INVENTORY_ADJUSTMENT',
      'NEGATIVE_STOCK_EXCEPTION',
      'INVENTORY_CLOSE_REOPEN',
    ]);
  });
});

describe('assertApprovalActor', () => {
  it('★ requesterId 와 approverId 가 다르면 항상 통과한다', () => {
    for (const workflow of APPROVAL_WORKFLOWS) {
      expect(() =>
        assertApprovalActor({
          requesterId: REQUESTER,
          approverId: OTHER,
          workflow,
          settings: BOTH_OFF,
        }),
      ).not.toThrow();
    }
  });

  it('SKU 설정이 켜져 있으면 자기승인이 통과한다', () => {
    expect(() =>
      assertApprovalActor({
        requesterId: REQUESTER,
        approverId: REQUESTER,
        workflow: 'SKU',
        settings: BOTH_ON,
      }),
    ).not.toThrow();
  });

  it('★ 금지된 자기승인은 SELF_APPROVAL_FORBIDDEN 403', () => {
    try {
      assertApprovalActor({
        requesterId: REQUESTER,
        approverId: REQUESTER,
        workflow: 'SKU',
        settings: BOTH_OFF,
      });
      throw new Error('오류가 발생하지 않았습니다.');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(ERROR_CODES.SELF_APPROVAL_FORBIDDEN);
      expect(appError.httpStatus).toBe(403);
    }
  });

  it('★ 재고 3종은 설정이 모두 켜져 있어도 SELF_APPROVAL_FORBIDDEN', () => {
    for (const workflow of ALWAYS_SEPARATED_WORKFLOWS) {
      try {
        assertApprovalActor({
          requesterId: REQUESTER,
          approverId: REQUESTER,
          workflow,
          settings: BOTH_ON,
        });
        throw new Error(`${workflow}: 오류가 발생하지 않았습니다.`);
      } catch (error) {
        const appError = error as AppError;
        expect(appError.code, workflow).toBe(ERROR_CODES.SELF_APPROVAL_FORBIDDEN);
        expect(appError.context?.['alwaysSeparated'], workflow).toBe(true);
      }
    }
  });

  it('내부 식별자는 로그 전용 context 에만 담긴다', () => {
    try {
      assertApprovalActor({
        requesterId: REQUESTER,
        approverId: REQUESTER,
        workflow: 'BOM',
        settings: BOTH_OFF,
      });
      throw new Error('오류가 발생하지 않았습니다.');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.context?.['requesterId']).toBe(REQUESTER);
      expect(appError.publicDetails).toBeUndefined();
      expect(appError.publicHint).toBe('요청자와 다른 사용자가 승인해야 합니다.');
    }
  });

  it('★ ADMIN 예외가 없다 — 역할을 인자로 받지 않는다', () => {
    // 함수 시그니처에 역할이 없다는 것 자체가 예외 불가능을 보장한다.
    const input = {
      requesterId: REQUESTER,
      approverId: REQUESTER,
      workflow: 'INVENTORY_ADJUSTMENT' as const,
      settings: BOTH_ON,
    };
    expect(Object.keys(input).sort()).toEqual([
      'approverId',
      'requesterId',
      'settings',
      'workflow',
    ]);
    expect(() => assertApprovalActor(input)).toThrow();
  });
});
