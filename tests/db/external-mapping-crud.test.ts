import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  createExternalMapping,
  EXTERNAL_MAPPING_CREATE_PERMISSION,
  EXTERNAL_MAPPING_READ_PERMISSION,
  EXTERNAL_MAPPING_UPDATE_PERMISSION,
  listExternalMappings,
  parseCreateMappingInput,
  parseListMappingsQuery,
  parseUpdateMappingInput,
  updateExternalMapping,
} from '@/modules/external-mapping/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * 외부 상품 매핑 CRUD DB 테스트 (T05-2) — 실제 PostgreSQL.
 *
 * 계약 근거는 `docs/13_설계복구_외부상품매핑CRUD.md` 뿐이다.
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - T05-1 조건부 UNIQUE 2종의 실제 판정과 409 매핑(코드 중복 vs 대표 충돌)
 *   - `mappingStatus` server-derived 파생이 실 행에 저장되는지
 *   - 감사로그 실패 시 실 트랜잭션 롤백 (매핑·IdempotencyRecord 함께)
 *   - 실 동시 요청에서 DB partial UNIQUE 가 최종 방어선임
 *   - RolePermission seed 가 실제 DB 에 반영되어 권한 판정에 쓰임
 */

const RUN = randomBytes(4).toString('hex');
const SKU_CODE = (suffix: string) => `TXC-${RUN}-${suffix}`;
const SYS_CODE = (suffix: string) => `TXC-${RUN}-${suffix}`;
/** ★ 외부코드는 (system, code) 범위 UNIQUE 라 시스템만 유일하면 충분하다. */
const CODE = (suffix: string) => `P-${suffix}`;

const ADMIN_ID = 'aaaaaaa2-0000-4000-8000-00000000ce01';
const FINANCE_ID = 'aaaaaaa2-0000-4000-8000-00000000ce02';
const EXEC_ID = 'aaaaaaa2-0000-4000-8000-00000000ce03';
const NOPERM_ID = 'aaaaaaa2-0000-4000-8000-00000000ce04';
const ACTOR_IDS = [ADMIN_ID, FINANCE_ID, EXEC_ID, NOPERM_ID];

const ALL_PERMISSIONS = [
  EXTERNAL_MAPPING_READ_PERMISSION,
  EXTERNAL_MAPPING_CREATE_PERMISSION,
  EXTERNAL_MAPPING_UPDATE_PERMISSION,
];

const ADMIN: ActorContext = createActorContext({
  userId: ADMIN_ID,
  email: 'xmap-admin@deeppoint.test',
  name: '매핑 관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: ALL_PERMISSIONS,
  requestId: 'req-xmap-admin',
});

/** read 만 가진 역할 — 화면별 권한표의 FINANCE. */
const FINANCE: ActorContext = createActorContext({
  userId: FINANCE_ID,
  email: 'xmap-finance@deeppoint.test',
  name: '재무',
  active: true,
  roles: ['FINANCE'],
  permissions: [EXTERNAL_MAPPING_READ_PERMISSION],
  requestId: 'req-xmap-finance',
});

/** ★ EXECUTIVE 는 외부매핑에서 read 조차 없다 (docs/13 §11). */
const EXECUTIVE: ActorContext = createActorContext({
  userId: EXEC_ID,
  email: 'xmap-exec@deeppoint.test',
  name: '경영진',
  active: true,
  roles: ['EXECUTIVE'],
  permissions: [],
  requestId: 'req-xmap-exec',
});

/** ★ ADMIN 역할이지만 RolePermission 행이 없는 actor — ADMIN bypass 부재 증명. */
const ADMIN_NO_PERMISSION: ActorContext = createActorContext({
  userId: NOPERM_ID,
  email: 'xmap-noperm@deeppoint.test',
  name: '권한없는 관리자',
  active: true,
  roles: ['ADMIN'],
  permissions: [],
  requestId: 'req-xmap-noperm',
});

let skuSeq = 0;
let sysSeq = 0;

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
    where: { externalSystem: { systemCode: { startsWith: 'TXC-' } } },
  });
  await client.skuExternalMapping.deleteMany({
    where: { sku: { skuCode: { startsWith: 'TXC-' } } },
  });
  await client.externalSystem.deleteMany({ where: { systemCode: { startsWith: 'TXC-' } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TXC-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

async function newSku(label: string): Promise<string> {
  skuSeq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: SKU_CODE(String(skuSeq).padStart(3, '0')),
      skuName: `외부매핑 CRUD SKU (${label})`,
      itemType: 'FINISHED',
    },
    select: { id: true },
  });
  return row.id;
}

async function newSystem(label: string, active = true): Promise<string> {
  sysSeq += 1;
  const row = await getPrismaClient().externalSystem.create({
    data: {
      systemCode: SYS_CODE(String(sysSeq).padStart(3, '0')),
      systemName: `외부시스템 (${label})`,
      systemType: 'ERP',
      active,
    },
    select: { id: true },
  });
  return row.id;
}

function input(body: Record<string, unknown>) {
  return parseCreateMappingInput(body);
}

function patch(body: Record<string, unknown>) {
  return parseUpdateMappingInput(body);
}

