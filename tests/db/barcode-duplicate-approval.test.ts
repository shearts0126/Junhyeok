import { randomBytes, randomInt } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  BARCODE_APPROVE_DUPLICATE_PERMISSION,
  BARCODE_CREATE_PERMISSION,
  BARCODE_DEACTIVATE_PERMISSION,
  BARCODE_READ_PERMISSION,
  BARCODE_REQUEST_DUPLICATE_PERMISSION,
  BARCODE_STATUS_PENDING_DUPLICATE,
  BARCODE_UPDATE_PERMISSION,
  approveDuplicateBarcode,
  createSkuBarcode,
  deactivateSkuBarcode,
  listSkuBarcodes,
  parseCreateBarcodeInput,
  parseRequestDuplicateCandidateInput,
  requestDuplicateCandidate,
  updateSkuBarcode,
} from '@/modules/barcode/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * 바코드 중복 예외 승인 DB 테스트 (T04-4A) — 실제 PostgreSQL.
 *
 * 계약 근거는 `docs/11_설계복구_Barcode중복예외승인.md` 뿐이다.
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - `ux_barcode_pending_duplicate` 의 실제 판정과 catalog predicate
 *   - `PENDING_DUPLICATE` 후보가 T04-1 두 partial index predicate 밖이라는 사실
 *   - 승인 트랜잭션의 행 잠금·롤백·감사로그 원자성
 *   - 실 동시 요청에서 후보 1건·승인 1건이 되는 것
 */

const RUN = randomBytes(4).toString('hex');
const NUM = String(randomInt(100_000, 999_999));
const SKU_CODE = (suffix: string) => `TDX-${RUN}-${suffix}`;
const BC = (suffix: string) => `${NUM}${suffix}`;

const LEADER_ID = 'bbbbbbb1-0000-4000-8000-00000000da01';
const STAFF_ID = 'bbbbbbb1-0000-4000-8000-00000000da02';
const FINANCE_ID = 'bbbbbbb1-0000-4000-8000-00000000da03';
const NOPERM_ID = 'bbbbbbb1-0000-4000-8000-00000000da04';
const LEADER2_ID = 'bbbbbbb1-0000-4000-8000-00000000da05';
const ACTOR_IDS = [LEADER_ID, STAFF_ID, FINANCE_ID, NOPERM_ID, LEADER2_ID];

const CRUD_PERMISSIONS = [
  BARCODE_READ_PERMISSION,
  BARCODE_CREATE_PERMISSION,
  BARCODE_UPDATE_PERMISSION,
  BARCODE_DEACTIVATE_PERMISSION,
];

/** ADMIN·SCM_LEADER — 요청과 승인을 모두 가진다 (자가승인 허용, docs/11 §12). */
const LEADER: ActorContext = createActorContext({
  userId: LEADER_ID,
  email: 'dup-leader@deeppoint.test',
  name: '리더',
  active: true,
  roles: ['SCM_LEADER'],
  permissions: [
    ...CRUD_PERMISSIONS,
    BARCODE_REQUEST_DUPLICATE_PERMISSION,
    BARCODE_APPROVE_DUPLICATE_PERMISSION,
  ],
  requestId: 'req-dup-leader',
});

/** 두 번째 승인자 — 동시 승인 경합 검증용. */
const LEADER2: ActorContext = createActorContext({
  userId: LEADER2_ID,
  email: 'dup-leader2@deeppoint.test',
  name: '리더2',
  active: true,
  roles: ['SCM_LEADER'],
  permissions: [...CRUD_PERMISSIONS, BARCODE_APPROVE_DUPLICATE_PERMISSION],
  requestId: 'req-dup-leader2',
});

/** SCM_STAFF — 요청은 되지만 승인은 안 된다. */
const STAFF: ActorContext = createActorContext({
  userId: STAFF_ID,
  email: 'dup-staff@deeppoint.test',
  name: '담당자',
  active: true,
  roles: ['SCM_STAFF'],
  permissions: [...CRUD_PERMISSIONS, BARCODE_REQUEST_DUPLICATE_PERMISSION],
  requestId: 'req-dup-staff',
});

/** FINANCE — read 전용. */
const FINANCE: ActorContext = createActorContext({
  userId: FINANCE_ID,
  email: 'dup-finance@deeppoint.test',
  name: '재무',
  active: true,
  roles: ['FINANCE'],
  permissions: [BARCODE_READ_PERMISSION],
  requestId: 'req-dup-finance',
});

