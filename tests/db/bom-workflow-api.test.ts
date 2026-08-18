import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  activateBom,
  approveBom,
  archiveBom,
  cloneBom,
  createBom,
  createBomLine,
  deactivateBom,
  parseActivateBomInput,
  parseArchiveBomInput,
  parseCloneBomInput,
  parseDeactivateBomInput,
  parseRejectBomInput,
  parseSubmitBomInput,
  rejectBom,
  resolveEffectiveBom,
  submitBom,
  updateBomLine,
  BOM_APPROVE_PERMISSION,
  BOM_CREATE_PERMISSION,
  BOM_LINE_ENTITY_TYPE,
  BOM_READ_PERMISSION,
  BOM_SUBMIT_PERMISSION,
  BOM_UPDATE_PERMISSION,
  BOM_WORKFLOW_ENTITY_TYPE,
  parseDateOnly,
  type CreateBomInput,
  type CreateLineInput,
} from '@/modules/bom/application';
import { businessDateOf } from '@/shared/business-date';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * BOM workflow DB 통합 테스트 (T07-5) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-6 · §D-7(chain) · §D-8 · §D-10(submit
 *    게이트) · §D-13(activate 최종 T 재검사) · §D-15 · §D-16 · §D-17 · §D-28 ·
 *    §D-29 · §D-32 test matrix + `★ T07-5 workflow gap closure` W-1 ~ W-9.
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - **D-7 chain 전량** — 미래 / 과거 / gap / 동일일 / 반복
 *   - predecessor 가 **`ACTIVE` 를 유지**하고 `effectiveFrom` 이 안 바뀌는 것
 *   - **activate 최종 `T` 기준 cycle 재검사** (approve 통과 재사용 금지)
 *   - 자가승인 — 트랜잭션 안에서 최신 `SystemSetting` 을 읽는지
 *   - **deactivate 날짜 경계 CASE A~F** (미래 equality 400 포함)
 *   - clone Header/Line matrix · legacy reset · line audit N건
 *   - 동시성 — approve×approve · approve×reject · submit×PATCH · sibling activate
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TWF-${RUN}-${suffix}`;

const AUTHOR_ID = 'fff00000-0000-4000-8000-0000000f7001';
const APPROVER_ID = 'fff00000-0000-4000-8000-0000000f7002';
const APPROVER2_ID = 'fff00000-0000-4000-8000-0000000f7003';
const STAFF_ID = 'fff00000-0000-4000-8000-0000000f7004';
const FINANCE_ID = 'fff00000-0000-4000-8000-0000000f7005';
const NOPERM_ID = 'fff00000-0000-4000-8000-0000000f7006';
const ACTOR_IDS = [AUTHOR_ID, APPROVER_ID, APPROVER2_ID, STAFF_ID, FINANCE_ID, NOPERM_ID];

const actor = (userId: string, roles: string[], permissions: string[]): ActorContext =>
  createActorContext({
    userId,
    email: `${userId}@deeppoint.test`,
    name: userId,
    active: true,
    roles,
    permissions,
    requestId: `req-${userId}`,
  });

const ALL_BOM = [
  BOM_READ_PERMISSION,
  BOM_CREATE_PERMISSION,
  BOM_UPDATE_PERMISSION,
  BOM_SUBMIT_PERMISSION,
  BOM_APPROVE_PERMISSION,
];

/** 작성자 — create·update·submit 은 되지만 approve 는 없다. */
const AUTHOR = actor(
  AUTHOR_ID,
  ['SCM_STAFF'],
  [BOM_READ_PERMISSION, BOM_CREATE_PERMISSION, BOM_UPDATE_PERMISSION, BOM_SUBMIT_PERMISSION],
);
/** 승인자 — 전 권한. 자가승인 테스트에서 작성자와 다른 사람 역할. */
const APPROVER = actor(APPROVER_ID, ['SCM_LEADER'], ALL_BOM);
const APPROVER2 = actor(APPROVER2_ID, ['SCM_LEADER'], ALL_BOM);
/** 작성자이면서 승인 권한도 가진 사람 — 자가승인 시나리오용. */
const SELF = actor(AUTHOR_ID, ['SCM_LEADER'], ALL_BOM);
/** SCM_STAFF — submit 은 되지만 approve 는 안 된다 (D-15). */
const STAFF = actor(
  STAFF_ID,
  ['SCM_STAFF'],
  [BOM_READ_PERMISSION, BOM_CREATE_PERMISSION, BOM_UPDATE_PERMISSION, BOM_SUBMIT_PERMISSION],
);
/** FINANCE — read 만. */
const FINANCE = actor(FINANCE_ID, ['FINANCE'], [BOM_READ_PERMISSION]);
/** ADMIN role 이지만 permission 데이터가 없다 — bypass 부재 증명. */
const NO_PERMISSION = actor(NOPERM_ID, ['ADMIN'], []);

let seq = 0;

async function newSku(label: string, overrides: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `워크플로 SKU (${label})`,
      itemType: 'FINISHED_GOOD',
      ...overrides,
    },
    select: { id: true },
  });
  return row.id;
}

function bomInput(parentSkuId: string, overrides: Partial<CreateBomInput> = {}): CreateBomInput {
  seq += 1;
  return {
    parentSkuId,
    bomType: 'MANUFACTURING',
    version: `v${String(seq).padStart(4, '0')}`,
    effectiveFrom: '2026-01-01',
    ...overrides,
  };
}

function lineInput(
  componentSkuId: string,
  overrides: Partial<CreateLineInput> = {},
): CreateLineInput {
  return { componentSkuId, componentRole: 'MATERIAL', ...overrides };
}

interface Fixture {
  readonly bomId: string;
  readonly parentSkuId: string;
  readonly componentSkuId: string;
  readonly lineId: string;
}

/** 확정된 라인 1개를 가진 `DRAFT` — submit 게이트를 통과하는 최소 구성. */
async function draftReadyToSubmit(
  label: string,
  author: ActorContext = AUTHOR,
  overrides: Partial<CreateBomInput> = {},
): Promise<Fixture> {
  const parentSkuId = await newSku(`${label}-p`, { status: 'ACTIVE' });
  const componentSkuId = await newSku(`${label}-c`, { status: 'ACTIVE' });
  const created = await createBom(author, bomInput(parentSkuId, overrides));
  const line = await createBomLine(
    author,
    created.bom.id,
    lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '2' }),
  );
  return { bomId: created.bom.id, parentSkuId, componentSkuId, lineId: line.line.id };
}

/** `DRAFT` → `APPROVED` 까지 밀어 둔다. */
async function approved(label: string, overrides: Partial<CreateBomInput> = {}): Promise<Fixture> {
  const fixture = await draftReadyToSubmit(label, AUTHOR, overrides);
  await submitBom(AUTHOR, fixture.bomId, parseSubmitBomInput({}));
  await approveBom(APPROVER, fixture.bomId, {});
  return fixture;
}

async function headerRow(bomId: string) {
  return getPrismaClient().bomHeader.findUniqueOrThrow({
    where: { id: bomId },
    select: {
      id: true,
      status: true,
      effectiveFrom: true,
      effectiveTo: true,
      approvedAt: true,
      approvedBy: true,
      activatedAt: true,
      createdBy: true,
      version: true,
    },
  });
}

async function auditsOf(entityType: string, entityId: string) {
  return getPrismaClient().auditLog.findMany({
    where: { entityType, entityId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { action: true, actorId: true, reason: true, afterValue: true },
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('예외가 발생하지 않았다');
}

function dateStr(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

async function setSelfApprovalBom(allowed: boolean): Promise<void> {
  await getPrismaClient().systemSetting.update({
    where: { id: 1 },
    data: { allowSelfApprovalBom: allowed },
  });
}

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`,
    ACTOR_IDS,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({ where: { actorId: { in: ACTOR_IDS } } });
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TWF-' } } } },
  });
  await client.bomLine.deleteMany({ where: { componentSku: { skuCode: { startsWith: 'TWF-' } } } });
  await client.bomHeader.deleteMany({ where: { parentSku: { skuCode: { startsWith: 'TWF-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TWF-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: '워크플로 테스트' })),
  });
  await client.systemSetting.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
});

afterAll(async () => {
  await setSelfApprovalBom(false);
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 1. submit
// ═══════════════════════════════════════════════════════════════

describe('★ submit — DRAFT·REJECTED → PENDING_APPROVAL (D-6)', () => {
  it('DRAFT 를 제출하면 PENDING_APPROVAL 이고 SUBMIT audit 1건이다', async () => {
    const { bomId } = await draftReadyToSubmit('submit');
    const result = await submitBom(AUTHOR, bomId, parseSubmitBomInput({ note: '검토 요청' }));

    expect(result.bom.status).toBe('PENDING_APPROVAL');
    expect((await headerRow(bomId)).status).toBe('PENDING_APPROVAL');
    const audits = await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId);
    const submits = audits.filter((row) => row.action === 'SUBMIT');
    expect(submits).toHaveLength(1);
    expect(submits[0]?.reason).toBe('검토 요청');
  });

  it('★ REJECTED 는 DRAFT 를 거치지 않고 바로 재제출된다', async () => {
    const { bomId } = await draftReadyToSubmit('resubmit');
    await submitBom(AUTHOR, bomId, {});
    await rejectBom(APPROVER, bomId, parseRejectBomInput({ reason: '단가 확인' }));
    expect((await headerRow(bomId)).status).toBe('REJECTED');

    await submitBom(AUTHOR, bomId, {});
    expect((await headerRow(bomId)).status).toBe('PENDING_APPROVAL');
  });

  it('★★ 반복 submit 은 200 no-op — write 0 · Audit 0 (D-17)', async () => {
    const { bomId } = await draftReadyToSubmit('submit-repeat');
    await submitBom(AUTHOR, bomId, {});
    const before = await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId);
    const headerBefore = await headerRow(bomId);

    const result = await submitBom(AUTHOR, bomId, {});
    expect(result.bom.status).toBe('PENDING_APPROVAL');
    expect(await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).toHaveLength(before.length);
    expect(await headerRow(bomId)).toEqual(headerBefore);
  });

  it('★ 무관한 상태의 submit 은 422 `BOM_INVALID_TRANSITION` 이다', async () => {
    const { bomId } = await approved('submit-invalid');
    expect(await codeOf(submitBom(AUTHOR, bomId, {}))).toBe(ERROR_CODES.BOM_INVALID_TRANSITION);
  });
});

describe('★★ submit 소요량 게이트 (D-10)', () => {
  it('★★ required 라인이 UNKNOWN 이면 422 `BOM_QTY_UNCONFIRMED` · 상태 불변', async () => {
    const parentSkuId = await newSku('gate-unknown-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('gate-unknown-c', { status: 'ACTIVE' });
    const created = await createBom(AUTHOR, bomInput(parentSkuId));
    await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(componentSkuId, { quantityStatus: 'UNKNOWN', isRequired: true }),
    );

    expect(await codeOf(submitBom(AUTHOR, created.bom.id, {}))).toBe(
      ERROR_CODES.BOM_QTY_UNCONFIRMED,
    );
    expect((await headerRow(created.bom.id)).status).toBe('DRAFT');
    expect(await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, created.bom.id)).toHaveLength(1); // CREATE 뿐
  });

  it('★★ required 라인이 SUGGESTED 여도 422 다 — SUGGESTED 는 확정이 아니다', async () => {
    const parentSkuId = await newSku('gate-sug-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('gate-sug-c', { status: 'ACTIVE' });
    const created = await createBom(AUTHOR, bomInput(parentSkuId));
    await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(componentSkuId, {
        quantityStatus: 'SUGGESTED',
        quantityPer: '1',
        isRequired: true,
      }),
    );

    expect(await codeOf(submitBom(AUTHOR, created.bom.id, {}))).toBe(
      ERROR_CODES.BOM_QTY_UNCONFIRMED,
    );
  });

  it('★★ optional 라인의 UNKNOWN 은 submit 을 막지 않는다', async () => {
    const parentSkuId = await newSku('gate-opt-p', { status: 'ACTIVE' });
    const required = await newSku('gate-opt-c1', { status: 'ACTIVE' });
    const optional = await newSku('gate-opt-c2', { status: 'ACTIVE' });
    const created = await createBom(AUTHOR, bomInput(parentSkuId));
    await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(required, { quantityStatus: 'CONFIRMED', quantityPer: '1', isRequired: true }),
    );
    await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(optional, { quantityStatus: 'UNKNOWN', isRequired: false }),
    );

    await expect(submitBom(AUTHOR, created.bom.id, {})).resolves.toMatchObject({
      bom: { status: 'PENDING_APPROVAL' },
    });
  });

  it('★★ submit 이 수량을 자동 확정하지 않는다 — optional 라인이 그대로 UNKNOWN 이다', async () => {
    const parentSkuId = await newSku('gate-noauto-p', { status: 'ACTIVE' });
    const required = await newSku('gate-noauto-c1', { status: 'ACTIVE' });
    const optional = await newSku('gate-noauto-c2', { status: 'ACTIVE' });
    const created = await createBom(AUTHOR, bomInput(parentSkuId));
    await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(required, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
    );
    const opt = await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(optional, { quantityStatus: 'UNKNOWN', isRequired: false, packQuantity: '30' }),
    );

    await submitBom(AUTHOR, created.bom.id, {});

    const row = await getPrismaClient().bomLine.findUniqueOrThrow({
      where: { id: opt.line.id },
      select: { quantityPer: true, quantityStatus: true, packQuantity: true },
    });
    // ⛔ 자동 CONFIRMED·자동 1·pack 기반 계산이 전부 없다.
    expect(row.quantityStatus).toBe('UNKNOWN');
    expect(row.quantityPer).toBeNull();
    expect(row.packQuantity?.toFixed()).toBe('30');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. approve · reject · 자가승인
// ═══════════════════════════════════════════════════════════════

describe('★ approve — PENDING_APPROVAL → APPROVED (D-8)', () => {
  it('★★ approve 는 활성화가 아니다 — 기간·activatedAt 을 건드리지 않는다', async () => {
    const { bomId } = await draftReadyToSubmit('approve');
    await submitBom(AUTHOR, bomId, {});
    const before = await headerRow(bomId);

    await approveBom(APPROVER, bomId, { note: '승인' });

    const after = await headerRow(bomId);
    expect(after.status).toBe('APPROVED');
    expect(after.approvedBy).toBe(APPROVER_ID);
    expect(after.approvedAt).not.toBeNull();
    // ⛔ 기간·활성 시각은 그대로다.
    expect(after.effectiveFrom).toEqual(before.effectiveFrom);
    expect(after.effectiveTo).toEqual(before.effectiveTo);
    expect(after.activatedAt).toBeNull();
  });

  it('★★ 반복 approve 는 no-op 이고 approvedBy 를 덮어쓰지 않는다', async () => {
    const { bomId } = await approved('approve-repeat');
    const before = await headerRow(bomId);
    const auditsBefore = await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId);

    await approveBom(APPROVER2, bomId, {});

    const after = await headerRow(bomId);
    expect(after.approvedBy).toBe(APPROVER_ID); // ⛔ APPROVER2 로 바뀌지 않는다
    expect(after.approvedAt).toEqual(before.approvedAt);
    expect(await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).toHaveLength(auditsBefore.length);
  });

  it('★ DRAFT 에서 approve 는 422 — no-op 으로 위장하지 않는다', async () => {
    const { bomId } = await draftReadyToSubmit('approve-invalid');
    expect(await codeOf(approveBom(APPROVER, bomId, {}))).toBe(ERROR_CODES.BOM_INVALID_TRANSITION);
  });
});

