import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import { ERROR_CODES, httpStatusForCode, isKnownErrorCode } from '@/shared/errors';

import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from '../../../prisma/seed/roles';

import {
  BARCODE_CREATE_PERMISSION,
  BARCODE_CREATE_ROUTE_SCOPE,
  BARCODE_DEACTIVATE_PERMISSION,
  BARCODE_MAX_LENGTH,
  BARCODE_READ_PERMISSION,
  BARCODE_STATUSES,
  BARCODE_TYPES,
  BARCODE_UPDATE_PERMISSION,
  barcodeCreateRequestHash,
  parseBarcodeId,
  parseCreateBarcodeInput,
  parseUpdateBarcodeInput,
  resolveBarcodeInput,
  resolveBarcodeUniqueViolation,
} from './application';

/**
 * 바코드 CRUD 단위 테스트 (T04-3).
 *
 * 계약 근거는 `docs/10_설계복구_BarcodeCRUD.md` 뿐이다.
 * DB 가 필요한 서비스 동작은 `tests/db/barcode-crud.test.ts` 에서 실 PostgreSQL 로 본다.
 */

const SKU_ID = '11111111-1111-4111-8111-111111111111';
const BARCODE_ID = '22222222-2222-4222-8222-222222222222';

// ═══════════════════════════════════════════════════════════════
// route policy 우선순위 (§4) — 7번 항목
// ═══════════════════════════════════════════════════════════════