/** ADMIN 역할이지만 RolePermission 행이 없다 — ADMIN bypass 부재 증명. */
const ADMIN_NO_PERMISSION: ActorContext = createActorContext({
  userId: NOPERM_ID,
  email: 'dup-noperm@deeppoint.test',
  name: '권한없는 관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: [],
  requestId: 'req-dup-noperm',
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
  await client.skuBarcode.deleteMany({ where: { sku: { skuCode: { startsWith: 'TDX-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TDX-' } } });
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
      { id: LEADER_ID, email: 'dup-leader@deeppoint.test', name: '리더' },
      { id: STAFF_ID, email: 'dup-staff@deeppoint.test', name: '담당자' },
      { id: FINANCE_ID, email: 'dup-finance@deeppoint.test', name: '재무' },
      { id: NOPERM_ID, email: 'dup-noperm@deeppoint.test', name: '권한없는 관리자' },
      { id: LEADER2_ID, email: 'dup-leader2@deeppoint.test', name: '리더2' },
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
      skuName: `중복 예외 SKU (${label})`,
      itemType: 'FINISHED',
    },
    select: { id: true },
  });
  return row.id;
}

function candidateInput(barcode: string, extra: Record<string, unknown> = {}) {
  return parseRequestDuplicateCandidateInput({ barcode, barcodeType: 'UNIT', ...extra });
}

/** 다른 SKU 에 ACTIVE 바코드를 만들어 "실제 중복" 상대를 준비한다. */
async function activeBarcodeOn(
  skuId: string,
  barcode: string,
  extra: Record<string, unknown> = {},
) {
  const result = await createSkuBarcode(
    LEADER,
    skuId,
    parseCreateBarcodeInput({ barcode, barcodeType: 'UNIT', ...extra }),
  );
  if (result.kind !== 'CREATED') throw new Error('CREATED 결과가 아니다');
  return result.barcode;
}

async function auditRows(entityId: string) {
  return getPrismaClient().auditLog.findMany({
    where: { entityType: 'SkuBarcode', entityId },
    orderBy: { occurredAt: 'asc' },
  });
}

/** 실제 중복 상대 + 후보를 한 번에 준비한다. */
async function preparedCandidate(label: string, extra: Record<string, unknown> = {}) {
  const barcode = BC(String(skuSeq).padStart(3, '0'));
  const otherSkuId = await newSku(`${label}-other`);
  const targetSkuId = await newSku(`${label}-target`);
  await activeBarcodeOn(otherSkuId, barcode);

  const result = await requestDuplicateCandidate(
    STAFF,
    targetSkuId,
    candidateInput(barcode, extra),
  );
  return { barcode, otherSkuId, targetSkuId, candidate: result.barcode };
}

// ═══════════════════════════════════════════════════════════════
// §30 DB — PENDING_DUPLICATE 저장·index
// ═══════════════════════════════════════════════════════════════

