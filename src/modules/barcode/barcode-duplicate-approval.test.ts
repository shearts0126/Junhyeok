import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import { ERROR_CODES, httpStatusForCode, isKnownErrorCode } from '@/shared/errors';

import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from '../../../prisma/seed/roles';

import {
  BARCODE_ALL_STATUSES,
  BARCODE_APPROVE_DUPLICATE_ACTION,
  BARCODE_APPROVE_DUPLICATE_PERMISSION,
  BARCODE_CANDIDATE_ROUTE_SCOPE,
  BARCODE_REQUEST_DUPLICATE_ACTION,
  BARCODE_REQUEST_DUPLICATE_PERMISSION,
  BARCODE_STATUS_PENDING_DUPLICATE,
  BARCODE_STATUSES,
  barcodeCandidateRequestHash,
  parseApproveDuplicateInput,
  parseRequestDuplicateCandidateInput,
  parseUpdateBarcodeInput,
  resolveBarcodeUniqueViolation,
} from './application';

/**
 * 바코드 중복 예외 승인 단위 테스트 (T04-4A).
 *
 * 계약 근거는 `docs/11_설계복구_Barcode중복예외승인.md` 뿐이다.
 * DB 가 필요한 서비스 동작·동시성은 `tests/db/barcode-duplicate-approval.test.ts` 에서
 * 실 PostgreSQL 로 본다.
 */

const SKU_ID = '11111111-1111-4111-8111-111111111111';
const BARCODE_ID = '22222222-2222-4222-8222-222222222222';

// ═══════════════════════════════════════════════════════════════
// §3 권한 · §4 route policy 우선순위
// ═══════════════════════════════════════════════════════════════

