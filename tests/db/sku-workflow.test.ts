import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  SKU_APPROVE_PERMISSION,
  SKU_CREATE_PERMISSION,
  SKU_DEACTIVATE_PERMISSION,
  SKU_READ_PERMISSION,
  SKU_SUBMIT_PERMISSION,
  approveSku,
  createSku,
  deactivateSku,
  parseCreateSkuInput,
  rejectSku,
  submitSku,
} from '@/modules/sku/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedCommonCodes } from '../../prisma/seed/common-codes';
import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * SKU 승인 워크플로 DB 테스트 (T1-4A) — 실제 PostgreSQL.
 *
 * 대역으로 재현할 수 없는 것:
 *   - approve vs reject **실제 동시 실행** — 조건부 원자 update 의 직렬화
 *   - 감사로그 실패 시 상태변경 실 롤백
 *   - 실 SystemSetting 기반 자가승인 / 실 seed 공통코드 기반 approve 재검증
 *   - RolePermission seed 반영
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TSW-${RUN}-${suffix}`;

const WRITER_ID = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
const APPROVER_ID = 'ffffffff-ffff-4fff-8fff-fffffffffff2';

const WRITER: ActorContext = createActorContext({
  userId: WRITER_ID,
  email: 'wf-writer@deeppoint.test',
  name: '워크플로 작성자',
  active: true,
  roles: ['SCM_STAFF'],
  permissions: [SKU_READ_PERMISSION, SKU_CREATE_PERMISSION, SKU_SUBMIT_PERMISSION],
  requestId: 'req-wf-db',
});

const APPROVER: ActorContext = createActorContext({
  userId: APPROVER_ID,
  email: 'wf-approver@deeppoint.test',
  name: '워크플로 승인자',
  active: true,
  roles: ['SCM_LEADER'],
  permissions: [SKU_READ_PERMISSION, SKU_APPROVE_PERMISSION, SKU_DEACTIVATE_PERMISSION],
  requestId: 'req-wf-db',
});

/** 작성자가 승인 권한도 가진 조합 — 자가승인 테스트용. */
const WRITER_AS_APPROVER: ActorContext = createActorContext({
  userId: WRITER_ID,
  email: 'wf-writer@deeppoint.test',
  name: '워크플로 작성자',
  active: true,
  roles: ['SCM_LEADER'],
  permissions: [SKU_READ_PERMISSION, SKU_APPROVE_PERMISSION],
  requestId: 'req-wf-db',
});

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id IN ($1::uuid, $2::uuid)`,
    WRITER_ID,
    APPROVER_ID,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TSW-' } } });
  await client.user.deleteMany({ where: { id: { in: [WRITER_ID, APPROVER_ID] } } });
  // 자가승인 설정 원복
  await client.systemSetting.updateMany({
    where: { id: 1 },
    data: { allowSelfApprovalSku: false },
  });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
    await seedCommonCodes(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: [
      { id: WRITER_ID, email: 'wf-writer@deeppoint.test', name: '워크플로 작성자' },
      { id: APPROVER_ID, email: 'wf-approver@deeppoint.test', name: '워크플로 승인자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

/** V1~V5 를 통과하는 SKU 를 만든다 — itemType 은 vocabulary 내 값. */
async function createValidSku(suffix: string): Promise<string> {
  const { sku } = await createSku(
    WRITER,
    parseCreateSkuInput({
      skuCode: CODE(suffix),
      skuName: `워크플로 ${suffix}`,
      itemType: 'FINISHED_GOOD',
    }),
  );
  return sku.id;
}

async function statusOf(id: string): Promise<string> {
  const row = await getPrismaClient().sku.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  return row.status;
}

async function workflowAudits(entityId: string) {
  return getPrismaClient().auditLog.findMany({
    where: {
      entityType: 'Sku',
      entityId,
      action: { in: ['SUBMIT', 'APPROVE', 'REJECT', 'DEACTIVATE'] },
    },
    orderBy: { occurredAt: 'asc' },
  });
}

describe('★ RolePermission seed — 워크플로 권한 3종 (실제 PostgreSQL)', () => {
  it('★ submit=S·L·A / approve=L·A / deactivate=L·A, sku.reject·sku.archive 없음', async () => {
    const client = getPrismaClient();
    const rows = await client.rolePermission.findMany({
      where: {
        permission: { permissionKey: { in: ['sku.submit', 'sku.approve', 'sku.deactivate'] } },
      },
      include: { role: true, permission: true },
    });
    const byKey = new Map<string, string[]>();
    for (const row of rows) {
      const list = byKey.get(row.permission.permissionKey) ?? [];
      list.push(row.role.roleCode);
      byKey.set(row.permission.permissionKey, list);
    }
    expect(byKey.get('sku.submit')?.sort()).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    expect(byKey.get('sku.approve')?.sort()).toEqual(['ADMIN', 'SCM_LEADER']);
    expect(byKey.get('sku.deactivate')?.sort()).toEqual(['ADMIN', 'SCM_LEADER']);

    expect(
      await client.permission.count({
        where: { permissionKey: { in: ['sku.reject', 'sku.archive'] } },
      }),
    ).toBe(0);
  });
});

describe('★ TC-SKU-006 — 실제 PostgreSQL 전체 lifecycle', () => {
  it('★ submit → approve — 상태·approvedAt/By·감사로그 SUBMIT/APPROVE 커밋', async () => {
    const id = await createValidSku('A1');

    const submitted = await submitSku(WRITER, id, { note: '등록 요청' });
    expect(submitted.sku.status).toBe('PENDING_APPROVAL');
    expect(submitted.validation?.hasErrors).toBe(false);
    expect(submitted.sku.approvedAt).toBeNull();

    const approved = await approveSku(APPROVER, id, { note: '승인' });
    expect(approved.sku.status).toBe('ACTIVE');
    expect(approved.sku.approvedBy).toBe(APPROVER_ID);
    expect(approved.sku.approvedAt).not.toBeNull();

    const audits = await workflowAudits(id);
    expect(audits.map((row) => row.action)).toEqual(['SUBMIT', 'APPROVE']);
    expect(audits[0]?.reason).toBe('등록 요청');
    expect(audits[1]?.approvedBy).toBe(APPROVER_ID);
    expect(audits[1]?.reason).toBe('승인');
  });

  it('★ reject — REJECTED + reason 감사 기록, approvedAt/By 미설정', async () => {
    const id = await createValidSku('R1');
    await submitSku(WRITER, id, {});
    const rejected = await rejectSku(APPROVER, id, { reason: '분류 재검토 필요' });

    expect(rejected.sku.status).toBe('REJECTED');
    expect(rejected.sku.approvedAt).toBeNull();
    expect(rejected.sku.approvedBy).toBeNull();

    const audits = await workflowAudits(id);
    expect(audits.map((row) => row.action)).toEqual(['SUBMIT', 'REJECT']);
    expect(audits[1]?.reason).toBe('분류 재검토 필요');
    expect(audits[1]?.approvedBy).toBeNull();
  });

  it('★ deactivate — INACTIVE, 기존 approvedAt/By 유지', async () => {
    const id = await createValidSku('D1');
    await submitSku(WRITER, id, {});
    const approved = await approveSku(APPROVER, id, {});

    const deactivated = await deactivateSku(APPROVER, id, { reason: '단종' });
    expect(deactivated.sku.status).toBe('INACTIVE');
    expect(deactivated.sku.approvedAt).toBe(approved.sku.approvedAt);
    expect(deactivated.sku.approvedBy).toBe(APPROVER_ID);

    const audits = await workflowAudits(id);
    expect(audits.map((row) => row.action)).toEqual(['SUBMIT', 'APPROVE', 'DEACTIVATE']);
    expect(audits[2]?.reason).toBe('단종');
  });

  it('★ 자가승인 — 실 SystemSetting false → 403 / true → 허용 (트랜잭션 내 최신값)', async () => {
    const id = await createValidSku('S1');
    await submitSku(WRITER, id, {});

    await getPrismaClient().systemSetting.update({
      where: { id: 1 },
      data: { allowSelfApprovalSku: false },
    });
    await expect(approveSku(WRITER_AS_APPROVER, id, {})).rejects.toMatchObject({
      code: 'SELF_APPROVAL_FORBIDDEN',
      httpStatus: 403,
    });
    expect(await statusOf(id)).toBe('PENDING_APPROVAL');

    await getPrismaClient().systemSetting.update({
      where: { id: 1 },
      data: { allowSelfApprovalSku: true },
    });
    const approved = await approveSku(WRITER_AS_APPROVER, id, {});
    expect(approved.sku.status).toBe('ACTIVE');
    expect(approved.sku.approvedBy).toBe(WRITER_ID);

    await getPrismaClient().systemSetting.update({
      where: { id: 1 },
      data: { allowSelfApprovalSku: false },
    });
  });

  it('★ approve 재검증 — submit 후 참조 브랜드 비활성화 시 approve 422·PENDING 유지', async () => {
    const client = getPrismaClient();
    const group = await client.commonCodeGroup.findUniqueOrThrow({
      where: { groupCode: 'BRAND' },
    });
    const brand = await client.commonCode.upsert({
      where: { groupId_code: { groupId: group.id, code: 'ZZT_WF_BRAND' } },
      update: { active: true },
      create: {
        groupId: group.id,
        code: 'ZZT_WF_BRAND',
        name: '워크플로 테스트 브랜드',
        sortOrder: 991,
        active: true,
      },
    });

    const { sku } = await createSku(
      WRITER,
      parseCreateSkuInput({
        skuCode: CODE('V1'),
        skuName: '재검증 대상',
        itemType: 'FINISHED_GOOD',
        brandId: brand.id,
      }),
    );

    // submit 시점엔 활성 — 통과
    await submitSku(WRITER, sku.id, {});

    // approve 전 비활성화 — 재검증에서 V4 FAIL
    await client.commonCode.update({ where: { id: brand.id }, data: { active: false } });

    await expect(approveSku(APPROVER, sku.id, {})).rejects.toMatchObject({
      code: 'SKU_APPROVAL_VALIDATION_FAILED',
      httpStatus: 422,
    });
    expect(await statusOf(sku.id)).toBe('PENDING_APPROVAL');

    // 정리: 참조 해제 후 코드 삭제
    await client.sku.update({ where: { id: sku.id }, data: { brandId: null } });
    await client.commonCode.delete({ where: { id: brand.id } });
  });

  it('★ V3 실DB — vocabulary 밖 itemType 은 submit 422', async () => {
    const { sku } = await createSku(
      WRITER,
      parseCreateSkuInput({
        skuCode: CODE('V3'),
        skuName: '미매핑 품목구분',
        itemType: 'FINISHED', // 14종에 없음 (T1-3 픽스처들이 쓰던 값)
      }),
    );
    await expect(submitSku(WRITER, sku.id, {})).rejects.toMatchObject({
      code: 'SKU_APPROVAL_VALIDATION_FAILED',
      httpStatus: 422,
    });
    expect(await statusOf(sku.id)).toBe('DRAFT');
  });

  it('★ 감사로그 실패 시 상태변경 실 롤백', async () => {
    const id = await createValidSku('RB');
    await expect(
      submitSku(
        WRITER,
        id,
        {},
        {
          auditLogger: {
            write: async () => {
              throw new Error('감사로그 강제 실패');
            },
          },
        },
      ),
    ).rejects.toThrow('감사로그 강제 실패');

    expect(await statusOf(id)).toBe('DRAFT');
    expect(await workflowAudits(id)).toHaveLength(0);
  });
});

describe('★ 동시성 — approve vs reject (실제 PostgreSQL 동시 실행)', () => {
  it('★ PENDING SKU 에 동시 approve+reject — 정확히 1개 성공, 상태·감사로그 일관', async () => {
    const id = await createValidSku('CC');
    await submitSku(WRITER, id, {});

    const [approveResult, rejectResult] = await Promise.allSettled([
      approveSku(APPROVER, id, {}),
      rejectSku(APPROVER, id, { reason: '동시성 테스트 반려' }),
    ]);

    const outcomes = [approveResult, rejectResult];
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // 진 쪽은 최신 상태 기준 전이 오류(또는 방어적 직렬화 실패)다
    const loser = rejected[0] as PromiseRejectedResult;
    expect(['INVALID_STATUS_TRANSITION', 'SERIALIZATION_FAILURE']).toContain(
      (loser.reason as { code?: string }).code,
    );

    // 최종 상태는 이긴 action 과 일치
    const finalStatus = await statusOf(id);
    const winnerWasApprove = approveResult.status === 'fulfilled';
    expect(finalStatus).toBe(winnerWasApprove ? 'ACTIVE' : 'REJECTED');

    // 상태 action 감사로그도 정확히 1건 (SUBMIT 제외)
    const audits = await workflowAudits(id);
    const decisionAudits = audits.filter((row) => row.action !== 'SUBMIT');
    expect(decisionAudits).toHaveLength(1);
    expect(decisionAudits[0]?.action).toBe(winnerWasApprove ? 'APPROVE' : 'REJECT');
  });
});
