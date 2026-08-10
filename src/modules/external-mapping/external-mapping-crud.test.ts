import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import { ERROR_CODES, httpStatusForCode, isKnownErrorCode } from '@/shared/errors';

import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from '../../../prisma/seed/roles';

import {
  businessDateOf,
  deriveMappingStatus,
  EXTERNAL_MAPPING_CREATE_PERMISSION,
  EXTERNAL_MAPPING_CREATE_ROUTE_SCOPE,
  EXTERNAL_MAPPING_READ_PERMISSION,
  EXTERNAL_MAPPING_UPDATE_PERMISSION,
  MAPPING_STATUSES,
  mappingCreateRequestHash,
  normalizeExternalBarcode,
  normalizeExternalText,
  parseCreateMappingInput,
  parseExternalMappingId,
  parseListMappingsQuery,
  parseUpdateMappingInput,
  resolveEffectiveTo,
  resolveExternalMappingUniqueViolation,
} from './application';

/**
 * 외부 상품 매핑 CRUD 단위 테스트 (T05-2).
 *
 * 계약 근거는 `docs/13_설계복구_외부상품매핑CRUD.md` 뿐이다.
 * DB 가 필요한 서비스 동작은 `tests/db/external-mapping-crud.test.ts` 에서
 * 실 PostgreSQL 로 본다.
 */

const SKU_ID = '11111111-1111-4111-8111-111111111111';
const SYSTEM_ID = '22222222-2222-4222-8222-222222222222';
const MAPPING_ID = '33333333-3333-4333-8333-333333333333';

const MINIMAL = { skuId: SKU_ID, externalSystemId: SYSTEM_ID, externalProductCode: 'P001' };

// ═══════════════════════════════════════════════════════════════
// route policy (§11)
// ═══════════════════════════════════════════════════════════════

