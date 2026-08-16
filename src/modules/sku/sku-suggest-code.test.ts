import { describe, expect, it } from 'vitest';

import {
  ROUTE_PERMISSIONS,
  createActorContext,
  resolveRoutePermission,
  type ActorContext,
} from '@/modules/auth/application';
import { ValidationError, type AppError } from '@/shared/errors';

import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from '../../../prisma/seed/roles';

import {
  SKU_SUGGEST_CODE_PERMISSION,
  parseSuggestSkuCodeInput,
  suggestSkuCode,
  type SuggestCodeClient,
} from './application';
import {
  SKU_CODE_POLICY,
  SKU_SERIAL_MAX,
  buildSkuCodePrefix,
  formatSkuSerial,
  nextSkuSerial,
  usedSkuSerials,
} from './domain';

/**
 * SKU 코드 추천 테스트 (T03-7) — DB 없이 대역으로 검증한다.
 *
 * 규칙 근거: `docs/09_설계복구_SKU코드추천.md` (STANDARD_PRODUCT_V1).
 * 실 PostgreSQL 동시성·부작용 부재는 `tests/db/sku-suggest-code.test.ts`.
 */

const BRAND_ID = '77777777-7777-4777-8777-777777777701';
const MAJOR_ID = '77777777-7777-4777-8777-777777777702';
const MINOR_ID = '77777777-7777-4777-8777-777777777703';
const MINOR2_ID = '77777777-7777-4777-8777-777777777704';
const BRAND2_ID = '77777777-7777-4777-8777-777777777705';
const MAJOR2_ID = '77777777-7777-4777-8777-777777777706';
const INACTIVE_BRAND_ID = '77777777-7777-4777-8777-777777777707';
const CHANNEL_ID = '77777777-7777-4777-8777-777777777708';
const MISSING_ID = '77777777-7777-4777-8777-777777777799';

function actorOf(permissions: readonly string[], roles: readonly string[]): ActorContext {
  return createActorContext({
    userId: '88888888-8888-4888-8888-888888888888',
    email: 'suggest@deeppoint.test',
    name: '코드 추천 사용자',
    active: true,
    roles,
    permissions,
    requestId: 'req-suggest',
  });
}

const STAFF = actorOf([SKU_SUGGEST_CODE_PERMISSION], ['SCM_STAFF']);
const READER = actorOf(['sku.read'], ['FINANCE']);
/** ADMIN 역할인데 권한 데이터 없음 — bypass 금지 확인용. */
const ADMIN_NO_PERM = actorOf([], ['ADMIN']);

interface FakeCode {
  id: string;
  groupCode: string;
  code: string;
  active: boolean;
}

const CODES: readonly FakeCode[] = [
  { id: BRAND_ID, groupCode: 'BRAND', code: 'FB', active: true },
  { id: BRAND2_ID, groupCode: 'BRAND', code: 'BO', active: true },
  { id: INACTIVE_BRAND_ID, groupCode: 'BRAND', code: 'XB', active: false },
  { id: MAJOR_ID, groupCode: 'MAJOR_CATEGORY', code: 'OY', active: true },
  { id: MAJOR2_ID, groupCode: 'MAJOR_CATEGORY', code: 'BT', active: true },
  { id: MINOR_ID, groupCode: 'MINOR_CATEGORY', code: 'CW', active: true },
  { id: MINOR2_ID, groupCode: 'MINOR_CATEGORY', code: 'SP', active: true },
  { id: CHANNEL_ID, groupCode: 'CHANNEL', code: 'A', active: true },
];

/** 주어진 skuCode 목록만 가진 최소 클라이언트 대역. */
function fakeDb(skuCodes: readonly string[]): SuggestCodeClient {
  return {
    commonCode: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        CODES.filter((entry) => where.id.in.includes(entry.id)).map((entry) => ({
          id: entry.id,
          code: entry.code,
          name: entry.code,
          active: entry.active,
          group: { groupCode: entry.groupCode },
        })),
    },
    sku: {
      findMany: async ({ where }: { where: { skuCode: { startsWith: string } } }) =>
        skuCodes
          .filter((skuCode) => skuCode.startsWith(where.skuCode.startsWith))
          .map((skuCode) => ({ skuCode })),
      findUnique: async ({ where }: { where: { skuCode: string } }) =>
        skuCodes.includes(where.skuCode) ? { id: 'existing' } : null,
    },
  } as unknown as SuggestCodeClient;
}

