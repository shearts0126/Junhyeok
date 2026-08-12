import { randomBytes, randomInt } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  BARCODE_CREATE_PERMISSION,
  BARCODE_DEACTIVATE_PERMISSION,
  BARCODE_READ_PERMISSION,
  BARCODE_REQUEST_DUPLICATE_PERMISSION,
  BARCODE_UPDATE_PERMISSION,
  createSkuBarcode,
  deactivateSkuBarcode,
  parseCreateBarcodeInput,
  parseRequestDuplicateCandidateInput,
  requestDuplicateCandidate,
  updateSkuBarcode,
} from '@/modules/barcode/application';
import {
  EXTERNAL_MAPPING_CREATE_PERMISSION,
  createExternalMapping,
  parseCreateMappingInput,
} from '@/modules/external-mapping/application';
import {
  SKU_CREATE_PERMISSION,
  SKU_HISTORY_PAGE_SIZE,
  SKU_READ_PERMISSION,
  SKU_SUBMIT_PERMISSION,
  SKU_UPDATE_PERMISSION,
  createSku,
  listSkuHistory,
  parseCreateSkuInput,
  parseUpdateSkuInput,
  submitSku,
  updateSku,
} from '@/modules/sku/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * SKU 변경이력 조회 DB 테스트 (T1-6B3) — 실제 PostgreSQL.
 *
 * 계약 근거는 `docs/16_설계복구_SKU상세잔여탭.md` §27~§40 뿐이다.
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - 실제 producer 가 쓴 감사로그를 그대로 읽어오는지 (entity 범위)
 *   - `Sku` + 그 SKU 의 `SkuBarcode` **만** 나오는지 (매핑·타 SKU 제외)
 *   - `occurredAt DESC, id DESC` 정렬과 DB-level pagination·`total`
 *   - read-only — 조회가 감사로그를 만들지 않는지
 */

const RUN = randomBytes(4).toString('hex');
const NUM = String(randomInt(100_000, 999_999));
const SKU_CODE = (suffix: string) => `THX-${RUN}-${suffix}`;

const ACTOR_ID = 'cccccccc-0000-4000-8000-0000000c1001';
const READER_ID = 'cccccccc-0000-4000-8000-0000000c1002';
const NOPERM_ID = 'cccccccc-0000-4000-8000-0000000c1003';
const ACTOR_IDS = [ACTOR_ID, READER_ID, NOPERM_ID];

/** 이력을 만드는 actor — SKU·바코드·매핑 쓰기 권한을 전부 갖는다. */
const WRITER: ActorContext = createActorContext({
  userId: ACTOR_ID,
  email: 'hist-writer@deeppoint.test',
  name: '작성자',
  active: true,
  roles: ['ADMIN'],
  permissions: [
    SKU_READ_PERMISSION,
    SKU_CREATE_PERMISSION,
    SKU_UPDATE_PERMISSION,
    SKU_SUBMIT_PERMISSION,
    BARCODE_READ_PERMISSION,
    BARCODE_CREATE_PERMISSION,
    BARCODE_UPDATE_PERMISSION,
    BARCODE_DEACTIVATE_PERMISSION,
    BARCODE_REQUEST_DUPLICATE_PERMISSION,
    EXTERNAL_MAPPING_CREATE_PERMISSION,
  ],
  requestId: 'req-hist-writer',
});

/** `sku.read` 만 — 변경이력 조회에 필요한 최소 권한이다. */
const READER: ActorContext = createActorContext({
  userId: READER_ID,
  email: 'hist-reader@deeppoint.test',
  name: '조회자',
  active: true,
  roles: ['EXECUTIVE'],
  permissions: [SKU_READ_PERMISSION],
  requestId: 'req-hist-reader',
});