describe('★★ 자가승인 — approve 에만 적용된다 (D-8)', () => {
  it('★★ allowSelfApprovalBom=false + createdBy == actor → 403', async () => {
    await setSelfApprovalBom(false);
    const { bomId } = await draftReadyToSubmit('self-deny', AUTHOR);
    await submitBom(AUTHOR, bomId, {});

    // SELF 는 AUTHOR 와 같은 userId 이며 approve 권한을 갖는다.
    expect(await codeOf(approveBom(SELF, bomId, {}))).toBe(ERROR_CODES.SELF_APPROVAL_FORBIDDEN);
    expect((await headerRow(bomId)).status).toBe('PENDING_APPROVAL');
  });

  it('★★ allowSelfApprovalBom=true 면 같은 사람도 승인할 수 있다', async () => {
    await setSelfApprovalBom(true);
    const { bomId } = await draftReadyToSubmit('self-allow', AUTHOR);
    await submitBom(AUTHOR, bomId, {});

    await expect(approveBom(SELF, bomId, {})).resolves.toMatchObject({
      bom: { status: 'APPROVED' },
    });
    await setSelfApprovalBom(false);
  });

  it('★ createdBy != actor 는 언제나 통과한다', async () => {
    await setSelfApprovalBom(false);
    const { bomId } = await draftReadyToSubmit('self-other', AUTHOR);
    await submitBom(AUTHOR, bomId, {});
    await expect(approveBom(APPROVER, bomId, {})).resolves.toBeDefined();
  });

  it('★★ createdBy = null 은 비교 대상이 없으므로 통과한다', async () => {
    await setSelfApprovalBom(false);
    const { bomId } = await draftReadyToSubmit('self-null', AUTHOR);
    await submitBom(AUTHOR, bomId, {});
    // 마이그레이션 유입분을 흉내낸다.
    await getPrismaClient().bomHeader.update({ where: { id: bomId }, data: { createdBy: null } });

    await expect(approveBom(SELF, bomId, {})).resolves.toMatchObject({
      bom: { status: 'APPROVED' },
    });
  });

  it('★★ activate 에는 자가승인 검사가 없다 — 같은 사람이 활성화해도 된다', async () => {
    await setSelfApprovalBom(false);
    const { bomId } = await draftReadyToSubmit('self-activate', AUTHOR);
    await submitBom(AUTHOR, bomId, {});
    await approveBom(APPROVER, bomId, {});

    // SELF = 작성자이며 approve 권한 보유. activate 는 통과해야 한다.
    await expect(activateBom(SELF, bomId, {})).resolves.toMatchObject({
      bom: { status: 'ACTIVE' },
    });
  });

  it('★ 설정을 트랜잭션 안에서 다시 읽는다 — 중간에 바꾸면 판정이 따라 바뀐다', async () => {
    const { bomId } = await draftReadyToSubmit('self-reload', AUTHOR);
    await submitBom(AUTHOR, bomId, {});

    await setSelfApprovalBom(false);
    expect(await codeOf(approveBom(SELF, bomId, {}))).toBe(ERROR_CODES.SELF_APPROVAL_FORBIDDEN);

    await setSelfApprovalBom(true);
    await expect(approveBom(SELF, bomId, {})).resolves.toBeDefined();
    await setSelfApprovalBom(false);
  });
});