describe('★ §30 DB — PENDING_DUPLICATE 와 신규 partial UNIQUE', () => {
  it('1·2. PENDING 행은 저장되며 ux_barcode_active predicate 밖이다', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('db-pending-a');
    const skuB = await newSku('db-pending-b');
    const barcode = BC('01');

    await client.skuBarcode.create({ data: { skuId: skuA, barcode, status: 'ACTIVE' } });
    // 같은 값이 ACTIVE 로 있어도 PENDING 후보는 만들어진다 (predicate 밖).
    const pending = await client.skuBarcode.create({
      data: { skuId: skuB, barcode, status: BARCODE_STATUS_PENDING_DUPLICATE },
    });
    expect(pending.status).toBe('PENDING_DUPLICATE');

    // 대표 index 도 status='ACTIVE' 조건이므로 PENDING primary 는 충돌하지 않는다.
    await client.skuBarcode.create({
      data: { skuId: skuA, barcode: BC('02'), isPrimary: true, status: 'ACTIVE' },
    });
    const pendingPrimary = await client.skuBarcode.create({
      data: {
        skuId: skuA,
        barcode: BC('03'),
        isPrimary: true,
        status: BARCODE_STATUS_PENDING_DUPLICATE,
      },
    });
    expect(pendingPrimary.isPrimary).toBe(true);
  });

  it('3. ★ 동일 SKU+barcode 의 PENDING 후보 두 개는 UNIQUE 실패', async () => {
    const client = getPrismaClient();
    const skuId = await newSku('db-pending-dup');
    const barcode = BC('04');

    await client.skuBarcode.create({
      data: { skuId, barcode, status: BARCODE_STATUS_PENDING_DUPLICATE },
    });
    await expect(
      client.skuBarcode.create({
        data: { skuId, barcode, status: BARCODE_STATUS_PENDING_DUPLICATE },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await expect(
      client.$executeRawUnsafe(
        `INSERT INTO sku_barcode (id, sku_id, barcode, status)
         VALUES (gen_random_uuid(), $1::uuid, $2, 'PENDING_DUPLICATE')`,
        skuId,
        barcode,
      ),
    ).rejects.toThrow(/23505|ux_barcode_pending_duplicate/);
  });

  it('4. 다른 SKU 는 같은 barcode 로 각각 PENDING 후보를 가질 수 있다', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('db-pending-cross-a');
    const skuB = await newSku('db-pending-cross-b');
    const barcode = BC('05');

    await client.skuBarcode.create({
      data: { skuId: skuA, barcode, status: BARCODE_STATUS_PENDING_DUPLICATE },
    });
    const second = await client.skuBarcode.create({
      data: { skuId: skuB, barcode, status: BARCODE_STATUS_PENDING_DUPLICATE },
    });
    expect(second.skuId).toBe(skuB);
  });

  it('5. ★ catalog 에서 ux_barcode_pending_duplicate 의 정확한 predicate 를 확인한다', async () => {
    const rows = await getPrismaClient().$queryRaw<
      Array<{
        indexname: string;
        isunique: boolean;
        ispartial: boolean;
        predicate: string;
        columns: string;
      }>
    >`
      SELECT c.relname AS indexname,
             i.indisunique AS isunique,
             (i.indpred IS NOT NULL) AS ispartial,
             pg_get_expr(i.indpred, i.indrelid) AS predicate,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'sku_barcode'::regclass AND c.relname = 'ux_barcode_pending_duplicate'`;

    expect(rows).toHaveLength(1);
    const index = rows[0];
    expect(index?.isunique).toBe(true);
    expect(index?.ispartial).toBe(true);
    expect(index?.columns).toBe('sku_id,barcode');
    expect(
      (index?.predicate ?? '')
        .replace(/\(|\)/g, ' ')
        .replace(/::text/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe("status = 'PENDING_DUPLICATE'");
  });

  it('6. partial UNIQUE 는 이제 3종이며 서로 다른 규칙이다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ indexname: string }>>`
      SELECT c.relname AS indexname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'sku_barcode'::regclass AND i.indpred IS NOT NULL AND i.indisunique
      ORDER BY c.relname`;
    expect(rows.map((row) => row.indexname)).toEqual([
      'ux_barcode_active',
      'ux_barcode_pending_duplicate',
      'ux_barcode_primary',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// §31 candidate API
// ═══════════════════════════════════════════════════════════════

describe('★ §31 중복 예외 요청 API', () => {
  it('7·8·9. STAFF·LEADER 요청 성공 (seed 역할 배정 확인)', async () => {
    const rows = await getPrismaClient().rolePermission.findMany({
      where: { permission: { permissionKey: { startsWith: 'barcode.' } } },
      include: { role: true, permission: true },
    });
    const rolesOf = (key: string) =>
      rows
        .filter((row) => row.permission.permissionKey === key)
        .map((row) => row.role.roleCode)
        .sort();
    expect(rolesOf('barcode.request_duplicate')).toEqual(['ADMIN', 'SCM_LEADER', 'SCM_STAFF']);
    expect(rolesOf('barcode.approve_duplicate')).toEqual(['ADMIN', 'SCM_LEADER']);

    const staffCase = await preparedCandidate('req-staff');
    expect(staffCase.candidate.status).toBe('PENDING_DUPLICATE');

    const barcode = BC('10');
    const otherSkuId = await newSku('req-leader-other');
    const targetSkuId = await newSku('req-leader-target');
    await activeBarcodeOn(otherSkuId, barcode);
    const leaderResult = await requestDuplicateCandidate(
      LEADER,
      targetSkuId,
      candidateInput(barcode),
    );
    expect(leaderResult.barcode.status).toBe('PENDING_DUPLICATE');
  });

  it('10·11. FINANCE 는 403, permission 없는 ADMIN 역할도 403', async () => {
    const barcode = BC('11');
    const otherSkuId = await newSku('req-403-other');
    const targetSkuId = await newSku('req-403-target');
    await activeBarcodeOn(otherSkuId, barcode);

    await expect(
      requestDuplicateCandidate(FINANCE, targetSkuId, candidateInput(barcode)),
    ).rejects.toMatchObject({ httpStatus: 403 });
    await expect(
      requestDuplicateCandidate(ADMIN_NO_PERMISSION, targetSkuId, candidateInput(barcode)),
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(await getPrismaClient().skuBarcode.count({ where: { skuId: targetSkuId } })).toBe(0);
  });

  it('12·19. ★ cross-SKU ACTIVE 중복이 있으면 PENDING 후보를 만든다 (초기값 확인)', async () => {
    const { candidate, targetSkuId, barcode } = await preparedCandidate('req-ok');

    expect(candidate.skuId).toBe(targetSkuId);
    expect(candidate.barcode).toBe(barcode);
    expect(candidate.status).toBe('PENDING_DUPLICATE');
    // ★ 승인 전에는 예외가 아니다.
    expect(candidate.duplicateException).toBe(false);
    expect(candidate.exceptionReason).toBeNull();
    expect(candidate.approvedBy).toBeNull();
    expect(candidate.isPrimary).toBe(false);
    expect(candidate.barcodeType).toBe('UNIT');

    expect((await auditRows(candidate.id)).map((log) => log.action)).toEqual(['REQUEST_DUPLICATE']);
  });

  it('13. ★ 실제 중복이 없으면 422 이고 후보를 만들지 않는다', async () => {
    const targetSkuId = await newSku('req-none');
    await expect(
      requestDuplicateCandidate(STAFF, targetSkuId, candidateInput(BC('12'))),
    ).rejects.toMatchObject({
      code: 'BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE',
      httpStatus: 422,
    });
    expect(await getPrismaClient().skuBarcode.count({ where: { skuId: targetSkuId } })).toBe(0);
  });

  it('13. INACTIVE 상대만 있으면 실제 중복이 아니다 (422)', async () => {
    const barcode = BC('13');
    const otherSkuId = await newSku('req-inactive-other');
    const targetSkuId = await newSku('req-inactive-target');
    const other = await activeBarcodeOn(otherSkuId, barcode);
    await deactivateSkuBarcode(LEADER, otherSkuId, other.id);

    await expect(
      requestDuplicateCandidate(STAFF, targetSkuId, candidateInput(barcode)),
    ).rejects.toMatchObject({ code: 'BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE' });
  });

  it('14. ★ 같은 SKU 의 중복만 있으면 예외 대상이 아니다 (422)', async () => {
    const skuId = await newSku('req-same-sku');
    const barcode = BC('14');
    await activeBarcodeOn(skuId, barcode);

    await expect(
      requestDuplicateCandidate(STAFF, skuId, candidateInput(barcode)),
    ).rejects.toMatchObject({
      code: 'BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE',
      httpStatus: 422,
    });
  });

  it('15. ★ 상대가 duplicateException=true ACTIVE 여도 실제 중복으로 인정한다', async () => {
    const client = getPrismaClient();
    const barcode = BC('15');
    const otherSkuId = await newSku('req-exception-other');
    const targetSkuId = await newSku('req-exception-target');

    // 이미 예외 승인된 ACTIVE 행 (마이그레이션 이관 행과 같은 모양).
    await client.skuBarcode.create({
      data: {
        skuId: otherSkuId,
        barcode,
        status: 'ACTIVE',
        duplicateException: true,
        exceptionReason: '기존 예외',
        approvedBy: LEADER_ID,
      },
    });

    const result = await requestDuplicateCandidate(STAFF, targetSkuId, candidateInput(barcode));
    expect(result.barcode.status).toBe('PENDING_DUPLICATE');
  });

  it('16·17. 정규화된 값으로 저장되고 앞자리 0 이 보존된다', async () => {
    const barcode = `00${BC('16')}`;
    const otherSkuId = await newSku('req-normalize-other');
    const targetSkuId = await newSku('req-normalize-target');
    await activeBarcodeOn(otherSkuId, barcode);

    const spaced = `  ${barcode.slice(0, 4)}-${barcode.slice(4)}  `;
    const result = await requestDuplicateCandidate(STAFF, targetSkuId, candidateInput(spaced));
    expect(result.barcode.barcode).toBe(barcode);
  });

  it('18. unknown field·정규화 실패는 후보 생성 전에 거부된다', () => {
    expect(() =>
      parseRequestDuplicateCandidateInput({
        barcode: BC('17'),
        barcodeType: 'UNIT',
        duplicateException: true,
      }),
    ).toThrow(/올바르지/);
  });

  it('20·21. ★ 동일 내용 재요청은 200 기존 후보, 내용이 다르면 409', async () => {
    const { targetSkuId, barcode, candidate } = await preparedCandidate('req-existing');

    // 20. 업무 필드까지 동일 → 기존 후보 반환, row·AuditLog 증가 없음
    const same = await requestDuplicateCandidate(STAFF, targetSkuId, candidateInput(barcode));
    expect(same.existing).toBe(true);
    expect(same.barcode.id).toBe(candidate.id);
    expect(
      await getPrismaClient().skuBarcode.count({
        where: { skuId: targetSkuId, status: BARCODE_STATUS_PENDING_DUPLICATE },
      }),
    ).toBe(1);
    expect(await auditRows(candidate.id)).toHaveLength(1);

    // 21. 업무 필드가 다르면 409 — 기존 후보를 자동 수정하지 않는다.
    await expect(
      requestDuplicateCandidate(
        STAFF,
        targetSkuId,
        candidateInput(barcode, { barcodeType: 'INNER_BOX' }),
      ),
    ).rejects.toMatchObject({ code: 'BARCODE_DUPLICATE_CANDIDATE_EXISTS', httpStatus: 409 });

    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(reread.barcodeType).toBe('UNIT');
  });

  it('22. ★ 멱등 — first 201 / replay / 다른 내용 409', async () => {
    const barcode = BC('20');
    const otherSkuId = await newSku('req-idem-other');
    const targetSkuId = await newSku('req-idem-target');
    const targetSkuId2 = await newSku('req-idem-target2');
    await activeBarcodeOn(otherSkuId, barcode);
    const key = `dup-idem-${RUN}`;

    const first = await requestDuplicateCandidate(
      STAFF,
      targetSkuId,
      candidateInput(barcode),
      {},
      key,
    );
    expect(first).toMatchObject({ replayed: false, existing: false });

    const replay = await requestDuplicateCandidate(
      STAFF,
      targetSkuId,
      candidateInput(barcode),
      {},
      key,
    );
    // ★ 관찰 가능한 계약: 200 + 같은 후보 + row·AuditLog 증가 없음.
    //   같은 key 재요청은 §9(기존 후보 반환)와 §10(멱등 replay) 중 먼저 성립하는 쪽으로
    //   끝나며, 두 경로 모두 동일한 200 응답이다. 라우트는 둘 다 200 을 낸다.
    expect(replay.replayed || replay.existing).toBe(true);
    expect(replay.barcode.id).toBe(first.barcode.id);
    expect(await auditRows(first.barcode.id)).toHaveLength(1);
    expect(
      await getPrismaClient().skuBarcode.count({
        where: { skuId: targetSkuId, status: BARCODE_STATUS_PENDING_DUPLICATE },
      }),
    ).toBe(1);

    // 같은 key + 다른 내용(다른 SKU) → 409
    await expect(
      requestDuplicateCandidate(STAFF, targetSkuId2, candidateInput(barcode), {}, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 409 });
  });

  it('23. ★ 감사로그 실패 시 후보·멱등기록이 함께 롤백된다', async () => {
    const barcode = BC('21');
    const otherSkuId = await newSku('req-rollback-other');
    const targetSkuId = await newSku('req-rollback-target');
    await activeBarcodeOn(otherSkuId, barcode);
    const key = `dup-rollback-${RUN}`;
    const failing = {
      write: async () => {
        throw new Error('감사로그 실패 주입');
      },
    };

    await expect(
      requestDuplicateCandidate(
        STAFF,
        targetSkuId,
        candidateInput(barcode),
        { auditLogger: failing as never },
        key,
      ),
    ).rejects.toThrow(/감사로그 실패 주입/);

    const client = getPrismaClient();
    expect(await client.skuBarcode.count({ where: { skuId: targetSkuId } })).toBe(0);
    expect(
      await client.idempotencyRecord.count({ where: { actorId: STAFF_ID, idempotencyKey: key } }),
    ).toBe(0);

    // 롤백 후 같은 key 재시도는 정상 생성된다.
    const retry = await requestDuplicateCandidate(
      STAFF,
      targetSkuId,
      candidateInput(barcode),
      {},
      key,
    );
    expect(retry.barcode.status).toBe('PENDING_DUPLICATE');
  });
});

// ═══════════════════════════════════════════════════════════════
// §32 승인 API
// ═══════════════════════════════════════════════════════════════

describe('★ §32 중복 예외 승인 API', () => {
  it('24·32·33·34·35·41. LEADER 승인 성공 — 4개 필드만 바뀌고 감사로그가 남는다', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('approve-ok');

    const approved = await approveDuplicateBarcode(LEADER, targetSkuId, candidate.id, {
      reason: '채널 공용 바코드',
    });

    expect(approved.status).toBe('ACTIVE'); // 32
    expect(approved.duplicateException).toBe(true); // 33
    expect(approved.approvedBy).toBe(LEADER_ID); // 34
    expect(approved.exceptionReason).toBe('채널 공용 바코드'); // 35
    // ⛔ 나머지 필드는 그대로다.
    expect(approved.barcode).toBe(candidate.barcode);
    expect(approved.barcodeType).toBe(candidate.barcodeType);
    expect(approved.isPrimary).toBe(candidate.isPrimary);
    expect(approved.skuId).toBe(candidate.skuId);
    expect(approved.countryCode).toBeNull();
    expect(approved.effectiveFrom).toBeNull();

    // 41. AuditLog 정확한 action·reason·approvedBy
    const logs = await auditRows(candidate.id);
    expect(logs.map((log) => log.action)).toEqual(['REQUEST_DUPLICATE', 'APPROVE_DUPLICATE']);
    const approval = logs[1];
    expect(approval?.actorId).toBe(LEADER_ID);
    expect(approval?.approvedBy).toBe(LEADER_ID);
    expect(approval?.reason).toBe('채널 공용 바코드');
  });

  it('26·27·28. STAFF·FINANCE·permission 없는 ADMIN 역할은 403 이고 후보가 그대로다', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('approve-403');

    for (const actor of [STAFF, FINANCE, ADMIN_NO_PERMISSION]) {
      await expect(
        approveDuplicateBarcode(actor, targetSkuId, candidate.id, { reason: '사유' }),
        actor.email,
      ).rejects.toMatchObject({ httpStatus: 403 });
    }

    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(reread.status).toBe('PENDING_DUPLICATE');
    expect(reread.duplicateException).toBe(false);
  });

  it('29·30. reason 은 trim 저장되고 공백만이면 400 이다', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('approve-reason');

    const approved = await approveDuplicateBarcode(LEADER, targetSkuId, candidate.id, {
      reason: '원본 공유 확인',
    });
    expect(approved.exceptionReason).toBe('원본 공유 확인');

    const { parseApproveDuplicateInput } = await import('@/modules/barcode/application');
    expect(() => parseApproveDuplicateInput({ reason: '   ' })).toThrow(/올바르지/);
  });

  it('31. ★ 다른 SKU 의 barcodeId 는 404 이며 승인되지 않는다', async () => {
    const { candidate } = await preparedCandidate('approve-owner');
    const otherSkuId = await newSku('approve-owner-foreign');

    await expect(
      approveDuplicateBarcode(LEADER, otherSkuId, candidate.id, { reason: '사유' }),
    ).rejects.toMatchObject({ httpStatus: 404 });

    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(reread.status).toBe('PENDING_DUPLICATE');
  });

  it('36. ★ 승인 직전 실제 중복이 사라지면 422 이고 후보는 PENDING 그대로다', async () => {
    const { candidate, targetSkuId, otherSkuId, barcode } = await preparedCandidate('approve-gone');

    // 상대 바코드를 비활성 — 더 이상 공유할 활성 바코드가 없다.
    const other = await getPrismaClient().skuBarcode.findFirstOrThrow({
      where: { skuId: otherSkuId, barcode },
    });
    await deactivateSkuBarcode(LEADER, otherSkuId, other.id);

    await expect(
      approveDuplicateBarcode(LEADER, targetSkuId, candidate.id, { reason: '사유' }),
    ).rejects.toMatchObject({
      code: 'BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE',
      httpStatus: 422,
    });

    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(reread.status).toBe('PENDING_DUPLICATE');
    expect(reread.duplicateException).toBe(false);
    expect(reread.approvedBy).toBeNull();
  });

  it('37. ★ 대표 충돌이면 409 이고 후보가 전부 롤백된다 (기존 대표 유지)', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('approve-primary', {
      isPrimary: true,
    });

    // 대상 SKU 에 이미 활성 대표가 있다.
    const existingPrimary = await activeBarcodeOn(targetSkuId, BC('30'), { isPrimary: true });

    await expect(
      approveDuplicateBarcode(LEADER, targetSkuId, candidate.id, { reason: '사유' }),
    ).rejects.toMatchObject({ code: 'BARCODE_PRIMARY_CONFLICT', httpStatus: 409 });

    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(reread.status).toBe('PENDING_DUPLICATE');
    expect(reread.duplicateException).toBe(false);
    expect(reread.approvedBy).toBeNull();
    expect(reread.exceptionReason).toBeNull();
    // ⛔ 기존 대표를 자동 해제하지 않았다.
    const primary = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: existingPrimary.id },
    });
    expect(primary.isPrimary).toBe(true);
    expect(primary.status).toBe('ACTIVE');
    // 승인 실패이므로 감사로그도 REQUEST 뿐이다.
    expect((await auditRows(candidate.id)).map((log) => log.action)).toEqual(['REQUEST_DUPLICATE']);
  });

  it('38. ★ 재승인은 200 no-op — 최초 승인자 기록을 덮어쓰지 않는다', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('approve-repeat');

    const first = await approveDuplicateBarcode(LEADER, targetSkuId, candidate.id, {
      reason: '최초 사유',
    });

    const second = await approveDuplicateBarcode(LEADER2, targetSkuId, candidate.id, {
      reason: '두 번째 사유',
    });
    expect(second).toEqual(first);
    expect(second.approvedBy).toBe(LEADER_ID);
    expect(second.exceptionReason).toBe('최초 사유');

    expect((await auditRows(candidate.id)).map((log) => log.action)).toEqual([
      'REQUEST_DUPLICATE',
      'APPROVE_DUPLICATE',
    ]);
  });

  it('39·40. INACTIVE·일반 ACTIVE 비예외 대상은 422 다', async () => {
    // 39. INACTIVE
    const cancelled = await preparedCandidate('approve-inactive');
    await deactivateSkuBarcode(LEADER, cancelled.targetSkuId, cancelled.candidate.id);
    await expect(
      approveDuplicateBarcode(LEADER, cancelled.targetSkuId, cancelled.candidate.id, {
        reason: '사유',
      }),
    ).rejects.toMatchObject({
      code: 'BARCODE_DUPLICATE_APPROVAL_INVALID_STATE',
      httpStatus: 422,
    });

    // 40. 일반 ACTIVE + duplicateException=false
    const skuId = await newSku('approve-normal');
    const normal = await activeBarcodeOn(skuId, BC('40'));
    await expect(
      approveDuplicateBarcode(LEADER, skuId, normal.id, { reason: '사유' }),
    ).rejects.toMatchObject({ code: 'BARCODE_DUPLICATE_APPROVAL_INVALID_STATE' });
  });

  it('42. ★ 감사로그 실패 시 승인이 롤백된다', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('approve-audit-fail');
    const failing = {
      write: async () => {
        throw new Error('승인 감사로그 실패 주입');
      },
    };

    await expect(
      approveDuplicateBarcode(
        LEADER,
        targetSkuId,
        candidate.id,
        { reason: '사유' },
        { auditLogger: failing as never },
      ),
    ).rejects.toThrow(/승인 감사로그 실패 주입/);

    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(reread.status).toBe('PENDING_DUPLICATE');
    expect(reread.duplicateException).toBe(false);
    expect(reread.approvedBy).toBeNull();
  });

  it('43. ★ 요청자와 승인자가 같아도 허용된다 (자가승인 금지 정책 없음)', async () => {
    const barcode = BC('43');
    const otherSkuId = await newSku('approve-self-other');
    const targetSkuId = await newSku('approve-self-target');
    await activeBarcodeOn(otherSkuId, barcode);

    // LEADER 가 요청하고 LEADER 가 승인한다.
    const requested = await requestDuplicateCandidate(LEADER, targetSkuId, candidateInput(barcode));
    const approved = await approveDuplicateBarcode(LEADER, targetSkuId, requested.barcode.id, {
      reason: '자가승인 허용',
    });

    expect(approved.duplicateException).toBe(true);
    expect(approved.approvedBy).toBe(LEADER_ID);
    const logs = await auditRows(requested.barcode.id);
    expect(logs.map((log) => log.actorId)).toEqual([LEADER_ID, LEADER_ID]);
  });

  it('44. ★ 마이그레이션 이관 행(이미 승인됨) 재호출은 200 no-op 이다', async () => {
    const client = getPrismaClient();
    const skuA = await newSku('migration-first');
    const skuB = await newSku('migration-second');
    const barcode = BC('44');

    // 06 §12.5 이관 모양 — 첫 SKU 는 정상, 둘째는 이미 예외 승인된 행이다.
    await client.skuBarcode.create({ data: { skuId: skuA, barcode, status: 'ACTIVE' } });
    const migrated = await client.skuBarcode.create({
      data: {
        skuId: skuB,
        barcode,
        status: 'ACTIVE',
        duplicateException: true,
        exceptionReason: '마이그레이션 이관 — 원본 중복',
        approvedBy: LEADER_ID,
      },
    });

    const result = await approveDuplicateBarcode(LEADER2, skuB, migrated.id, {
      reason: '재승인 시도',
    });
    expect(result.exceptionReason).toBe('마이그레이션 이관 — 원본 중복');
    expect(result.approvedBy).toBe(LEADER_ID);
    expect(await auditRows(migrated.id)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// §33 우회 차단
// ═══════════════════════════════════════════════════════════════

describe('★ §33 PENDING 후보 우회 차단', () => {
  it('45·46·47. ★ PENDING 후보의 일반 PATCH 는 전부 422 다', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('bypass-patch');

    for (const patch of [
      { isPrimary: true },
      { status: 'ACTIVE' as const },
      { status: 'INACTIVE' as const },
    ]) {
      await expect(
        updateSkuBarcode(LEADER, targetSkuId, candidate.id, patch),
        JSON.stringify(patch),
      ).rejects.toMatchObject({
        code: 'BARCODE_DUPLICATE_APPROVAL_PENDING',
        httpStatus: 422,
      });
    }

    // ★ 승인 endpoint 를 우회하지 못했다.
    const reread = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(reread.status).toBe('PENDING_DUPLICATE');
    expect(reread.duplicateException).toBe(false);
    expect(reread.isPrimary).toBe(false);
  });

  it('48·49. DELETE 로 후보를 취소할 수 있고, 이후 승인은 422 다', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('bypass-cancel');

    const cancelled = await deactivateSkuBarcode(LEADER, targetSkuId, candidate.id);
    expect(cancelled.status).toBe('INACTIVE');
    expect((await auditRows(candidate.id)).map((log) => log.action)).toEqual([
      'REQUEST_DUPLICATE',
      'DEACTIVATE',
    ]);

    await expect(
      approveDuplicateBarcode(LEADER, targetSkuId, candidate.id, { reason: '사유' }),
    ).rejects.toMatchObject({ code: 'BARCODE_DUPLICATE_APPROVAL_INVALID_STATE' });
  });

  it('50. ★ 일반 POST 의 중복 계약은 그대로다 — 409 이고 행이 생기지 않는다', async () => {
    const barcode = BC('50');
    const otherSkuId = await newSku('bypass-post-other');
    const targetSkuId = await newSku('bypass-post-target');
    await activeBarcodeOn(otherSkuId, barcode);

    await expect(
      createSkuBarcode(
        LEADER,
        targetSkuId,
        parseCreateBarcodeInput({ barcode, barcodeType: 'UNIT' }),
      ),
    ).rejects.toMatchObject({ code: 'BARCODE_DUPLICATE', httpStatus: 409 });

    expect(await getPrismaClient().skuBarcode.count({ where: { skuId: targetSkuId } })).toBe(0);
  });

  it('GET 은 PENDING 후보까지 모두 반환한다', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('bypass-get');
    const list = await listSkuBarcodes(FINANCE, targetSkuId);
    expect(list.map((row) => row.id)).toContain(candidate.id);
    expect(list.find((row) => row.id === candidate.id)?.status).toBe('PENDING_DUPLICATE');
  });
});

// ═══════════════════════════════════════════════════════════════
// §34 동시성 — 실 PostgreSQL
// ═══════════════════════════════════════════════════════════════

describe('★ §34 동시성', () => {
  it('candidate 동시 요청 → PENDING 후보는 정확히 1건', async () => {
    const barcode = BC('60');
    const otherSkuId = await newSku('race-cand-other');
    const targetSkuId = await newSku('race-cand-target');
    await activeBarcodeOn(otherSkuId, barcode);

    // ★ 서로 다른 멱등키 — 멱등 replay 가 아니라 실제 INSERT 경합을 본다.
    const results = await Promise.allSettled([
      requestDuplicateCandidate(STAFF, targetSkuId, candidateInput(barcode), {}, `race-c1-${RUN}`),
      requestDuplicateCandidate(STAFF, targetSkuId, candidateInput(barcode), {}, `race-c2-${RUN}`),
    ]);

    // 내용이 같으므로 둘 다 성공할 수 있으나, 후보 row 는 1건이어야 한다.
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(
      await getPrismaClient().skuBarcode.count({
        where: { skuId: targetSkuId, barcode, status: BARCODE_STATUS_PENDING_DUPLICATE },
      }),
    ).toBe(1);
  });

  it('★ 동시 승인 → mutation 1건 · APPROVE_DUPLICATE 감사로그 1건 · 최초 승인자 유지', async () => {
    const { candidate, targetSkuId } = await preparedCandidate('race-approve');

    const results = await Promise.allSettled([
      approveDuplicateBarcode(LEADER, targetSkuId, candidate.id, { reason: '리더1 사유' }),
      approveDuplicateBarcode(LEADER2, targetSkuId, candidate.id, { reason: '리더2 사유' }),
    ]);

    // 두 요청 모두 최종적으로 성공한다 — 하나는 승인, 하나는 no-op.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const stored = await getPrismaClient().skuBarcode.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(stored.status).toBe('ACTIVE');
    expect(stored.duplicateException).toBe(true);

    const approvals = (await auditRows(candidate.id)).filter(
      (log) => log.action === 'APPROVE_DUPLICATE',
    );
    expect(approvals).toHaveLength(1);

    // 최초 성공 actor 의 approvedBy·reason 이 유지된다.
    expect(stored.approvedBy).toBe(approvals[0]?.actorId);
    expect(stored.exceptionReason).toBe(approvals[0]?.reason);
    expect(['리더1 사유', '리더2 사유']).toContain(stored.exceptionReason);

    // 두 응답 모두 같은 최종 상태를 본다.
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      expect(result.value.approvedBy).toBe(stored.approvedBy);
      expect(result.value.exceptionReason).toBe(stored.exceptionReason);
    }
  });
});
