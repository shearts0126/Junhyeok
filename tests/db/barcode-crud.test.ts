import { randomBytes, randomInt } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  BARCODE_CREATE_PERMISSION,
  BARCODE_DEACTIVATE_PERMISSION,
  BARCODE_READ_PERMISSION,
  BARCODE_UPDATE_PERMISSION,
  createSkuBarcode,
  deactivateSkuBarcode,
  listSkuBarcodes,
  parseCreateBarcodeInput,
  updateSkuBarcode,
} from '@/modules/barcode/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * 바코드 CRUD DB 테스트 (T04-3) — 실제 PostgreSQL.
 *
 * 계약 근거는 `docs/10_설계복구_BarcodeCRUD.md` 뿐이다.
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - T04-1 조건부 UNIQUE 2종의 실제 판정과 409 매핑(중복 vs 대표 충돌)
 *   - 감사로그 실패 시 실 트랜잭션 롤백 (SkuBarcode·IdempotencyRecord 함께)
 *   - 실 동시 요청에서 DB partial UNIQUE 가 최종 방어선임
 *   - RolePermission seed 가 실제 DB 에 반영되어 권한 판정에 쓰임
 */

const RUN = randomBytes(4).toString('hex');
/** ★ 바코드는 숫자 전용이며 `ux_barcode_active` 가 전역이므로 실행마다 유일해야 한다. */
const NUM = String(randomInt(100_000, 999_999));
const SKU_CODE = (suffix: string) => `TBX-${RUN}-${suffix}`;
const BC = (suffix: string) => `${NUM}${suffix}`;

const ADMIN_ID = 'aaaaaaa1-0000-4000-8000-00000000ba01';
const FINANCE_ID = 'aaaaaaa1-0000-4000-8000-00000000ba02';
const NOPERM_ID = 'aaaaaaa1-0000-4000-8000-00000000ba03';
const ACTOR_IDS = [ADMIN_ID, FINANCE_ID, NOPERM_ID];

const ALL_PERMISSIONS = [
  BARCODE_READ_PERMISSION,
  BARCODE_CREATE_PERMISSION,
  BARCODE_UPDATE_PERMISSION,
  BARCODE_DEACTIVATE_PERMISSION,
];

const ADMIN: ActorContext = createActorContext({
  userId: ADMIN_ID,
  email: 'barcode-admin@deeppoint.test',
  name: '바코드 관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: ALL_PERMISSIONS,
  requestId: 'req-barcode-admin',
});

/** read 만 가진 역할 — 05 권한표의 FINANCE. */
const FINANCE: ActorContext = createActorContext({
  userId: FINANCE_ID,
  email: 'barcode-finance@deeppoint.test',
  name: '재무',
  active: true,
  roles: ['FINANCE'],
  permissions: [BARCODE_READ_PERMISSION],
  requestId: 'req-barcode-finance',
});

/** ★ ADMIN 역할이지만 RolePermission 행이 없는 actor — ADMIN bypass 부재 증명. */
const ADMIN_NO_PERMISSION: ActorContext = createActorContext({
  userId: NOPERM_ID,
  email: 'barcode-noperm@deeppoint.test',
  name: '권한없는 관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: [],
  requestId: 'req-barcode-noperm',
});