describe('★ reject — reason 은 AuditLog 에만 남는다', () => {
  it('REJECT audit 1건 + reason 기록 + approvedBy 미설정', async () => {
    const { bomId } = await draftReadyToSubmit('reject');
    await submitBom(AUTHOR, bomId, {});
    await rejectBom(APPROVER, bomId, parseRejectBomInput({ reason: '구성 재검토' }));

    const row = await headerRow(bomId);
    expect(row.status).toBe('REJECTED');
    expect(row.approvedBy).toBeNull();
    expect(row.approvedAt).toBeNull();

    const rejects = (await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).filter(
      (audit) => audit.action === 'REJECT',
    );
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.reason).toBe('구성 재검토');
  });

  it('★ 반복 reject 는 no-op 이다', async () => {
    const { bomId } = await draftReadyToSubmit('reject-repeat');
    await submitBom(AUTHOR, bomId, {});
    await rejectBom(APPROVER, bomId, { reason: 'r1' });
    const before = await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId);

    await rejectBom(APPROVER, bomId, { reason: 'r2' });
    expect(await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).toHaveLength(before.length);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. activate — D-7 chain 전량
// ═══════════════════════════════════════════════════════════════

describe('★★ activate — D-7 chain (미래·과거·gap·동일일·반복)', () => {
  it('★ ACTIVE 가 하나도 없으면 그대로 활성화된다 (무기한)', async () => {
    const { bomId } = await approved('act-first', { effectiveFrom: '2026-03-01' });
    const result = await activateBom(APPROVER, bomId, {});

    expect(result.bom.status).toBe('ACTIVE');
    const row = await headerRow(bomId);
    expect(dateStr(row.effectiveFrom)).toBe('2026-03-01');
    expect(row.effectiveTo).toBeNull();
    expect(row.activatedAt).not.toBeNull();
  });

  it('★★ override 생략 — T = candidate.effectiveFrom (예시 A)', async () => {
    const { bomId } = await approved('act-noover', { effectiveFrom: '2027-06-01' });
    await activateBom(APPROVER, bomId, parseActivateBomInput({}));
    expect(dateStr((await headerRow(bomId)).effectiveFrom)).toBe('2027-06-01');
  });

  it('★★ override 지정 — candidate.effectiveFrom 이 T 로 갱신된다 (예시 B)', async () => {
    const { bomId } = await approved('act-over', { effectiveFrom: '2027-06-01' });
    await activateBom(APPROVER, bomId, parseActivateBomInput({ effectiveFrom: '2027-07-01' }));
    const row = await headerRow(bomId);
    expect(dateStr(row.effectiveFrom)).toBe('2027-07-01');
    expect(row.status).toBe('ACTIVE');
  });

  it('★★ predecessor 는 effectiveTo 만 닫히고 status·effectiveFrom 은 그대로다', async () => {
    const parentSkuId = await newSku('act-pred-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('act-pred-c', { status: 'ACTIVE' });

    const makeApproved = async (version: string, from: string): Promise<string> => {
      const created = await createBom(AUTHOR, {
        parentSkuId,
        bomType: 'MANUFACTURING',
        version,
        effectiveFrom: from,
      });
      await createBomLine(
        AUTHOR,
        created.bom.id,
        lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
      );
      await submitBom(AUTHOR, created.bom.id, {});
      await approveBom(APPROVER, created.bom.id, {});
      return created.bom.id;
    };

    const first = await makeApproved(CODE('P1'), '2026-01-01');
    await activateBom(APPROVER, first, {});
    const predBefore = await headerRow(first);

    const second = await makeApproved(CODE('P2'), '2027-01-01');
    await activateBom(APPROVER, second, {});

    const pred = await headerRow(first);
    // ★ 기간만 닫힌다.
    expect(dateStr(pred.effectiveTo)).toBe('2027-01-01');
    // ⛔ status 는 ACTIVE 유지 — 자동 INACTIVE 가 아니다 (D-7 superseded).
    expect(pred.status).toBe('ACTIVE');
    // ⛔ 시작일은 그대로.
    expect(pred.effectiveFrom).toEqual(predBefore.effectiveFrom);

    const cand = await headerRow(second);
    expect(dateStr(cand.effectiveFrom)).toBe('2027-01-01');
    expect(cand.effectiveTo).toBeNull();

    // audit: candidate ACTIVATE 1 + predecessor UPDATE 1
    const candAudits = (await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, second)).filter(
      (row) => row.action === 'ACTIVATE',
    );
    expect(candAudits).toHaveLength(1);
    const predAudits = (await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, first)).filter(
      (row) => row.action === 'UPDATE',
    );
    expect(predAudits).toHaveLength(1);
  });

  it('★★ 미래 T — 오늘은 여전히 predecessor 가 resolver 에 선택된다', async () => {
    const parentSkuId = await newSku('act-future-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('act-future-c', { status: 'ACTIVE' });
    const make = async (version: string, from: string): Promise<string> => {
      const created = await createBom(AUTHOR, {
        parentSkuId,
        bomType: 'MANUFACTURING',
        version,
        effectiveFrom: from,
      });
      await createBomLine(
        AUTHOR,
        created.bom.id,
        lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
      );
      await submitBom(AUTHOR, created.bom.id, {});
      await approveBom(APPROVER, created.bom.id, {});
      return created.bom.id;
    };

    const current = await make(CODE('F1'), '2020-01-01');
    await activateBom(APPROVER, current, {});
    const future = await make(CODE('F2'), '2099-01-01');
    await activateBom(APPROVER, future, {});

    const client = getPrismaClient();
    // 오늘 기준 — predecessor 가 유효하다.
    const today = await resolveEffectiveBom(client, {
      parentSkuId,
      asOf: parseDateOnly(businessDateOf(new Date())),
    });
    expect(today?.id).toBe(current);

    // 미래 기준 — candidate 가 유효하다.
    const later = await resolveEffectiveBom(client, {
      parentSkuId,
      asOf: parseDateOnly('2099-06-01'),
    });
    expect(later?.id).toBe(future);
  });

  it('★★ successor 가 있으면 candidate.effectiveTo = successor.effectiveFrom (예시 C)', async () => {
    const parentSkuId = await newSku('act-succ-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('act-succ-c', { status: 'ACTIVE' });
    const make = async (version: string, from: string): Promise<string> => {
      const created = await createBom(AUTHOR, {
        parentSkuId,
        bomType: 'MANUFACTURING',
        version,
        effectiveFrom: from,
      });
      await createBomLine(
        AUTHOR,
        created.bom.id,
        lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
      );
      await submitBom(AUTHOR, created.bom.id, {});
      await approveBom(APPROVER, created.bom.id, {});
      return created.bom.id;
    };

    // successor 를 먼저 활성화한다.
    const successor = await make(CODE('S2'), '2027-10-01');
    await activateBom(APPROVER, successor, {});
    const succBefore = await headerRow(successor);

    // 그 앞에 historical 삽입.
    const candidate = await make(CODE('S1'), '2027-07-01');
    await activateBom(APPROVER, candidate, {});

    const cand = await headerRow(candidate);
    expect(dateStr(cand.effectiveFrom)).toBe('2027-07-01');
    expect(dateStr(cand.effectiveTo)).toBe('2027-10-01');

    // ⛔ successor 는 어느 필드도 바뀌지 않았다.
    expect(await headerRow(successor)).toEqual(succBefore);
  });

  it('★★ 동일일 activate 는 409 `BOM_PERIOD_OVERLAP` 이다', async () => {
    const parentSkuId = await newSku('act-same-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('act-same-c', { status: 'ACTIVE' });
    const make = async (version: string, from: string): Promise<string> => {
      const created = await createBom(AUTHOR, {
        parentSkuId,
        bomType: 'MANUFACTURING',
        version,
        effectiveFrom: from,
      });
      await createBomLine(
        AUTHOR,
        created.bom.id,
        lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
      );
      await submitBom(AUTHOR, created.bom.id, {});
      await approveBom(APPROVER, created.bom.id, {});
      return created.bom.id;
    };

    const first = await make(CODE('Q1'), '2028-01-01');
    await activateBom(APPROVER, first, {});
    const second = await make(CODE('Q2'), '2028-01-01');

    expect(await codeOf(activateBom(APPROVER, second, {}))).toBe(ERROR_CODES.BOM_PERIOD_OVERLAP);
    // 전체 rollback — predecessor 도 그대로다.
    expect((await headerRow(second)).status).toBe('APPROVED');
    expect((await headerRow(first)).effectiveTo).toBeNull();
  });

  it('★★ 반복 activate 는 no-op — activatedAt 을 덮어쓰지 않는다', async () => {
    const { bomId } = await approved('act-repeat', { effectiveFrom: '2026-05-01' });
    await activateBom(APPROVER, bomId, {});
    const before = await headerRow(bomId);
    const auditsBefore = await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId);

    await activateBom(APPROVER, bomId, { effectiveFrom: '2026-09-01' });

    expect(await headerRow(bomId)).toEqual(before);
    expect(await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).toHaveLength(auditsBefore.length);
  });

  it('★ predecessor 가 이미 `effectiveTo <= T` 면 닫지 않는다 — gap 은 정상이다', async () => {
    const parentSkuId = await newSku('act-gap-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('act-gap-c', { status: 'ACTIVE' });
    const make = async (version: string, from: string): Promise<string> => {
      const created = await createBom(AUTHOR, {
        parentSkuId,
        bomType: 'MANUFACTURING',
        version,
        effectiveFrom: from,
      });
      await createBomLine(
        AUTHOR,
        created.bom.id,
        lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
      );
      await submitBom(AUTHOR, created.bom.id, {});
      await approveBom(APPROVER, created.bom.id, {});
      return created.bom.id;
    };

    const first = await make(CODE('G1'), '2029-01-01');
    await activateBom(APPROVER, first, {});
    // ⚠️ D-7 6단계가 활성화 시 `effectiveTo := successor ?? null` 로 **재계산**
    //    한다. 따라서 "이미 마감된 predecessor" 는 활성화 **이후**에 만들어야
    //    시나리오가 성립한다.
    await getPrismaClient().bomHeader.update({
      where: { id: first },
      data: { effectiveTo: parseDateOnly('2029-06-01') },
    });
    const second = await make(CODE('G2'), '2029-09-01');
    await activateBom(APPROVER, second, {});

    // predecessor 는 그대로 06-01 마감 — 06-01~09-01 은 gap 이며 정상이다.
    expect(dateStr((await headerRow(first)).effectiveTo)).toBe('2029-06-01');
    // 실변경이 없으므로 predecessor UPDATE audit 을 만들지 않는다.
    const predUpdates = (await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, first)).filter(
      (row) => row.action === 'UPDATE',
    );
    expect(predUpdates).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. activate 최종 T cycle 재검사
// ═══════════════════════════════════════════════════════════════

describe('★★ activate 는 최종 T 로 cycle 을 다시 본다 (D-13)', () => {
  it('★★ 자기 자신을 구성품으로 갖는 BOM 은 activate 에서 422 · 전체 rollback', async () => {
    // A 의 BOM 이 A 를 구성품으로 갖는 상황은 라인 추가 시 이미 막히므로,
    // 라인을 직접 넣어 activate 시점 재검사가 실제로 도는지 본다.
    const parentSkuId = await newSku('cyc-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('cyc-c', { status: 'ACTIVE' });
    const created = await createBom(AUTHOR, bomInput(parentSkuId, { effectiveFrom: '2030-01-01' }));
    await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
    );
    await submitBom(AUTHOR, created.bom.id, {});
    await approveBom(APPROVER, created.bom.id, {});

    // 승인 뒤 라인의 구성품을 parent 자신으로 바꾼다 — DB 를 직접 건드려
    // "승인 시점에는 없던 순환" 을 만든다.
    await getPrismaClient().bomLine.updateMany({
      where: { bomHeaderId: created.bom.id },
      data: { componentSkuId: parentSkuId },
    });

    expect(await codeOf(activateBom(APPROVER, created.bom.id, {}))).toBe(
      ERROR_CODES.BOM_CYCLE_DETECTED,
    );
    // 전체 rollback — ACTIVE 가 되지 않았다.
    const row = await headerRow(created.bom.id);
    expect(row.status).toBe('APPROVED');
    expect(row.activatedAt).toBeNull();
    const activates = (await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, created.bom.id)).filter(
      (audit) => audit.action === 'ACTIVATE',
    );
    expect(activates).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. deactivate — W-3 CASE A~F
// ═══════════════════════════════════════════════════════════════

describe('★★ deactivate 날짜 경계 (W-3)', () => {
  const today = businessDateOf(new Date());

  /** ACTIVE 로 만든 뒤 필요하면 effectiveTo 를 직접 세팅한다. */
  async function activeWith(label: string, from: string, to: string | null): Promise<string> {
    const { bomId } = await approved(label, { effectiveFrom: from });
    await activateBom(APPROVER, bomId, {});
    if (to !== null) {
      await getPrismaClient().bomHeader.update({
        where: { id: bomId },
        data: { effectiveTo: parseDateOnly(to) },
      });
    }
    return bomId;
  }

  it('★ 과거 종료는 허용된다', async () => {
    const bomId = await activeWith('deact-past', '2020-01-01', null);
    await deactivateBom(
      APPROVER,
      bomId,
      parseDeactivateBomInput({ effectiveTo: '2020-06-01', reason: '단종' }),
    );
    const row = await headerRow(bomId);
    expect(row.status).toBe('INACTIVE');
    expect(dateStr(row.effectiveTo)).toBe('2020-06-01');
  });

  it('★ 오늘 종료는 허용된다', async () => {
    const bomId = await activeWith('deact-today', '2020-01-01', null);
    await deactivateBom(APPROVER, bomId, { effectiveTo: today, reason: '단종' });
    expect(dateStr((await headerRow(bomId)).effectiveTo)).toBe(today);
  });

  it('★★ 미래 종료는 400 이다 — 예약 종료를 지원하지 않는다', async () => {
    const bomId = await activeWith('deact-future', '2020-01-01', null);
    expect(
      await codeOf(deactivateBom(APPROVER, bomId, { effectiveTo: '2099-01-01', reason: 'x' })),
    ).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect((await headerRow(bomId)).status).toBe('ACTIVE');
  });

  it('★ effectiveFrom 이하는 400 이다', async () => {
    const bomId = await activeWith('deact-lower', '2020-01-01', null);
    expect(
      await codeOf(deactivateBom(APPROVER, bomId, { effectiveTo: '2020-01-01', reason: 'x' })),
    ).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('★★ CASE A — 유한 기간을 소급 단축한다', async () => {
    const bomId = await activeWith('deact-A', '2020-01-01', '2099-09-01');
    await deactivateBom(APPROVER, bomId, { effectiveTo: '2021-08-01', reason: 'A' });
    const row = await headerRow(bomId);
    expect(row.status).toBe('INACTIVE');
    expect(dateStr(row.effectiveTo)).toBe('2021-08-01');
  });

  it('★★ CASE B — 오늘로 단축한다', async () => {
    const bomId = await activeWith('deact-B', '2020-01-01', '2099-09-01');
    await deactivateBom(APPROVER, bomId, { effectiveTo: today, reason: 'B' });
    expect(dateStr((await headerRow(bomId)).effectiveTo)).toBe(today);
  });

  it('★★ CASE C — 현재값과 같아도 **미래**면 400 이다', async () => {
    const bomId = await activeWith('deact-C', '2020-01-01', '2099-09-01');
    expect(
      await codeOf(deactivateBom(APPROVER, bomId, { effectiveTo: '2099-09-01', reason: 'C' })),
    ).toBe(ERROR_CODES.VALIDATION_ERROR);
    // 상태·기간 모두 그대로다.
    const row = await headerRow(bomId);
    expect(row.status).toBe('ACTIVE');
    expect(dateStr(row.effectiveTo)).toBe('2099-09-01');
  });

  it('★★ CASE D·E — 현재값과 같고 오늘 이하면 허용, 기간 no-change 여도 전이한다', async () => {
    const caseD = await activeWith('deact-D', '2020-01-01', today);
    await deactivateBom(APPROVER, caseD, { effectiveTo: today, reason: 'D' });
    expect((await headerRow(caseD)).status).toBe('INACTIVE');
    expect(dateStr((await headerRow(caseD)).effectiveTo)).toBe(today);

    const caseE = await activeWith('deact-E', '2020-01-01', '2021-08-10');
    await deactivateBom(APPROVER, caseE, { effectiveTo: '2021-08-10', reason: 'E' });
    expect((await headerRow(caseE)).status).toBe('INACTIVE');
    expect(dateStr((await headerRow(caseE)).effectiveTo)).toBe('2021-08-10');
  });

  it('★★ CASE F — 기존 기간 연장은 400 이다', async () => {
    const bomId = await activeWith('deact-F', '2020-01-01', '2021-08-10');
    expect(
      await codeOf(deactivateBom(APPROVER, bomId, { effectiveTo: '2021-08-11', reason: 'F' })),
    ).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect((await headerRow(bomId)).status).toBe('ACTIVE');
  });

  it('★ DEACTIVATE audit 1건 + reason · 반복은 no-op', async () => {
    const bomId = await activeWith('deact-audit', '2020-01-01', null);
    await deactivateBom(APPROVER, bomId, { effectiveTo: '2021-01-01', reason: '사용종료 사유' });
    const audits = (await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).filter(
      (row) => row.action === 'DEACTIVATE',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBe('사용종료 사유');

    const before = await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId);
    await deactivateBom(APPROVER, bomId, { effectiveTo: '2020-06-01', reason: '반복' });
    expect(await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).toHaveLength(before.length);
    // 기간도 다시 쓰이지 않았다.
    expect(dateStr((await headerRow(bomId)).effectiveTo)).toBe('2021-01-01');
  });

  it('★★ INACTIVE 는 과거 asOf 에서도 resolver 후보가 아니다 (W-3 귀결)', async () => {
    const { bomId, parentSkuId } = await approved('deact-resolver', {
      effectiveFrom: '2020-01-01',
    });
    await activateBom(APPROVER, bomId, {});
    const client = getPrismaClient();
    // 종료 전에는 선택된다.
    expect(
      (await resolveEffectiveBom(client, { parentSkuId, asOf: parseDateOnly('2020-06-01') }))?.id,
    ).toBe(bomId);

    await deactivateBom(APPROVER, bomId, { effectiveTo: '2021-01-01', reason: '단종' });

    // ★ effectiveTo 이전인 과거 asOf 에서도 더 이상 선택되지 않는다.
    expect(
      await resolveEffectiveBom(client, { parentSkuId, asOf: parseDateOnly('2020-06-01') }),
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. archive
// ═══════════════════════════════════════════════════════════════

describe('★ archive — DRAFT·REJECTED 만 (W-1)', () => {
  it('★ DRAFT 를 보관한다 — 물리삭제가 아니며 라인·기간이 남는다', async () => {
    const { bomId } = await draftReadyToSubmit('archive-draft');
    await archiveBom(APPROVER, bomId, parseArchiveBomInput({ reason: '중복 초안' }));

    const row = await headerRow(bomId);
    expect(row.status).toBe('ARCHIVED');
    expect(row.version).toBeTruthy();
    expect(await getPrismaClient().bomLine.count({ where: { bomHeaderId: bomId } })).toBe(1);

    const audits = (await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).filter(
      (audit) => audit.action === 'ARCHIVE',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBe('중복 초안');
  });

  it('★ REJECTED 도 보관할 수 있다', async () => {
    const { bomId } = await draftReadyToSubmit('archive-rejected');
    await submitBom(AUTHOR, bomId, {});
    await rejectBom(APPROVER, bomId, { reason: 'r' });
    await archiveBom(APPROVER, bomId, { reason: '폐기' });
    expect((await headerRow(bomId)).status).toBe('ARCHIVED');
  });

  it('★★ APPROVED·ACTIVE 는 보관 대상이 아니다 — 422', async () => {
    const { bomId } = await approved('archive-approved');
    expect(await codeOf(archiveBom(APPROVER, bomId, { reason: 'x' }))).toBe(
      ERROR_CODES.BOM_INVALID_TRANSITION,
    );
  });

  it('★ 반복 archive 는 no-op 이다', async () => {
    const { bomId } = await draftReadyToSubmit('archive-repeat');
    await archiveBom(APPROVER, bomId, { reason: 'r1' });
    const before = await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId);
    await archiveBom(APPROVER, bomId, { reason: 'r2' });
    expect(await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).toHaveLength(before.length);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. clone — W-4 ~ W-9
// ═══════════════════════════════════════════════════════════════

describe('★★ clone — Header/Line matrix (W-5 · W-6)', () => {
  it('★★ Header 19 scalar 가 matrix 대로다', async () => {
    const parentSkuId = await newSku('clone-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('clone-c', { status: 'ACTIVE' });
    const supplier = await getPrismaClient().supplier.create({
      data: {
        supplierCode: CODE('SUP'),
        supplierName: '조립처',
        supplierType: 'MANUFACTURER',
      },
      select: { id: true },
    });
    const created = await createBom(AUTHOR, {
      parentSkuId,
      bomType: 'KIT',
      version: CODE('V1'),
      effectiveFrom: '2026-01-01',
      outputQty: '5',
      outputUom: 'EA',
      productionPartnerId: supplier.id,
      overallLossRate: '0.05',
      description: '원본 설명',
    });
    await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '2' }),
    );
    // 원본을 ACTIVE 까지 밀어 승인·활성 metadata 를 채운다.
    await submitBom(AUTHOR, created.bom.id, {});
    await approveBom(APPROVER, created.bom.id, {});
    await activateBom(APPROVER, created.bom.id, {});

    const result = await cloneBom(
      STAFF,
      created.bom.id,
      parseCloneBomInput({
        newVersion: CODE('V2'),
        effectiveFrom: '2027-01-01',
        changeReason: '원가 반영',
      }),
    );

    const clone = await getPrismaClient().bomHeader.findUniqueOrThrow({
      where: { id: result.bom.id },
    });
    // COPY
    expect(clone.parentSkuId).toBe(parentSkuId);
    expect(clone.bomType).toBe('KIT');
    expect(clone.outputQty.toFixed()).toBe('5');
    expect(clone.outputUom).toBe('EA');
    expect(clone.productionPartnerId).toBe(supplier.id);
    expect(clone.overallLossRate?.toFixed()).toBe('0.05');
    expect(clone.description).toBe('원본 설명');
    // OVERRIDE
    expect(clone.version).toBe(CODE('V2'));
    expect(dateStr(clone.effectiveFrom)).toBe('2027-01-01');
    expect(clone.changeReason).toBe('원가 반영');
    // RESET
    expect(clone.status).toBe('DRAFT');
    expect(clone.effectiveTo).toBeNull();
    expect(clone.approvedAt).toBeNull();
    expect(clone.approvedBy).toBeNull();
    expect(clone.activatedAt).toBeNull();
    expect(clone.createdBy).toBe(STAFF_ID);
    // ⛔ 새 id 다.
    expect(clone.id).not.toBe(created.bom.id);
  });

  it('★★ Line 18 scalar — legacy 2개만 RESET, 나머지 COPY', async () => {
    const parentSkuId = await newSku('clone-line-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('clone-line-c', { status: 'ACTIVE' });
    const created = await createBom(AUTHOR, bomInput(parentSkuId));
    const line = await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(componentSkuId, {
        lineNo: 7,
        quantityStatus: 'SUGGESTED',
        quantityPer: '0.033333',
        lossRate: '0.02',
        componentRole: 'SERVICE',
        supplyType: 'TURNKEY',
        alternateGroup: 'ALT-A',
        isRequired: false,
        packQuantity: '30',
        specification: '규격',
        note: '비고',
      }),
    );
    // legacy 는 server-owned 라 DTO 로 못 넣는다 — 마이그레이션 유입분을 흉내낸다.
    await getPrismaClient().bomLine.update({
      where: { id: line.line.id },
      data: { legacyBomCode: 'LEG-1', legacyCommonBomCode: 'LEG-C' },
    });

    const result = await cloneBom(STAFF, created.bom.id, {
      newVersion: CODE('LV2'),
      effectiveFrom: '2027-02-01',
      changeReason: 'r',
    });

    const cloned = await getPrismaClient().bomLine.findFirstOrThrow({
      where: { bomHeaderId: result.bom.id },
    });
    // COPY — 특히 수량·상태·순번이 보존된다.
    expect(cloned.lineNo).toBe(7);
    expect(cloned.componentSkuId).toBe(componentSkuId);
    expect(cloned.quantityPer?.toFixed()).toBe('0.033333');
    expect(cloned.quantityStatus).toBe('SUGGESTED'); // ⛔ 자동 CONFIRMED 아님
    expect(cloned.lossRate?.toFixed()).toBe('0.02');
    expect(cloned.componentRole).toBe('SERVICE');
    expect(cloned.supplyType).toBe('TURNKEY');
    expect(cloned.alternateGroup).toBe('ALT-A');
    expect(cloned.isRequired).toBe(false);
    expect(cloned.packQuantity?.toFixed()).toBe('30');
    expect(cloned.specification).toBe('규격');
    expect(cloned.note).toBe('비고');
    // NEW
    expect(cloned.id).not.toBe(line.line.id);
    expect(cloned.bomHeaderId).toBe(result.bom.id);
    // ★ RESET — legacy 는 BomLine scalar 이며 승계하지 않는다.
    expect(cloned.legacyBomCode).toBeNull();
    expect(cloned.legacyCommonBomCode).toBeNull();
  });

  it('★★ clone audit — Header CREATE 1건(sourceBomId) + Line CREATE N건 (W-7)', async () => {
    const parentSkuId = await newSku('clone-audit-p', { status: 'ACTIVE' });
    const created = await createBom(AUTHOR, bomInput(parentSkuId));
    const lineIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const componentSkuId = await newSku(`clone-audit-c${index}`, { status: 'ACTIVE' });
      const line = await createBomLine(
        AUTHOR,
        created.bom.id,
        lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
      );
      lineIds.push(line.line.id);
    }

    const result = await cloneBom(STAFF, created.bom.id, {
      newVersion: CODE('AV2'),
      effectiveFrom: '2027-03-01',
      changeReason: '복제 사유',
    });

    // header CREATE 1건 — sourceBomId 포함, reason = changeReason.
    const headerAudits = await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, result.bom.id);
    const creates = headerAudits.filter((audit) => audit.action === 'CREATE');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.reason).toBe('복제 사유');
    expect(JSON.stringify(creates[0]?.afterValue)).toContain(created.bom.id);
    // ⛔ CLONE action 을 만들지 않았다.
    expect(headerAudits.map((audit) => audit.action)).not.toContain('CLONE');

    // ★ line CREATE N건 — bulk-confirm 의 압축 예외를 clone 에 적용하지 않는다.
    const clonedLines = await getPrismaClient().bomLine.findMany({
      where: { bomHeaderId: result.bom.id },
      select: { id: true },
    });
    expect(clonedLines).toHaveLength(3);
    for (const line of clonedLines) {
      const audits = (await auditsOf(BOM_LINE_ENTITY_TYPE, line.id)).filter(
        (audit) => audit.action === 'CREATE',
      );
      expect(audits, line.id).toHaveLength(1);
    }
  });

  it('★ source 는 모든 status 에서 clone 가능하다 (W-4)', async () => {
    const STATUSES = [
      'DRAFT',
      'PENDING_APPROVAL',
      'REJECTED',
      'APPROVED',
      'ACTIVE',
      'INACTIVE',
      'ARCHIVED',
    ];
    for (const [index, status] of STATUSES.entries()) {
      const { bomId } = await draftReadyToSubmit(`clone-src-${status}`);
      await getPrismaClient().$executeRawUnsafe(
        `UPDATE bom_header SET status = $1::"BomStatus" WHERE id = $2::uuid`,
        status,
        bomId,
      );
      const result = await cloneBom(STAFF, bomId, {
        // ⚠️ `version` 은 VarChar(20) 이다 (D-4) — status 이름을 그대로 붙이면
        //    넘친다. 짧은 인덱스를 쓴다.
        newVersion: CODE(`CS${index}`),
        effectiveFrom: '2031-01-01',
        changeReason: 'r',
      });
      expect(result.bom.status, status).toBe('DRAFT');
    }
  });

  it('★ 같은 parent 에 같은 version 이면 409 `BOM_VERSION_DUPLICATE`', async () => {
    const { bomId } = await draftReadyToSubmit('clone-dup');
    const version = CODE('DUP');
    await cloneBom(STAFF, bomId, {
      newVersion: version,
      effectiveFrom: '2032-01-01',
      changeReason: 'r',
    });
    expect(
      await codeOf(
        cloneBom(STAFF, bomId, {
          newVersion: version,
          effectiveFrom: '2032-06-01',
          changeReason: 'r',
        }),
      ),
    ).toBe(ERROR_CODES.BOM_VERSION_DUPLICATE);
  });

  it('★★ clone cycle 실패 → header·line·audit 전부 rollback', async () => {
    // parent 를 구성품으로 갖는 라인을 DB 로 심어 두면 복제 결과가 순환이다.
    const parentSkuId = await newSku('clone-cyc-p', { status: 'ACTIVE' });
    const created = await createBom(AUTHOR, bomInput(parentSkuId, { effectiveFrom: '2033-01-01' }));
    const componentSkuId = await newSku('clone-cyc-c', { status: 'ACTIVE' });
    await createBomLine(
      AUTHOR,
      created.bom.id,
      lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
    );
    await getPrismaClient().bomLine.updateMany({
      where: { bomHeaderId: created.bom.id },
      data: { componentSkuId: parentSkuId },
    });

    const version = CODE('CYCV');
    expect(
      await codeOf(
        cloneBom(STAFF, created.bom.id, {
          newVersion: version,
          effectiveFrom: '2033-06-01',
          changeReason: 'r',
        }),
      ),
    ).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);

    // 새 header 가 하나도 만들어지지 않았다.
    expect(await getPrismaClient().bomHeader.count({ where: { parentSkuId, version } })).toBe(0);
  });
});

describe('★★ clone 멱등 (D-17 · W-9)', () => {
  it('★ 같은 키 + 같은 payload → replay, 새 header 를 만들지 않는다', async () => {
    const { bomId } = await draftReadyToSubmit('clone-idem');
    const key = `k-${randomBytes(6).toString('hex')}`;
    const payload = {
      newVersion: CODE('IDV'),
      effectiveFrom: '2034-01-01',
      changeReason: 'r',
    };

    const first = await cloneBom(STAFF, bomId, payload, {}, key);
    const second = await cloneBom(STAFF, bomId, payload, {}, key);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.bom.id).toBe(first.bom.id);
    expect(await getPrismaClient().bomHeader.count({ where: { id: first.bom.id } })).toBe(1);
  });

  it('★ 같은 키 + 다른 payload → 409 `IDEMPOTENCY_KEY_REUSED`', async () => {
    const { bomId } = await draftReadyToSubmit('clone-idem-conflict');
    const key = `k-${randomBytes(6).toString('hex')}`;
    await cloneBom(
      STAFF,
      bomId,
      { newVersion: CODE('CF1'), effectiveFrom: '2035-01-01', changeReason: 'r' },
      {},
      key,
    );
    expect(
      await codeOf(
        cloneBom(
          STAFF,
          bomId,
          { newVersion: CODE('CF2'), effectiveFrom: '2035-01-01', changeReason: 'r' },
          {},
          key,
        ),
      ),
    ).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  });

  it('★★ 같은 키 동시 요청 — clone 은 한 번만 실행된다', async () => {
    const { bomId } = await draftReadyToSubmit('clone-idem-conc');
    const key = `k-${randomBytes(6).toString('hex')}`;
    const version = CODE('CCV');
    const payload = { newVersion: version, effectiveFrom: '2036-01-01', changeReason: 'r' };

    const outcomes = await Promise.all([
      cloneBom(STAFF, bomId, payload, {}, key).then(
        (result) => (result.replayed ? 'replay' : 'executed'),
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
      cloneBom(STAFF, bomId, payload, {}, key).then(
        (result) => (result.replayed ? 'replay' : 'executed'),
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'executed')).toHaveLength(1);
    // ★ 새 version row 가 정확히 1개다 — 중복 생성이 없다.
    expect(await getPrismaClient().bomHeader.count({ where: { version } })).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. 권한 (D-15)
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 matrix (D-15)', () => {
  it('★★ SCM_STAFF 는 submit 은 되지만 approve 계열은 403 이다', async () => {
    const { bomId } = await draftReadyToSubmit('perm-staff', STAFF);
    await expect(submitBom(STAFF, bomId, {})).resolves.toBeDefined();
    expect(await codeOf(approveBom(STAFF, bomId, {}))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(rejectBom(STAFF, bomId, { reason: 'x' }))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(activateBom(STAFF, bomId, {}))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(archiveBom(STAFF, bomId, { reason: 'x' }))).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ FINANCE 는 workflow 전부 403 이다', async () => {
    const { bomId } = await draftReadyToSubmit('perm-finance');
    expect(await codeOf(submitBom(FINANCE, bomId, {}))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(approveBom(FINANCE, bomId, {}))).toBe(ERROR_CODES.FORBIDDEN);
    expect(
      await codeOf(
        cloneBom(FINANCE, bomId, {
          newVersion: CODE('FIN'),
          effectiveFrom: '2037-01-01',
          changeReason: 'r',
        }),
      ),
    ).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★★ ADMIN role 이어도 permission 데이터가 없으면 403 — bypass 없음', async () => {
    const { bomId } = await draftReadyToSubmit('perm-admin');
    expect(await codeOf(submitBom(NO_PERMISSION, bomId, {}))).toBe(ERROR_CODES.FORBIDDEN);
    expect(await codeOf(approveBom(NO_PERMISSION, bomId, {}))).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ 권한 실패 시 write·Audit 이 0 이다', async () => {
    const { bomId } = await draftReadyToSubmit('perm-noaudit');
    const before = await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId);
    await codeOf(submitBom(FINANCE, bomId, {}));
    expect((await headerRow(bomId)).status).toBe('DRAFT');
    expect(await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).toHaveLength(before.length);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. 동시성
// ═══════════════════════════════════════════════════════════════

describe('★★ 동시성 — header row lock 으로 직렬화된다 (D-28)', () => {
  it('★★ approve × approve — 실제 승인은 1회, approvedBy 가 덮이지 않는다', async () => {
    const { bomId } = await draftReadyToSubmit('conc-approve');
    await submitBom(AUTHOR, bomId, {});

    const outcomes = await Promise.all([
      approveBom(APPROVER, bomId, {}).then(
        () => 'ok' as const,
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
      approveBom(APPROVER2, bomId, {}).then(
        () => 'ok' as const,
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
    ]);
    // 둘 다 성공할 수 있다 — 뒤에 온 쪽은 no-op 이다.
    expect(outcomes.filter((outcome) => outcome === 'ok').length).toBeGreaterThanOrEqual(1);

    const row = await headerRow(bomId);
    expect(row.status).toBe('APPROVED');
    // ★ APPROVE audit 은 정확히 1건이며 approvedBy 는 그 actor 다.
    const approves = (await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).filter(
      (audit) => audit.action === 'APPROVE',
    );
    expect(approves).toHaveLength(1);
    expect(row.approvedBy).toBe(approves[0]?.actorId);
  });

  it('★★ approve × reject — 최종 상태는 둘 중 하나이고 전이 audit 은 1건이다', async () => {
    const { bomId } = await draftReadyToSubmit('conc-approve-reject');
    await submitBom(AUTHOR, bomId, {});

    await Promise.all([
      approveBom(APPROVER, bomId, {}).catch(() => undefined),
      rejectBom(APPROVER2, bomId, { reason: 'r' }).catch(() => undefined),
    ]);

    const row = await headerRow(bomId);
    expect(['APPROVED', 'REJECTED']).toContain(row.status);
    const transitions = (await auditsOf(BOM_WORKFLOW_ENTITY_TYPE, bomId)).filter(
      (audit) => audit.action === 'APPROVE' || audit.action === 'REJECT',
    );
    // ★ 하나만 전이한다 — 둘 다 서로 다른 final state 를 commit 하지 않는다.
    expect(transitions).toHaveLength(1);
    expect(row.status).toBe(transitions[0]?.action === 'APPROVE' ? 'APPROVED' : 'REJECTED');
  });

  it('★★ submit × line PATCH — 제출 후 stale 판단으로 라인이 수정되지 않는다', async () => {
    const { bomId, lineId } = await draftReadyToSubmit('conc-submit-patch');

    const [submitOutcome, patchOutcome] = await Promise.all([
      submitBom(AUTHOR, bomId, {}).then(
        () => 'ok' as const,
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
      updateBomLine(AUTHOR, bomId, lineId, { quantityPer: '9' }).then(
        () => 'ok' as const,
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
    ]);

    const row = await headerRow(bomId);
    const line = await getPrismaClient().bomLine.findUniqueOrThrow({
      where: { id: lineId },
      select: { quantityPer: true },
    });

    // ★★ 어느 쪽도 **deadlock 으로 죽지 않는다**. submit 이 header row lock 을
    //    먼저 잡고 advisory 를 기다리면 advisory-first 인 line PATCH 와 순서가
    //    엇갈려 `P2010`(raw query failed)이 난다 — 실제로 그렇게 실패했었고
    //    D-28 순서(advisory 먼저)로 고쳤다. 이 단언이 그 회귀를 막는다.
    for (const outcome of [submitOutcome, patchOutcome]) {
      expect(outcome, `deadlock: ${submitOutcome}/${patchOutcome}`).not.toBe('P2010');
    }

    // ★ 직렬 실행 두 결과 중 하나와 일치해야 한다.
    if (row.status === 'PENDING_APPROVAL' && patchOutcome !== 'ok') {
      // submit 이 먼저 — PATCH 는 편집 불가로 막혔다.
      expect(line.quantityPer?.toFixed()).toBe('2');
    } else if (patchOutcome === 'ok') {
      // PATCH 가 먼저 — 값이 반영됐고 submit 은 성공하거나 밀렸다.
      expect(line.quantityPer?.toFixed()).toBe('9');
      expect(['ok', ERROR_CODES.BOM_NOT_EDITABLE]).toContain(submitOutcome);
    }
    // ⛔ 어느 경우에도 "PENDING 인데 값이 9" + "PATCH 실패" 같은 섞인 상태는 없다.
    expect(row.status === 'PENDING_APPROVAL' || row.status === 'DRAFT').toBe(true);
  });

  it('★★ sibling activate 동시 실행 — 기간이 겹치지 않는다', async () => {
    const parentSkuId = await newSku('conc-act-p', { status: 'ACTIVE' });
    const componentSkuId = await newSku('conc-act-c', { status: 'ACTIVE' });
    const make = async (version: string, from: string): Promise<string> => {
      const created = await createBom(AUTHOR, {
        parentSkuId,
        bomType: 'MANUFACTURING',
        version,
        effectiveFrom: from,
      });
      await createBomLine(
        AUTHOR,
        created.bom.id,
        lineInput(componentSkuId, { quantityStatus: 'CONFIRMED', quantityPer: '1' }),
      );
      await submitBom(AUTHOR, created.bom.id, {});
      await approveBom(APPROVER, created.bom.id, {});
      return created.bom.id;
    };

    const a = await make(CODE('CA1'), '2040-01-01');
    const b = await make(CODE('CA2'), '2041-01-01');

    await Promise.all([
      activateBom(APPROVER, a, {}).catch(() => undefined),
      activateBom(APPROVER2, b, {}).catch(() => undefined),
    ]);

    // ★ 최종 invariant — ACTIVE 구간이 서로 겹치지 않는다.
    const actives = await getPrismaClient().bomHeader.findMany({
      where: { parentSkuId, status: 'ACTIVE' },
      select: { effectiveFrom: true, effectiveTo: true },
      orderBy: { effectiveFrom: 'asc' },
    });
    for (let index = 1; index < actives.length; index += 1) {
      const previous = actives[index - 1]!;
      const current = actives[index]!;
      expect(previous.effectiveTo).not.toBeNull();
      expect(previous.effectiveTo!.getTime()).toBeLessThanOrEqual(current.effectiveFrom.getTime());
    }
  });
});
