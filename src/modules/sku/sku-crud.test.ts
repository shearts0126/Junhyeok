import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { AuditLogger, AuditWriteInput } from '@/modules/audit/application/audit-logger';
import {
  createActorContext,
  resolveRoutePermission,
  type ActorContext,
} from '@/modules/auth/application';
import type { TransactionClient } from '@/shared/db';
import { toDecimalString } from '@/shared/decimal';
import { ValidationError, type AppError } from '@/shared/errors';

import { PERMISSION_SEED, ROLE_CODES, ROLE_PERMISSION_SEED } from '../../../prisma/seed/roles';

import {
  SKU_CREATE_PERMISSION,
  SKU_READ_PERMISSION,
  SKU_UPDATE_PERMISSION,
  createSku,
  getSku,
  listSkus,
  parseCreateSkuInput,
  parseListSkusQuery,
  parseSkuId,
  parseUpdateSkuInput,
  skuCreateRequestHash,
  updateSku,
  type SkuReadClient,
} from './application';

/**
 * SKU CRUD 테스트 (T1-3) — DB 없이 대역으로 검증한다.
 *
 * 실제 DB 제약(UNIQUE·FK·트랜잭션 롤백)은 `tests/db/sku-crud.test.ts`.
 */

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

function actorWith(
  permissions: readonly string[],
  roles: readonly string[] = ['SCM_STAFF'],
): ActorContext {
  return createActorContext({
    userId: ACTOR_ID,
    email: 'sku-staff@deeppoint.test',
    name: 'SKU 담당자',
    active: true,
    roles,
    permissions,
    requestId: 'req-sku',
    sessionId: 'sess-sku',
    ipAddress: '10.0.0.10',
  });
}

const WRITER = actorWith([SKU_READ_PERMISSION, SKU_CREATE_PERMISSION, SKU_UPDATE_PERMISSION]);
const READER_ONLY = actorWith([SKU_READ_PERMISSION], ['FINANCE']);
/** 역할은 ADMIN 인데 권한 데이터가 없는 비정상 조합 — 그래도 차단되어야 한다 (bypass 금지). */
const ADMIN_ROLE_NO_PERMISSION = actorWith([], ['ADMIN']);

// 픽스처 공통코드 UUID (형식만 유효하면 된다)
const BRAND_ID = '11111111-1111-4111-8111-111111111101';
const BRAND_INACTIVE_ID = '11111111-1111-4111-8111-111111111102';
const MAJOR_ID = '11111111-1111-4111-8111-111111111103';
const MINOR_ID = '11111111-1111-4111-8111-111111111104';
const CHANNEL_ID = '11111111-1111-4111-8111-111111111105';
const MISSING_ID = '11111111-1111-4111-8111-111111111199';

const SKU_DRAFT_ID = '22222222-2222-4222-8222-222222222201';
const SKU_TRADED_ID = '22222222-2222-4222-8222-222222222202';
const SKU_ACTIVE_ID = '22222222-2222-4222-8222-222222222203';
const SKU_DELETED_ID = '22222222-2222-4222-8222-222222222204';

// ── 인메모리 대역 ───────────────────────────────────────────────

interface FakeCommonCode {
  id: string;
  groupCode: string;
  code: string;
  name: string;
  active: boolean;
}

interface FakeSkuRow {
  id: string;
  skuCode: string;
  skuName: string;
  skuNameEn: string | null;
  itemType: string;
  status: string;
  brandId: string | null;
  majorCategoryId: string | null;
  minorCategoryId: string | null;
  serialNumber: string | null;
  additionalCode: string | null;
  baseUom: string;
  purchaseUom: string | null;
  unitConversionQty: string;
  inventoryManaged: boolean;
  sellable: boolean;
  purchasable: boolean;
  manufacturable: boolean;
  lotManaged: boolean;
  expiryManaged: boolean;
  serialManaged: boolean;
  defaultShelfLifeDays: number | null;
  minimumRemainingDays: number | null;
  reconciliationToleranceQty: string;
  erpItemType: string | null;
  hasTransaction: boolean;
  discontinuationDate: Date | null;
  note: string | null;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  deletedAt: Date | null;
}

const NOW = new Date('2026-08-07T00:00:00.000Z');

function makeSku(overrides: Partial<FakeSkuRow>): FakeSkuRow {
  return {
    id: SKU_DRAFT_ID,
    skuCode: 'DP-F-0001',
    skuName: '테스트 SKU',
    skuNameEn: null,
    itemType: 'FINISHED',
    status: 'DRAFT',
    brandId: null,
    majorCategoryId: null,
    minorCategoryId: null,
    serialNumber: null,
    additionalCode: null,
    baseUom: 'EA',
    purchaseUom: null,
    unitConversionQty: '1',
    inventoryManaged: true,
    sellable: false,
    purchasable: false,
    manufacturable: false,
    lotManaged: false,
    expiryManaged: false,
    serialManaged: false,
    defaultShelfLifeDays: null,
    minimumRemainingDays: null,
    reconciliationToleranceQty: '0',
    erpItemType: null,
    hasTransaction: false,
    discontinuationDate: null,
    note: null,
    createdAt: NOW,
    createdBy: ACTOR_ID,
    updatedAt: NOW,
    updatedBy: ACTOR_ID,
    approvedAt: null,
    approvedBy: null,
    deletedAt: null,
    ...overrides,
  };
}