/** ADMIN 역할이지만 RolePermission 행이 없다 — ADMIN bypass 부재 증명. */
const ADMIN_NO_PERMISSION: ActorContext = createActorContext({
  userId: NOPERM_ID,
  email: 'hist-noperm@deeppoint.test',
  name: '권한없는 관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: [],
  requestId: 'req-hist-noperm',
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
  await client.skuExternalMapping.deleteMany({
    where: { sku: { skuCode: { startsWith: 'THX-' } } },
  });
  await client.externalSystem.deleteMany({ where: { systemCode: { startsWith: 'THX-' } } });
  await client.skuBarcode.deleteMany({ where: { sku: { skuCode: { startsWith: 'THX-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'THX-' } } });
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
      { id: ACTOR_ID, email: 'hist-writer@deeppoint.test', name: '작성자' },
      { id: READER_ID, email: 'hist-reader@deeppoint.test', name: '조회자' },
      { id: NOPERM_ID, email: 'hist-noperm@deeppoint.test', name: '권한없는 관리자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

/** 실제 서비스로 SKU 를 만든다 — 그래야 `CREATE` 감사로그가 함께 생긴다. */
async function newSku(label: string): Promise<string> {
  skuSeq += 1;
  const result = await createSku(
    WRITER,
    parseCreateSkuInput({
      skuCode: SKU_CODE(String(skuSeq).padStart(3, '0')),
      skuName: `이력 SKU (${label})`,
      itemType: 'FINISHED_GOOD',
    }),
  );
  return result.sku.id;
}

const barcodeValue = (suffix: string) => `${NUM}${suffix}`;

// ═══════════════════════════════════════════════════════════════
// 권한 · 부모
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 · 부모 SKU', () => {
  it('1. `sku.read` 만 있어도 조회할 수 있다', async () => {
    const skuId = await newSku('read');
    const result = await listSkuHistory(READER, skuId, { page: 1 });
    expect(result.total).toBeGreaterThan(0);
  });

  it('2. ★ 권한이 없으면 403 — ADMIN 역할이어도 bypass 가 없다', async () => {
    const skuId = await newSku('noperm');
    await expect(listSkuHistory(ADMIN_NO_PERMISSION, skuId, { page: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('3. ★ 존재하지 않는 SKU 는 404 다 (빈 이력으로 위장하지 않는다)', async () => {
    await expect(
      listSkuHistory(READER, '00000000-0000-4000-8000-000000000000', { page: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('4. 잘못된 UUID 는 400 이다', async () => {
    await expect(listSkuHistory(READER, 'not-a-uuid', { page: 1 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('5. ★ 감사로그가 0건이면 200 · items=[] · total=0 · totalPages=0', async () => {
    // 서비스가 아니라 직접 INSERT 해 감사로그 없는 SKU 를 만든다.
    skuSeq += 1;
    const row = await getPrismaClient().sku.create({
      data: {
        skuCode: SKU_CODE(`E${String(skuSeq).padStart(3, '0')}`),
        skuName: '이력 없는 SKU',
        itemType: 'FINISHED_GOOD',
      },
      select: { id: true },
    });

    const result = await listSkuHistory(READER, row.id, { page: 1 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    // ★ 1 로 올리지 않는다.
    expect(result.totalPages).toBe(0);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(SKU_HISTORY_PAGE_SIZE);
  });
});

// ═══════════════════════════════════════════════════════════════
// entity 범위
// ═══════════════════════════════════════════════════════════════

describe('★ entity 범위 — Sku + 그 SKU 의 SkuBarcode 뿐', () => {
  it('6·7·8. SKU CREATE·UPDATE·SUBMIT 이 모두 포함된다', async () => {
    const skuId = await newSku('sku-actions');
    await updateSku(WRITER, skuId, parseUpdateSkuInput({ skuName: '수정된 이름' }));
    await submitSku(WRITER, skuId, {});

    const result = await listSkuHistory(READER, skuId, { page: 1 });
    const actions = result.items
      .filter((item) => item.entityType === 'Sku')
      .map((item) => item.action);
    expect(actions).toContain('CREATE');
    expect(actions).toContain('UPDATE');
    expect(actions).toContain('SUBMIT');
  });

  it('9·10. ★ 해당 SKU 바코드의 CREATE·UPDATE·DEACTIVATE 가 포함된다', async () => {
    const skuId = await newSku('barcode-actions');
    const created = await createSkuBarcode(
      WRITER,
      skuId,
      parseCreateBarcodeInput({ barcode: barcodeValue('01'), barcodeType: 'UNIT' }),
    );
    if (created.kind !== 'CREATED') throw new Error('CREATED 결과가 아니다');
    await updateSkuBarcode(WRITER, skuId, created.barcode.id, { isPrimary: true });
    await deactivateSkuBarcode(WRITER, skuId, created.barcode.id);

    const result = await listSkuHistory(READER, skuId, { page: 1 });
    const barcodeItems = result.items.filter((item) => item.entityType === 'SkuBarcode');
    expect(barcodeItems.map((item) => item.action).sort()).toEqual([
      'CREATE',
      'DEACTIVATE',
      'UPDATE',
    ]);
    // ★ INACTIVE 로 내려간 바코드의 과거 이력도 그대로 남는다.
    expect(barcodeItems.every((item) => item.entityId === created.barcode.id)).toBe(true);
  });

  it('11. ★ REQUEST_DUPLICATE 도 포함된다', async () => {
    const otherSkuId = await newSku('dup-other');
    const targetSkuId = await newSku('dup-target');
    const shared = barcodeValue('77');
    await createSkuBarcode(
      WRITER,
      otherSkuId,
      parseCreateBarcodeInput({ barcode: shared, barcodeType: 'UNIT' }),
    );
    await requestDuplicateCandidate(
      WRITER,
      targetSkuId,
      parseRequestDuplicateCandidateInput({ barcode: shared, barcodeType: 'UNIT' }),
    );

    const result = await listSkuHistory(READER, targetSkuId, { page: 1 });
    expect(result.items.map((item) => item.action)).toContain('REQUEST_DUPLICATE');
  });

  it('12. ★ 다른 SKU 의 감사로그와 그 SKU 바코드 이력은 섞이지 않는다', async () => {
    const mine = await newSku('isolation-mine');
    const other = await newSku('isolation-other');
    const otherBarcode = await createSkuBarcode(
      WRITER,
      other,
      parseCreateBarcodeInput({ barcode: barcodeValue('88'), barcodeType: 'UNIT' }),
    );
    if (otherBarcode.kind !== 'CREATED') throw new Error('CREATED 결과가 아니다');

    const result = await listSkuHistory(READER, mine, { page: 1 });
    expect(result.items.every((item) => item.entityId !== other)).toBe(true);
    expect(result.items.every((item) => item.entityId !== otherBarcode.barcode.id)).toBe(true);
    // 내 SKU 의 CREATE 하나뿐이다.
    expect(result.total).toBe(1);
  });

  it('13. ★ SkuExternalMapping 이력은 포함되지 않는다', async () => {
    const skuId = await newSku('mapping-excluded');
    const system = await getPrismaClient().externalSystem.create({
      data: {
        systemCode: `THX-${RUN}-SYS`,
        systemName: '이력 테스트 외부시스템',
        systemType: 'ERP',
      },
      select: { id: true },
    });
    await createExternalMapping(
      WRITER,
      parseCreateMappingInput({
        skuId,
        externalSystemId: system.id,
        externalProductCode: `THX-${RUN}-CODE`,
      }),
    );

    // 매핑 감사로그는 실제로 만들어졌다.
    const mappingLogs = await getPrismaClient().auditLog.count({
      where: { entityType: 'SkuExternalMapping', actorId: ACTOR_ID },
    });
    expect(mappingLogs).toBeGreaterThan(0);

    // ★ 그런데 SKU 변경이력에는 나오지 않는다.
    const result = await listSkuHistory(READER, skuId, { page: 1 });
    expect(result.items.every((item) => item.entityType !== 'SkuExternalMapping')).toBe(true);
    expect(result.items.map((item) => item.entityType)).toEqual(['Sku']);
  });

  it('14. ★ CommonCode·SystemSetting 이력도 포함되지 않는다', async () => {
    const skuId = await newSku('other-entities');
    const result = await listSkuHistory(READER, skuId, { page: 1 });
    for (const item of result.items) {
      expect(['Sku', 'SkuBarcode']).toContain(item.entityType);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 정렬 · 페이지네이션
// ═══════════════════════════════════════════════════════════════

describe('★ 정렬 · 페이지네이션', () => {
  it('15. ★ occurredAt DESC 최신순이다', async () => {
    const skuId = await newSku('ordering');
    await updateSku(WRITER, skuId, parseUpdateSkuInput({ skuName: '두 번째' }));
    await updateSku(WRITER, skuId, parseUpdateSkuInput({ skuName: '세 번째' }));

    const result = await listSkuHistory(READER, skuId, { page: 1 });
    const times = result.items.map((item) => Date.parse(item.occurredAt));
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index - 1]!).toBeGreaterThanOrEqual(times[index]!);
    }
    // 가장 최근이 마지막 UPDATE 다.
    expect(result.items[0]?.action).toBe('UPDATE');
  });

  it('16. ★ occurredAt 동률에서도 id DESC 로 결정적이다', async () => {
    const skuId = await newSku('tie-breaker');
    const client = getPrismaClient();
    // 같은 occurredAt 을 강제로 심는다 — 트랜잭션 시각 동률의 재현이다.
    const sameMoment = new Date('2026-08-11T09:00:00.000Z');
    await client.auditLog.createMany({
      data: ['aaaa1111-0000-4000-8000-000000000001', 'aaaa1111-0000-4000-8000-000000000002'].map(
        (id) => ({
          id,
          entityType: 'Sku',
          entityId: skuId,
          action: 'UPDATE',
          actorId: ACTOR_ID,
          occurredAt: sameMoment,
        }),
      ),
    });

    const first = await listSkuHistory(READER, skuId, { page: 1 });
    const second = await listSkuHistory(READER, skuId, { page: 1 });
    expect(first.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));

    const tied = first.items.filter((item) => item.occurredAt === sameMoment.toISOString());
    expect(tied).toHaveLength(2);
    expect(tied[0]!.id > tied[1]!.id).toBe(true);
  });

  it('17·18. ★ total·totalPages 가 정확하고 DB 에서 페이징된다', async () => {
    const skuId = await newSku('pagination');
    const client = getPrismaClient();
    // CREATE 1건 + 아래 60건 = 61건 → 2페이지 (pageSize 50)
    await client.auditLog.createMany({
      data: Array.from({ length: 60 }, (_, index) => ({
        entityType: 'Sku',
        entityId: skuId,
        action: 'UPDATE',
        actorId: ACTOR_ID,
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })),
    });

    const page1 = await listSkuHistory(READER, skuId, { page: 1 });
    expect(page1.total).toBe(61);
    expect(page1.totalPages).toBe(2);
    expect(page1.items).toHaveLength(SKU_HISTORY_PAGE_SIZE);
    expect(page1.pageSize).toBe(50);

    const page2 = await listSkuHistory(READER, skuId, { page: 2 });
    expect(page2.page).toBe(2);
    expect(page2.items).toHaveLength(11);
    // 페이지 간 중복이 없다.
    const ids = new Set([...page1.items, ...page2.items].map((item) => item.id));
    expect(ids.size).toBe(61);
  });

  it('19. 범위를 넘는 page 는 빈 목록이다 (오류가 아니다)', async () => {
    const skuId = await newSku('overflow-page');
    const result = await listSkuHistory(READER, skuId, { page: 9 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(1);
    expect(result.page).toBe(9);
  });
});

// ═══════════════════════════════════════════════════════════════
// projection
// ═══════════════════════════════════════════════════════════════

describe('★ projection — 좁은 응답', () => {
  it('20·21. actorId·reason 이 포함되고 before/after 가 원형 그대로다', async () => {
    const skuId = await newSku('projection');
    await updateSku(WRITER, skuId, parseUpdateSkuInput({ skuName: '이름 변경' }));
    await submitSku(WRITER, skuId, { note: '승인 요청 메모' });

    const result = await listSkuHistory(READER, skuId, { page: 1 });

    const submit = result.items.find((item) => item.action === 'SUBMIT');
    expect(submit?.actorId).toBe(ACTOR_ID);
    // ★ SUBMIT 의 note 도 reason 컬럼에 저장된다 — 화면 라벨이 `사유/메모` 인 이유다.
    expect(submit?.reason).toBe('승인 요청 메모');

    const update = result.items.find((item) => item.action === 'UPDATE');
    expect((update?.beforeValue as { skuName?: string }).skuName).toBeDefined();
    expect((update?.afterValue as { skuName?: string }).skuName).toBe('이름 변경');

    const create = result.items.find((item) => item.action === 'CREATE');
    // ★ CREATE 의 before 는 저장된 JSON null 이다 — 화면은 `null` 로 표시한다.
    expect(create?.beforeValue).toBeNull();
    expect(create?.reason).toBeNull();
  });

  it('22. ★ approvedBy·requestId·sessionId·ipAddress 를 노출하지 않는다', async () => {
    const skuId = await newSku('no-metadata');
    const result = await listSkuHistory(READER, skuId, { page: 1 });
    const item = result.items[0]!;

    // 저장 자체는 되어 있다.
    const stored = await getPrismaClient().auditLog.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.requestId).toBe('req-hist-writer');

    // ★ 그런데 응답 projection 에는 없다.
    for (const forbidden of ['approvedBy', 'requestId', 'sessionId', 'ipAddress']) {
      expect(Object.keys(item), forbidden).not.toContain(forbidden);
    }
    expect(Object.keys(item).sort()).toEqual([
      'action',
      'actorId',
      'afterValue',
      'beforeValue',
      'entityId',
      'entityType',
      'id',
      'occurredAt',
      'reason',
    ]);
  });

  it('23. ★ 조회는 read-only 다 — 감사로그를 만들지 않는다', async () => {
    const skuId = await newSku('read-only');
    const client = getPrismaClient();
    const before = await client.auditLog.count({ where: { actorId: { in: ACTOR_IDS } } });

    await listSkuHistory(READER, skuId, { page: 1 });
    await listSkuHistory(READER, skuId, { page: 2 });

    const after = await client.auditLog.count({ where: { actorId: { in: ACTOR_IDS } } });
    expect(after).toBe(before);
  });
});
