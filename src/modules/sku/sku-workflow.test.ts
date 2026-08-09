import { describe, expect, it } from 'vitest';

import type { AuditLogger, AuditWriteInput } from '@/modules/audit/application/audit-logger';
import {
  ROUTE_PERMISSIONS,
  createActorContext,
  resolveRoutePermission,
  type ActorContext,
} from '@/modules/auth/application';
import type { TransactionClient } from '@/shared/db';
import { ValidationError, type AppError } from '@/shared/errors';

import { ROLE_PERMISSION_SEED, PERMISSION_SEED } from '../../../prisma/seed/roles';

import {
  SKU_APPROVAL_CHECKS,
  SKU_APPROVE_PERMISSION,
  SKU_DEACTIVATE_PERMISSION,
  SKU_ITEM_TYPES,
  SKU_READ_PERMISSION,
  SKU_SUBMIT_PERMISSION,
  approveSku,
  deactivateSku,
  parseApproveSkuInput,
  parseDeactivateSkuInput,
  parseRejectSkuInput,
  parseSubmitSkuInput,
  rejectSku,
  submitSku,
} from './application';
import { SKU_STATUS_TRANSITIONS, SKU_STATUSES } from './domain';

/**
 * SKU 승인 워크플로 테스트 (T1-4A) — DB 없이 대역으로 검증한다.
 *
 * V1~V9 contract 근거: docs/08_설계복구_승인전검증9종.md.
 * 실제 DB(동시성·롤백·실 seed)는 `tests/db/sku-workflow.test.ts`.
 */

const STAFF_ID = '44444444-4444-4444-8444-444444444401';
const LEADER_ID = '44444444-4444-4444-8444-444444444402';

function actorOf(
  userId: string,
  permissions: readonly string[],
  roles: readonly string[],
): ActorContext {
  return createActorContext({
    userId,
    email: `wf-${userId.slice(-2)}@deeppoint.test`,
    name: '워크플로 테스트',
    active: true,
    roles,
    permissions,
    requestId: 'req-sku-wf',
  });
}

const STAFF = actorOf(STAFF_ID, [SKU_READ_PERMISSION, SKU_SUBMIT_PERMISSION], ['SCM_STAFF']);
const LEADER = actorOf(
  LEADER_ID,
  [SKU_READ_PERMISSION, SKU_SUBMIT_PERMISSION, SKU_APPROVE_PERMISSION, SKU_DEACTIVATE_PERMISSION],
  ['SCM_LEADER'],
);
const FINANCE_READER = actorOf(
  '44444444-4444-4444-8444-444444444403',
  [SKU_READ_PERMISSION],
  ['FINANCE'],
);
/** ADMIN 역할 + 권한 데이터 없음 — bypass 금지 검증. */
const ADMIN_NO_PERM = actorOf('44444444-4444-4444-8444-444444444404', [], ['ADMIN']);

// 공통코드 픽스처
const BRAND_ID = '55555555-5555-4555-8555-555555555501';
const BRAND_INACTIVE_ID = '55555555-5555-4555-8555-555555555502';
const CHANNEL_ID = '55555555-5555-4555-8555-555555555503';

const SKU_DRAFT_ID = '66666666-6666-4666-8666-666666666601';
const SKU_PENDING_ID = '66666666-6666-4666-8666-666666666602';
const SKU_ACTIVE_ID = '66666666-6666-4666-8666-666666666603';
const SKU_ARCHIVED_ID = '66666666-6666-4666-8666-666666666604';

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

const NOW = new Date('2026-08-09T00:00:00.000Z');