interface FakeStore {
  commonCodes: FakeCommonCode[];
  skus: FakeSkuRow[];
  auditWrites: AuditWriteInput[];
}

function makeStore(): FakeStore {
  return {
    commonCodes: [
      { id: BRAND_ID, groupCode: 'BRAND', code: 'FB', name: '퍼스트브랜드', active: true },
      { id: BRAND_INACTIVE_ID, groupCode: 'BRAND', code: 'XB', name: '중단 브랜드', active: false },
      { id: MAJOR_ID, groupCode: 'MAJOR_CATEGORY', code: 'HC', name: '헬스케어', active: true },
      { id: MINOR_ID, groupCode: 'MINOR_CATEGORY', code: 'SH', name: '샴푸', active: true },
      { id: CHANNEL_ID, groupCode: 'CHANNEL', code: 'CP', name: '쿠팡', active: true },
    ],
    skus: [
      makeSku({ id: SKU_DRAFT_ID, skuCode: 'DP-F-0001' }),
      makeSku({ id: SKU_TRADED_ID, skuCode: 'DP-F-0002', hasTransaction: true }),
      makeSku({
        id: SKU_ACTIVE_ID,
        skuCode: 'DP-F-0003',
        status: 'ACTIVE',
        approvedAt: NOW,
        approvedBy: ACTOR_ID,
      }),
      makeSku({ id: SKU_DELETED_ID, skuCode: 'DP-F-0004', deletedAt: NOW }),
    ],
    auditWrites: [],
  };
}

function refFor(store: FakeStore, id: string | null) {
  if (id === null) return null;
  const code = store.commonCodes.find((entry) => entry.id === id);
  if (code === undefined) return null;
  return { id: code.id, code: code.code, name: code.name, active: code.active };
}

function includeFor(store: FakeStore, row: FakeSkuRow) {
  return {
    ...row,
    brand: refFor(store, row.brandId),
    majorCategory: refFor(store, row.majorCategoryId),
    minorCategory: refFor(store, row.minorCategoryId),
  };
}

let idSequence = 0;

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function createFakeTx(store: FakeStore): TransactionClient {
  const tx = {
    commonCode: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        store.commonCodes
          .filter((entry) => where.id.in.includes(entry.id))
          .map((entry) => ({
            id: entry.id,
            code: entry.code,
            name: entry.name,
            active: entry.active,
            group: { groupCode: entry.groupCode },
          })),
    },
    sku: {
      findFirst: async ({ where }: { where: { id: string; deletedAt: null } }) => {
        const row =
          store.skus.find((entry) => entry.id === where.id && entry.deletedAt === null) ?? null;
        return row === null ? null : includeFor(store, row);
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (store.skus.some((entry) => entry.skuCode === data['skuCode'])) throw p2002();
        idSequence += 1;
        const row = makeSku({
          id: `44444444-4444-4444-8444-4444444444${String(idSequence).padStart(2, '0')}`,
        });
        Object.assign(row, data);
        store.skus.push(row);
        return includeFor(store, row);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.skus.find((entry) => entry.id === where.id);
        if (row === undefined) throw new Error('행 없음 (대역)');
        if (
          'skuCode' in data &&
          store.skus.some((entry) => entry.id !== row.id && entry.skuCode === data['skuCode'])
        ) {
          throw p2002();
        }
        Object.assign(row, data);
        row.updatedAt = new Date();
        return includeFor(store, row);
      },
    },
  };
  return tx as unknown as TransactionClient;
}