beforeAll(async () => {
  await cleanup();
  await seedRolesAndPermissions(getPrismaClient());
  await getPrismaClient().user.createMany({
    data: [
      { id: ADMIN_ID, email: 'xmap-admin@deeppoint.test', name: '매핑 관리자' },
      { id: FINANCE_ID, email: 'xmap-finance@deeppoint.test', name: '재무' },
      { id: EXEC_ID, email: 'xmap-exec@deeppoint.test', name: '경영진' },
      { id: NOPERM_ID, email: 'xmap-noperm@deeppoint.test', name: '권한없는 관리자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

async function auditRows(entityId: string) {
  return getPrismaClient().auditLog.findMany({
    where: { entityType: 'SkuExternalMapping', entityId },
    orderBy: { occurredAt: 'asc' },
  });
}

// ═══════════════════════════════════════════════════════════════
// POST — 권한 · 참조 · 자동판정
// ═══════════════════════════════════════════════════════════════

describe('★ POST — 권한 (2겹 가드, ADMIN bypass 없음)', () => {
  it('1. 쓰기 권한이 있는 actor 는 생성할 수 있다', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('perm-ok'),
        externalSystemId: await newSystem('perm-ok'),
        externalProductCode: CODE('001'),
      }),
    );
    expect(result.replayed).toBe(false);
    expect(result.mapping.mappingStatus).toBe('MATCHED');
  });

  it('2. read 만 가진 FINANCE 는 생성이 거부된다', async () => {
    await expect(
      createExternalMapping(
        FINANCE,
        input({
          skuId: await newSku('perm-finance'),
          externalSystemId: await newSystem('perm-finance'),
          externalProductCode: CODE('002'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });

  it('2b. EXECUTIVE 는 조회조차 거부된다 (화면별 권한표 채택)', async () => {
    await expect(
      listExternalMappings(EXECUTIVE, parseListMappingsQuery(new URLSearchParams())),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });

  it('3. ★ ADMIN 역할이어도 RolePermission 이 없으면 거부된다', async () => {
    await expect(
      createExternalMapping(
        ADMIN_NO_PERMISSION,
        input({
          skuId: await newSku('perm-noperm'),
          externalSystemId: await newSystem('perm-noperm'),
          externalProductCode: CODE('003'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });

  it('3b. 시드된 external_mapping.read 가 실 DB 에 존재한다', async () => {
    const rows = await getPrismaClient().rolePermission.findMany({
      where: { permission: { permissionKey: EXTERNAL_MAPPING_READ_PERMISSION } },
      include: { role: true },
    });
    const roles = rows.map((r) => r.role.roleCode).sort();
    expect(roles).toEqual(['ADMIN', 'FINANCE', 'SCM_LEADER', 'SCM_STAFF']);
  });
});

describe('★ POST — 참조 검증', () => {
  it('4. 없는 SKU 는 404', async () => {
    await expect(
      createExternalMapping(
        ADMIN,
        input({
          skuId: '00000000-0000-4000-8000-000000000000',
          externalSystemId: await newSystem('ref-nosku'),
          externalProductCode: CODE('004'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('4b. soft-delete 된 SKU 도 404', async () => {
    const skuId = await newSku('ref-deleted');
    await getPrismaClient().sku.update({ where: { id: skuId }, data: { deletedAt: new Date() } });

    await expect(
      createExternalMapping(
        ADMIN,
        input({
          skuId,
          externalSystemId: await newSystem('ref-deleted'),
          externalProductCode: CODE('004b'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('4c. ★ SKU status 로 막지 않는다 — DRAFT 도 매핑 가능', async () => {
    const skuId = await newSku('ref-draft');
    const row = await getPrismaClient().sku.findUniqueOrThrow({ where: { id: skuId } });
    expect(row.status).toBe('DRAFT');

    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId,
        externalSystemId: await newSystem('ref-draft'),
        externalProductCode: CODE('004c'),
      }),
    );
    expect(result.mapping.id).toBeTruthy();
  });

  it('5. 없는 ExternalSystem 은 404', async () => {
    await expect(
      createExternalMapping(
        ADMIN,
        input({
          skuId: await newSku('ref-nosys'),
          externalSystemId: '00000000-0000-4000-8000-000000000000',
          externalProductCode: CODE('005'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('6. ★ active=false 인 ExternalSystem 도 차단하지 않는다', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('ref-inactive'),
        externalSystemId: await newSystem('ref-inactive', false),
        externalProductCode: CODE('006'),
      }),
    );
    expect(result.mapping.id).toBeTruthy();
  });
});

describe('★ POST — mappingStatus 자동판정 (§4)', () => {
  it('7. code only → MATCHED', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('st-code'),
        externalSystemId: await newSystem('st-code'),
        externalProductCode: CODE('007'),
      }),
    );
    expect(result.mapping.mappingStatus).toBe('MATCHED');

    const row = await getPrismaClient().skuExternalMapping.findUniqueOrThrow({
      where: { id: result.mapping.id },
    });
    expect(row.mappingStatus).toBe('MATCHED');
  });

  it('8. barcode only → MATCHED', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('st-barcode'),
        externalSystemId: await newSystem('st-barcode'),
        externalBarcode: '8809619961373',
      }),
    );
    expect(result.mapping.mappingStatus).toBe('MATCHED');
    expect(result.mapping.externalProductCode).toBeNull();
  });

  it('9. code + barcode → MATCHED', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('st-both'),
        externalSystemId: await newSystem('st-both'),
        externalProductCode: CODE('009'),
        externalBarcode: '8809619961374',
      }),
    );
    expect(result.mapping.mappingStatus).toBe('MATCHED');
  });

  it('10. name only → REVIEW_REQUIRED', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('st-name'),
        externalSystemId: await newSystem('st-name'),
        externalProductName: '외부 상품 A',
      }),
    );
    expect(result.mapping.mappingStatus).toBe('REVIEW_REQUIRED');
  });

  it('11. 식별자가 하나도 없으면 422 이고 행이 생기지 않는다', async () => {
    const skuId = await newSku('st-none');
    await expect(
      createExternalMapping(
        ADMIN,
        input({ skuId, externalSystemId: await newSystem('st-none'), note: '메모만' }),
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_MAPPING_IDENTIFIER_REQUIRED', httpStatus: 422 });

    expect(await getPrismaClient().skuExternalMapping.count({ where: { skuId } })).toBe(0);
  });

  it('11b. blank 만 있는 식별자도 422 다 (blank → null canonicalize 후 판정)', async () => {
    await expect(
      createExternalMapping(
        ADMIN,
        input({
          skuId: await newSku('st-blank'),
          externalSystemId: await newSystem('st-blank'),
          externalProductCode: '   ',
          externalProductName: '',
        }),
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_MAPPING_IDENTIFIER_REQUIRED' });
  });
});

describe('★ POST — 정규화 · server-managed 필드', () => {
  it('12. blank code/name 은 null 로 저장된다', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('norm-blank'),
        externalSystemId: await newSystem('norm-blank'),
        externalProductCode: '   ',
        externalProductName: '  이름  ',
      }),
    );
    expect(result.mapping.externalProductCode).toBeNull();
    expect(result.mapping.externalProductName).toBe('이름');
    expect(result.mapping.mappingStatus).toBe('REVIEW_REQUIRED');
  });

  it('12b. 앞자리 0·내부 하이픈이 보존된다', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('norm-preserve'),
        externalSystemId: await newSystem('norm-preserve'),
        externalProductCode: '  00-123  ',
      }),
    );
    expect(result.mapping.externalProductCode).toBe('00-123');
  });

  it('13. ★ externalBarcode 는 T04-2 규칙으로 정규화되어 저장된다', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('norm-barcode'),
        externalSystemId: await newSystem('norm-barcode'),
        externalBarcode: ' 880-961 9961375 ',
      }),
    );
    expect(result.mapping.externalBarcode).toBe('8809619961375');

    // ⛔ SkuBarcode 행을 만들지 않는다 — 문자열 정규화만 공유한다.
    expect(await getPrismaClient().skuBarcode.count({ where: { barcode: '8809619961375' } })).toBe(
      0,
    );
  });

  it('14. 지수표기·확인필요·형식오류 바코드는 422 이고 행이 생기지 않는다', async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['8.80962E+12', 'BARCODE_SCIENTIFIC_NOTATION'],
      ['확인필요', 'BARCODE_UNVERIFIED'],
      ['ABC123', 'BARCODE_INVALID_FORMAT'],
    ];
    for (const [raw, code] of cases) {
      const skuId = await newSku(`norm-bad-${code}`);
      await expect(
        createExternalMapping(
          ADMIN,
          input({
            skuId,
            externalSystemId: await newSystem(`norm-bad-${code}`),
            externalBarcode: raw,
          }),
        ),
        raw,
      ).rejects.toMatchObject({ code, httpStatus: 422 });
      expect(await getPrismaClient().skuExternalMapping.count({ where: { skuId } })).toBe(0);
    }
  });

  it('14b. EMPTY 표시 바코드는 오류가 아니라 null 이다', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('norm-empty-bc'),
        externalSystemId: await newSystem('norm-empty-bc'),
        externalBarcode: '-',
        externalProductName: '이름',
      }),
    );
    expect(result.mapping.externalBarcode).toBeNull();
    expect(result.mapping.mappingStatus).toBe('REVIEW_REQUIRED');
  });

  it('15·16. mappingStatus·warehouseId 는 DTO 가 400 으로 막는다', () => {
    expect(() =>
      input({ skuId: ADMIN_ID, externalSystemId: FINANCE_ID, mappingStatus: 'MATCHED' }),
    ).toThrow();
    expect(() =>
      input({ skuId: ADMIN_ID, externalSystemId: FINANCE_ID, warehouseId: EXEC_ID }),
    ).toThrow();
  });

  it('16b. ★ 저장된 warehouseId 는 항상 null 이다 (T08-1 staged)', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('wh-null'),
        externalSystemId: await newSystem('wh-null'),
        externalProductCode: CODE('016'),
      }),
    );
    expect(result.mapping.warehouseId).toBeNull();

    const row = await getPrismaClient().skuExternalMapping.findUniqueOrThrow({
      where: { id: result.mapping.id },
    });
    expect(row.warehouseId).toBeNull();
  });
});