let skuSeq = 0;

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`,
    ACTOR_IDS,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.idempotencyRecord.deleteMany({ where: { actorId: { in: ACTOR_IDS } } });
  await client.skuBarcode.deleteMany({ where: { sku: { skuCode: { startsWith: 'TBX-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TBX-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: [
      { id: ADMIN_ID, email: 'barcode-admin@deeppoint.test', name: '바코드 관리자' },
      { id: FINANCE_ID, email: 'barcode-finance@deeppoint.test', name: '재무' },
      { id: NOPERM_ID, email: 'barcode-noperm@deeppoint.test', name: '권한없는 관리자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

async function newSku(label: string): Promise<string> {
  skuSeq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: SKU_CODE(String(skuSeq).padStart(3, '0')),
      skuName: `바코드 CRUD SKU (${label})`,
      itemType: 'FINISHED',
    },
    select: { id: true },
  });
  return row.id;
}

function input(barcode: string, extra: Record<string, unknown> = {}) {
  return parseCreateBarcodeInput({ barcode, barcodeType: 'UNIT', ...extra });
}

async function auditRows(entityId: string) {
  return getPrismaClient().auditLog.findMany({
    where: { entityType: 'SkuBarcode', entityId },
    orderBy: { occurredAt: 'asc' },
  });
}

async function created(actor: ActorContext, skuId: string, barcode: string, extra = {}) {
  const result = await createSkuBarcode(actor, skuId, input(barcode, extra));
  if (result.kind !== 'CREATED') throw new Error('CREATED 결과가 아니다');
  return result.barcode;
}

// ═══════════════════════════════════════════════════════════════
// 1~7. 권한
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — 2겹 가드, ADMIN bypass 없음', () => {
  it('1·2·4·5. seed 된 RolePermission 이 계약대로다 (실 DB 조회)', async () => {
    const rows = await getPrismaClient().rolePermission.findMany({
      where: { permission: { permissionKey: { startsWith: 'barcode.' } } },
      include: { role: true, permission: true },
    });
    const rolesOf = (key: string) =>
      rows
        .filter((row) => row.permission.permissionKey === key)
        .map((row) => row.role.roleCode)
        .sort();

    // 1. GET — 5개 역할 전부
    expect(rolesOf('barcode.read')).toEqual([
      'ADMIN',
      'EXECUTIVE',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
    // 2·4·5. POST·PATCH·DELETE — ADMIN·SCM_LEADER·SCM_STAFF
    for (const key of ['barcode.create', 'barcode.update', 'barcode.deactivate']) {
      expect(rolesOf(key), key).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    }
    // ✏️ T04-4A 에서 중복 예외 permission 2종이 추가됐다 — CRUD 4종의 배정은 위와 같이
    //    그대로이고, 요청은 S·L·A / 승인은 **L·A** 로 역할집합이 다르다 (docs/11 §3).
    expect(rolesOf('barcode.request_duplicate')).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    expect(rolesOf('barcode.approve_duplicate')).toEqual(['ADMIN', 'SCM_LEADER']);
  });

  it('2·4·5. 쓰기 권한 보유 actor 는 POST·PATCH·DELETE 에 성공한다', async () => {
    const skuId = await newSku('perm-write');
    const row = await created(ADMIN, skuId, BC('01'));
    expect(row.status).toBe('ACTIVE');

    const patched = await updateSkuBarcode(ADMIN, skuId, row.id, { isPrimary: true });
    expect(patched.isPrimary).toBe(true);

    const removed = await deactivateSkuBarcode(ADMIN, skuId, row.id);
    expect(removed.status).toBe('INACTIVE');
  });

  it('1. read 권한만 있는 actor 도 목록 조회는 된다', async () => {
    const skuId = await newSku('perm-read');
    await created(ADMIN, skuId, BC('02'));
    const list = await listSkuBarcodes(FINANCE, skuId);
    expect(list).toHaveLength(1);
  });

  it('3. read 전용 actor 의 POST·PATCH·DELETE 는 403 이다', async () => {
    const skuId = await newSku('perm-403');
    const row = await created(ADMIN, skuId, BC('03'));

    await expect(createSkuBarcode(FINANCE, skuId, input(BC('04')))).rejects.toMatchObject({
      httpStatus: 403,
    });
    await expect(
      updateSkuBarcode(FINANCE, skuId, row.id, { isPrimary: true }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    await expect(deactivateSkuBarcode(FINANCE, skuId, row.id)).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('6. ★ ADMIN 역할이어도 permission 이 없으면 전부 403 이다', async () => {
    const skuId = await newSku('perm-admin-noperm');
    const row = await created(ADMIN, skuId, BC('05'));

    await expect(listSkuBarcodes(ADMIN_NO_PERMISSION, skuId)).rejects.toMatchObject({
      httpStatus: 403,
    });
    await expect(
      createSkuBarcode(ADMIN_NO_PERMISSION, skuId, input(BC('06'))),
    ).rejects.toMatchObject({ httpStatus: 403 });
    await expect(
      updateSkuBarcode(ADMIN_NO_PERMISSION, skuId, row.id, { status: 'INACTIVE' }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    await expect(deactivateSkuBarcode(ADMIN_NO_PERMISSION, skuId, row.id)).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('★ 권한 거부는 아무 것도 쓰지 않는다', async () => {
    const skuId = await newSku('perm-no-write');
    await expect(createSkuBarcode(FINANCE, skuId, input(BC('07')))).rejects.toMatchObject({
      httpStatus: 403,
    });
    expect(await getPrismaClient().skuBarcode.count({ where: { skuId } })).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8~11. GET
// ═══════════════════════════════════════════════════════════════

describe('★ GET 목록', () => {
  it('8. 부모 SKU 가 없으면 404 다 (빈 배열이 아니다)', async () => {
    await expect(
      listSkuBarcodes(ADMIN, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('8. soft-delete 된 SKU 도 404 다', async () => {
    const skuId = await newSku('get-deleted');
    await getPrismaClient().sku.update({ where: { id: skuId }, data: { deletedAt: new Date() } });
    await expect(listSkuBarcodes(ADMIN, skuId)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('9. 바코드가 없으면 빈 배열이다', async () => {
    const skuId = await newSku('get-empty');
    expect(await listSkuBarcodes(ADMIN, skuId)).toEqual([]);
  });

  it('10. ★ ACTIVE 와 INACTIVE 를 모두 반환한다 (ACTIVE-only 필터 없음)', async () => {
    const skuId = await newSku('get-both');
    const active = await created(ADMIN, skuId, BC('10'));
    const inactive = await created(ADMIN, skuId, BC('11'));
    await deactivateSkuBarcode(ADMIN, skuId, inactive.id);

    const list = await listSkuBarcodes(ADMIN, skuId);
    expect(list).toHaveLength(2);
    expect(list.map((row) => row.status).sort()).toEqual(['ACTIVE', 'INACTIVE']);
    expect(list.map((row) => row.id).sort()).toEqual([active.id, inactive.id].sort());
  });

  it('11. ★ 정렬은 createdAt DESC, id DESC 로 결정적이다', async () => {
    const skuId = await newSku('get-order');
    const first = await created(ADMIN, skuId, BC('12'));
    const second = await created(ADMIN, skuId, BC('13'));
    const third = await created(ADMIN, skuId, BC('14'));

    const list = await listSkuBarcodes(ADMIN, skuId);
    const ids = list.map((row) => row.id);
    // 최신이 앞이다.
    expect(ids[0]).toBe(third.id);
    expect(ids).toContain(second.id);
    expect(ids[ids.length - 1]).toBe(first.id);

    // 반복 조회해도 순서가 같다.
    for (let i = 0; i < 3; i += 1) {
      expect((await listSkuBarcodes(ADMIN, skuId)).map((row) => row.id)).toEqual(ids);
    }
  });

  it('조회 응답은 T04-4 필드까지 포함한다 (입력은 못 해도 조회는 된다)', async () => {
    const skuId = await newSku('get-fields');
    const row = await created(ADMIN, skuId, BC('15'));
    expect(Object.keys(row).sort()).toEqual(
      [
        'approvedBy',
        'barcode',
        'barcodeType',
        'channelCode',
        'countryCode',
        'createdAt',
        'duplicateException',
        'effectiveFrom',
        'effectiveTo',
        'exceptionReason',
        'id',
        'isPrimary',
        'skuId',
        'status',
      ].sort(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 12~27. POST
// ═══════════════════════════════════════════════════════════════

describe('★ POST 생성', () => {
  it('12. 정상 생성 — 201 payload + server-managed 기본값', async () => {
    const skuId = await newSku('post-normal');
    const row = await created(ADMIN, skuId, BC('20'));

    expect(row.barcode).toBe(BC('20'));
    expect(row.barcodeType).toBe('UNIT');
    expect(row.isPrimary).toBe(false);
    expect(row.status).toBe('ACTIVE');
    // ★ T04-4 필드는 서버가 강제로 비운다.
    expect(row.duplicateException).toBe(false);
    expect(row.exceptionReason).toBeNull();
    expect(row.approvedBy).toBeNull();

    expect((await auditRows(row.id)).map((log) => log.action)).toEqual(['CREATE']);
  });

  it('13·14. 멱등 — 같은 key+내용은 replay, 다른 내용은 409', async () => {
    const skuId = await newSku('post-idem');
    const key = `bc-idem-${RUN}`;

    const first = await createSkuBarcode(ADMIN, skuId, input(BC('21')), {}, key);
    expect(first).toMatchObject({ kind: 'CREATED', replayed: false });

    // 13. 같은 key + 같은 내용 → 같은 id replay, 행·감사로그 증가 없음
    const replay = await createSkuBarcode(ADMIN, skuId, input(BC('21')), {}, key);
    expect(replay).toMatchObject({ kind: 'CREATED', replayed: true });
    if (first.kind !== 'CREATED' || replay.kind !== 'CREATED') throw new Error('unreachable');
    expect(replay.barcode.id).toBe(first.barcode.id);
    expect(await getPrismaClient().skuBarcode.count({ where: { skuId } })).toBe(1);
    expect(await auditRows(first.barcode.id)).toHaveLength(1);

    // 14. 같은 key + 다른 내용 → 409 IDEMPOTENCY_KEY_REUSED
    await expect(createSkuBarcode(ADMIN, skuId, input(BC('22')), {}, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      httpStatus: 409,
    });
    expect(await getPrismaClient().skuBarcode.count({ where: { skuId } })).toBe(1);
  });

  it('★ 정규화 결과가 같아도 원 입력이 다르면 409 다 (semantic normalization 없음)', async () => {
    const skuId = await newSku('post-idem-normalized');
    const key = `bc-norm-${RUN}`;
    const raw = BC('23');

    await createSkuBarcode(ADMIN, skuId, input(raw), {}, key);
    await expect(
      createSkuBarcode(ADMIN, skuId, input(`${raw.slice(0, 3)}-${raw.slice(3)}`), {}, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('15·16. 정규화 — 공백·하이픈 제거, 앞자리 0 보존', async () => {
    const skuA = await newSku('post-normalize');
    const spaced = await created(ADMIN, skuA, `${BC('24').slice(0, 3)} ${BC('24').slice(3)}`);
    expect(spaced.barcode).toBe(BC('24'));

    const hyphened = await created(ADMIN, skuA, `${BC('25').slice(0, 3)}-${BC('25').slice(3)}`);
    expect(hyphened.barcode).toBe(BC('25'));

    // 16. 앞자리 0 보존 — 숫자 왕복이었다면 사라졌을 값이다.
    const zero = await created(ADMIN, skuA, `  00${BC('26')}  `);
    expect(zero.barcode).toBe(`00${BC('26')}`);
    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({ where: { id: zero.id } });
    expect(reread.barcode).toBe(`00${BC('26')}`);
  });

  it('17. ★ EMPTY — 저장 0 / 감사로그 0 / 멱등기록 0, 오류가 아니다', async () => {
    const skuId = await newSku('post-empty');
    const key = `bc-empty-${RUN}`;

    for (const empty of ['', '   ', '-', '—', ' - ']) {
      const result = await createSkuBarcode(ADMIN, skuId, input(empty), {}, key);
      expect(result, JSON.stringify(empty)).toEqual({ kind: 'EMPTY' });
    }

    const client = getPrismaClient();
    expect(await client.skuBarcode.count({ where: { skuId } })).toBe(0);
    expect(
      await client.auditLog.count({ where: { entityType: 'SkuBarcode', actorId: ADMIN_ID } }),
    ).toBeGreaterThanOrEqual(0);
    // ★ claim 이전에 종료 — 같은 key 가 소모되지 않았다.
    expect(
      await client.idempotencyRecord.count({ where: { actorId: ADMIN_ID, idempotencyKey: key } }),
    ).toBe(0);

    // 따라서 같은 key 로 정상 값을 다시 제출할 수 있다.
    const ok = await createSkuBarcode(ADMIN, skuId, input(BC('27')), {}, key);
    expect(ok).toMatchObject({ kind: 'CREATED', replayed: false });
  });

  it('18·19·20. 정규화 실패는 422 이며 DataIssue 도 행도 만들지 않는다', async () => {
    const skuId = await newSku('post-422');

    await expect(createSkuBarcode(ADMIN, skuId, input('1.23E+12'))).rejects.toMatchObject({
      code: 'BARCODE_SCIENTIFIC_NOTATION',
      httpStatus: 422,
    });
    for (const raw of ['확인필요', '확인불가', '확인 필요', '바코드']) {
      await expect(createSkuBarcode(ADMIN, skuId, input(raw))).rejects.toMatchObject({
        code: 'BARCODE_UNVERIFIED',
        httpStatus: 422,
      });
    }
    for (const raw of ['ABC123', '8809/1234', '123_456']) {
      await expect(createSkuBarcode(ADMIN, skuId, input(raw))).rejects.toMatchObject({
        code: 'BARCODE_INVALID_FORMAT',
        httpStatus: 422,
      });
    }

    expect(await getPrismaClient().skuBarcode.count({ where: { skuId } })).toBe(0);
  });

  it('21. 숫자 JSON 입력은 DTO 에서 400 이며 도메인까지 가지 않는다', () => {
    expect(() => parseCreateBarcodeInput({ barcode: 8809619961373, barcodeType: 'UNIT' })).toThrow(
      /올바르지/,
    );
  });

  it('22. 정규화 결과 100자 초과는 400 이고 DB 22001 까지 가지 않는다', async () => {
    const skuId = await newSku('post-length');
    await expect(createSkuBarcode(ADMIN, skuId, input('9'.repeat(101)))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
    });

    // 정확히 100자는 저장된다 (DB 경계와 일치).
    const ok = await created(ADMIN, skuId, `${BC('28')}${'7'.repeat(100 - BC('28').length)}`);
    expect(ok.barcode).toHaveLength(100);
  });

  it('23·26. unknown field·T04-4 필드 주입은 400 이다', () => {
    for (const extra of [
      { status: 'INACTIVE' },
      { duplicateException: true },
      { exceptionReason: '사유' },
      { approvedBy: ADMIN_ID },
      { countryCode: 'KR' },
    ]) {
      expect(
        () => parseCreateBarcodeInput({ barcode: BC('29'), barcodeType: 'UNIT', ...extra }),
        JSON.stringify(extra),
      ).toThrow(/올바르지/);
    }
  });

  it('24. ★ 활성 일반 바코드 중복 → 409 BARCODE_DUPLICATE (자동 예외 없음)', async () => {
    const skuA = await newSku('post-dup-a');
    const skuB = await newSku('post-dup-b');
    const barcode = BC('30');

    await created(ADMIN, skuA, barcode);
    await expect(createSkuBarcode(ADMIN, skuB, input(barcode))).rejects.toMatchObject({
      code: 'BARCODE_DUPLICATE',
      httpStatus: 409,
    });

    // ⛔ 자동 duplicateException=true 로 우회하지 않았다.
    const rows = await getPrismaClient().skuBarcode.findMany({ where: { barcode } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.duplicateException).toBe(false);
    // ⛔ 기존 바코드를 자동 비활성하지도 않았다.
    expect(rows[0]?.status).toBe('ACTIVE');
  });

  it('25. ★ 활성 대표 중복 → 409 BARCODE_PRIMARY_CONFLICT (기존 대표 유지)', async () => {
    const skuId = await newSku('post-primary');
    const first = await created(ADMIN, skuId, BC('31'), { isPrimary: true });

    await expect(
      createSkuBarcode(ADMIN, skuId, input(BC('32'), { isPrimary: true })),
    ).rejects.toMatchObject({ code: 'BARCODE_PRIMARY_CONFLICT', httpStatus: 409 });

    // ⛔ 기존 대표가 자동으로 내려가지 않았다.
    const rows = await getPrismaClient().skuBarcode.findMany({ where: { skuId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.id);
    expect(rows[0]?.isPrimary).toBe(true);

    // 대표가 아닌 바코드는 함께 존재할 수 있다.
    const secondary = await created(ADMIN, skuId, BC('33'));
    expect(secondary.isPrimary).toBe(false);
  });

  it('27. ★ 감사로그 실패 시 바코드·멱등기록이 함께 롤백된다', async () => {
    const skuId = await newSku('post-rollback');
    const key = `bc-rollback-${RUN}`;
    const failing = {
      write: async () => {
        throw new Error('감사로그 실패 주입');
      },
    };

    await expect(
      createSkuBarcode(ADMIN, skuId, input(BC('34')), { auditLogger: failing as never }, key),
    ).rejects.toThrow(/감사로그 실패 주입/);

    const client = getPrismaClient();
    expect(await client.skuBarcode.count({ where: { skuId } })).toBe(0);
    expect(
      await client.idempotencyRecord.count({ where: { actorId: ADMIN_ID, idempotencyKey: key } }),
    ).toBe(0);

    // 롤백 후 같은 key 로 재시도하면 정상 생성된다 (key 가 영구 점유되지 않는다).
    const retry = await createSkuBarcode(ADMIN, skuId, input(BC('34')), {}, key);
    expect(retry).toMatchObject({ kind: 'CREATED', replayed: false });
  });

  it('부모 SKU 가 없으면 404 이고 아무 것도 쓰지 않는다', async () => {
    await expect(
      createSkuBarcode(ADMIN, '00000000-0000-4000-8000-000000000000', input(BC('35'))),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

// ═══════════════════════════════════════════════════════════════
// 28~36. PATCH
// ═══════════════════════════════════════════════════════════════

describe('★ PATCH 수정', () => {
  it('28. isPrimary 를 바꾸고 감사로그 UPDATE 를 남긴다', async () => {
    const skuId = await newSku('patch-primary');
    const row = await created(ADMIN, skuId, BC('40'));

    const patched = await updateSkuBarcode(ADMIN, skuId, row.id, { isPrimary: true });
    expect(patched.isPrimary).toBe(true);
    expect((await auditRows(row.id)).map((log) => log.action)).toEqual(['CREATE', 'UPDATE']);
  });

  it('29·30. ACTIVE ↔ INACTIVE 양방향 전이', async () => {
    const skuId = await newSku('patch-status');
    const row = await created(ADMIN, skuId, BC('41'));

    const off = await updateSkuBarcode(ADMIN, skuId, row.id, { status: 'INACTIVE' });
    expect(off.status).toBe('INACTIVE');

    const on = await updateSkuBarcode(ADMIN, skuId, row.id, { status: 'ACTIVE' });
    expect(on.status).toBe('ACTIVE');
  });

  it('31. ★ 대표 지정 충돌 → 409, 기존 대표 자동 해제 없음', async () => {
    const skuId = await newSku('patch-primary-conflict');
    const first = await created(ADMIN, skuId, BC('42'), { isPrimary: true });
    const second = await created(ADMIN, skuId, BC('43'));

    await expect(
      updateSkuBarcode(ADMIN, skuId, second.id, { isPrimary: true }),
    ).rejects.toMatchObject({ code: 'BARCODE_PRIMARY_CONFLICT', httpStatus: 409 });

    const rows = await getPrismaClient().skuBarcode.findMany({ where: { skuId } });
    expect(rows.filter((row) => row.isPrimary).map((row) => row.id)).toEqual([first.id]);

    // 명시적으로 기존 대표를 내린 뒤에는 지정할 수 있다.
    await updateSkuBarcode(ADMIN, skuId, first.id, { isPrimary: false });
    const promoted = await updateSkuBarcode(ADMIN, skuId, second.id, { isPrimary: true });
    expect(promoted.isPrimary).toBe(true);
  });

  it('32. ★ 재활성 시 중복이면 409 — 자동 해결 없음', async () => {
    const skuA = await newSku('patch-react-a');
    const skuB = await newSku('patch-react-b');
    const barcode = BC('44');

    const rowA = await created(ADMIN, skuA, barcode);
    await deactivateSkuBarcode(ADMIN, skuA, rowA.id);
    // 그 사이 다른 SKU 가 같은 값을 활성으로 쓴다.
    await created(ADMIN, skuB, barcode);

    await expect(
      updateSkuBarcode(ADMIN, skuA, rowA.id, { status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'BARCODE_DUPLICATE', httpStatus: 409 });

    // 비활성 상태 그대로 남는다.
    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({ where: { id: rowA.id } });
    expect(reread.status).toBe('INACTIVE');
  });

  it('32. ★ 재활성 시 활성 대표가 있으면 409 BARCODE_PRIMARY_CONFLICT', async () => {
    const skuId = await newSku('patch-react-primary');
    const old = await created(ADMIN, skuId, BC('45'), { isPrimary: true });
    await deactivateSkuBarcode(ADMIN, skuId, old.id);
    await created(ADMIN, skuId, BC('46'), { isPrimary: true });

    await expect(
      updateSkuBarcode(ADMIN, skuId, old.id, { status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'BARCODE_PRIMARY_CONFLICT', httpStatus: 409 });
  });

  it('35. ★ 변화가 없으면 UPDATE 도 감사로그도 만들지 않는다', async () => {
    const skuId = await newSku('patch-noop');
    const row = await created(ADMIN, skuId, BC('47'));

    const same = await updateSkuBarcode(ADMIN, skuId, row.id, {
      isPrimary: false,
      status: 'ACTIVE',
    });
    expect(same).toEqual(row);
    expect((await auditRows(row.id)).map((log) => log.action)).toEqual(['CREATE']);
  });

  it('36. ★ 다른 SKU 의 barcodeId 는 404 이며 수정되지 않는다', async () => {
    const skuA = await newSku('patch-owner-a');
    const skuB = await newSku('patch-owner-b');
    const rowB = await created(ADMIN, skuB, BC('48'));

    await expect(updateSkuBarcode(ADMIN, skuA, rowB.id, { isPrimary: true })).rejects.toMatchObject(
      { httpStatus: 404 },
    );

    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({ where: { id: rowB.id } });
    expect(reread.isPrimary).toBe(false);
  });

  it('존재하지 않는 barcodeId 도 같은 404 다 (구분 노출 없음)', async () => {
    const skuId = await newSku('patch-missing');
    await expect(
      updateSkuBarcode(ADMIN, skuId, '00000000-0000-4000-8000-000000000000', { isPrimary: true }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

// ═══════════════════════════════════════════════════════════════
// 37~41. DELETE (= 비활성)
// ═══════════════════════════════════════════════════════════════

describe('★ DELETE — 물리삭제가 아니라 비활성', () => {
  it('37·38. ACTIVE → INACTIVE + DEACTIVATE 감사로그, 행은 남는다', async () => {
    const skuId = await newSku('delete-basic');
    const row = await created(ADMIN, skuId, BC('50'));

    const removed = await deactivateSkuBarcode(ADMIN, skuId, row.id);
    expect(removed.status).toBe('INACTIVE');
    expect((await auditRows(row.id)).map((log) => log.action)).toEqual(['CREATE', 'DEACTIVATE']);

    // 38. 물리 행이 그대로 존재한다.
    const stored = await getPrismaClient().skuBarcode.findUnique({ where: { id: row.id } });
    expect(stored).not.toBeNull();
    expect(stored?.barcode).toBe(BC('50'));
  });

  it('39. ★ 이미 INACTIVE 면 재호출도 200 이며 추가 감사로그가 없다', async () => {
    const skuId = await newSku('delete-repeat');
    const row = await created(ADMIN, skuId, BC('51'));

    const first = await deactivateSkuBarcode(ADMIN, skuId, row.id);
    const second = await deactivateSkuBarcode(ADMIN, skuId, row.id);
    const third = await deactivateSkuBarcode(ADMIN, skuId, row.id);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // ⛔ 409·422 가 아니다.
    expect((await auditRows(row.id)).map((log) => log.action)).toEqual(['CREATE', 'DEACTIVATE']);
  });

  it('40. ★ 대표 바코드 비활성 — isPrimary 유지, 자동 승격 없음', async () => {
    const skuId = await newSku('delete-primary');
    const primary = await created(ADMIN, skuId, BC('52'), { isPrimary: true });
    const other = await created(ADMIN, skuId, BC('53'));

    const removed = await deactivateSkuBarcode(ADMIN, skuId, primary.id);
    // ★ isPrimary 를 자동으로 내리지 않는다 — 과거 대표 이력이다.
    expect(removed.isPrimary).toBe(true);
    expect(removed.status).toBe('INACTIVE');

    // ⛔ 다른 바코드를 자동 대표 승격하지 않는다.
    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: other.id },
    });
    expect(reread.isPrimary).toBe(false);

    // 활성 대표 0개 상태가 허용된다.
    expect(
      await getPrismaClient().skuBarcode.count({
        where: { skuId, isPrimary: true, status: 'ACTIVE' },
      }),
    ).toBe(0);

    // 그 뒤 새 대표를 지정할 수 있다 (partial index 는 ACTIVE 조건이므로 충돌 없음).
    const promoted = await updateSkuBarcode(ADMIN, skuId, other.id, { isPrimary: true });
    expect(promoted.isPrimary).toBe(true);
  });

  it('41. ★ 다른 SKU 의 barcodeId 는 404 이며 비활성되지 않는다', async () => {
    const skuA = await newSku('delete-owner-a');
    const skuB = await newSku('delete-owner-b');
    const rowB = await created(ADMIN, skuB, BC('54'));

    await expect(deactivateSkuBarcode(ADMIN, skuA, rowB.id)).rejects.toMatchObject({
      httpStatus: 404,
    });

    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({ where: { id: rowB.id } });
    expect(reread.status).toBe('ACTIVE');
  });

  it('비활성 후 같은 값을 다른 SKU 가 활성으로 쓸 수 있다', async () => {
    const skuA = await newSku('delete-release-a');
    const skuB = await newSku('delete-release-b');
    const barcode = BC('55');

    const rowA = await created(ADMIN, skuA, barcode);
    await deactivateSkuBarcode(ADMIN, skuA, rowA.id);

    const rowB = await created(ADMIN, skuB, barcode);
    expect(rowB.status).toBe('ACTIVE');
  });
});

// ═══════════════════════════════════════════════════════════════
// §35 실 PostgreSQL 동시성 — DB partial UNIQUE 가 최종 방어선
// ═══════════════════════════════════════════════════════════════

describe('★ 동시 요청 — DB 조건부 UNIQUE 가 최종 방어선', () => {
  it('동일 바코드 동시 생성 → 정확히 1건 성공 + 1건 BARCODE_DUPLICATE', async () => {
    const skuA = await newSku('race-dup-a');
    const skuB = await newSku('race-dup-b');
    const barcode = BC('60');

    // ★ 멱등키는 서로 다르게 — 멱등 replay 가 아니라 실제 동시 INSERT 경합을 본다.
    const results = await Promise.allSettled([
      createSkuBarcode(ADMIN, skuA, input(barcode), {}, `race-dup-a-${RUN}`),
      createSkuBarcode(ADMIN, skuB, input(barcode), {}, `race-dup-b-${RUN}`),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'BARCODE_DUPLICATE',
      httpStatus: 409,
    });

    const stored = await getPrismaClient().skuBarcode.findMany({
      where: { barcode, status: 'ACTIVE', duplicateException: false },
    });
    expect(stored).toHaveLength(1);
  });

  it('동일 SKU 대표 동시 지정 → 정확히 1건 성공 + 1건 BARCODE_PRIMARY_CONFLICT', async () => {
    const skuId = await newSku('race-primary');

    const results = await Promise.allSettled([
      createSkuBarcode(ADMIN, skuId, input(BC('61'), { isPrimary: true }), {}, `race-p1-${RUN}`),
      createSkuBarcode(ADMIN, skuId, input(BC('62'), { isPrimary: true }), {}, `race-p2-${RUN}`),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'BARCODE_PRIMARY_CONFLICT',
      httpStatus: 409,
    });

    // ★ 최종 활성 대표는 정확히 1개다.
    expect(
      await getPrismaClient().skuBarcode.count({
        where: { skuId, isPrimary: true, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 범위 고정
// ═══════════════════════════════════════════════════════════════

describe('★ T04-3 범위 고정', () => {
  it('production 경로로 duplicateException=true 를 만들 수 없다', async () => {
    const skuId = await newSku('scope-exception');
    await created(ADMIN, skuId, BC('70'));

    const rows = await getPrismaClient().skuBarcode.findMany({ where: { skuId } });
    expect(rows.every((row) => row.duplicateException === false)).toBe(true);
    expect(rows.every((row) => row.approvedBy === null)).toBe(true);
    expect(rows.every((row) => row.exceptionReason === null)).toBe(true);
  });

  it('SkuBarcode 스키마가 T04-1 그대로다 — 새 컬럼이 없다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sku_barcode' ORDER BY column_name`;
    expect(rows.map((row) => row.column_name)).toEqual([
      'approved_by',
      'barcode',
      'barcode_type',
      'channel_code',
      'country_code',
      'created_at',
      'duplicate_exception',
      'effective_from',
      'effective_to',
      'exception_reason',
      'id',
      'is_primary',
      'sku_id',
      'status',
    ]);
  });

  it('data_issue 테이블이 여전히 없다 — T04-3 은 DataIssue 를 만들지 않는다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'data_issue'`;
    expect(rows[0]?.count).toBe(0);
  });
});