function fakeDependencies(store: FakeStore, options: { failAudit?: boolean } = {}) {
  const auditLogger: AuditLogger = {
    write: async (_tx, input) => {
      if (options.failAudit === true) throw new Error('감사로그 실패 (대역)');
      store.auditWrites.push(input);
      return {
        id: `audit-${store.auditWrites.length}`,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorId: input.actor.userId,
      };
    },
  };
  return {
    auditLogger,
    runInTransaction: async <T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T> =>
      callback(createFakeTx(store)),
  };
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

const MINIMAL_CREATE = { skuCode: 'DP-N-0001', skuName: '신규', itemType: 'FINISHED' };

// ═══════════════════════════════════════════════════════════════
// DTO — 생성
// ═══════════════════════════════════════════════════════════════
describe('parseCreateSkuInput', () => {
  it('최소 입력(skuCode·skuName·itemType)을 통과시킨다', () => {
    const input = parseCreateSkuInput(MINIMAL_CREATE);
    expect(input.skuCode).toBe('DP-N-0001');
  });

  it('★ server-managed 필드는 하나라도 오면 400 (조용히 버리지 않는다)', () => {
    for (const [field, value] of [
      ['id', '55555555-5555-4555-8555-555555555555'],
      ['status', 'ACTIVE'],
      ['hasTransaction', true],
      ['createdAt', '2026-01-01T00:00:00Z'],
      ['createdBy', ACTOR_ID],
      ['updatedAt', '2026-01-01T00:00:00Z'],
      ['updatedBy', ACTOR_ID],
      ['approvedAt', '2026-01-01T00:00:00Z'],
      ['approvedBy', ACTOR_ID],
      ['deletedAt', null],
    ] as const) {
      expect(
        () => parseCreateSkuInput({ ...MINIMAL_CREATE, [field]: value }),
        String(field),
      ).toThrow(ValidationError);
    }
  });

  it('★ 폐기 설계 negativeStockAllowed 는 어떤 값이든 400', () => {
    for (const value of [true, false]) {
      expect(() => parseCreateSkuInput({ ...MINIMAL_CREATE, negativeStockAllowed: value })).toThrow(
        ValidationError,
      );
    }
  });

  it('알 수 없는 필드를 거부한다', () => {
    expect(() => parseCreateSkuInput({ ...MINIMAL_CREATE, hacker: 1 })).toThrow(ValidationError);
  });

  it("★ ' ABC ' 는 자동 trim 하지 않고 거부한다 (정규화 금지)", () => {
    for (const bad of [' ABC ', 'ABC ', ' ABC', '', '  ']) {
      expect(() => parseCreateSkuInput({ ...MINIMAL_CREATE, skuCode: bad }), bad).toThrow(
        ValidationError,
      );
    }
  });

  it('코드 패턴 검사를 하지 않는다 — 체계 밖 실존 코드도 통과 (WARNING 은 후속 Task)', () => {
    for (const legacy of ['구코드_한글', 'x', '123', 'A/B(2)']) {
      expect(parseCreateSkuInput({ ...MINIMAL_CREATE, skuCode: legacy }).skuCode).toBe(legacy);
    }
  });

  it('★ Decimal 은 문자열만 — JSON number 는 거부, 해석은 shared toDecimal 로만', () => {
    const parsed = parseCreateSkuInput({ ...MINIMAL_CREATE, unitConversionQty: '2.500000' });
    expect(toDecimalString(parsed.unitConversionQty ?? '0')).toBe('2.5');

    for (const bad of [2.5, 1, 'abc', '1,000', ' 1 ', 'Infinity', 'NaN', '']) {
      expect(
        () => parseCreateSkuInput({ ...MINIMAL_CREATE, unitConversionQty: bad }),
        JSON.stringify(bad),
      ).toThrow(ValidationError);
    }
  });

  it('unitConversionQty 0 이하 거부, reconciliationToleranceQty 음수 거부(0 허용)', () => {
    for (const bad of ['0', '-1']) {
      expect(() => parseCreateSkuInput({ ...MINIMAL_CREATE, unitConversionQty: bad })).toThrow(
        ValidationError,
      );
    }
    expect(() =>
      parseCreateSkuInput({ ...MINIMAL_CREATE, reconciliationToleranceQty: '-0.000001' }),
    ).toThrow(ValidationError);
    expect(
      toDecimalString(
        parseCreateSkuInput({ ...MINIMAL_CREATE, reconciliationToleranceQty: '0' })
          .reconciliationToleranceQty ?? '9',
      ),
    ).toBe('0');
  });

  it('serialNumber 는 문자열 — 앞자리 0 이 보존된다', () => {
    const parsed = parseCreateSkuInput({ ...MINIMAL_CREATE, serialNumber: '00123' });
    expect(parsed.serialNumber).toBe('00123');
    expect(() => parseCreateSkuInput({ ...MINIMAL_CREATE, serialNumber: 123 })).toThrow(
      ValidationError,
    );
  });

  it('discontinuationDate 는 YYYY-MM-DD 만', () => {
    expect(
      parseCreateSkuInput({ ...MINIMAL_CREATE, discontinuationDate: '2026-12-31' })
        .discontinuationDate,
    ).toBe('2026-12-31');
    for (const bad of ['2026/12/31', '2026-13-01', '20261231', '2026-12-31T00:00:00Z']) {
      expect(() => parseCreateSkuInput({ ...MINIMAL_CREATE, discontinuationDate: bad })).toThrow(
        ValidationError,
      );
    }
  });

  it('공통코드 참조는 UUID 형식만 (형식 검증 — 실존·그룹은 service 가 본다)', () => {
    expect(() => parseCreateSkuInput({ ...MINIMAL_CREATE, brandId: 'FB' })).toThrow(
      ValidationError,
    );
    expect(parseCreateSkuInput({ ...MINIMAL_CREATE, brandId: BRAND_ID }).brandId).toBe(BRAND_ID);
    expect(parseCreateSkuInput({ ...MINIMAL_CREATE, brandId: null }).brandId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// DTO — 수정·id·목록 쿼리
// ═══════════════════════════════════════════════════════════════
describe('parseUpdateSkuInput', () => {
  it('★ 빈 PATCH({}) 는 400', () => {
    expect(() => parseUpdateSkuInput({})).toThrow(ValidationError);
  });

  it('★ status 변경 시도는 400 — 상태전이는 이 API 소관이 아니다', () => {
    expect(() => parseUpdateSkuInput({ status: 'ACTIVE' })).toThrow(ValidationError);
    expect(() => parseUpdateSkuInput({ skuName: '이름', status: 'INACTIVE' })).toThrow(
      ValidationError,
    );
  });

  it('server-managed·미지 필드 거부, 부분 수정은 통과', () => {
    expect(() => parseUpdateSkuInput({ hasTransaction: false })).toThrow(ValidationError);
    expect(() => parseUpdateSkuInput({ negativeStockAllowed: true })).toThrow(ValidationError);
    const patch = parseUpdateSkuInput({ skuName: '변경', note: null });
    expect(patch.skuName).toBe('변경');
    expect(patch.note).toBeNull();
  });
});

describe('parseSkuId', () => {
  it('UUID 형식이 아니면 400 (404 가 아니다)', () => {
    for (const bad of ['1', 'DP-F-0001', 'not-a-uuid']) {
      expect(() => parseSkuId(bad)).toThrow(ValidationError);
    }
    expect(parseSkuId(SKU_DRAFT_ID)).toBe(SKU_DRAFT_ID);
  });
});

describe('parseListSkusQuery', () => {
  const query = (qs: string) => parseListSkusQuery(new URLSearchParams(qs));

  it('기본값: page=1, pageSize=50, sort=updatedAt_desc', () => {
    expect(query('')).toMatchObject({ page: 1, pageSize: 50, sort: 'updatedAt_desc' });
  });

  it('지원 파라미터를 해석한다', () => {
    const parsed = query(
      `q=샴푸&status=DRAFT&itemType=FINISHED&brandId=${BRAND_ID}&page=2&pageSize=10&sort=skuCode_asc`,
    );
    expect(parsed).toMatchObject({
      q: '샴푸',
      status: 'DRAFT',
      itemType: 'FINISHED',
      brandId: BRAND_ID,
      page: 2,
      pageSize: 10,
      sort: 'skuCode_asc',
    });
  });

  it('★ 미래 필터(hasBom·mappingStatus·hasIssue)와 미지 파라미터는 조용히 무시하지 않고 400', () => {
    for (const bad of ['hasBom=true', 'mappingStatus=MISSING', 'hasIssue=1', 'foo=bar']) {
      expect(() => query(bad), bad).toThrow(ValidationError);
    }
  });

  it('경계값: page<1·pageSize>200·미지 sort·미지 status 거부', () => {
    for (const bad of ['page=0', 'pageSize=201', 'sort=name_asc', 'status=LIVE']) {
      expect(() => query(bad), bad).toThrow(ValidationError);
    }
    expect(query('pageSize=200').pageSize).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// 권한 — seed 표와 2차 가드 (ADMIN bypass 금지)
// ═══════════════════════════════════════════════════════════════
describe('★ 권한 배정 (RolePermission seed 표)', () => {
  it('★ sku.read 는 5개 역할 전부, sku.create/update 는 ADMIN·SCM_LEADER·SCM_STAFF 만', () => {
    const rolesOf = (key: string) =>
      ROLE_PERMISSION_SEED.filter((grant) => grant.permissionKey === key)
        .map((grant) => grant.roleCode)
        .sort();

    expect(rolesOf('sku.read')).toEqual([...ROLE_CODES].sort());
    expect(rolesOf('sku.create')).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    expect(rolesOf('sku.update')).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
  });

  it('권한 3종이 PERMISSION_SEED 에 등록되어 있다', () => {
    const keys = PERMISSION_SEED.map((entry) => entry.permissionKey);
    expect(keys).toContain('sku.read');
    expect(keys).toContain('sku.create');
    expect(keys).toContain('sku.update');
  });

  it('★ FINANCE·EXECUTIVE 는 read-only — 작성 권한이 없다', () => {
    for (const role of ['FINANCE', 'EXECUTIVE'] as const) {
      const keys = ROLE_PERMISSION_SEED.filter((grant) => grant.roleCode === role).map(
        (grant) => grant.permissionKey,
      );
      expect(keys).toContain('sku.read');
      expect(keys).not.toContain('sku.create');
      expect(keys).not.toContain('sku.update');
    }
  });
});

describe('★ 1차 가드 — 라우트 정책 (proxy 판정 표)', () => {
  it('/api/skus 메서드별 권한', () => {
    const resolve = (method: string, pathname = '/api/skus') =>
      resolveRoutePermission({ pathname, method });
    expect(resolve('GET')).toBe(SKU_READ_PERMISSION);
    expect(resolve('HEAD')).toBe(SKU_READ_PERMISSION);
    expect(resolve('POST')).toBe(SKU_CREATE_PERMISSION);
    expect(resolve('PATCH', `/api/skus/${SKU_DRAFT_ID}`)).toBe(SKU_UPDATE_PERMISSION);
    expect(resolve('GET', `/api/skus/${SKU_DRAFT_ID}`)).toBe(SKU_READ_PERMISSION);
    // 핸들러가 없어 405 지만, 1차 가드는 변경성 권한으로 묶는다.
    expect(resolve('DELETE', `/api/skus/${SKU_DRAFT_ID}`)).toBe(SKU_UPDATE_PERMISSION);
    expect(resolve('PUT')).toBe(SKU_UPDATE_PERMISSION);
  });
});

describe('★ 2차 가드 — application 권한 재검사', () => {
  it('★ read 전용(FINANCE 상당)은 create·update 403', async () => {
    const store = makeStore();
    const deps = fakeDependencies(store);
    await expectAppError(
      createSku(READER_ONLY, parseCreateSkuInput(MINIMAL_CREATE), deps),
      'FORBIDDEN',
      403,
    );
    await expectAppError(
      updateSku(READER_ONLY, SKU_DRAFT_ID, parseUpdateSkuInput({ skuName: '변경' }), deps),
      'FORBIDDEN',
      403,
    );
    expect(store.auditWrites).toHaveLength(0);
  });

  it('★ ADMIN 역할이라도 권한 데이터가 없으면 차단 — 코드상 bypass 없음', async () => {
    const store = makeStore();
    const deps = fakeDependencies(store);
    await expectAppError(
      listSkus(ADMIN_ROLE_NO_PERMISSION, parseListSkusQuery(new URLSearchParams())),
      'FORBIDDEN',
      403,
    );
    await expectAppError(
      createSku(ADMIN_ROLE_NO_PERMISSION, parseCreateSkuInput(MINIMAL_CREATE), deps),
      'FORBIDDEN',
      403,
    );
    await expectAppError(getSku(ADMIN_ROLE_NO_PERMISSION, SKU_DRAFT_ID), 'FORBIDDEN', 403);
  });
});

// ═══════════════════════════════════════════════════════════════
// createSku
// ═══════════════════════════════════════════════════════════════
describe('skuCreateRequestHash — 검증된 DTO 기준 (T1-3 보완)', () => {
  it('★ property 순서만 다른 요청 본문은 같은 hash', () => {
    const a = parseCreateSkuInput({ skuCode: 'DP-H-1', skuName: '이름', itemType: 'FINISHED' });
    const b = parseCreateSkuInput({ itemType: 'FINISHED', skuName: '이름', skuCode: 'DP-H-1' });
    expect(skuCreateRequestHash(a)).toBe(skuCreateRequestHash(b));
  });

  it('★ 필드 생략과 명시 전달을 합치지 않는다 — server 강제값은 hash 에 없다', () => {
    const omitted = parseCreateSkuInput({
      skuCode: 'DP-H-2',
      skuName: '이름',
      itemType: 'FINISHED',
    });
    const explicit = parseCreateSkuInput({
      skuCode: 'DP-H-2',
      skuName: '이름',
      itemType: 'FINISHED',
      baseUom: 'EA', // DB 기본값과 같은 값이라도 "명시 전달" 은 다른 요청 표현이다
    });
    expect(skuCreateRequestHash(omitted)).not.toBe(skuCreateRequestHash(explicit));
  });

  it('Decimal 표기 차이는 같은 값이면 같은 hash', () => {
    const a = parseCreateSkuInput({
      skuCode: 'DP-H-3',
      skuName: '이름',
      itemType: 'FINISHED',
      unitConversionQty: '2.500000',
    });
    const b = parseCreateSkuInput({
      skuCode: 'DP-H-3',
      skuName: '이름',
      itemType: 'FINISHED',
      unitConversionQty: '2.5',
    });
    expect(skuCreateRequestHash(a)).toBe(skuCreateRequestHash(b));
  });
});

describe('createSku', () => {
  it('★ server-managed 필드를 강제한다 — status=DRAFT·hasTransaction=false·작성자=Actor', async () => {
    const store = makeStore();
    const { sku: view, replayed } = await createSku(
      WRITER,
      parseCreateSkuInput({ ...MINIMAL_CREATE, brandId: BRAND_ID, unitConversionQty: '2' }),
      fakeDependencies(store),
    );

    expect(replayed).toBe(false);
    expect(view.status).toBe('DRAFT');
    expect(view.hasTransaction).toBe(false);
    expect(view.createdBy).toBe(ACTOR_ID);
    expect(view.updatedBy).toBe(ACTOR_ID);
    expect(view.approvedAt).toBeNull();
    expect(view.approvedBy).toBeNull();
    expect(view.unitConversionQty).toBe('2');
    expect(view.brand?.code).toBe('FB');

    const row = store.skus.find((entry) => entry.skuCode === 'DP-N-0001');
    expect(row?.status).toBe('DRAFT');
    expect(row?.hasTransaction).toBe(false);
    expect(row?.deletedAt).toBeNull();
  });

  it('★ 감사로그 CREATE 가 같은 트랜잭션에서 기록된다 — entityId 는 UUID', async () => {
    const store = makeStore();
    const { sku: view } = await createSku(
      WRITER,
      parseCreateSkuInput(MINIMAL_CREATE),
      fakeDependencies(store),
    );

    expect(store.auditWrites).toHaveLength(1);
    const audit = store.auditWrites[0];
    expect(audit?.entityType).toBe('Sku');
    expect(audit?.entityId).toBe(view.id);
    expect(audit?.entityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(audit?.action).toBe('CREATE');
    expect(audit?.beforeValue).toBeNull();
  });

  it('감사로그 실패 시 생성이 실패한다 (실 롤백은 db 테스트)', async () => {
    const store = makeStore();
    await expect(
      createSku(
        WRITER,
        parseCreateSkuInput(MINIMAL_CREATE),
        fakeDependencies(store, { failAudit: true }),
      ),
    ).rejects.toThrow('감사로그 실패');
  });

  it('★ 중복 skuCode 는 P2002 → 409 SKU_CODE_DUPLICATE (앱 선조회 대체 없음)', async () => {
    const store = makeStore();
    await expectAppError(
      createSku(
        WRITER,
        parseCreateSkuInput({ ...MINIMAL_CREATE, skuCode: 'DP-F-0001' }),
        fakeDependencies(store),
      ),
      'SKU_CODE_DUPLICATE',
      409,
    );
  });

  it('★ 실존하지만 다른 그룹의 코드 ID 는 실패한다 (group 정체성 — T1-1 limitation 해소)', async () => {
    const store = makeStore();
    const error = (await expectAppError(
      createSku(
        WRITER,
        parseCreateSkuInput({ ...MINIMAL_CREATE, brandId: CHANNEL_ID }),
        fakeDependencies(store),
      ),
      'VALIDATION_ERROR',
      400,
    )) as ValidationError;
    expect(error.fieldErrors[0]?.path).toBe('brandId');
    expect(error.fieldErrors[0]?.message).toContain('BRAND');
  });

  it('★ 비활성 코드·실존하지 않는 코드는 새로 참조할 수 없다', async () => {
    const store = makeStore();
    await expectAppError(
      createSku(
        WRITER,
        parseCreateSkuInput({ ...MINIMAL_CREATE, brandId: BRAND_INACTIVE_ID }),
        fakeDependencies(store),
      ),
      'VALIDATION_ERROR',
      400,
    );
    await expectAppError(
      createSku(
        WRITER,
        parseCreateSkuInput({ ...MINIMAL_CREATE, majorCategoryId: MISSING_ID }),
        fakeDependencies(store),
      ),
      'VALIDATION_ERROR',
      400,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// updateSku
// ═══════════════════════════════════════════════════════════════
describe('updateSku', () => {
  const patchOf = (body: unknown) => parseUpdateSkuInput(body);

  it('부분 수정 + updatedBy 강제 + 감사로그 UPDATE(before/after)', async () => {
    const store = makeStore();
    const view = await updateSku(
      WRITER,
      SKU_DRAFT_ID,
      patchOf({ skuName: '변경된 이름', note: '메모' }),
      fakeDependencies(store),
    );

    expect(view.skuName).toBe('변경된 이름');
    expect(view.updatedBy).toBe(ACTOR_ID);

    expect(store.auditWrites).toHaveLength(1);
    const audit = store.auditWrites[0];
    expect(audit?.action).toBe('UPDATE');
    expect(audit?.entityId).toBe(SKU_DRAFT_ID);
    expect((audit?.beforeValue as { skuName: string }).skuName).toBe('테스트 SKU');
    expect((audit?.afterValue as { skuName: string }).skuName).toBe('변경된 이름');
  });

  it('★ 없는 id·soft-delete 된 SKU 는 404', async () => {
    const store = makeStore();
    const deps = fakeDependencies(store);
    await expectAppError(
      updateSku(WRITER, MISSING_ID, patchOf({ skuName: 'x' }), deps),
      'NOT_FOUND',
      404,
    );
    await expectAppError(
      updateSku(WRITER, SKU_DELETED_ID, patchOf({ skuName: 'x' }), deps),
      'NOT_FOUND',
      404,
    );
  });

  it('★ ACTIVE SKU 의 일반 수정은 422 SKU_ACTIVE_UPDATE_RESTRICTED (보수적 차단)', async () => {
    const store = makeStore();
    await expectAppError(
      updateSku(WRITER, SKU_ACTIVE_ID, patchOf({ skuName: '변경' }), fakeDependencies(store)),
      'SKU_ACTIVE_UPDATE_RESTRICTED',
      422,
    );
    expect(store.auditWrites).toHaveLength(0);
  });

  it('다른 상태(REJECTED 등)에는 이 제한을 발명하지 않는다', async () => {
    const store = makeStore();
    store.skus.push(makeSku({ id: MISSING_ID, skuCode: 'DP-F-0009', status: 'REJECTED' }));
    const view = await updateSku(
      WRITER,
      MISSING_ID,
      patchOf({ skuName: '반려 후 수정' }),
      fakeDependencies(store),
    );
    expect(view.skuName).toBe('반려 후 수정');
  });

  it('★ TC-SKU-007 위임 — hasTransaction=true 인 SKU 의 코드 변경은 422 SKU_CODE_IMMUTABLE', async () => {
    const store = makeStore();
    await expectAppError(
      updateSku(WRITER, SKU_TRADED_ID, patchOf({ skuCode: 'DP-F-9999' }), fakeDependencies(store)),
      'SKU_CODE_IMMUTABLE',
      422,
    );

    // 동일 코드 재전송은 변경이 아니다 — 다른 필드 수정과 함께 허용된다.
    const view = await updateSku(
      WRITER,
      SKU_TRADED_ID,
      patchOf({ skuCode: 'DP-F-0002', skuName: '거래 있는 SKU 이름만 수정' }),
      fakeDependencies(store),
    );
    expect(view.skuCode).toBe('DP-F-0002');
    expect(view.skuName).toBe('거래 있는 SKU 이름만 수정');
  });

  it('hasTransaction=false 면 코드 변경 허용, 중복이면 409', async () => {
    const store = makeStore();
    const view = await updateSku(
      WRITER,
      SKU_DRAFT_ID,
      patchOf({ skuCode: 'DP-F-7777' }),
      fakeDependencies(store),
    );
    expect(view.skuCode).toBe('DP-F-7777');

    await expectAppError(
      updateSku(WRITER, SKU_DRAFT_ID, patchOf({ skuCode: 'DP-F-0003' }), fakeDependencies(store)),
      'SKU_CODE_DUPLICATE',
      409,
    );
  });

  it('★ 기존 비활성 참조를 건드리지 않는 수정은 막히지 않고, 새 참조만 검증된다', async () => {
    const store = makeStore();
    // 기존 행이 이미 비활성 브랜드를 참조 중 (과거 활성 시절 연결됐다고 가정)
    const row = store.skus.find((entry) => entry.id === SKU_DRAFT_ID);
    if (row !== undefined) row.brandId = BRAND_INACTIVE_ID;

    // brandId 를 건드리지 않는 수정 → 성공
    const view = await updateSku(
      WRITER,
      SKU_DRAFT_ID,
      patchOf({ skuName: '참조 유지 수정' }),
      fakeDependencies(store),
    );
    expect(view.brand?.active).toBe(false);

    // 비활성 코드를 **새로** 선택하는 것은 실패
    await expectAppError(
      updateSku(
        WRITER,
        SKU_DRAFT_ID,
        patchOf({ minorCategoryId: BRAND_INACTIVE_ID }),
        fakeDependencies(store),
      ),
      'VALIDATION_ERROR',
      400,
    );

    // null 로 해제는 허용
    const cleared = await updateSku(
      WRITER,
      SKU_DRAFT_ID,
      patchOf({ brandId: null }),
      fakeDependencies(store),
    );
    expect(cleared.brand).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// getSku · listSkus
// ═══════════════════════════════════════════════════════════════
describe('getSku', () => {
  function fakeDb(store: FakeStore): SkuReadClient {
    return {
      sku: {
        findFirst: async ({ where }: { where: { id: string } }) => {
          const row =
            store.skus.find((entry) => entry.id === where.id && entry.deletedAt === null) ?? null;
          return row === null ? null : includeFor(store, row);
        },
      },
    } as unknown as SkuReadClient;
  }

  it('상세를 반환한다 — Decimal 은 문자열, 공통코드는 표시용 참조', async () => {
    const store = makeStore();
    const row = store.skus.find((entry) => entry.id === SKU_DRAFT_ID);
    if (row !== undefined) {
      row.brandId = BRAND_ID;
      row.unitConversionQty = '2.500000';
    }
    const view = await getSku(WRITER, SKU_DRAFT_ID, { db: fakeDb(store) });
    expect(view.unitConversionQty).toBe('2.5');
    expect(view.brand).toEqual({ id: BRAND_ID, code: 'FB', name: '퍼스트브랜드', active: true });
    // 미래 모델 관계를 가짜로 채우지 않는다.
    expect(view).not.toHaveProperty('barcodes');
    expect(view).not.toHaveProperty('bom');
    expect(view).not.toHaveProperty('mappings');
  });

  it('★ UUID 형식 오류 400 / 없는 id·soft-delete 404', async () => {
    const store = makeStore();
    await expect(getSku(WRITER, 'not-a-uuid', { db: fakeDb(store) })).rejects.toThrow(
      ValidationError,
    );
    await expectAppError(getSku(WRITER, MISSING_ID, { db: fakeDb(store) }), 'NOT_FOUND', 404);
    await expectAppError(getSku(WRITER, SKU_DELETED_ID, { db: fakeDb(store) }), 'NOT_FOUND', 404);
  });
});

describe('listSkus', () => {
  interface CountArgs {
    where: Record<string, unknown>;
  }
  interface FindManyArgs {
    where: Record<string, unknown>;
    orderBy: unknown;
    skip: number;
    take: number;
  }
  interface CapturedArgs {
    count?: CountArgs;
    findMany?: FindManyArgs;
  }

  function capturingDb(captured: CapturedArgs): SkuReadClient {
    return {
      sku: {
        count: async (args: CountArgs) => {
          captured.count = args;
          return 0;
        },
        findMany: async (args: FindManyArgs) => {
          captured.findMany = args;
          return [];
        },
      },
    } as unknown as SkuReadClient;
  }

  const parse = (qs: string) => parseListSkusQuery(new URLSearchParams(qs));

  it('★ 기본 정렬 updatedAt DESC + 결정적 tie-breaker id ASC, 페이지 계산', async () => {
    const captured: CapturedArgs = {};
    const result = await listSkus(WRITER, parse('page=3&pageSize=20'), {
      db: capturingDb(captured),
    });

    expect(captured.findMany?.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }]);
    expect(captured.findMany?.skip).toBe(40);
    expect(captured.findMany?.take).toBe(20);
    expect(result).toMatchObject({ page: 3, pageSize: 20, total: 0, totalPages: 1 });
  });

  it('★ soft-delete 는 항상 제외되고 count 도 같은 where 를 쓴다', async () => {
    const captured: CapturedArgs = {};
    await listSkus(WRITER, parse('status=DRAFT'), { db: capturingDb(captured) });

    expect(captured.findMany?.where).toMatchObject({ deletedAt: null, status: 'DRAFT' });
    expect(captured.count?.where).toEqual(captured.findMany?.where);
  });

  it('★ q 는 skuCode·skuName·skuNameEn 3개 필드만 검색한다', async () => {
    const captured: CapturedArgs = {};
    await listSkus(WRITER, parse('q=샴푸'), { db: capturingDb(captured) });

    const or = captured.findMany?.where['OR'] as Array<Record<string, unknown>>;
    expect(or.map((entry) => Object.keys(entry)[0])).toEqual(['skuCode', 'skuName', 'skuNameEn']);
    for (const entry of or) {
      expect(Object.values(entry)[0]).toEqual({ contains: '샴푸', mode: 'insensitive' });
    }
  });

  it('필터 조합이 where 에 그대로 반영된다', async () => {
    const captured: CapturedArgs = {};
    await listSkus(
      WRITER,
      parse(
        `itemType=FINISHED&brandId=${BRAND_ID}&majorCategoryId=${MAJOR_ID}&minorCategoryId=${MINOR_ID}&sort=skuCode_desc`,
      ),
      { db: capturingDb(captured) },
    );
    expect(captured.findMany?.where).toMatchObject({
      itemType: 'FINISHED',
      brandId: BRAND_ID,
      majorCategoryId: MAJOR_ID,
      minorCategoryId: MINOR_ID,
    });
    expect(captured.findMany?.orderBy).toEqual([{ skuCode: 'desc' }, { id: 'asc' }]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 라우트 모듈 — 노출 endpoint 고정
// ═══════════════════════════════════════════════════════════════
describe('★ 라우트 모듈 — T1-3 은 4개 endpoint 만', () => {
  it('DELETE·PUT 핸들러를 export 하지 않는다 (405)', async () => {
    const collection = await import('../../app/api/skus/route');
    const detail = await import('../../app/api/skus/[id]/route');

    expect(Object.keys(collection).sort()).toEqual(['GET', 'POST', 'dynamic']);
    expect(Object.keys(detail).sort()).toEqual(['GET', 'PATCH', 'dynamic']);
  });

  it('승인 워크플로·기타 T1-4+ 라우트 디렉터리가 없다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const skusDir = fileURLToPath(new URL('../../app/api/skus', import.meta.url));
    const entries = readdirSync(skusDir).sort();
    expect(entries).toEqual(['[id]', 'route.ts']);
    const detailEntries = readdirSync(`${skusDir}/[id]`).sort();
    // submit/approve/reject/deactivate/archive/history 등 하위 경로 없음
    expect(detailEntries).toEqual(['route.ts']);
  });
});