describe('★ 중복 예외 권한 — 요청과 승인은 서로 다른 capability', () => {
  const keys = PERMISSION_SEED.map((row) => row.permissionKey);
  const rolesOf = (key: string) =>
    ROLE_PERMISSION_SEED.filter((row) => row.permissionKey === key)
      .map((row) => row.roleCode)
      .sort();

  it('permission 키 2종이 시드에 있다', () => {
    expect(BARCODE_REQUEST_DUPLICATE_PERMISSION).toBe('barcode.request_duplicate');
    expect(BARCODE_APPROVE_DUPLICATE_PERMISSION).toBe('barcode.approve_duplicate');
    expect(keys).toContain(BARCODE_REQUEST_DUPLICATE_PERMISSION);
    expect(keys).toContain(BARCODE_APPROVE_DUPLICATE_PERMISSION);
  });

  it('요청은 S·L·A, 승인은 L·A 다 — 역할집합이 다르다', () => {
    expect(rolesOf(BARCODE_REQUEST_DUPLICATE_PERMISSION)).toEqual([
      'ADMIN',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    expect(rolesOf(BARCODE_APPROVE_DUPLICATE_PERMISSION)).toEqual(['ADMIN', 'SCM_LEADER']);
  });

  it('★ 기존 barcode.* CRUD 권한의 역할 배정이 바뀌지 않았다', () => {
    expect(rolesOf('barcode.read')).toEqual([
      'ADMIN',
      'EXECUTIVE',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    for (const key of ['barcode.create', 'barcode.update', 'barcode.deactivate']) {
      expect(rolesOf(key), key).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    }
  });
});

describe('★ route policy — 중복 예외 경로가 일반 바코드 정책보다 앞선다', () => {
  const candidates = `/api/skus/${SKU_ID}/barcodes/duplicate-candidates`;
  const approve = `/api/skus/${SKU_ID}/barcodes/${BARCODE_ID}/approve-duplicate`;

  it('candidate POST 는 barcode.request_duplicate 다', () => {
    expect(resolveRoutePermission({ pathname: candidates, method: 'POST' })).toBe(
      'barcode.request_duplicate',
    );
  });

  it('approve POST 는 barcode.approve_duplicate 다', () => {
    expect(resolveRoutePermission({ pathname: approve, method: 'POST' })).toBe(
      'barcode.approve_duplicate',
    );
  });

  it('★ barcode.create 로 fall-through 하지 않는다 — 승인 통제가 무너지면 안 된다', () => {
    for (const pathname of [candidates, approve]) {
      const permission = resolveRoutePermission({ pathname, method: 'POST' });
      expect(permission, pathname).not.toBe('barcode.create');
      expect(permission, pathname).not.toBe('sku.create');
      expect(permission, pathname).not.toBe('sku.update');
    }
  });

  it('★ T04-3 바코드 CRUD 매칭은 그대로다 — 회귀 없음', () => {
    const collection = `/api/skus/${SKU_ID}/barcodes`;
    const item = `${collection}/${BARCODE_ID}`;
    expect(resolveRoutePermission({ pathname: collection, method: 'GET' })).toBe('barcode.read');
    expect(resolveRoutePermission({ pathname: collection, method: 'POST' })).toBe('barcode.create');
    expect(resolveRoutePermission({ pathname: item, method: 'PATCH' })).toBe('barcode.update');
    expect(resolveRoutePermission({ pathname: item, method: 'DELETE' })).toBe('barcode.deactivate');
  });
});

// ═══════════════════════════════════════════════════════════════
// §4 status
// ═══════════════════════════════════════════════════════════════

describe('★ PENDING_DUPLICATE status', () => {
  it('업무 status 는 3종이지만 일반 PATCH DTO 는 여전히 2종만 받는다', () => {
    expect(BARCODE_STATUS_PENDING_DUPLICATE).toBe('PENDING_DUPLICATE');
    expect(BARCODE_ALL_STATUSES).toEqual(['ACTIVE', 'INACTIVE', 'PENDING_DUPLICATE']);
    expect(BARCODE_STATUSES).toEqual(['ACTIVE', 'INACTIVE']);
  });

  it('★ 일반 PATCH 로 PENDING_DUPLICATE 를 직접 지정할 수 없다 (400)', () => {
    expect(() => parseUpdateBarcodeInput({ status: 'PENDING_DUPLICATE' })).toThrow(/올바르지/);
  });

  it('VARCHAR(20) 안에 들어간다 — 컬럼 변경이 필요 없다', () => {
    expect(BARCODE_STATUS_PENDING_DUPLICATE.length).toBeLessThanOrEqual(20);
  });
});

// ═══════════════════════════════════════════════════════════════
// §5 candidate DTO
// ═══════════════════════════════════════════════════════════════

describe('★ candidate 요청 DTO — T04-3 POST 와 동일한 최소 strict 계약', () => {
  it('정상 body 를 통과시킨다', () => {
    expect(
      parseRequestDuplicateCandidateInput({ barcode: '8809619960499', barcodeType: 'UNIT' }),
    ).toEqual({ barcode: '8809619960499', barcodeType: 'UNIT' });
    expect(
      parseRequestDuplicateCandidateInput({
        barcode: '880',
        barcodeType: 'CHANNEL',
        isPrimary: true,
      }),
    ).toEqual({ barcode: '880', barcodeType: 'CHANNEL', isPrimary: true });
  });

  it('★ unknown field·server-managed·T04-4 필드 주입은 전부 400 이다', () => {
    for (const extra of [
      { status: 'PENDING_DUPLICATE' },
      { duplicateException: true },
      { exceptionReason: '사유' },
      { approvedBy: SKU_ID },
      { skuId: SKU_ID },
      { reason: '사유' },
      { countryCode: 'KR' },
    ]) {
      expect(
        () =>
          parseRequestDuplicateCandidateInput({ barcode: '880', barcodeType: 'UNIT', ...extra }),
        JSON.stringify(extra),
      ).toThrow(/올바르지/);
    }
  });

  it('barcode 는 문자열 전용, barcodeType 은 필수다', () => {
    expect(() =>
      parseRequestDuplicateCandidateInput({ barcode: 8809619960499, barcodeType: 'UNIT' }),
    ).toThrow(/올바르지/);
    expect(() => parseRequestDuplicateCandidateInput({ barcode: '880' })).toThrow(/올바르지/);
  });
});

// ═══════════════════════════════════════════════════════════════
// §13 approval DTO
// ═══════════════════════════════════════════════════════════════

describe('★ 승인 DTO — {reason} 필수, trim 저장', () => {
  it('reason 을 trim 해서 돌려준다', () => {
    expect(parseApproveDuplicateInput({ reason: '  채널 공용 바코드  ' })).toEqual({
      reason: '채널 공용 바코드',
    });
  });

  it('★ 공백만 있는 reason 은 400 이다', () => {
    for (const blank of ['', '   ', '\t', '\n ']) {
      expect(() => parseApproveDuplicateInput({ reason: blank }), JSON.stringify(blank)).toThrow(
        /올바르지/,
      );
    }
  });

  it('reason 누락·비문자열은 400 이다', () => {
    expect(() => parseApproveDuplicateInput({})).toThrow(/올바르지/);
    expect(() => parseApproveDuplicateInput({ reason: 1 })).toThrow(/올바르지/);
  });

  it('★ unknown field 는 400 이다', () => {
    for (const extra of [
      { approvedBy: SKU_ID },
      { status: 'ACTIVE' },
      { duplicateException: true },
    ]) {
      expect(
        () => parseApproveDuplicateInput({ reason: '사유', ...extra }),
        JSON.stringify(extra),
      ).toThrow(/올바르지/);
    }
  });

  it('★ 임의 최대 길이를 두지 않았다 — 긴 사유도 통과한다', () => {
    const long = '가'.repeat(5000);
    expect(parseApproveDuplicateInput({ reason: long })).toEqual({ reason: long });
  });
});

// ═══════════════════════════════════════════════════════════════
// §29 오류 카탈로그
// ═══════════════════════════════════════════════════════════════

describe('★ 신규 public error code 4종', () => {
  it('카탈로그에 등록되고 상태코드가 계약대로다', () => {
    const expected: ReadonlyArray<readonly [string, number]> = [
      [ERROR_CODES.BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE, 422],
      [ERROR_CODES.BARCODE_DUPLICATE_CANDIDATE_EXISTS, 409],
      [ERROR_CODES.BARCODE_DUPLICATE_APPROVAL_INVALID_STATE, 422],
      [ERROR_CODES.BARCODE_DUPLICATE_APPROVAL_PENDING, 422],
    ];
    for (const [code, status] of expected) {
      expect(isKnownErrorCode(code), code).toBe(true);
      expect(httpStatusForCode(code), code).toBe(status);
    }
  });

  it('★ 기존 바코드 코드는 그대로 재사용된다 — 의미 재정의 없음', () => {
    expect(httpStatusForCode(ERROR_CODES.BARCODE_DUPLICATE)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.BARCODE_PRIMARY_CONFLICT)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.BARCODE_UNVERIFIED)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.IDEMPOTENCY_KEY_REUSED)).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════
// §8 세 번째 partial UNIQUE 구분
// ═══════════════════════════════════════════════════════════════

function p2002(meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta,
  });
}

describe('★ P2002 → 세 조건부 UNIQUE 구분', () => {
  it('★ (sku_id, barcode) 2컬럼은 ux_barcode_pending_duplicate 다', () => {
    expect(
      resolveBarcodeUniqueViolation(
        p2002({
          driverAdapterError: { cause: { constraint: { fields: ['sku_id', 'barcode'] } } },
        }),
      ),
    ).toBe('ux_barcode_pending_duplicate');
    // 컬럼 순서가 바뀌어도 동일하게 판정한다.
    expect(resolveBarcodeUniqueViolation(p2002({ target: ['barcode', 'sku_id'] }))).toBe(
      'ux_barcode_pending_duplicate',
    );
  });

  it('★ 단일 컬럼 판정이 회귀하지 않았다', () => {
    expect(resolveBarcodeUniqueViolation(p2002({ target: ['barcode'] }))).toBe('ux_barcode_active');
    expect(resolveBarcodeUniqueViolation(p2002({ target: ['sku_id'] }))).toBe('ux_barcode_primary');
  });

  it('메시지 fallback 도 3종을 구분한다', () => {
    const withMessage = (name: string) =>
      p2002({
        driverAdapterError: {
          cause: { originalMessage: `duplicate key value violates unique constraint "${name}"` },
        },
      });
    expect(resolveBarcodeUniqueViolation(withMessage('ux_barcode_pending_duplicate'))).toBe(
      'ux_barcode_pending_duplicate',
    );
    expect(resolveBarcodeUniqueViolation(withMessage('ux_barcode_active'))).toBe(
      'ux_barcode_active',
    );
    expect(resolveBarcodeUniqueViolation(withMessage('ux_barcode_primary'))).toBe(
      'ux_barcode_primary',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// §10 멱등 · §11·§22 AuditLog action
// ═══════════════════════════════════════════════════════════════

describe('★ candidate 멱등 scope·hash', () => {
  it('routeScope 는 route template 이며 raw UUID 를 포함하지 않는다', () => {
    expect(BARCODE_CANDIDATE_ROUTE_SCOPE).toBe('/api/skus/{id}/barcodes/duplicate-candidates');
    expect(BARCODE_CANDIDATE_ROUTE_SCOPE).not.toContain(SKU_ID);
  });

  it('hash 는 skuId 를 포함하고 정규화 전 원 입력 기준이다', () => {
    const input = { barcode: '001234', barcodeType: 'UNIT' } as const;
    const other = '33333333-3333-4333-8333-333333333333';
    expect(barcodeCandidateRequestHash(SKU_ID, input)).not.toBe(
      barcodeCandidateRequestHash(other, input),
    );
    expect(barcodeCandidateRequestHash(SKU_ID, input)).not.toBe(
      barcodeCandidateRequestHash(SKU_ID, { barcode: '001-234', barcodeType: 'UNIT' }),
    );
    expect(barcodeCandidateRequestHash(SKU_ID, input)).toBe(
      barcodeCandidateRequestHash(SKU_ID, input),
    );
  });
});

describe('★ AuditLog action naming', () => {
  it('요청·승인 action 이 기존 대문자 스네이크 convention 을 따른다', () => {
    expect(BARCODE_REQUEST_DUPLICATE_ACTION).toBe('REQUEST_DUPLICATE');
    expect(BARCODE_APPROVE_DUPLICATE_ACTION).toBe('APPROVE_DUPLICATE');
    for (const action of [BARCODE_REQUEST_DUPLICATE_ACTION, BARCODE_APPROVE_DUPLICATE_ACTION]) {
      expect(action, action).toMatch(/^[A-Z_]+$/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// §27 범위 고정
// ═══════════════════════════════════════════════════════════════

describe('★ T04-4A 범위 고정 — UI 미착수', () => {
  it('바코드 UI 탭·승인대기 화면이 없다 (T04-4B / T1-6B)', async () => {
    const { readdir } = await import('node:fs/promises');
    const master = await readdir(new URL('../../app/master/skus', import.meta.url).pathname);
    expect(master.sort()).not.toContain('approvals');
    expect(master.filter((entry) => entry.includes('barcode'))).toEqual([]);
  });
});