const REQUEST = { brandId: BRAND_ID, majorId: MAJOR_ID, minorId: MINOR_ID };

async function suggest(skuCodes: readonly string[], actor: ActorContext = STAFF) {
  return suggestSkuCode(actor, REQUEST, { db: fakeDb(skuCodes) });
}

async function expectAppError(promise: Promise<unknown>, code: string, httpStatus: number) {
  const error = (await promise.then(
    () => {
      throw new Error('오류가 나야 하는데 성공했습니다.');
    },
    (thrown: unknown) => thrown,
  )) as AppError;
  expect(error.code).toBe(code);
  expect(error.httpStatus).toBe(httpStatus);
  return error;
}

// ═══════════════════════════════════════════════════════════════
// 도메인 규칙 (STANDARD_PRODUCT_V1)
// ═══════════════════════════════════════════════════════════════
describe('★ serial 파싱·형식 (docs/09 §5)', () => {
  const prefix = 'FB-OY-CW';

  it('정책 상수', () => {
    expect(SKU_CODE_POLICY).toBe('STANDARD_PRODUCT_V1');
    expect(SKU_SERIAL_MAX).toBe(999);
    expect(buildSkuCodePrefix({ brandCode: 'FB', majorCode: 'OY', minorCode: 'CW' })).toBe(prefix);
  });

  it('★ zero-padding 3자리', () => {
    expect(formatSkuSerial(1)).toBe('001');
    expect(formatSkuSerial(9)).toBe('009');
    expect(formatSkuSerial(10)).toBe('010');
    expect(formatSkuSerial(99)).toBe('099');
    expect(formatSkuSerial(100)).toBe('100');
    expect(formatSkuSerial(999)).toBe('999');
  });

  it('★ legacy suffix 가 붙어도 serial 은 사용된 것으로 본다', () => {
    const used = usedSkuSerials(prefix, [
      'FB-OY-CW-001',
      'FB-OY-CW-002-EU',
      'FB-OY-CW-003-ANYTHING-ELSE',
    ]);
    expect([...used].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('★ 비정형 legacy 는 무시한다 — A01 · 01 · 0001 · 000', () => {
    const used = usedSkuSerials(prefix, [
      'FB-OY-CW-A01',
      'FB-OY-CW-01',
      'FB-OY-CW-0001',
      'FB-OY-CW-000',
      'FB-OY-CW-',
    ]);
    expect(used.size).toBe(0);
  });

  it('★ 다른 prefix 는 계산에 포함되지 않는다 (scope 독립)', () => {
    const used = usedSkuSerials(prefix, [
      'FB-OY-SP-005', // 다른 minor
      'FB-BT-CW-006', // 다른 major
      'BO-OY-CW-007', // 다른 brand
      'FB-OY-CWX-008', // prefix 유사 문자열
    ]);
    expect(used.size).toBe(0);
  });

  it('★ MAX+1 — gap 을 재사용하지 않는다', () => {
    expect(nextSkuSerial(new Set())).toBe(1);
    expect(nextSkuSerial(new Set([1]))).toBe(2);
    expect(nextSkuSerial(new Set([1, 2, 4]))).toBe(5); // ★ 3 이 아니다
    expect(nextSkuSerial(new Set([9]))).toBe(10);
    expect(nextSkuSerial(new Set([99]))).toBe(100);
    expect(nextSkuSerial(new Set([998]))).toBe(999);
    expect(nextSkuSerial(new Set([999]))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 추천 서비스
// ═══════════════════════════════════════════════════════════════
describe('★ suggestSkuCode — 번호 산정', () => {
  it('★ 기존 코드 없음 → 001', async () => {
    const result = await suggest([]);
    expect(result).toEqual({ suggestedCode: 'FB-OY-CW-001', serialNumber: '001' });
  });

  it('★ 001 → 002 / 001,002,004 → 005 (gap 재사용 없음)', async () => {
    expect((await suggest(['FB-OY-CW-001'])).suggestedCode).toBe('FB-OY-CW-002');
    const gap = await suggest(['FB-OY-CW-001', 'FB-OY-CW-002', 'FB-OY-CW-004']);
    expect(gap.suggestedCode).toBe('FB-OY-CW-005');
    expect(gap.serialNumber).toBe('005');
  });

  it('★ 다른 brand·major·minor sequence 는 독립이다', async () => {
    const others = ['FB-OY-SP-001', 'FB-BT-CW-001', 'BO-OY-CW-001'];
    expect((await suggest(others)).suggestedCode).toBe('FB-OY-CW-001');

    // 같은 조합만 카운트되는지 반대로도 확인
    const mixed = await suggestSkuCode(
      STAFF,
      { brandId: BRAND2_ID, majorId: MAJOR2_ID, minorId: MINOR2_ID },
      { db: fakeDb(['BO-BT-SP-001', 'FB-OY-CW-050']) },
    );
    expect(mixed.suggestedCode).toBe('BO-BT-SP-002');
  });

  it('★ legacy suffix 코드가 serial 을 점유한다', async () => {
    expect((await suggest(['FB-OY-CW-001-EU'])).suggestedCode).toBe('FB-OY-CW-002');
  });

  it('★ 자릿수 경계 — 009→010, 099→100, 998→999', async () => {
    expect((await suggest(['FB-OY-CW-009'])).suggestedCode).toBe('FB-OY-CW-010');
    expect((await suggest(['FB-OY-CW-099'])).suggestedCode).toBe('FB-OY-CW-100');
    expect((await suggest(['FB-OY-CW-998'])).suggestedCode).toBe('FB-OY-CW-999');
  });

  it('★ 999 사용 시 409 SKU_CODE_SEQUENCE_EXHAUSTED — 4자리 확장 없음', async () => {
    const error = await expectAppError(
      suggest(['FB-OY-CW-999']),
      'SKU_CODE_SEQUENCE_EXHAUSTED',
      409,
    );
    expect((error.publicDetails as { maxSerial: number }).maxSerial).toBe(999);
  });

  it('★ additionalCode 를 자동 부착하지 않는다 — 항상 4세그먼트', async () => {
    const result = await suggest(['FB-OY-CW-001-EU', 'FB-OY-CW-002-GL', 'FB-OY-CW-003-BK']);
    expect(result.suggestedCode).toBe('FB-OY-CW-004');
    expect(result.suggestedCode.split('-')).toHaveLength(4);
  });

  it('★ CommonCode.code 를 그대로 쓴다 — case/trim 정규화 없음', async () => {
    // 픽스처 코드는 대문자 그대로이며, 결과에 그대로 반영된다.
    expect((await suggest([])).suggestedCode).toBe('FB-OY-CW-001');
    expect((await suggest([])).suggestedCode).not.toBe('fb-oy-cw-001');
  });

  it('후보가 이미 존재하면 같은 cycle 에서 다음 번호를 시도한다 (동시 INSERT 방어)', async () => {
    // 대역: findMany 는 prefix 로만 거르므로, 사용 이력에 없는 004 가 이미 있는
    // 비정상 상황을 만들 수 없다 → 대신 findUnique 만 충돌하도록 별도 대역 사용.
    const db = {
      commonCode: (fakeDb([]) as unknown as { commonCode: unknown }).commonCode,
      sku: {
        findMany: async () => [{ skuCode: 'FB-OY-CW-001' }],
        findUnique: async ({ where }: { where: { skuCode: string } }) =>
          where.skuCode === 'FB-OY-CW-002' ? { id: 'race' } : null,
      },
    } as unknown as SuggestCodeClient;

    const result = await suggestSkuCode(STAFF, REQUEST, { db });
    expect(result.suggestedCode).toBe('FB-OY-CW-003');
  });
});

// ═══════════════════════════════════════════════════════════════
// DTO · 권한 · 라우트 정책
// ═══════════════════════════════════════════════════════════════
describe('parseSuggestSkuCodeInput', () => {
  it('3개 필수 + UUID 형식', () => {
    expect(parseSuggestSkuCodeInput(REQUEST)).toEqual(REQUEST);
    for (const bad of [
      {},
      { brandId: BRAND_ID },
      { brandId: BRAND_ID, majorId: MAJOR_ID },
      { ...REQUEST, brandId: 'not-a-uuid' },
    ]) {
      expect(() => parseSuggestSkuCodeInput(bad), JSON.stringify(bad)).toThrow(ValidationError);
    }
  });

  it('★ 알 수 없는 필드는 400 (skuId 포함 — 추천은 기존 SKU 와 무관)', () => {
    expect(() => parseSuggestSkuCodeInput({ ...REQUEST, skuId: MISSING_ID })).toThrow(
      ValidationError,
    );
    expect(() => parseSuggestSkuCodeInput({ ...REQUEST, hacker: 1 })).toThrow(ValidationError);
  });
});

describe('★ CommonCode 검증 (T1-3 인프라 재사용)', () => {
  const cases = [
    ['brandId', { ...REQUEST, brandId: CHANNEL_ID }, 'brandId'],
    ['majorId', { ...REQUEST, majorId: CHANNEL_ID }, 'majorId'],
    ['minorId', { ...REQUEST, minorId: CHANNEL_ID }, 'minorId'],
  ] as const;

  it('★ 잘못된 group 은 400 이고 오류 경로가 요청 필드명이다', async () => {
    for (const [label, request, path] of cases) {
      const error = (await expectAppError(
        suggestSkuCode(STAFF, request, { db: fakeDb([]) }),
        'VALIDATION_ERROR',
        400,
      )) as ValidationError;
      expect(error.fieldErrors[0]?.path, label).toBe(path);
    }
  });

  it('★ 비활성 코드 400 / 존재하지 않는 id 400', async () => {
    await expectAppError(
      suggestSkuCode(STAFF, { ...REQUEST, brandId: INACTIVE_BRAND_ID }, { db: fakeDb([]) }),
      'VALIDATION_ERROR',
      400,
    );
    await expectAppError(
      suggestSkuCode(STAFF, { ...REQUEST, minorId: MISSING_ID }, { db: fakeDb([]) }),
      'VALIDATION_ERROR',
      400,
    );
  });
});

describe('★ 권한 — sku.suggest_code (독립 capability)', () => {
  it('시드 배정: ADMIN·SCM_LEADER·SCM_STAFF, FINANCE·EXECUTIVE 없음', () => {
    expect(PERMISSION_SEED.map((entry) => entry.permissionKey)).toContain('sku.suggest_code');
    const roles = ROLE_PERMISSION_SEED.filter((grant) => grant.permissionKey === 'sku.suggest_code')
      .map((grant) => grant.roleCode)
      .sort();
    expect(roles).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    for (const role of ['FINANCE', 'EXECUTIVE'] as const) {
      expect(roles as readonly string[]).not.toContain(role);
    }
  });

  it('★ 2차 가드 — 권한 없으면 403, ADMIN 역할 bypass 없음', async () => {
    await expectAppError(suggest([], READER), 'FORBIDDEN', 403);
    await expectAppError(suggest([], ADMIN_NO_PERM), 'FORBIDDEN', 403);
    // sku.create 만으로는 추천할 수 없다 (독립 permission)
    await expectAppError(
      suggest([], actorOf(['sku.create', 'sku.update'], ['SCM_STAFF'])),
      'FORBIDDEN',
      403,
    );
  });
});

describe('★ 1차 가드 — 라우트 정책 우선순위', () => {
  it('★ POST /api/skus/suggest-code → sku.suggest_code, POST /api/skus → sku.create', () => {
    expect(resolveRoutePermission({ pathname: '/api/skus/suggest-code', method: 'POST' })).toBe(
      SKU_SUGGEST_CODE_PERMISSION,
    );
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'POST' })).toBe('sku.create');
  });

  it('정책 배열에서 suggest-code 가 일반 /api/skus 정책보다 앞에 있다', () => {
    const suggestIndex = ROUTE_PERMISSIONS.findIndex(
      (policy) => policy.prefix === '/api/skus/suggest-code',
    );
    const generalIndex = ROUTE_PERMISSIONS.findIndex(
      (policy) => policy.prefix === '/api/skus' && policy.methods?.includes('POST') === true,
    );
    expect(suggestIndex).toBeGreaterThanOrEqual(0);
    expect(suggestIndex).toBeLessThan(generalIndex);
  });

  it('★ 구 경로 /api/skus/{id}/suggest-code 라우트를 만들지 않았다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const skusDir = fileURLToPath(new URL('../../app/api/skus', import.meta.url));
    expect(readdirSync(skusDir).sort()).toEqual(['[id]', 'route.ts', 'suggest-code']);
    // 상세 하위에는 워크플로 4종 + 바코드(T04-3) + 변경이력(T1-6B3) +
    // 공급조건 요약(T1-6B4) + BOM 역전개(T07-3) 만 — suggest-code 없음
    expect(readdirSync(`${skusDir}/[id]`).sort()).toEqual([
      'approve',
      'barcodes',
      'deactivate',
      'history',
      'reject',
      'route.ts',
      'submit',
      'supplier-skus',
      'where-used',
    ]);
  });

  it('추천 라우트 모듈은 POST 만 export 한다', async () => {
    const routeModule = (await import('../../app/api/skus/suggest-code/route')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(routeModule).sort()).toEqual(['POST', 'dynamic']);
  });
});