function makeSku(overrides: Partial<FakeSkuRow>): FakeSkuRow {
  return {
    id: SKU_DRAFT_ID,
    skuCode: 'FB-HC-SH-001',
    skuName: '워크플로 SKU',
    skuNameEn: null,
    itemType: 'FINISHED_GOOD', // V3 vocabulary 내
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
    createdBy: STAFF_ID,
    updatedAt: NOW,
    updatedBy: STAFF_ID,
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
  settings: { allowSelfApprovalSku: boolean; allowSelfApprovalBom: boolean };
}

function makeStore(): FakeStore {
  return {
    commonCodes: [
      { id: BRAND_ID, groupCode: 'BRAND', code: 'FB', name: '퍼스트브랜드', active: true },
      { id: BRAND_INACTIVE_ID, groupCode: 'BRAND', code: 'XB', name: '중단 브랜드', active: false },
      { id: CHANNEL_ID, groupCode: 'CHANNEL', code: 'A', name: '자사몰', active: true },
    ],
    skus: [
      makeSku({ id: SKU_DRAFT_ID, skuCode: 'FB-HC-SH-001' }),
      makeSku({ id: SKU_PENDING_ID, skuCode: 'FB-HC-SH-002', status: 'PENDING_APPROVAL' }),
      makeSku({
        id: SKU_ACTIVE_ID,
        skuCode: 'FB-HC-SH-003',
        status: 'ACTIVE',
        approvedAt: NOW,
        approvedBy: LEADER_ID,
      }),
      makeSku({ id: SKU_ARCHIVED_ID, skuCode: 'FB-HC-SH-004', status: 'ARCHIVED' }),
    ],
    auditWrites: [],
    settings: { allowSelfApprovalSku: false, allowSelfApprovalBom: false },
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
    systemSetting: {
      findUniqueOrThrow: async () => ({ ...store.settings }),
    },
    sku: {
      findFirst: async (args: {
        where: { id: string; deletedAt: null };
        select?: { status: boolean };
      }) => {
        const row =
          store.skus.find((entry) => entry.id === args.where.id && entry.deletedAt === null) ??
          null;
        if (row === null) return null;
        if (args.select !== undefined) return { status: row.status };
        return includeFor(store, row);
      },
      count: async ({ where }: { where: { skuCode: string; id: { not: string } } }) =>
        store.skus.filter((entry) => entry.skuCode === where.skuCode && entry.id !== where.id.not)
          .length,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string; deletedAt: null };
        data: Record<string, unknown>;
      }) => {
        const row = store.skus.find(
          (entry) =>
            entry.id === where.id && entry.status === where.status && entry.deletedAt === null,
        );
        if (row === undefined) return { count: 0 };
        Object.assign(row, data);
        row.updatedAt = new Date();
        return { count: 1 };
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

// ═══════════════════════════════════════════════════════════════
// DTO
// ═══════════════════════════════════════════════════════════════
describe('워크플로 DTO', () => {
  it('submit/approve — note 선택, 본문 없음({}) 허용, 미지 필드 400, untrimmed 400', () => {
    expect(parseSubmitSkuInput(undefined)).toEqual({});
    expect(parseSubmitSkuInput({ note: '요청 메모' }).note).toBe('요청 메모');
    expect(parseApproveSkuInput({})).toEqual({});
    expect(() => parseSubmitSkuInput({ note: ' 공백 ' })).toThrow(ValidationError);
    expect(() => parseSubmitSkuInput({ hacker: 1 })).toThrow(ValidationError);
    expect(() => parseApproveSkuInput({ status: 'ACTIVE' })).toThrow(ValidationError);
  });

  it('★ reject — reason 필수(trimmed nonblank)', () => {
    expect(parseRejectSkuInput({ reason: '검증 미비' }).reason).toBe('검증 미비');
    for (const bad of [undefined, {}, { reason: '' }, { reason: '   ' }, { reason: ' x ' }]) {
      expect(() => parseRejectSkuInput(bad), JSON.stringify(bad)).toThrow(ValidationError);
    }
  });

  it('deactivate — reason 은 선택 (임의 필수화 금지)', () => {
    expect(parseDeactivateSkuInput(undefined)).toEqual({});
    expect(parseDeactivateSkuInput({ reason: '단종 예정' }).reason).toBe('단종 예정');
    expect(() => parseDeactivateSkuInput({ note: 'x' })).toThrow(ValidationError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 권한 시드·1차 가드
// ═══════════════════════════════════════════════════════════════
describe('★ T1-4A 권한 배정 (RolePermission seed 표)', () => {
  const rolesOf = (key: string) =>
    ROLE_PERMISSION_SEED.filter((grant) => grant.permissionKey === key)
      .map((grant) => grant.roleCode)
      .sort();

  it('★ submit=S·L·A / approve=L·A / deactivate=L·A — sku.reject 없음, sku.archive 아직 없음', () => {
    expect(rolesOf('sku.submit')).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    expect(rolesOf('sku.approve')).toEqual(['ADMIN', 'SCM_LEADER']);
    expect(rolesOf('sku.deactivate')).toEqual(['ADMIN', 'SCM_LEADER']);
    const keys = PERMISSION_SEED.map((entry) => entry.permissionKey);
    expect(keys).not.toContain('sku.reject');
    expect(keys).not.toContain('sku.archive'); // T1-4B
  });

  it('★ FINANCE·EXECUTIVE 는 워크플로 권한이 전혀 없다', () => {
    for (const role of ['FINANCE', 'EXECUTIVE'] as const) {
      const keys = ROLE_PERMISSION_SEED.filter((grant) => grant.roleCode === role).map(
        (grant) => grant.permissionKey,
      );
      for (const denied of ['sku.submit', 'sku.approve', 'sku.deactivate']) {
        expect(keys, `${role}:${denied}`).not.toContain(denied);
      }
    }
  });
});

describe('★ 1차 가드 — SKU 화면 라우트 정책 (T1-6A)', () => {
  const resolvePage = (pathname: string) => resolveRoutePermission({ pathname, method: 'GET' });

  it('★ /master/skus/new 는 sku.create — 일반 /master/skus read 정책보다 우선한다', () => {
    expect(resolvePage('/master/skus/new')).toBe('sku.create');
    // 목록·상세는 그대로 sku.read (신규 정책이 회귀를 만들지 않는다)
    expect(resolvePage('/master/skus')).toBe(SKU_READ_PERMISSION);
    expect(resolvePage('/master/skus?status=DRAFT')).toBe(SKU_READ_PERMISSION);
    expect(resolvePage(`/master/skus/${SKU_DRAFT_ID}`)).toBe(SKU_READ_PERMISSION);
  });

  it('정책 배열에서 new 정책이 일반 정책보다 앞에 있다 (첫 일치 우선 규칙)', () => {
    const newIndex = ROUTE_PERMISSIONS.findIndex((policy) => policy.prefix === '/master/skus/new');
    const listIndex = ROUTE_PERMISSIONS.findIndex((policy) => policy.prefix === '/master/skus');
    expect(newIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeLessThan(listIndex);
  });
});

describe('★ 1차 가드 — 워크플로 라우트 정책', () => {
  const resolve = (path: string) =>
    resolveRoutePermission({ pathname: `/api/skus/${SKU_DRAFT_ID}${path}`, method: 'POST' });

  it('suffix 별 권한 매핑 + 일반 POST(생성) 유지', () => {
    expect(resolve('/submit')).toBe(SKU_SUBMIT_PERMISSION);
    expect(resolve('/approve')).toBe(SKU_APPROVE_PERMISSION);
    expect(resolve('/reject')).toBe(SKU_APPROVE_PERMISSION); // 동일 approval authority
    expect(resolve('/deactivate')).toBe(SKU_DEACTIVATE_PERMISSION);
    // 워크플로 정책이 일반 생성 정책을 가리지 않는다
    expect(resolveRoutePermission({ pathname: '/api/skus', method: 'POST' })).toBe('sku.create');
  });
});

// ═══════════════════════════════════════════════════════════════
// V1~V9 검증 report
// ═══════════════════════════════════════════════════════════════
describe('★ 승인 전 검증 V1~V9 (docs/08 복구 contract)', () => {
  it('9종 코드·severity 가 계약대로 고정돼 있다', () => {
    expect(SKU_APPROVAL_CHECKS).toHaveLength(9);
    expect(SKU_ITEM_TYPES).toHaveLength(14);
  });

  it('★ 정상 SKU submit — report 반환: V1~V5 PASS, V6 CHECK_UNAVAILABLE, V7~V9 NOT_APPLICABLE', async () => {
    const store = makeStore();
    const { sku, validation } = await submitSku(STAFF, SKU_DRAFT_ID, {}, fakeDependencies(store));

    expect(sku.status).toBe('PENDING_APPROVAL');
    expect(validation?.hasErrors).toBe(false);
    expect(validation?.hasWarnings).toBe(false);

    const byCode = new Map(validation?.checks.map((check) => [check.code, check]));
    expect(byCode.size).toBe(9);
    for (const code of [
      'REQUIRED_FIELD_MISSING',
      'SKU_CODE_DUPLICATE',
      'ITEM_TYPE_UNMAPPED',
      'BRAND_CODE_NOT_FOUND',
      'CATEGORY_CODE_NOT_FOUND',
    ] as const) {
      expect(byCode.get(code)?.status, code).toBe('PASS');
    }
    // ★ CHECK_UNAVAILABLE 을 PASS 로 위장하지 않는다
    expect(byCode.get('SKU_CODE_PATTERN_VIOLATION')?.status).toBe('CHECK_UNAVAILABLE');
    expect(byCode.get('SKU_CODE_PATTERN_VIOLATION')?.severity).toBe('WARNING');
    for (const code of [
      'BARCODE_SCIENTIFIC_NOTATION',
      'BARCODE_UNVERIFIED',
      'BARCODE_DUPLICATE',
    ] as const) {
      expect(byCode.get(code)?.status, code).toBe('NOT_APPLICABLE');
      expect(byCode.get(code)?.message).toContain('BARCODE_MODULE');
    }
  });

  it('★ ERROR FAIL 이면 422 + 상태 유지 + 감사로그 없음 (V2·V3·V4·V5)', async () => {
    // V2: 중복 skuCode (다른 행과 동일 코드)
    const dupStore = makeStore();
    const dupRow = dupStore.skus.find((entry) => entry.id === SKU_DRAFT_ID);
    if (dupRow !== undefined) dupRow.skuCode = 'FB-HC-SH-002'; // PENDING 행과 중복
    // V3: vocabulary 밖 itemType
    const v3Store = makeStore();
    const v3Row = v3Store.skus.find((entry) => entry.id === SKU_DRAFT_ID);
    if (v3Row !== undefined) v3Row.itemType = 'FINISHED'; // 14종에 없음
    // V4: 비활성 브랜드 참조
    const v4Store = makeStore();
    const v4Row = v4Store.skus.find((entry) => entry.id === SKU_DRAFT_ID);
    if (v4Row !== undefined) v4Row.brandId = BRAND_INACTIVE_ID;
    // V5: 다른 그룹의 실존 코드
    const v5Store = makeStore();
    const v5Row = v5Store.skus.find((entry) => entry.id === SKU_DRAFT_ID);
    if (v5Row !== undefined) v5Row.majorCategoryId = CHANNEL_ID;

    for (const [label, store, failCode] of [
      ['V2', dupStore, 'SKU_CODE_DUPLICATE'],
      ['V3', v3Store, 'ITEM_TYPE_UNMAPPED'],
      ['V4', v4Store, 'BRAND_CODE_NOT_FOUND'],
      ['V5', v5Store, 'CATEGORY_CODE_NOT_FOUND'],
    ] as const) {
      const error = await expectAppError(
        submitSku(STAFF, SKU_DRAFT_ID, {}, fakeDependencies(store)),
        'SKU_APPROVAL_VALIDATION_FAILED',
        422,
      );
      const checks = (error.publicDetails as { checks: Array<{ code: string; status: string }> })
        .checks;
      expect(checks.find((check) => check.code === failCode)?.status, `${label}:${failCode}`).toBe(
        'FAIL',
      );
      // 상태 유지 + 감사로그 없음
      expect(store.skus.find((entry) => entry.id === SKU_DRAFT_ID)?.status, label).toBe('DRAFT');
      expect(store.auditWrites, label).toHaveLength(0);
    }
  });

  it('V1 — persisted state 기준 핵심값 공백 FAIL (DTO 를 통과한 과거 데이터 가정)', async () => {
    const store = makeStore();
    const row = store.skus.find((entry) => entry.id === SKU_DRAFT_ID);
    if (row !== undefined) row.skuName = '   ';
    const error = await expectAppError(
      submitSku(STAFF, SKU_DRAFT_ID, {}, fakeDependencies(store)),
      'SKU_APPROVAL_VALIDATION_FAILED',
      422,
    );
    const checks = (error.publicDetails as { checks: Array<{ code: string; status: string }> })
      .checks;
    expect(checks.find((check) => check.code === 'REQUIRED_FIELD_MISSING')?.status).toBe('FAIL');
  });
});

// ═══════════════════════════════════════════════════════════════
// TC-SKU-006 — 전이·자가승인·권한
// ═══════════════════════════════════════════════════════════════
describe('★ TC-SKU-006 — 승인 워크플로', () => {
  it('★ DRAFT submit → PENDING / PENDING approve → ACTIVE / PENDING reject → REJECTED / ACTIVE deactivate → INACTIVE', async () => {
    const store = makeStore();
    const deps = fakeDependencies(store);

    const submitted = await submitSku(STAFF, SKU_DRAFT_ID, { note: '신규 등록 요청' }, deps);
    expect(submitted.sku.status).toBe('PENDING_APPROVAL');

    const approved = await approveSku(LEADER, SKU_DRAFT_ID, {}, deps);
    expect(approved.sku.status).toBe('ACTIVE');
    expect(approved.sku.approvedBy).toBe(LEADER_ID);
    expect(approved.sku.approvedAt).not.toBeNull();
    expect(approved.sku.updatedBy).toBe(LEADER_ID);

    const rejected = await rejectSku(LEADER, SKU_PENDING_ID, { reason: '분류 재검토' }, deps);
    expect(rejected.sku.status).toBe('REJECTED');
    // ★ 반려는 승인이 아니다 — approvedAt/approvedBy 를 설정하지 않는다
    expect(rejected.sku.approvedAt).toBeNull();
    expect(rejected.sku.approvedBy).toBeNull();

    const deactivated = await deactivateSku(LEADER, SKU_ACTIVE_ID, { reason: '단종' }, deps);
    expect(deactivated.sku.status).toBe('INACTIVE');
    // ★ 기존 승인 이력을 지우지 않는다
    expect(deactivated.sku.approvedAt).not.toBeNull();
    expect(deactivated.sku.approvedBy).toBe(LEADER_ID);
  });

  it('★ 자가승인 — 설정 false 면 작성자 approve 403, true 면 허용', async () => {
    const store = makeStore();
    const deps = fakeDependencies(store);
    // 작성자(STAFF_ID)가 sku.approve 권한을 가진 상황을 가정한 actor
    const creatorApprover = actorOf(
      STAFF_ID,
      [SKU_READ_PERMISSION, SKU_APPROVE_PERMISSION],
      ['SCM_LEADER'],
    );

    store.settings.allowSelfApprovalSku = false;
    await expectAppError(
      approveSku(creatorApprover, SKU_PENDING_ID, {}, deps),
      'SELF_APPROVAL_FORBIDDEN',
      403,
    );
    expect(store.skus.find((entry) => entry.id === SKU_PENDING_ID)?.status).toBe(
      'PENDING_APPROVAL',
    );

    store.settings.allowSelfApprovalSku = true;
    const approved = await approveSku(creatorApprover, SKU_PENDING_ID, {}, deps);
    expect(approved.sku.status).toBe('ACTIVE');
  });

  it('★ 권한 403 — submit 권한만으로 approve/reject/deactivate 불가, FINANCE 전부 불가, ADMIN bypass 없음', async () => {
    const store = makeStore();
    const deps = fakeDependencies(store);

    await expectAppError(approveSku(STAFF, SKU_PENDING_ID, {}, deps), 'FORBIDDEN', 403);
    await expectAppError(rejectSku(STAFF, SKU_PENDING_ID, { reason: 'x' }, deps), 'FORBIDDEN', 403);
    await expectAppError(deactivateSku(STAFF, SKU_ACTIVE_ID, {}, deps), 'FORBIDDEN', 403);

    await expectAppError(submitSku(FINANCE_READER, SKU_DRAFT_ID, {}, deps), 'FORBIDDEN', 403);
    await expectAppError(approveSku(FINANCE_READER, SKU_PENDING_ID, {}, deps), 'FORBIDDEN', 403);

    await expectAppError(submitSku(ADMIN_NO_PERM, SKU_DRAFT_ID, {}, deps), 'FORBIDDEN', 403);
    await expectAppError(approveSku(ADMIN_NO_PERM, SKU_PENDING_ID, {}, deps), 'FORBIDDEN', 403);

    expect(store.auditWrites).toHaveLength(0);
  });

  it('★ 상태 오류 — 허용되지 않은 전이는 전부 422 INVALID_STATUS_TRANSITION', async () => {
    const store = makeStore();
    const deps = fakeDependencies(store);

    await expectAppError(
      submitSku(STAFF, SKU_ACTIVE_ID, {}, deps),
      'INVALID_STATUS_TRANSITION',
      422,
    );
    await expectAppError(
      approveSku(LEADER, SKU_DRAFT_ID, {}, deps),
      'INVALID_STATUS_TRANSITION',
      422,
    );
    await expectAppError(
      rejectSku(LEADER, SKU_DRAFT_ID, { reason: 'x' }, deps),
      'INVALID_STATUS_TRANSITION',
      422,
    );
    await expectAppError(
      deactivateSku(LEADER, SKU_DRAFT_ID, {}, deps),
      'INVALID_STATUS_TRANSITION',
      422,
    );
    await expectAppError(
      deactivateSku(LEADER, SKU_PENDING_ID, {}, deps),
      'INVALID_STATUS_TRANSITION',
      422,
    );
    // ARCHIVED 는 terminal — 네 action 전부 불가
    await expectAppError(
      submitSku(STAFF, SKU_ARCHIVED_ID, {}, deps),
      'INVALID_STATUS_TRANSITION',
      422,
    );
    await expectAppError(
      approveSku(LEADER, SKU_ARCHIVED_ID, {}, deps),
      'INVALID_STATUS_TRANSITION',
      422,
    );
    await expectAppError(
      rejectSku(LEADER, SKU_ARCHIVED_ID, { reason: 'x' }, deps),
      'INVALID_STATUS_TRANSITION',
      422,
    );
    await expectAppError(
      deactivateSku(LEADER, SKU_ARCHIVED_ID, {}, deps),
      'INVALID_STATUS_TRANSITION',
      422,
    );
  });

  it('★ approve 재검증 — submit 후 브랜드가 비활성화되면 approve 422, PENDING 유지', async () => {
    const store = makeStore();
    const deps = fakeDependencies(store);
    const row = store.skus.find((entry) => entry.id === SKU_DRAFT_ID);
    if (row !== undefined) row.brandId = BRAND_ID;

    await submitSku(STAFF, SKU_DRAFT_ID, {}, deps);

    // submit 후 approve 전 사이에 참조 브랜드 비활성화
    const brand = store.commonCodes.find((entry) => entry.id === BRAND_ID);
    if (brand !== undefined) brand.active = false;

    await expectAppError(
      approveSku(LEADER, SKU_DRAFT_ID, {}, deps),
      'SKU_APPROVAL_VALIDATION_FAILED',
      422,
    );
    expect(store.skus.find((entry) => entry.id === SKU_DRAFT_ID)?.status).toBe('PENDING_APPROVAL');
  });

  it('★ AuditLog — action 4종·reason/note·APPROVE 의 approvedBy, 실패 시 전파', async () => {
    const store = makeStore();
    const deps = fakeDependencies(store);

    await submitSku(STAFF, SKU_DRAFT_ID, { note: '요청 사유' }, deps);
    await approveSku(LEADER, SKU_DRAFT_ID, { note: '승인 메모' }, deps);
    await rejectSku(LEADER, SKU_PENDING_ID, { reason: '반려 사유' }, deps);
    await deactivateSku(LEADER, SKU_ACTIVE_ID, { reason: '중지 사유' }, deps);

    const actions = store.auditWrites.map((write) => write.action);
    expect(actions).toEqual(['SUBMIT', 'APPROVE', 'REJECT', 'DEACTIVATE']);

    const [submit, approve, reject, deactivate] = store.auditWrites;
    expect(submit?.reason).toBe('요청 사유');
    expect(submit?.approvedBy).toBeUndefined();
    expect((submit?.beforeValue as { status: string }).status).toBe('DRAFT');
    expect((submit?.afterValue as { status: string }).status).toBe('PENDING_APPROVAL');

    expect(approve?.approvedBy).toBe(LEADER_ID);
    expect(approve?.reason).toBe('승인 메모');

    expect(reject?.reason).toBe('반려 사유');
    expect(reject?.approvedBy).toBeUndefined();

    expect(deactivate?.reason).toBe('중지 사유');
    expect((deactivate?.beforeValue as { status: string }).status).toBe('ACTIVE');
    expect((deactivate?.afterValue as { status: string }).status).toBe('INACTIVE');

    // 감사 실패 → 전파 (실 롤백은 db 테스트)
    const failStore = makeStore();
    await expect(
      submitSku(STAFF, SKU_DRAFT_ID, {}, fakeDependencies(failStore, { failAudit: true })),
    ).rejects.toThrow('감사로그 실패');
  });
});

// ═══════════════════════════════════════════════════════════════
// 회귀 — matrix·라우트 모듈
// ═══════════════════════════════════════════════════════════════
describe('★ T1-4A 회귀 고정', () => {
  it('★ 7×7 matrix 는 기존 allowed 4 / blocked 45 그대로 — ARCHIVED 전이는 T1-4B', () => {
    const allowed = SKU_STATUSES.flatMap((from) =>
      SKU_STATUS_TRANSITIONS[from].map((to) => `${from}→${to}`),
    );
    expect(allowed.sort()).toEqual([
      'ACTIVE→INACTIVE',
      'DRAFT→PENDING_APPROVAL',
      'PENDING_APPROVAL→ACTIVE',
      'PENDING_APPROVAL→REJECTED',
    ]);
    expect(SKU_STATUSES.length * SKU_STATUSES.length - allowed.length).toBe(45);
  });

  it('워크플로 라우트 모듈은 POST 만 export 한다', async () => {
    const modules: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['submit', await import('../../app/api/skus/[id]/submit/route')],
      ['approve', await import('../../app/api/skus/[id]/approve/route')],
      ['reject', await import('../../app/api/skus/[id]/reject/route')],
      ['deactivate', await import('../../app/api/skus/[id]/deactivate/route')],
    ];
    for (const [action, routeModule] of modules) {
      expect(Object.keys(routeModule).sort(), action).toEqual(['POST', 'dynamic']);
    }
  });
});