describe('★ route policy — 바코드 경로가 일반 SKU 정책보다 앞선다', () => {
  const collection = `/api/skus/${SKU_ID}/barcodes`;
  const item = `${collection}/${BARCODE_ID}`;

  it('컬렉션 경로가 메서드별 barcode.* 권한으로 매칭된다', () => {
    expect(resolveRoutePermission({ pathname: collection, method: 'GET' })).toBe('barcode.read');
    expect(resolveRoutePermission({ pathname: collection, method: 'HEAD' })).toBe('barcode.read');
    expect(resolveRoutePermission({ pathname: collection, method: 'POST' })).toBe('barcode.create');
  });

  it('단건 경로도 메서드별 barcode.* 권한으로 매칭된다', () => {
    expect(resolveRoutePermission({ pathname: item, method: 'PATCH' })).toBe('barcode.update');
    expect(resolveRoutePermission({ pathname: item, method: 'DELETE' })).toBe('barcode.deactivate');
    expect(resolveRoutePermission({ pathname: item, method: 'GET' })).toBe('barcode.read');
  });

  it('★ generic /api/skus 정책으로 fall-through 하지 않는다', () => {
    // 이 단언이 깨지면 SKU 권한만으로 바코드를 변경할 수 있게 된다.
    for (const pathname of [collection, item]) {
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
        const permission = resolveRoutePermission({ pathname, method });
        expect(permission, `${method} ${pathname}`).not.toBe('sku.read');
        expect(permission, `${method} ${pathname}`).not.toBe('sku.create');
        expect(permission, `${method} ${pathname}`).not.toBe('sku.update');
        expect(permission, `${method} ${pathname}`).not.toBe('sku.deactivate');
        expect(permission?.startsWith('barcode.'), `${method} ${pathname}`).toBe(true);
      }
    }
  });

  it('기존 SKU 경로 매칭은 그대로다 — 회귀 없음', () => {
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'GET' })).toBe('sku.read');
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'POST' })).toBe('sku.create');
    expect(resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}`, method: 'PATCH' })).toBe(
      'sku.update',
    );
    expect(resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/submit`, method: 'POST' })).toBe(
      'sku.submit',
    );
    expect(
      resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/approve`, method: 'POST' }),
    ).toBe('sku.approve');
    expect(resolveRoutePermission({ pathname: '/api/skus/suggest-code', method: 'POST' })).toBe(
      'sku.suggest_code',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// permission seed (§3)
// ═══════════════════════════════════════════════════════════════

describe('★ 바코드 권한 — 독립 capability (sku.* 재사용 아님)', () => {
  const keys = PERMISSION_SEED.map((row) => row.permissionKey);
  const rolesOf = (key: string) =>
    ROLE_PERMISSION_SEED.filter((row) => row.permissionKey === key)
      .map((row) => row.roleCode)
      .sort();

  it('4종 permission 이 시드에 있다', () => {
    expect(keys).toContain(BARCODE_READ_PERMISSION);
    expect(keys).toContain(BARCODE_CREATE_PERMISSION);
    expect(keys).toContain(BARCODE_UPDATE_PERMISSION);
    expect(keys).toContain(BARCODE_DEACTIVATE_PERMISSION);
    expect(BARCODE_READ_PERMISSION).toBe('barcode.read');
    expect(BARCODE_CREATE_PERMISSION).toBe('barcode.create');
    expect(BARCODE_UPDATE_PERMISSION).toBe('barcode.update');
    expect(BARCODE_DEACTIVATE_PERMISSION).toBe('barcode.deactivate');
  });

  it('read 는 5개 역할 전부, 쓰기 3종은 ADMIN·SCM_LEADER·SCM_STAFF', () => {
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

  it('✏️ T04-4A 에서 중복 예외 permission 2종이 추가됐다 — CRUD 4종과 별개다', () => {
    // T04-3 시점에는 두 키가 없었다. T04-4A(docs/11 §3)에서 신설되었고,
    // 역할집합이 달라 barcode.create·barcode.update 를 재사용하지 않는다.
    expect(keys).toContain('barcode.request_duplicate');
    expect(keys).toContain('barcode.approve_duplicate');
    expect(rolesOf('barcode.request_duplicate')).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    expect(rolesOf('barcode.approve_duplicate')).toEqual(['ADMIN', 'SCM_LEADER']);
  });
});

// ═══════════════════════════════════════════════════════════════
// POST DTO (§5·§6)
// ═══════════════════════════════════════════════════════════════

describe('★ POST DTO — V1 최소 strict 계약', () => {
  it('정상 body 를 통과시킨다 (isPrimary 는 선택)', () => {
    expect(parseCreateBarcodeInput({ barcode: '8809619961373', barcodeType: 'UNIT' })).toEqual({
      barcode: '8809619961373',
      barcodeType: 'UNIT',
    });
    expect(
      parseCreateBarcodeInput({ barcode: '880', barcodeType: 'OUTER_BOX', isPrimary: true }),
    ).toEqual({ barcode: '880', barcodeType: 'OUTER_BOX', isPrimary: true });
  });

  it('barcodeType 은 필수이며 5종만 허용한다', () => {
    expect(() => parseCreateBarcodeInput({ barcode: '880' })).toThrow(/올바르지/);
    expect(BARCODE_TYPES).toEqual(['UNIT', 'INNER_BOX', 'OUTER_BOX', 'CHANNEL', 'LEGACY']);
    for (const type of BARCODE_TYPES) {
      expect(parseCreateBarcodeInput({ barcode: '880', barcodeType: type }).barcodeType).toBe(type);
    }
    for (const bad of ['EAN13', 'UPC', 'QR', 'unit']) {
      expect(() => parseCreateBarcodeInput({ barcode: '880', barcodeType: bad }), bad).toThrow();
    }
  });

  it('★ barcode 는 문자열 전용 — 숫자 JSON 은 도메인까지 가지 않고 400 이다', () => {
    for (const bad of [8809619961373, Number.NaN, null, true, ['880']]) {
      expect(
        () => parseCreateBarcodeInput({ barcode: bad, barcodeType: 'UNIT' }),
        String(bad),
      ).toThrow(/올바르지/);
    }
  });

  it('★ unknown field 는 400 이다 — 조용히 무시하지 않는다', () => {
    for (const extra of [
      { status: 'INACTIVE' },
      { skuId: SKU_ID },
      { id: BARCODE_ID },
      { createdAt: '2026-01-01T00:00:00Z' },
      { countryCode: 'KR' },
      { channelCode: 'A' },
      { effectiveFrom: '2026-01-01' },
      { effectiveTo: '2026-12-31' },
    ]) {
      expect(
        () => parseCreateBarcodeInput({ barcode: '880', barcodeType: 'UNIT', ...extra }),
        JSON.stringify(extra),
      ).toThrow(/올바르지/);
    }
  });

  it('★ T04-4 필드 주입은 항상 400 이다', () => {
    for (const extra of [
      { duplicateException: true },
      { exceptionReason: '원본 중복' },
      { approvedBy: SKU_ID },
    ]) {
      expect(
        () => parseCreateBarcodeInput({ barcode: '880', barcodeType: 'UNIT', ...extra }),
        JSON.stringify(extra),
      ).toThrow(/올바르지/);
    }
  });

  it('필드 오류 경로가 body 기준으로 보고된다', () => {
    try {
      parseCreateBarcodeInput({ barcode: 1, barcodeType: 'UNIT' });
      expect.unreachable('400 이어야 한다');
    } catch (error) {
      expect((error as { fieldErrors: { path: string }[] }).fieldErrors[0]?.path).toBe('barcode');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// PATCH DTO (§6·§7)
// ═══════════════════════════════════════════════════════════════

describe('★ PATCH DTO — isPrimary·status 만, 최소 하나 필수', () => {
  it('두 필드를 각각·함께 허용한다', () => {
    expect(parseUpdateBarcodeInput({ isPrimary: true })).toEqual({ isPrimary: true });
    expect(parseUpdateBarcodeInput({ status: 'INACTIVE' })).toEqual({ status: 'INACTIVE' });
    expect(parseUpdateBarcodeInput({ isPrimary: false, status: 'ACTIVE' })).toEqual({
      isPrimary: false,
      status: 'ACTIVE',
    });
    expect(BARCODE_STATUSES).toEqual(['ACTIVE', 'INACTIVE']);
  });

  it('★ 빈 객체는 400 이다', () => {
    expect(() => parseUpdateBarcodeInput({})).toThrow(/올바르지/);
  });

  it('★ barcode 값 수정 시도는 400 이다 — 생성 후 immutable', () => {
    expect(() => parseUpdateBarcodeInput({ barcode: '999' })).toThrow(/올바르지/);
    expect(() => parseUpdateBarcodeInput({ isPrimary: true, barcode: '999' })).toThrow(/올바르지/);
  });

  it('★ 그 밖의 필드도 전부 400 이다', () => {
    for (const patch of [
      { barcodeType: 'UNIT' },
      { countryCode: 'KR' },
      { channelCode: 'A' },
      { effectiveFrom: '2026-01-01' },
      { effectiveTo: '2026-12-31' },
      { duplicateException: true },
      { exceptionReason: '사유' },
      { approvedBy: SKU_ID },
      { skuId: SKU_ID },
      { id: BARCODE_ID },
      { createdAt: '2026-01-01T00:00:00Z' },
    ]) {
      expect(() => parseUpdateBarcodeInput(patch), JSON.stringify(patch)).toThrow(/올바르지/);
    }
  });

  it('status 는 ACTIVE·INACTIVE 만 허용한다', () => {
    for (const bad of ['ARCHIVED', 'DRAFT', 'active', '']) {
      expect(() => parseUpdateBarcodeInput({ status: bad }), bad).toThrow(/올바르지/);
    }
  });
});

describe('parseBarcodeId', () => {
  it('UUID 만 통과하고 형식 오류는 400 이다 (404 가 아니다)', () => {
    expect(parseBarcodeId(BARCODE_ID)).toBe(BARCODE_ID);
    expect(() => parseBarcodeId('not-a-uuid')).toThrow(/바코드 id/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 정규화 연결 (§8·§9)
// ═══════════════════════════════════════════════════════════════

describe('★ resolveBarcodeInput — T04-2 결과 → API 계약', () => {
  it('EMPTY sentinel 은 오류가 아니라 저장 없음이다', () => {
    for (const empty of ['', '   ', '-', '  -  ', '—', '\t']) {
      expect(resolveBarcodeInput(empty), JSON.stringify(empty)).toEqual({ kind: 'EMPTY' });
    }
  });

  it('OK 는 정규화된 문자열로 진행한다 (앞자리 0 보존, 공백·하이픈 제거)', () => {
    expect(resolveBarcodeInput('  001-234 567  ')).toEqual({ kind: 'OK', barcode: '001234567' });
    expect(resolveBarcodeInput('8809619961373')).toEqual({ kind: 'OK', barcode: '8809619961373' });
  });

  it('★ 지수표기 → 422 BARCODE_SCIENTIFIC_NOTATION', () => {
    for (const raw of ['1.23E+12', '1.23e+12']) {
      expect(() => resolveBarcodeInput(raw), raw).toThrow();
      try {
        resolveBarcodeInput(raw);
      } catch (error) {
        expect((error as { code: string }).code).toBe(ERROR_CODES.BARCODE_SCIENTIFIC_NOTATION);
        expect((error as { httpStatus: number }).httpStatus).toBe(422);
      }
    }
  });

  it('★ 확인필요 계열 → 422 BARCODE_UNVERIFIED', () => {
    for (const raw of ['확인필요', '확인불가', '확인 필요', '바코드', ' 확인필요 ']) {
      try {
        resolveBarcodeInput(raw);
        expect.unreachable(`${raw} 는 거부되어야 한다`);
      } catch (error) {
        expect((error as { code: string }).code, raw).toBe(ERROR_CODES.BARCODE_UNVERIFIED);
        expect((error as { httpStatus: number }).httpStatus, raw).toBe(422);
      }
    }
  });

  it('★ 숫자 전용 위반 → 422 BARCODE_INVALID_FORMAT', () => {
    for (const raw of ['ABC123', '8809/1234', '123_456', 'null', '88.09']) {
      try {
        resolveBarcodeInput(raw);
        expect.unreachable(`${raw} 는 거부되어야 한다`);
      } catch (error) {
        expect((error as { code: string }).code, raw).toBe(ERROR_CODES.BARCODE_INVALID_FORMAT);
        expect((error as { httpStatus: number }).httpStatus, raw).toBe(422);
      }
    }
  });

  it('★ 정규화 결과가 DB 물리 용량을 넘으면 400 (업무 길이 규칙이 아니다)', () => {
    expect(BARCODE_MAX_LENGTH).toBe(100);

    const exactly100 = '9'.repeat(100);
    expect(resolveBarcodeInput(exactly100)).toEqual({ kind: 'OK', barcode: exactly100 });

    // 하이픈 제거 후 100자면 통과한다 — 원문 길이가 아니라 정규화 결과 기준이다.
    expect(resolveBarcodeInput(`${'9'.repeat(50)}-${'9'.repeat(50)}`)).toEqual({
      kind: 'OK',
      barcode: exactly100,
    });

    try {
      resolveBarcodeInput('9'.repeat(101));
      expect.unreachable('101자는 400 이어야 한다');
    } catch (error) {
      expect((error as { code: string }).code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect((error as { fieldErrors: { path: string }[] }).fieldErrors[0]?.path).toBe('barcode');
    }
  });

  it('★ 체크디지트·EAN-13 을 검증하지 않는다', () => {
    expect(resolveBarcodeInput('8809619961374')).toEqual({ kind: 'OK', barcode: '8809619961374' });
    expect(resolveBarcodeInput('1')).toEqual({ kind: 'OK', barcode: '1' });
  });
});

// ═══════════════════════════════════════════════════════════════
// 오류 카탈로그 (§8·§11)
// ═══════════════════════════════════════════════════════════════

describe('★ 신규 public error code', () => {
  it('5종이 카탈로그에 등록되고 상태코드가 계약대로다', () => {
    const expected: ReadonlyArray<readonly [string, number]> = [
      [ERROR_CODES.BARCODE_SCIENTIFIC_NOTATION, 422],
      [ERROR_CODES.BARCODE_UNVERIFIED, 422],
      [ERROR_CODES.BARCODE_INVALID_FORMAT, 422],
      [ERROR_CODES.BARCODE_DUPLICATE, 409],
      [ERROR_CODES.BARCODE_PRIMARY_CONFLICT, 409],
    ];
    for (const [code, status] of expected) {
      expect(isKnownErrorCode(code), code).toBe(true);
      expect(httpStatusForCode(code), code).toBe(status);
    }
  });

  it('★ BARCODE_READ_AS_NUMBER 는 공개 오류코드가 아니다 (import parser 전용)', () => {
    expect(isKnownErrorCode('BARCODE_READ_AS_NUMBER')).toBe(false);
  });

  it('기존 코드 의미가 바뀌지 않았다', () => {
    expect(httpStatusForCode(ERROR_CODES.SKU_CODE_DUPLICATE)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.IDEMPOTENCY_KEY_REUSED)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.VALIDATION_ERROR)).toBe(400);
    expect(httpStatusForCode(ERROR_CODES.NOT_FOUND)).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// 조건부 UNIQUE 구분 (§11)
// ═══════════════════════════════════════════════════════════════

function p2002(meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta,
  });
}

describe('★ P2002 → 두 조건부 UNIQUE 구분', () => {
  it('구조화된 제약 컬럼 목록을 1차 계약으로 쓴다', () => {
    expect(
      resolveBarcodeUniqueViolation(
        p2002({ driverAdapterError: { cause: { constraint: { fields: ['barcode'] } } } }),
      ),
    ).toBe('ux_barcode_active');

    expect(
      resolveBarcodeUniqueViolation(
        p2002({ driverAdapterError: { cause: { constraint: { fields: ['sku_id'] } } } }),
      ),
    ).toBe('ux_barcode_primary');
  });

  it('Prisma 표준 meta.target 도 인식한다', () => {
    expect(resolveBarcodeUniqueViolation(p2002({ target: ['barcode'] }))).toBe('ux_barcode_active');
    expect(resolveBarcodeUniqueViolation(p2002({ target: 'sku_id' }))).toBe('ux_barcode_primary');
  });

  it('구조화 정보가 없을 때만 인덱스 이름 문자열로 fallback 한다', () => {
    expect(
      resolveBarcodeUniqueViolation(
        p2002({
          driverAdapterError: {
            cause: {
              originalMessage:
                'duplicate key value violates unique constraint "ux_barcode_primary"',
            },
          },
        }),
      ),
    ).toBe('ux_barcode_primary');
  });

  it('★ 판정할 수 없으면 undefined — 추측으로 409 를 만들지 않는다', () => {
    expect(resolveBarcodeUniqueViolation(p2002({}))).toBeUndefined();
    expect(resolveBarcodeUniqueViolation(p2002({ target: ['some_other_column'] }))).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 멱등 scope·hash (§10)
// ═══════════════════════════════════════════════════════════════

describe('★ 멱등 계약', () => {
  it('routeScope 는 route template 이며 raw UUID 를 포함하지 않는다', () => {
    expect(BARCODE_CREATE_ROUTE_SCOPE).toBe('/api/skus/{id}/barcodes');
    expect(BARCODE_CREATE_ROUTE_SCOPE).not.toContain(SKU_ID);
  });

  it('hash 는 skuId 를 포함한다 — 같은 body 라도 SKU 가 다르면 다른 요청이다', () => {
    const input = { barcode: '880', barcodeType: 'UNIT' } as const;
    const other = '33333333-3333-4333-8333-333333333333';
    expect(barcodeCreateRequestHash(SKU_ID, input)).not.toBe(
      barcodeCreateRequestHash(other, input),
    );
  });

  it('★ 정규화 전 원 입력을 해싱한다 — 001-234 와 001234 는 다른 요청이다', () => {
    const a = barcodeCreateRequestHash(SKU_ID, { barcode: '001-234', barcodeType: 'UNIT' });
    const b = barcodeCreateRequestHash(SKU_ID, { barcode: '001234', barcodeType: 'UNIT' });
    expect(a).not.toBe(b);
    // 정규화 결과는 동일하다는 점을 함께 고정한다.
    expect(resolveBarcodeInput('001-234')).toEqual(resolveBarcodeInput('001234'));
  });

  it('같은 입력이면 hash 가 안정적이다', () => {
    const input = { barcode: '880', barcodeType: 'UNIT', isPrimary: true } as const;
    expect(barcodeCreateRequestHash(SKU_ID, input)).toBe(barcodeCreateRequestHash(SKU_ID, input));
  });
});

// ═══════════════════════════════════════════════════════════════
// 범위 고정 (§16)
// ═══════════════════════════════════════════════════════════════

describe('★ T04-3 범위 고정', () => {
  it('바코드 라우트 디렉터리 고정 — ✏️ T04-4A 의 2개 경로까지', async () => {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(
      new URL('../../app/api/skus/[id]/barcodes', import.meta.url).pathname,
    );
    // ✏️ T04-4A 에서 `duplicate-candidates`(중복 예외 요청)가 추가됐다.
    expect(entries.sort()).toEqual(['[bid]', 'duplicate-candidates', 'route.ts']);

    const item = await readdir(
      new URL('../../app/api/skus/[id]/barcodes/[bid]', import.meta.url).pathname,
    );
    // ✏️ T04-4A 에서 원문 endpoint `approve-duplicate` 가 추가됐다.
    expect(item.sort()).toEqual(['approve-duplicate', 'route.ts']);
  });
});