describe('★ POST — isPrimary (§9)', () => {
  it('17. ★ name-only + isPrimary=true → 422 EXTERNAL_MAPPING_PRIMARY_REQUIRES_MATCHED', async () => {
    const skuId = await newSku('pri-review');
    await expect(
      createExternalMapping(
        ADMIN,
        input({
          skuId,
          externalSystemId: await newSystem('pri-review'),
          externalProductName: '이름만',
          isPrimary: true,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_MAPPING_PRIMARY_REQUIRES_MATCHED',
      httpStatus: 422,
    });
    expect(await getPrismaClient().skuExternalMapping.count({ where: { skuId } })).toBe(0);
  });

  it('18. MATCHED 매핑은 대표로 생성된다. 기본값은 false 다', async () => {
    const systemId = await newSystem('pri-ok');
    const primary = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('pri-ok-a'),
        externalSystemId: systemId,
        externalProductCode: CODE('018a'),
        isPrimary: true,
      }),
    );
    expect(primary.mapping.isPrimary).toBe(true);

    const plain = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('pri-ok-b'),
        externalSystemId: systemId,
        externalProductCode: CODE('018b'),
      }),
    );
    expect(plain.mapping.isPrimary).toBe(false);
  });
});

describe('★ POST — 조건부 UNIQUE 2종 (§10)', () => {
  it('19. 같은 시스템의 현행 외부코드 중복 → 409 EXTERNAL_MAPPING_CODE_DUPLICATE', async () => {
    const systemId = await newSystem('dup-code');
    const code = CODE('019');
    await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('dup-code-a'),
        externalSystemId: systemId,
        externalProductCode: code,
      }),
    );

    await expect(
      createExternalMapping(
        ADMIN,
        input({
          skuId: await newSku('dup-code-b'),
          externalSystemId: systemId,
          externalProductCode: code,
        }),
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_MAPPING_CODE_DUPLICATE', httpStatus: 409 });
  });

  it('19b. 시스템이 다르면 같은 코드가 허용된다', async () => {
    const code = CODE('019b');
    const skuId = await newSku('dup-code-cross');
    const a = await createExternalMapping(
      ADMIN,
      input({
        skuId,
        externalSystemId: await newSystem('dup-cross-a'),
        externalProductCode: code,
      }),
    );
    const b = await createExternalMapping(
      ADMIN,
      input({
        skuId,
        externalSystemId: await newSystem('dup-cross-b'),
        externalProductCode: code,
      }),
    );
    expect(a.mapping.id).not.toBe(b.mapping.id);
  });

  it('20. 같은 (SKU, 시스템) 대표 중복 → 409 EXTERNAL_MAPPING_PRIMARY_CONFLICT', async () => {
    const skuId = await newSku('dup-primary');
    const systemId = await newSystem('dup-primary');
    await createExternalMapping(
      ADMIN,
      input({
        skuId,
        externalSystemId: systemId,
        externalProductCode: CODE('020a'),
        isPrimary: true,
      }),
    );

    await expect(
      createExternalMapping(
        ADMIN,
        input({
          skuId,
          externalSystemId: systemId,
          externalProductCode: CODE('020b'),
          isPrimary: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_MAPPING_PRIMARY_CONFLICT', httpStatus: 409 });
  });
});

describe('★ POST — 부수효과 금지 · 멱등 · AuditLog', () => {
  it('21. ★ externalProductName 이 Sku.skuName 을 바꾸지 않는다', async () => {
    const skuId = await newSku('no-overwrite');
    const before = await getPrismaClient().sku.findUniqueOrThrow({ where: { id: skuId } });

    await createExternalMapping(
      ADMIN,
      input({
        skuId,
        externalSystemId: await newSystem('no-overwrite'),
        externalProductName: '외부에서 온 전혀 다른 이름',
      }),
    );

    const after = await getPrismaClient().sku.findUniqueOrThrow({ where: { id: skuId } });
    expect(after.skuName).toBe(before.skuName);
    expect(after.skuName).not.toBe('외부에서 온 전혀 다른 이름');
  });

  it('22. 멱등 — 최초 201 / 같은 key+hash replay / 다른 hash 409', async () => {
    const skuId = await newSku('idem');
    const systemId = await newSystem('idem');
    const key = `xmap-idem-${RUN}`;
    const body = { skuId, externalSystemId: systemId, externalProductCode: CODE('022') };

    const first = await createExternalMapping(ADMIN, input(body), {}, key);
    expect(first.replayed).toBe(false);

    const replay = await createExternalMapping(ADMIN, input(body), {}, key);
    expect(replay.replayed).toBe(true);
    expect(replay.mapping.id).toBe(first.mapping.id);

    // ★ 정규화 결과가 같아도(공백 차이) raw DTO hash 가 다르므로 409 다.
    await expect(
      createExternalMapping(
        ADMIN,
        input({ ...body, externalProductCode: `  ${CODE('022')}  ` }),
        {},
        key,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 409 });

    // 행은 1건뿐이다.
    expect(await getPrismaClient().skuExternalMapping.count({ where: { skuId } })).toBe(1);
  });

  it('22b. business 실패는 key 를 점유하지 않는다', async () => {
    const key = `xmap-idem-fail-${RUN}`;
    await expect(
      createExternalMapping(
        ADMIN,
        input({
          skuId: '00000000-0000-4000-8000-000000000000',
          externalSystemId: await newSystem('idem-fail'),
          externalProductCode: CODE('022b'),
        }),
        {},
        key,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(
      await getPrismaClient().idempotencyRecord.count({
        where: { actorId: ADMIN_ID, idempotencyKey: key },
      }),
    ).toBe(0);

    // 같은 key 로 정상 요청을 다시 보낼 수 있다.
    const retry = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('idem-fail-retry'),
        externalSystemId: await newSystem('idem-fail-retry'),
        externalProductCode: CODE('022c'),
      }),
      {},
      key,
    );
    expect(retry.replayed).toBe(false);
  });

  it('23. ★ AuditLog 실패 시 매핑·멱등기록이 함께 롤백된다', async () => {
    const skuId = await newSku('audit-rollback');
    const key = `xmap-rollback-${RUN}`;
    const failing = {
      write: async () => {
        throw new Error('감사로그 실패 주입');
      },
    };

    await expect(
      createExternalMapping(
        ADMIN,
        input({
          skuId,
          externalSystemId: await newSystem('audit-rollback'),
          externalProductCode: CODE('023'),
        }),
        { auditLogger: failing as never },
        key,
      ),
    ).rejects.toThrow(/감사로그 실패 주입/);

    const client = getPrismaClient();
    expect(await client.skuExternalMapping.count({ where: { skuId } })).toBe(0);
    expect(
      await client.idempotencyRecord.count({ where: { actorId: ADMIN_ID, idempotencyKey: key } }),
    ).toBe(0);
  });

  it('23b. CREATE AuditLog 가 남는다', async () => {
    const result = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('audit-create'),
        externalSystemId: await newSystem('audit-create'),
        externalProductCode: CODE('023b'),
      }),
    );

    const rows = await auditRows(result.mapping.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('CREATE');
    expect(rows[0]?.actorId).toBe(ADMIN_ID);
    expect(rows[0]?.beforeValue).toBeNull();
    expect(rows[0]?.afterValue).toMatchObject({ mappingStatus: 'MATCHED' });
  });
});