describe('★ route policy — 외부 매핑 경로는 external_mapping.* 로만 매칭된다', () => {
  const collection = '/api/external-mappings';
  const item = `${collection}/${MAPPING_ID}`;

  it('메서드별 권한이 정확히 매칭된다', () => {
    expect(resolveRoutePermission({ pathname: collection, method: 'GET' })).toBe(
      'external_mapping.read',
    );
    expect(resolveRoutePermission({ pathname: collection, method: 'HEAD' })).toBe(
      'external_mapping.read',
    );
    expect(resolveRoutePermission({ pathname: collection, method: 'POST' })).toBe(
      'external_mapping.create',
    );
    expect(resolveRoutePermission({ pathname: item, method: 'PATCH' })).toBe(
      'external_mapping.update',
    );
    // DELETE 라우트는 없지만(405) 1차 가드는 update 로 묶어 read 권한 사용자를 막는다.
    expect(resolveRoutePermission({ pathname: item, method: 'DELETE' })).toBe(
      'external_mapping.update',
    );
  });

  it('★ sku.* 로 fall-through 하지 않는다', () => {
    for (const pathname of [collection, item]) {
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
        const permission = resolveRoutePermission({ pathname, method });
        expect(permission, `${method} ${pathname}`).not.toBe('sku.read');
        expect(permission, `${method} ${pathname}`).not.toBe('sku.create');
        expect(permission, `${method} ${pathname}`).not.toBe('sku.update');
        expect(permission?.startsWith('external_mapping.'), `${method} ${pathname}`).toBe(true);
      }
    }
  });

  it('기존 SKU·바코드 경로 매칭은 그대로다 — 회귀 없음', () => {
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'GET' })).toBe('sku.read');
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'POST' })).toBe('sku.create');
    expect(
      resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/barcodes`, method: 'POST' }),
    ).toBe('barcode.create');
  });
});

// ═══════════════════════════════════════════════════════════════
// permission seed (§11)
// ═══════════════════════════════════════════════════════════════

describe('★ 외부 매핑 권한 — 독립 capability (sku.* 재사용 아님)', () => {
  const keys = PERMISSION_SEED.map((row) => row.permissionKey);
  const rolesOf = (key: string) =>
    ROLE_PERMISSION_SEED.filter((row) => row.permissionKey === key)
      .map((row) => row.roleCode)
      .sort();

  it('3종 permission 이 시드에 있다', () => {
    expect(keys).toContain(EXTERNAL_MAPPING_READ_PERMISSION);
    expect(keys).toContain(EXTERNAL_MAPPING_CREATE_PERMISSION);
    expect(keys).toContain(EXTERNAL_MAPPING_UPDATE_PERMISSION);
    expect(EXTERNAL_MAPPING_READ_PERMISSION).toBe('external_mapping.read');
    expect(EXTERNAL_MAPPING_CREATE_PERMISSION).toBe('external_mapping.create');
    expect(EXTERNAL_MAPPING_UPDATE_PERMISSION).toBe('external_mapping.update');
  });

  it('★ read 는 A·L·S·F 4역할 — EXECUTIVE 는 제외된다 (화면별 권한표 채택)', () => {
    expect(rolesOf(EXTERNAL_MAPPING_READ_PERMISSION)).toEqual([
      'ADMIN',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    expect(rolesOf(EXTERNAL_MAPPING_READ_PERMISSION)).not.toContain('EXECUTIVE');
  });

  it('쓰기 2종은 ADMIN·SCM_LEADER·SCM_STAFF', () => {
    for (const key of [EXTERNAL_MAPPING_CREATE_PERMISSION, EXTERNAL_MAPPING_UPDATE_PERMISSION]) {
      expect(rolesOf(key), key).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    }
  });

  it('★ sku.read 는 여전히 5역할이다 — 이번 결정이 다른 capability 를 바꾸지 않았다', () => {
    expect(rolesOf('sku.read')).toEqual([
      'ADMIN',
      'EXECUTIVE',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    expect(rolesOf('barcode.read')).toContain('EXECUTIVE');
  });

  it('permission 키가 중복 없이 유일하다', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ═══════════════════════════════════════════════════════════════
// 오류코드 카탈로그 (§10)
// ═══════════════════════════════════════════════════════════════

describe('★ 신규 public 오류코드 8종', () => {
  const expected: ReadonlyArray<readonly [string, number]> = [
    [ERROR_CODES.EXTERNAL_MAPPING_CODE_DUPLICATE, 409],
    [ERROR_CODES.EXTERNAL_MAPPING_PRIMARY_CONFLICT, 409],
    [ERROR_CODES.EXTERNAL_MAPPING_IDENTIFIER_REQUIRED, 422],
    [ERROR_CODES.EXTERNAL_MAPPING_PRIMARY_REQUIRES_MATCHED, 422],
    [ERROR_CODES.EXTERNAL_MAPPING_PRIMARY_MUST_BE_CLEARED_BEFORE_END, 422],
    [ERROR_CODES.EXTERNAL_MAPPING_EFFECTIVE_DATE_INVALID, 422],
    [ERROR_CODES.EXTERNAL_MAPPING_ENDED, 422],
    [ERROR_CODES.EXTERNAL_MAPPING_UNMATCHED_NOT_INTERACTIVE, 422],
  ];

  it('카탈로그에 등록되고 상태코드가 정확하다', () => {
    for (const [code, status] of expected) {
      expect(isKnownErrorCode(code), code).toBe(true);
      expect(httpStatusForCode(code), code).toBe(status);
    }
  });

  it('★ 두 409 를 generic CONFLICT 하나로 합치지 않았다', () => {
    expect(ERROR_CODES.EXTERNAL_MAPPING_CODE_DUPLICATE).not.toBe(
      ERROR_CODES.EXTERNAL_MAPPING_PRIMARY_CONFLICT,
    );
    expect(ERROR_CODES.EXTERNAL_MAPPING_CODE_DUPLICATE).not.toBe(ERROR_CODES.CONFLICT);
  });

  it('★ barcode 오류코드를 재사용하지 않았다', () => {
    expect(ERROR_CODES.EXTERNAL_MAPPING_CODE_DUPLICATE).not.toBe(ERROR_CODES.BARCODE_DUPLICATE);
    expect(ERROR_CODES.EXTERNAL_MAPPING_PRIMARY_CONFLICT).not.toBe(
      ERROR_CODES.BARCODE_PRIMARY_CONFLICT,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// POST DTO (§5)
// ═══════════════════════════════════════════════════════════════

describe('★ CreateMappingDto V1 — strict', () => {
  it('최소 입력이 통과한다', () => {
    expect(parseCreateMappingInput(MINIMAL)).toEqual(MINIMAL);
  });

  it('선택 필드 전부를 받는다', () => {
    const full = {
      ...MINIMAL,
      externalProductName: '외부 상품명',
      externalBarcode: '8809619961373',
      isPrimary: true,
      note: '비고',
    };
    expect(parseCreateMappingInput(full)).toEqual(full);
  });

  it('★ mappingStatus 입력은 400 이다 — server-derived 다', () => {
    expect(() => parseCreateMappingInput({ ...MINIMAL, mappingStatus: 'MATCHED' })).toThrow();
  });

  it('★ warehouseId 입력은 400 이다 — T08-1 전까지 받지 않는다', () => {
    expect(() =>
      parseCreateMappingInput({ ...MINIMAL, warehouseId: '44444444-4444-4444-8444-444444444444' }),
    ).toThrow();
  });

  it('effectiveFrom·effectiveTo·id·createdAt 도 받지 않는다', () => {
    for (const key of ['effectiveFrom', 'effectiveTo', 'id', 'createdAt']) {
      expect(() => parseCreateMappingInput({ ...MINIMAL, [key]: '2026-01-01' }), key).toThrow();
    }
  });

  it('skuId·externalSystemId 는 UUID 여야 한다', () => {
    expect(() => parseCreateMappingInput({ ...MINIMAL, skuId: 'not-uuid' })).toThrow();
    expect(() => parseCreateMappingInput({ ...MINIMAL, externalSystemId: 'nope' })).toThrow();
  });

  it('★ externalBarcode 는 문자열 전용 — numeric JSON 은 400 이다', () => {
    expect(() => parseCreateMappingInput({ ...MINIMAL, externalBarcode: 8809619961373 })).toThrow();
  });

  it('null 은 명시적으로 허용된다 (값 없음)', () => {
    const parsed = parseCreateMappingInput({
      skuId: SKU_ID,
      externalSystemId: SYSTEM_ID,
      externalProductCode: null,
      externalProductName: '이름만',
    });
    expect(parsed.externalProductCode).toBeNull();
  });

  it('DB 물리 용량을 넘는 문자열은 400 이다', () => {
    expect(() =>
      parseCreateMappingInput({ ...MINIMAL, externalProductCode: 'x'.repeat(151) }),
    ).toThrow();
    expect(() =>
      parseCreateMappingInput({ ...MINIMAL, externalProductName: 'x'.repeat(501) }),
    ).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// PATCH DTO (§2·§5·§8)
// ═══════════════════════════════════════════════════════════════

describe('★ PATCH DTO V1 — identifier 를 받는다', () => {
  it('★ identifier 3종이 PATCH 대상이다 (원문 gap 복구)', () => {
    expect(parseUpdateMappingInput({ externalProductCode: 'P001' })).toEqual({
      externalProductCode: 'P001',
    });
    expect(parseUpdateMappingInput({ externalBarcode: '8809619961373' })).toBeTruthy();
    expect(parseUpdateMappingInput({ externalProductName: '이름' })).toBeTruthy();
  });

  it('isPrimary·effectiveTo·note 도 받는다', () => {
    expect(
      parseUpdateMappingInput({ isPrimary: false, effectiveTo: '2026-08-10', note: 'x' }),
    ).toEqual({ isPrimary: false, effectiveTo: '2026-08-10', note: 'x' });
  });

  it('★ 빈 객체는 400 이다', () => {
    expect(() => parseUpdateMappingInput({})).toThrow();
  });

  it('★ skuId·externalSystemId 는 immutable — 입력하면 400', () => {
    expect(() => parseUpdateMappingInput({ skuId: SKU_ID })).toThrow();
    expect(() => parseUpdateMappingInput({ externalSystemId: SYSTEM_ID })).toThrow();
  });

  it('★ mappingStatus·warehouseId·effectiveFrom 도 400', () => {
    expect(() => parseUpdateMappingInput({ mappingStatus: 'MATCHED' })).toThrow();
    expect(() =>
      parseUpdateMappingInput({ warehouseId: '44444444-4444-4444-8444-444444444444' }),
    ).toThrow();
    expect(() => parseUpdateMappingInput({ effectiveFrom: '2026-01-01' })).toThrow();
  });

  it('★ effectiveTo 는 null 을 받지 않는다 — 재활성은 V1 범위 밖', () => {
    expect(() => parseUpdateMappingInput({ effectiveTo: null })).toThrow();
  });

  it('effectiveTo 는 YYYY-MM-DD 형식이어야 한다', () => {
    expect(() => parseUpdateMappingInput({ effectiveTo: '2026/08/10' })).toThrow();
    expect(() => parseUpdateMappingInput({ effectiveTo: '2026-13-01' })).toThrow();
  });

  it('identifier 를 null 로 지우는 요청은 유효하다', () => {
    expect(parseUpdateMappingInput({ externalProductCode: null })).toEqual({
      externalProductCode: null,
    });
  });
});

describe('★ 경로 식별자', () => {
  it('UUID 가 아니면 400 (404 아님)', () => {
    expect(parseExternalMappingId(MAPPING_ID)).toBe(MAPPING_ID);
    expect(() => parseExternalMappingId('nope')).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 정규화 (§6·§7)
// ═══════════════════════════════════════════════════════════════

describe('★ external text 정규화 — trim / blank→null / 내부 보존', () => {
  it('앞뒤 공백만 제거한다', () => {
    expect(normalizeExternalText('  P001  ')).toBe('P001');
  });

  it('★ 앞자리 0·대소문자·내부 하이픈·내부 공백을 보존한다', () => {
    expect(normalizeExternalText('00123')).toBe('00123');
    expect(normalizeExternalText('abcDEF')).toBe('abcDEF');
    expect(normalizeExternalText('P-001')).toBe('P-001');
    expect(normalizeExternalText('상품 A')).toBe('상품 A');
  });

  it('blank 는 null 로 canonicalize 된다', () => {
    expect(normalizeExternalText('')).toBeNull();
    expect(normalizeExternalText('   ')).toBeNull();
    expect(normalizeExternalText(null)).toBeNull();
  });

  it('undefined 는 "건드리지 않음"으로 보존된다', () => {
    expect(normalizeExternalText(undefined)).toBeUndefined();
  });
});

describe('★ externalBarcode — T04-2 normalizeBarcode 재사용', () => {
  it('공백·하이픈이 제거된다 (T04-2 규칙 그대로)', () => {
    expect(normalizeExternalBarcode(' 880-961 9961373 ')).toBe('8809619961373');
  });

  it('EMPTY 표시값은 null 이다 (오류 아님)', () => {
    expect(normalizeExternalBarcode('')).toBeNull();
    expect(normalizeExternalBarcode('-')).toBeNull();
    expect(normalizeExternalBarcode('—')).toBeNull();
    expect(normalizeExternalBarcode(null)).toBeNull();
  });

  it('지수표기는 422 BARCODE_SCIENTIFIC_NOTATION', () => {
    expect(() => normalizeExternalBarcode('8.80962E+12')).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.BARCODE_SCIENTIFIC_NOTATION }),
    );
  });

  it('확인필요 센티넬은 422 BARCODE_UNVERIFIED', () => {
    expect(() => normalizeExternalBarcode('확인필요')).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.BARCODE_UNVERIFIED }),
    );
  });

  it('숫자 전용 위반은 422 BARCODE_INVALID_FORMAT', () => {
    expect(() => normalizeExternalBarcode('ABC123')).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.BARCODE_INVALID_FORMAT }),
    );
  });

  it('undefined 는 "건드리지 않음"으로 보존된다', () => {
    expect(normalizeExternalBarcode(undefined)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// truth table (§4)
// ═══════════════════════════════════════════════════════════════

describe('★ mappingStatus 자동판정 truth table', () => {
  const state = (
    code: string | null,
    barcode: string | null,
    name: string | null,
  ): Parameters<typeof deriveMappingStatus>[0] => ({
    externalProductCode: code,
    externalBarcode: barcode,
    externalProductName: name,
  });

  it('code O / barcode X → MATCHED (name 무관)', () => {
    expect(deriveMappingStatus(state('P001', null, null))).toBe('MATCHED');
    expect(deriveMappingStatus(state('P001', null, '이름'))).toBe('MATCHED');
  });

  it('code X / barcode O → MATCHED (name 무관)', () => {
    expect(deriveMappingStatus(state(null, '8809619961373', null))).toBe('MATCHED');
    expect(deriveMappingStatus(state(null, '8809619961373', '이름'))).toBe('MATCHED');
  });

  it('code O / barcode O → MATCHED', () => {
    expect(deriveMappingStatus(state('P001', '8809619961373', '이름'))).toBe('MATCHED');
  });

  it('code X / barcode X / name O → REVIEW_REQUIRED', () => {
    expect(deriveMappingStatus(state(null, null, '외부 상품 A'))).toBe('REVIEW_REQUIRED');
  });

  it('★ 식별자가 하나도 없으면 422 EXTERNAL_MAPPING_IDENTIFIER_REQUIRED', () => {
    expect(() => deriveMappingStatus(state(null, null, null))).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.EXTERNAL_MAPPING_IDENTIFIER_REQUIRED }),
    );
  });

  it('★ 어떤 조합에서도 UNMATCHED 를 반환하지 않는다', () => {
    const combos: Array<[string | null, string | null, string | null]> = [
      ['P001', null, null],
      [null, '880', null],
      ['P001', '880', '이름'],
      [null, null, '이름'],
    ];
    for (const [code, barcode, name] of combos) {
      expect(deriveMappingStatus(state(code, barcode, name))).not.toBe('UNMATCHED');
    }
  });

  it('MappingStatus enum 은 3종 그대로다 — UNMATCHED 를 삭제하지 않았다', () => {
    expect(MAPPING_STATUSES).toEqual(['MATCHED', 'UNMATCHED', 'REVIEW_REQUIRED']);
  });
});

// ═══════════════════════════════════════════════════════════════
// effectiveTo (§8)
// ═══════════════════════════════════════════════════════════════

describe('★ effectiveTo 규칙', () => {
  const now = new Date('2026-08-10T01:00:00.000Z'); // KST 2026-08-10 10:00

  it('오늘 이하 날짜는 통과한다', () => {
    expect(resolveEffectiveTo('2026-08-10', null, now).toISOString()).toBe(
      '2026-08-10T00:00:00.000Z',
    );
    expect(resolveEffectiveTo('2026-01-01', null, now)).toBeInstanceOf(Date);
  });

  it('★ 미래일 종료는 422 다', () => {
    expect(() => resolveEffectiveTo('2026-08-11', null, now)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.EXTERNAL_MAPPING_EFFECTIVE_DATE_INVALID }),
    );
  });

  it('★ effectiveFrom 보다 이른 종료는 422 다', () => {
    const from = new Date('2026-05-01T00:00:00.000Z');
    expect(() => resolveEffectiveTo('2026-04-30', from, now)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.EXTERNAL_MAPPING_EFFECTIVE_DATE_INVALID }),
    );
    expect(resolveEffectiveTo('2026-05-01', from, now)).toBeInstanceOf(Date);
  });

  it('★ 업무일자는 Asia/Seoul 기준이다 — UTC 자정 직후에도 KST 날짜를 쓴다', () => {
    // UTC 2026-08-09T16:30Z = KST 2026-08-10 01:30 → 업무일자는 08-10 이다.
    expect(businessDateOf(new Date('2026-08-09T16:30:00.000Z'))).toBe('2026-08-10');
    expect(businessDateOf(new Date('2026-08-09T14:30:00.000Z'))).toBe('2026-08-09');
  });
});

// ═══════════════════════════════════════════════════════════════
// P2002 판별 (§10)
// ═══════════════════════════════════════════════════════════════

function p2002(fields: readonly string[], message?: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta:
      message === undefined
        ? { driverAdapterError: { cause: { constraint: { fields } } } }
        : { driverAdapterError: { cause: { originalMessage: message } } },
  });
}

describe('★ P2002 → 조건부 UNIQUE 판별', () => {
  it('구조화된 컬럼 목록이 1차 계약이다', () => {
    expect(
      resolveExternalMappingUniqueViolation(p2002(['external_system_id', 'external_product_code'])),
    ).toBe('ux_external_mapping_code');
    expect(resolveExternalMappingUniqueViolation(p2002(['sku_id', 'external_system_id']))).toBe(
      'ux_external_mapping_primary',
    );
  });

  it('camelCase 컬럼 표기도 인식한다', () => {
    expect(
      resolveExternalMappingUniqueViolation(p2002(['externalSystemId', 'externalProductCode'])),
    ).toBe('ux_external_mapping_code');
    expect(resolveExternalMappingUniqueViolation(p2002(['skuId', 'externalSystemId']))).toBe(
      'ux_external_mapping_primary',
    );
  });

  it('index 이름은 최후 fallback 이다', () => {
    expect(
      resolveExternalMappingUniqueViolation(
        p2002([], 'duplicate key value violates unique constraint "ux_external_mapping_primary"'),
      ),
    ).toBe('ux_external_mapping_primary');
  });

  it('판별할 수 없으면 undefined 다 — 추측으로 409 를 만들지 않는다', () => {
    expect(resolveExternalMappingUniqueViolation(p2002([], 'something else'))).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// GET query (§12)
// ═══════════════════════════════════════════════════════════════

describe('★ GET query V1', () => {
  const parse = (search: string) => parseListMappingsQuery(new URLSearchParams(search));

  it('기본값은 page=1, pageSize=50 이다', () => {
    expect(parse('')).toEqual({ page: 1, pageSize: 50 });
  });

  it('허용 필터를 파싱한다', () => {
    const parsed = parse(
      `q=abc&externalSystemId=${SYSTEM_ID}&skuId=${SKU_ID}&mappingStatus=MATCHED&page=2&pageSize=10`,
    );
    expect(parsed).toEqual({
      q: 'abc',
      externalSystemId: SYSTEM_ID,
      skuId: SKU_ID,
      mappingStatus: 'MATCHED',
      page: 2,
      pageSize: 10,
    });
  });

  it('★ mappingStatus 는 UNMATCHED 도 받는다 (조회는 가능하다)', () => {
    expect(parse('mappingStatus=UNMATCHED').mappingStatus).toBe('UNMATCHED');
    expect(parse('mappingStatus=REVIEW_REQUIRED').mappingStatus).toBe('REVIEW_REQUIRED');
  });

  it('★ sort 는 V1 미지원 — 400 이다', () => {
    expect(() => parse('sort=createdAt_desc')).toThrow();
  });

  it('★ warehouse 필터는 T08-1 이후 — 400 이다', () => {
    expect(() => parse('warehouseId=x')).toThrow();
    expect(() => parse('warehouse=x')).toThrow();
  });

  it('알 수 없는 파라미터는 조용히 무시하지 않고 400 이다', () => {
    expect(() => parse('hasIssue=true')).toThrow();
  });

  it('pageSize 상한은 200 이다', () => {
    expect(() => parse('pageSize=201')).toThrow();
    expect(parse('pageSize=200').pageSize).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// 멱등 (§13)
// ═══════════════════════════════════════════════════════════════

describe('★ 멱등 request hash', () => {
  it('routeScope 는 경로 파라미터 없는 template 이다', () => {
    expect(EXTERNAL_MAPPING_CREATE_ROUTE_SCOPE).toBe('/api/external-mappings');
    expect(EXTERNAL_MAPPING_CREATE_ROUTE_SCOPE).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('같은 입력은 같은 hash 다 (키 순서 무관)', () => {
    const a = mappingCreateRequestHash(parseCreateMappingInput(MINIMAL));
    const b = mappingCreateRequestHash(
      parseCreateMappingInput({
        externalProductCode: 'P001',
        externalSystemId: SYSTEM_ID,
        skuId: SKU_ID,
      }),
    );
    expect(a).toBe(b);
  });

  it('★ 정규화 전 raw DTO 를 해싱한다 — 공백 차이는 다른 요청이다', () => {
    const raw = mappingCreateRequestHash(parseCreateMappingInput(MINIMAL));
    const padded = mappingCreateRequestHash(
      parseCreateMappingInput({ ...MINIMAL, externalProductCode: '  P001  ' }),
    );
    expect(padded).not.toBe(raw);
  });

  it('다른 SKU 는 다른 hash 다', () => {
    const other = mappingCreateRequestHash(
      parseCreateMappingInput({ ...MINIMAL, skuId: MAPPING_ID }),
    );
    expect(other).not.toBe(mappingCreateRequestHash(parseCreateMappingInput(MINIMAL)));
  });
});