// ═══════════════════════════════════════════════════════════════
// PATCH
// ═══════════════════════════════════════════════════════════════

async function seedMapping(
  label: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; skuId: string; systemId: string }> {
  const skuId = await newSku(label);
  const systemId = await newSystem(label);
  const result = await createExternalMapping(
    ADMIN,
    input({ skuId, externalSystemId: systemId, ...body }),
  );
  return { id: result.mapping.id, skuId, systemId };
}

describe('★ PATCH — 권한 · DTO', () => {
  it('24. 쓰기 권한 actor 는 수정할 수 있다', async () => {
    const { id } = await seedMapping('patch-ok', { externalProductCode: CODE('024') });
    const updated = await updateExternalMapping(ADMIN, id, patch({ note: '메모' }));
    expect(updated.note).toBe('메모');
  });

  it('25. FINANCE·EXECUTIVE 는 거부된다', async () => {
    const { id } = await seedMapping('patch-denied', { externalProductCode: CODE('025') });
    for (const actor of [FINANCE, EXECUTIVE, ADMIN_NO_PERMISSION]) {
      await expect(updateExternalMapping(actor, id, patch({ note: 'x' }))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        httpStatus: 403,
      });
    }
  });

  it('26·27·28. unknown field · 빈 body · identity 필드는 400 (DTO)', () => {
    expect(() => patch({ nope: 1 })).toThrow();
    expect(() => patch({})).toThrow();
    expect(() => patch({ skuId: ADMIN_ID })).toThrow();
    expect(() => patch({ externalSystemId: ADMIN_ID })).toThrow();
    expect(() => patch({ mappingStatus: 'MATCHED' })).toThrow();
  });

  it('없는 매핑은 404', async () => {
    await expect(
      updateExternalMapping(ADMIN, '00000000-0000-4000-8000-000000000000', patch({ note: 'x' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });
});

describe('★ PATCH — identifier 수정과 상태 자동 전환 (§2·§4)', () => {
  it('29. ★ REVIEW_REQUIRED + 외부코드 추가 → MATCHED (서버 파생)', async () => {
    const { id } = await seedMapping('patch-review-code', { externalProductName: '이름' });
    const before = await getPrismaClient().skuExternalMapping.findUniqueOrThrow({ where: { id } });
    expect(before.mappingStatus).toBe('REVIEW_REQUIRED');

    const updated = await updateExternalMapping(
      ADMIN,
      id,
      patch({ externalProductCode: CODE('029') }),
    );
    expect(updated.mappingStatus).toBe('MATCHED');
    expect(updated.externalProductCode).toBe(CODE('029'));
  });

  it('30. REVIEW_REQUIRED + 외부바코드 추가 → MATCHED', async () => {
    const { id } = await seedMapping('patch-review-barcode', { externalProductName: '이름' });
    const updated = await updateExternalMapping(
      ADMIN,
      id,
      patch({ externalBarcode: ' 8809-619 961376 ' }),
    );
    expect(updated.mappingStatus).toBe('MATCHED');
    expect(updated.externalBarcode).toBe('8809619961376');
  });

  it('31. MATCHED 에서 식별자 제거 + 상품명 유지 → REVIEW_REQUIRED', async () => {
    const { id } = await seedMapping('patch-down', {
      externalProductCode: CODE('031'),
      externalProductName: '이름 유지',
    });

    const updated = await updateExternalMapping(
      ADMIN,
      id,
      patch({ externalProductCode: null, externalBarcode: null }),
    );
    expect(updated.mappingStatus).toBe('REVIEW_REQUIRED');
    expect(updated.externalProductCode).toBeNull();
  });

  it('32. 식별자를 전부 제거하면 422 이고 행이 바뀌지 않는다', async () => {
    const { id } = await seedMapping('patch-strip-all', {
      externalProductCode: CODE('032'),
      externalProductName: '이름',
    });

    await expect(
      updateExternalMapping(
        ADMIN,
        id,
        patch({ externalProductCode: null, externalBarcode: null, externalProductName: null }),
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_MAPPING_IDENTIFIER_REQUIRED', httpStatus: 422 });

    const row = await getPrismaClient().skuExternalMapping.findUniqueOrThrow({ where: { id } });
    expect(row.externalProductCode).toBe(CODE('032'));
    expect(row.mappingStatus).toBe('MATCHED');
  });

  it('33. ★ 대표인 채로 REVIEW_REQUIRED 로 내려가면 422 — primary 해제를 함께 요구한다', async () => {
    const { id } = await seedMapping('patch-primary-down', {
      externalProductCode: CODE('033'),
      externalProductName: '이름',
      isPrimary: true,
    });

    await expect(
      updateExternalMapping(ADMIN, id, patch({ externalProductCode: null, externalBarcode: null })),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_MAPPING_PRIMARY_REQUIRES_MATCHED',
      httpStatus: 422,
    });

    // 같은 요청에서 대표를 해제하면 성공한다.
    const updated = await updateExternalMapping(
      ADMIN,
      id,
      patch({ externalProductCode: null, externalBarcode: null, isPrimary: false }),
    );
    expect(updated.mappingStatus).toBe('REVIEW_REQUIRED');
    expect(updated.isPrimary).toBe(false);
  });
});

describe('★ PATCH — isPrimary (§9)', () => {
  it('34. false → true 로 대표 지정이 가능하다', async () => {
    const { id } = await seedMapping('patch-pri-set', { externalProductCode: CODE('034') });
    const updated = await updateExternalMapping(ADMIN, id, patch({ isPrimary: true }));
    expect(updated.isPrimary).toBe(true);
  });

  it('35·36. ★ 기존 대표가 있으면 409 이고 기존 행이 자동 해제되지 않는다', async () => {
    const skuId = await newSku('patch-pri-conflict');
    const systemId = await newSystem('patch-pri-conflict');
    const existing = await createExternalMapping(
      ADMIN,
      input({
        skuId,
        externalSystemId: systemId,
        externalProductCode: CODE('035a'),
        isPrimary: true,
      }),
    );
    const other = await createExternalMapping(
      ADMIN,
      input({ skuId, externalSystemId: systemId, externalProductCode: CODE('035b') }),
    );

    await expect(
      updateExternalMapping(ADMIN, other.mapping.id, patch({ isPrimary: true })),
    ).rejects.toMatchObject({ code: 'EXTERNAL_MAPPING_PRIMARY_CONFLICT', httpStatus: 409 });

    // ★ 기존 대표는 그대로다 — 숨은 side effect 없음.
    const kept = await getPrismaClient().skuExternalMapping.findUniqueOrThrow({
      where: { id: existing.mapping.id },
    });
    expect(kept.isPrimary).toBe(true);

    // 명시적으로 해제한 뒤에는 성공한다.
    await updateExternalMapping(ADMIN, existing.mapping.id, patch({ isPrimary: false }));
    const promoted = await updateExternalMapping(
      ADMIN,
      other.mapping.id,
      patch({ isPrimary: true }),
    );
    expect(promoted.isPrimary).toBe(true);
  });
});

describe('★ PATCH — no-change (§14)', () => {
  it('37. ★ 실질 변화가 없으면 200 + write 0 + AuditLog 0', async () => {
    const { id } = await seedMapping('patch-noop', {
      externalProductCode: CODE('037'),
      note: '고정',
    });
    const auditBefore = await auditRows(id);

    const same = await updateExternalMapping(
      ADMIN,
      id,
      // 공백만 다른 값 → 정규화하면 동일하다.
      patch({ externalProductCode: `  ${CODE('037')}  `, note: '고정' }),
    );
    expect(same.externalProductCode).toBe(CODE('037'));

    expect(await auditRows(id)).toHaveLength(auditBefore.length);
  });
});

describe('★ PATCH — effectiveTo / 매핑 해제 (§8)', () => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  it('38. 종료일 설정이 매핑 해제다 (DELETE 없음)', async () => {
    const { id } = await seedMapping('end-ok', { externalProductCode: CODE('038') });
    const updated = await updateExternalMapping(ADMIN, id, patch({ effectiveTo: today }));
    expect(updated.effectiveTo).toBe(today);
  });

  it('39. ★ 미래 종료일은 422', async () => {
    const { id } = await seedMapping('end-future', { externalProductCode: CODE('039') });
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await expect(
      updateExternalMapping(ADMIN, id, patch({ effectiveTo: future })),
    ).rejects.toMatchObject({ code: 'EXTERNAL_MAPPING_EFFECTIVE_DATE_INVALID', httpStatus: 422 });
  });

  it('40. ★ effectiveFrom 보다 이른 종료일은 422', async () => {
    const { id } = await seedMapping('end-before-from', { externalProductCode: CODE('040') });
    await getPrismaClient().skuExternalMapping.update({
      where: { id },
      data: { effectiveFrom: new Date('2026-05-01T00:00:00.000Z') },
    });

    await expect(
      updateExternalMapping(ADMIN, id, patch({ effectiveTo: '2026-04-30' })),
    ).rejects.toMatchObject({ code: 'EXTERNAL_MAPPING_EFFECTIVE_DATE_INVALID', httpStatus: 422 });
  });

  it('41·42. ★ 대표 매핑 종료는 isPrimary=false 동시 지정을 요구한다', async () => {
    const { id } = await seedMapping('end-primary', {
      externalProductCode: CODE('041'),
      isPrimary: true,
    });

    await expect(
      updateExternalMapping(ADMIN, id, patch({ effectiveTo: today })),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_MAPPING_PRIMARY_MUST_BE_CLEARED_BEFORE_END',
      httpStatus: 422,
    });

    const updated = await updateExternalMapping(
      ADMIN,
      id,
      patch({ effectiveTo: today, isPrimary: false }),
    );
    expect(updated.effectiveTo).toBe(today);
    expect(updated.isPrimary).toBe(false);
  });

  it('42b. ★ 종료 후 같은 시스템/코드로 새 현행 매핑을 만들 수 있다 (§8)', async () => {
    const skuId = await newSku('end-then-recreate');
    const systemId = await newSystem('end-then-recreate');
    const code = CODE('042');

    const first = await createExternalMapping(
      ADMIN,
      input({ skuId, externalSystemId: systemId, externalProductCode: code }),
    );
    await updateExternalMapping(ADMIN, first.mapping.id, patch({ effectiveTo: today }));

    const second = await createExternalMapping(
      ADMIN,
      input({
        skuId: await newSku('end-then-recreate-2'),
        externalSystemId: systemId,
        externalProductCode: code,
      }),
    );
    expect(second.mapping.id).not.toBe(first.mapping.id);
    expect(second.mapping.effectiveTo).toBeNull();
  });

  it('42c. ★ 대표를 해제하고 종료했으면 새 대표를 세울 수 있다 (ended primary 문제 해소)', async () => {
    const skuId = await newSku('end-primary-reuse');
    const systemId = await newSystem('end-primary-reuse');

    const old = await createExternalMapping(
      ADMIN,
      input({
        skuId,
        externalSystemId: systemId,
        externalProductCode: CODE('042c-old'),
        isPrimary: true,
      }),
    );
    await updateExternalMapping(
      ADMIN,
      old.mapping.id,
      patch({ effectiveTo: today, isPrimary: false }),
    );

    const fresh = await createExternalMapping(
      ADMIN,
      input({
        skuId,
        externalSystemId: systemId,
        externalProductCode: CODE('042c-new'),
        isPrimary: true,
      }),
    );
    expect(fresh.mapping.isPrimary).toBe(true);
  });

  it('43. ★ 종료된 행의 후속 PATCH 는 422 EXTERNAL_MAPPING_ENDED', async () => {
    const { id } = await seedMapping('ended-patch', { externalProductCode: CODE('043') });
    await updateExternalMapping(ADMIN, id, patch({ effectiveTo: today }));

    await expect(updateExternalMapping(ADMIN, id, patch({ note: 'x' }))).rejects.toMatchObject({
      code: 'EXTERNAL_MAPPING_ENDED',
      httpStatus: 422,
    });
  });
});

describe('★ PATCH — UNMATCHED 방어 (§3)', () => {
  it('44. ★ UNMATCHED 행은 조회는 되지만 PATCH 는 422 다', async () => {
    const { id } = await seedMapping('unmatched-guard', { externalProductCode: CODE('044') });
    // legacy/ingestion 로 생긴 상태를 재현한다 — interactive API 로는 만들 수 없다.
    await getPrismaClient().skuExternalMapping.update({
      where: { id },
      data: { mappingStatus: 'UNMATCHED' },
    });

    await expect(updateExternalMapping(ADMIN, id, patch({ note: 'x' }))).rejects.toMatchObject({
      code: 'EXTERNAL_MAPPING_UNMATCHED_NOT_INTERACTIVE',
      httpStatus: 422,
    });

    const listed = await listExternalMappings(
      ADMIN,
      parseListMappingsQuery(new URLSearchParams('mappingStatus=UNMATCHED')),
    );
    expect(listed.items.some((item) => item.id === id)).toBe(true);
  });
});

describe('★ PATCH — AuditLog (§14)', () => {
  it('45. before/after 가 정확히 남고 action 은 UPDATE 다', async () => {
    const { id } = await seedMapping('audit-update', { externalProductName: '이름' });
    await updateExternalMapping(ADMIN, id, patch({ externalProductCode: CODE('045') }));

    const rows = await auditRows(id);
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
    expect(rows[1]?.beforeValue).toMatchObject({
      mappingStatus: 'REVIEW_REQUIRED',
      externalProductCode: null,
    });
    expect(rows[1]?.afterValue).toMatchObject({
      mappingStatus: 'MATCHED',
      externalProductCode: CODE('045'),
    });
  });

  it('45b. ★ 매핑 해제도 UPDATE 다 — UNMAP/DEACTIVATE 를 만들지 않았다', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const { id } = await seedMapping('audit-unmap', { externalProductCode: CODE('045b') });
    await updateExternalMapping(ADMIN, id, patch({ effectiveTo: today }));

    const rows = await auditRows(id);
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
    expect(rows.map((r) => r.action)).not.toContain('UNMAP');
    expect(rows.map((r) => r.action)).not.toContain('DEACTIVATE');
  });

  it('46. ★ AuditLog 실패 시 PATCH 가 롤백된다', async () => {
    const { id } = await seedMapping('audit-patch-rollback', {
      externalProductCode: CODE('046'),
    });
    const failing = {
      write: async () => {
        throw new Error('감사로그 실패 주입');
      },
    };

    await expect(
      updateExternalMapping(ADMIN, id, patch({ note: '변경' }), {
        auditLogger: failing as never,
      }),
    ).rejects.toThrow(/감사로그 실패 주입/);

    const row = await getPrismaClient().skuExternalMapping.findUniqueOrThrow({ where: { id } });
    expect(row.note).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// GET
// ═══════════════════════════════════════════════════════════════

describe('★ GET — envelope · filter · q · projection (§12)', () => {
  const query = (search = '') => parseListMappingsQuery(new URLSearchParams(search));

  it('47·48·49. A·L·S·F 는 조회 가능, EXECUTIVE·무권한은 403', async () => {
    await expect(listExternalMappings(ADMIN, query())).resolves.toBeTruthy();
    await expect(listExternalMappings(FINANCE, query())).resolves.toBeTruthy();
    for (const actor of [EXECUTIVE, ADMIN_NO_PERMISSION]) {
      await expect(listExternalMappings(actor, query())).rejects.toMatchObject({
        code: 'FORBIDDEN',
        httpStatus: 403,
      });
    }
  });

  it('50. ★ envelope 가 SKU 목록 계약과 동일하다', async () => {
    const result = await listExternalMappings(ADMIN, query('pageSize=1'));
    expect(Object.keys(result).sort()).toEqual([
      'items',
      'page',
      'pageSize',
      'total',
      'totalPages',
    ]);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(1);
  });

  it('51·52·53·54·55. filter — externalSystemId / skuId / mappingStatus 3종', async () => {
    const skuId = await newSku('filter');
    const systemId = await newSystem('filter');
    await createExternalMapping(
      ADMIN,
      input({ skuId, externalSystemId: systemId, externalProductCode: CODE('051') }),
    );
    await createExternalMapping(
      ADMIN,
      input({ skuId, externalSystemId: systemId, externalProductName: '리뷰 필요 항목' }),
    );

    const bySystem = await listExternalMappings(ADMIN, query(`externalSystemId=${systemId}`));
    expect(bySystem.total).toBe(2);

    const bySku = await listExternalMappings(ADMIN, query(`skuId=${skuId}`));
    expect(bySku.total).toBe(2);

    const matched = await listExternalMappings(
      ADMIN,
      query(`skuId=${skuId}&mappingStatus=MATCHED`),
    );
    expect(matched.total).toBe(1);

    const review = await listExternalMappings(
      ADMIN,
      query(`skuId=${skuId}&mappingStatus=REVIEW_REQUIRED`),
    );
    expect(review.total).toBe(1);

    // UNMATCHED 필터는 받아들여지고 결과 0건이 정상이다.
    const unmatched = await listExternalMappings(
      ADMIN,
      query(`skuId=${skuId}&mappingStatus=UNMATCHED`),
    );
    expect(unmatched.total).toBe(0);
  });

  it('56·57·58·59·60. q 는 4종만 검색하고 externalBarcode 는 검색하지 않는다', async () => {
    const skuId = await newSku('qsearch');
    const systemId = await newSystem('qsearch');
    const uniq = `QQ${RUN}`;

    const target = await createExternalMapping(
      ADMIN,
      input({
        skuId,
        externalSystemId: systemId,
        externalProductCode: `${uniq}-CODE`,
        externalProductName: `${uniq}-NAME`,
        externalBarcode: '8809619961377',
      }),
    );

    const sku = await getPrismaClient().sku.findUniqueOrThrow({ where: { id: skuId } });

    for (const term of [sku.skuCode, sku.skuName, `${uniq}-CODE`, `${uniq}-NAME`]) {
      const found = await listExternalMappings(ADMIN, query(`q=${encodeURIComponent(term)}`));
      expect(
        found.items.some((item) => item.id === target.mapping.id),
        term,
      ).toBe(true);
    }

    // ★ externalBarcode 는 q 대상이 아니다.
    const byBarcode = await listExternalMappings(ADMIN, query('q=8809619961377'));
    expect(byBarcode.items.some((item) => item.id === target.mapping.id)).toBe(false);
  });

  it('61·62. 기본 정렬은 createdAt DESC, id DESC 이고 pagination 이 동작한다', async () => {
    const skuId = await newSku('sort');
    const systemId = await newSystem('sort');
    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const row = await createExternalMapping(
        ADMIN,
        input({
          skuId,
          externalSystemId: systemId,
          externalProductCode: CODE(`061-${i}`),
        }),
      );
      created.push(row.mapping.id);
    }

    const all = await listExternalMappings(ADMIN, query(`skuId=${skuId}&pageSize=10`));
    expect(all.total).toBe(3);
    const times = all.items.map((item) => Date.parse(item.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const first = await listExternalMappings(ADMIN, query(`skuId=${skuId}&pageSize=2&page=1`));
    const second = await listExternalMappings(ADMIN, query(`skuId=${skuId}&pageSize=2&page=2`));
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(first.totalPages).toBe(2);
    expect(created).toHaveLength(3);
  });

  it('63. projection 에 sku·externalSystem 이 포함되고 warehouse 객체는 없다', async () => {
    const { id, skuId, systemId } = await seedMapping('projection', {
      externalProductCode: CODE('063'),
    });
    const result = await listExternalMappings(ADMIN, query(`skuId=${skuId}`));
    const item = result.items.find((row) => row.id === id);

    expect(item?.sku).toMatchObject({ id: skuId });
    expect(item?.sku.skuCode).toBeTruthy();
    expect(item?.sku.skuName).toBeTruthy();
    expect(item?.externalSystem).toMatchObject({ id: systemId });
    expect(item?.externalSystem.systemCode).toBeTruthy();
    expect(item).not.toHaveProperty('warehouse');
    expect(item?.warehouseId).toBeNull();
  });

  it('63b. 종료된 매핑도 목록에 남는다 (이력)', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const { id, skuId } = await seedMapping('ended-listed', { externalProductCode: CODE('063b') });
    await updateExternalMapping(ADMIN, id, patch({ effectiveTo: today }));

    const result = await listExternalMappings(ADMIN, query(`skuId=${skuId}`));
    expect(result.items.some((row) => row.id === id && row.effectiveTo === today)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 실 PostgreSQL 동시성 — DB partial UNIQUE 가 최종 방어선
// ═══════════════════════════════════════════════════════════════

describe('★ 동시 요청 — DB 조건부 UNIQUE 가 최종 방어선', () => {
  it('동일 (system, code) 동시 생성 → 1건 성공 + 1건 CODE_DUPLICATE', async () => {
    const systemId = await newSystem('race-code');
    const skuA = await newSku('race-code-a');
    const skuB = await newSku('race-code-b');
    const code = CODE('race-1');

    // ★ 멱등키는 서로 다르게 — 멱등 replay 가 아니라 실제 동시 INSERT 경합을 본다.
    const results = await Promise.allSettled([
      createExternalMapping(
        ADMIN,
        input({ skuId: skuA, externalSystemId: systemId, externalProductCode: code }),
        {},
        `race-code-a-${RUN}`,
      ),
      createExternalMapping(
        ADMIN,
        input({ skuId: skuB, externalSystemId: systemId, externalProductCode: code }),
        {},
        `race-code-b-${RUN}`,
      ),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'EXTERNAL_MAPPING_CODE_DUPLICATE',
      httpStatus: 409,
    });

    const client = getPrismaClient();
    expect(
      await client.skuExternalMapping.count({
        where: { externalSystemId: systemId, externalProductCode: code, effectiveTo: null },
      }),
    ).toBe(1);
    expect(
      await client.auditLog.count({
        where: { entityType: 'SkuExternalMapping', action: 'CREATE', actorId: ADMIN_ID },
      }),
    ).toBeGreaterThan(0);
  });

  it('동일 (SKU, system) 대표 동시 지정 → 1건 성공 + 1건 PRIMARY_CONFLICT', async () => {
    const skuId = await newSku('race-primary');
    const systemId = await newSystem('race-primary');

    const results = await Promise.allSettled([
      createExternalMapping(
        ADMIN,
        input({
          skuId,
          externalSystemId: systemId,
          externalProductCode: CODE('race-p1'),
          isPrimary: true,
        }),
        {},
        `race-p1-${RUN}`,
      ),
      createExternalMapping(
        ADMIN,
        input({
          skuId,
          externalSystemId: systemId,
          externalProductCode: CODE('race-p2'),
          isPrimary: true,
        }),
        {},
        `race-p2-${RUN}`,
      ),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'EXTERNAL_MAPPING_PRIMARY_CONFLICT',
      httpStatus: 409,
    });

    expect(
      await getPrismaClient().skuExternalMapping.count({
        where: { skuId, externalSystemId: systemId, isPrimary: true },
      }),
    ).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// T05-2 범위 고정
// ═══════════════════════════════════════════════════════════════

describe('★ T05-2 범위 고정', () => {
  it('⛔ import·unmatched·resolver 라우트가 없다', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../src/app/api/external-mappings', import.meta.url));

    // ✏️ `[id]` 는 T05-2 의 PATCH 라우트다. 그 외 하위 경로는 아직 없다.
    expect(readdirSync(dir).sort()).toEqual(['[id]', 'route.ts']);
  });

  it('⛔ Warehouse·ExternalInventorySnapshot·ImportJob 테이블이 여전히 없다', async () => {
    const rows = await getPrismaClient().$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('warehouse', 'external_inventory_snapshot', 'import_job', 'import_row')`;
    expect(rows).toEqual([]);
  });
});
