import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  bulkConfirmBomLineQuantities,
  createBom,
  createBomLine,
  getBom,
  listBoms,
  parseBulkConfirmQtyInput,
  updateBomLine,
  BOM_CREATE_PERMISSION,
  BOM_HEADER_ENTITY_TYPE,
  BOM_LINE_ENTITY_TYPE,
  BOM_READ_PERMISSION,
  BOM_UPDATE_PERMISSION,
  type CreateBomInput,
  type CreateLineInput,
} from '@/modules/bom/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * BOM 소요량 일괄 확정 DB 통합 테스트 (T07-4) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-6 · §D-10 · §D-15 · §D-16 · §D-17 ·
 *    §D-28 · §D-29 · §D-32 test matrix + **"T07-4 bulk-confirm gap closure"**.
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - **TC-BOM-003** — `pack=30` 과 `qty=1/30` 이 **별도로** 저장된다
 *   - bulk 트랜잭션의 **원자성**(하나라도 invalid → 전체 rollback, audit 0)
 *   - **실변경만 write** 하고 Audit 요약이 실제 변경분만 센다 (B4)
 *   - business no-op 과 **멱등 replay 의 차이**
 *   - 편집 가능 상태 7종 matrix
 *   - 5역할 권한 matrix
 *   - `unconfirmedCount` 가 정확히 줄고 `lineCount` 는 그대로인지
 *   - **bulk vs bulk** · **bulk vs line PATCH** 동시성 (lost update 없음)
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TBQ-${RUN}-${suffix}`;

const STAFF_ID = 'ddd00000-0000-4000-8000-0000000d7001';
const STAFF2_ID = 'ddd00000-0000-4000-8000-0000000d7002';
const FINANCE_ID = 'ddd00000-0000-4000-8000-0000000d7003';
const EXEC_ID = 'ddd00000-0000-4000-8000-0000000d7004';
const NOPERM_ID = 'ddd00000-0000-4000-8000-0000000d7005';
const ACTOR_IDS = [STAFF_ID, STAFF2_ID, FINANCE_ID, EXEC_ID, NOPERM_ID];

const actor = (
  userId: string,
  roles: string[],
  permissions: string[],
  name: string,
): ActorContext =>
  createActorContext({
    userId,
    email: `${userId}@deeppoint.test`,
    name,
    active: true,
    roles,
    permissions,
    requestId: `req-${userId}`,
  });

const WRITE_PERMS = [BOM_READ_PERMISSION, BOM_CREATE_PERMISSION, BOM_UPDATE_PERMISSION];

const STAFF = actor(STAFF_ID, ['SCM_STAFF'], WRITE_PERMS, 'BOM 담당자');
const STAFF2 = actor(STAFF2_ID, ['SCM_STAFF'], WRITE_PERMS, 'BOM 담당자 2');
/** ★ FINANCE — read 만. mutation 권한이 하나도 없다 (D-15). */
const FINANCE = actor(FINANCE_ID, ['FINANCE'], [BOM_READ_PERMISSION], '재무');
/** ★ EXECUTIVE — read 는 되지만 확정은 못 한다. */
const EXECUTIVE = actor(EXEC_ID, ['EXECUTIVE'], [BOM_READ_PERMISSION], '경영진');
/** ADMIN role 이지만 permission 데이터가 없다 — bypass 부재 증명용. */
const NO_PERMISSION = actor(NOPERM_ID, ['ADMIN'], [], '권한 없는 관리자');

let seq = 0;

async function newSku(label: string, overrides: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `수량 SKU (${label})`,
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
  readonly lineIds: readonly string[];
}

/**
 * 부모 1 + 구성품 3 인 DRAFT BOM.
 *
 * 라인 상태를 **서로 다르게** 만든다 — 확정이 세 출발점을 모두 흡수하는지
 * 한 픽스처로 본다 (D-10).
 *
 *   line 0 — `UNKNOWN`   (`quantityPer = null`)
 *   line 1 — `SUGGESTED` (`quantityPer = "0.033333"`)
 *   line 2 — `CONFIRMED` (`quantityPer = "2.5"`)
 */
async function fixture(label: string): Promise<Fixture> {
  const parent = await newSku(`${label}-parent`, { status: 'ACTIVE' });
  const created = await createBom(STAFF, bomInput(parent));
  const bomId = created.bom.id;

  const specs: Partial<CreateLineInput>[] = [
    { quantityStatus: 'UNKNOWN' },
    { quantityStatus: 'SUGGESTED', quantityPer: '0.033333' },
    { quantityStatus: 'CONFIRMED', quantityPer: '2.5' },
  ];

  const lineIds: string[] = [];
  for (const [index, spec] of specs.entries()) {
    const component = await newSku(`${label}-c${index}`, { status: 'ACTIVE' });
    const line = await createBomLine(STAFF, bomId, lineInput(component, spec));
    lineIds.push(line.line.id);
  }
  return { bomId, lineIds };
}

async function auditsOf(entityType: string, entityId: string) {
  return getPrismaClient().auditLog.findMany({
    where: { entityType, entityId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { action: true, actorId: true, afterValue: true },
  });
}

async function lineRows(bomId: string) {
  return getPrismaClient().bomLine.findMany({
    where: { bomHeaderId: bomId },
    orderBy: { lineNo: 'asc' },
    select: {
      id: true,
      quantityPer: true,
      quantityStatus: true,
      packQuantity: true,
      uom: true,
      componentSkuId: true,
      componentRole: true,
      isRequired: true,
      alternateGroup: true,
      lineNo: true,
    },
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

async function setStatus(bomId: string, status: string): Promise<void> {
  await getPrismaClient().$executeRawUnsafe(
    `UPDATE bom_header SET status = $1::"BomStatus" WHERE id = $2::uuid`,
    status,
    bomId,
  );
}

/** DTO 를 실제로 통과시킨다 — route 와 같은 입력 경로를 쓴다. */
function confirm(items: { lineId: string; quantityPer: string }[]) {
  return parseBulkConfirmQtyInput(items);
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
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TBQ-' } } } },
  });
  await client.bomLine.deleteMany({ where: { componentSku: { skuCode: { startsWith: 'TBQ-' } } } });
  await client.bomHeader.deleteMany({ where: { parentSku: { skuCode: { startsWith: 'TBQ-' } } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TBQ-' } } });
  await client.user.deleteMany({ where: { id: { in: ACTOR_IDS } } });
}

beforeAll(async () => {
  const client = getPrismaClient();
  await client.$transaction(async (tx) => {
    await seedRolesAndPermissions(tx);
  });
  await cleanup();
  await client.user.createMany({
    data: ACTOR_IDS.map((id) => ({ id, email: `${id}@deeppoint.test`, name: '수량 테스트' })),
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 1. 기본 확정 — 세 출발 상태가 모두 CONFIRMED 가 된다 (D-10)
// ═══════════════════════════════════════════════════════════════

describe('★ 소요량 일괄 확정 — UNKNOWN·SUGGESTED·CONFIRMED 모두 대상이다 (D-10)', () => {
  it('★★ 세 라인이 한 번에 CONFIRMED 가 되고 요청 수량이 그대로 저장된다', async () => {
    const { bomId, lineIds } = await fixture('basic');

    const result = await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([
        { lineId: lineIds[0]!, quantityPer: '1.5' },
        { lineId: lineIds[1]!, quantityPer: '0.033333' },
        { lineId: lineIds[2]!, quantityPer: '3' },
      ]),
    );

    expect(result.replayed).toBe(false);

    const rows = await lineRows(bomId);
    expect(rows.map((row) => row.quantityStatus)).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    // ★ Decimal 정밀도 보존 — 반올림하지 않는다.
    //
    // ⚠️ Prisma 가 돌려주는 Decimal 의 `toFixed()` 는 **최소 표기**다
    //    (`"3"` — 컬럼이 Decimal(18,6) 이어도 `"3.000000"` 으로 채우지 않는다).
    //    값이 같으면 표기는 다를 수 있으므로 계약은 **값**이지 자릿수가 아니다.
    //    ★ 그래도 `0.033333` 은 그대로 남는다 — 정밀도는 잃지 않는다.
    expect(rows.map((row) => row.quantityPer?.toFixed())).toEqual(['1.5', '0.033333', '3']);
  });

  it('★★ UNKNOWN(null) 도 명시 수량을 주면 확정된다 — 조용히 건너뛰지 않는다', async () => {
    const { bomId, lineIds } = await fixture('unknown');
    const before = await lineRows(bomId);
    expect(before[0]?.quantityStatus).toBe('UNKNOWN');
    expect(before[0]?.quantityPer).toBeNull();

    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[0]!, quantityPer: '4' }]),
    );

    const after = await lineRows(bomId);
    expect(after[0]?.quantityStatus).toBe('CONFIRMED');
    expect(after[0]?.quantityPer?.toFixed()).toBe('4');
    // 나머지 라인은 손대지 않는다.
    expect(after[1]?.quantityStatus).toBe('SUGGESTED');
    expect(after[2]?.quantityStatus).toBe('CONFIRMED');
  });

  it('★★ SUGGESTED → CONFIRMED 는 상태만이 아니라 요청 수량으로 확정된다', async () => {
    const { bomId, lineIds } = await fixture('suggested');

    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[1]!, quantityPer: '9.25' }]),
    );

    const after = await lineRows(bomId);
    expect(after[1]?.quantityStatus).toBe('CONFIRMED');
    expect(after[1]?.quantityPer?.toFixed()).toBe('9.25');
  });

  it('★★ CONFIRMED + 다른 수량 → 실변경이다 (status 는 CONFIRMED 유지)', async () => {
    const { bomId, lineIds } = await fixture('requantify');

    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[2]!, quantityPer: '7' }]),
    );

    const after = await lineRows(bomId);
    expect(after[2]?.quantityStatus).toBe('CONFIRMED');
    expect(after[2]?.quantityPer?.toFixed()).toBe('7');

    const audits = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);
    const summaries = audits.filter((row) => row.action === 'UPDATE');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.afterValue).toMatchObject({
      confirmedLineCount: 1,
      lineIds: [lineIds[2]],
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 수량 불변식 — TC-BOM-002 · TC-BOM-003 · TC-BOM-010
// ═══════════════════════════════════════════════════════════════

describe('★ 수량 불변식 (D-10 · §D-32 test matrix)', () => {
  it('★★ TC-BOM-002 — `0` 은 422 이고 **아무것도 저장되지 않는다**', async () => {
    const { bomId, lineIds } = await fixture('zero');

    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          STAFF,
          bomId,
          confirm([{ lineId: lineIds[0]!, quantityPer: '0' }]),
        ),
      ),
    ).toBe(ERROR_CODES.BOM_QTY_INVALID);

    const rows = await lineRows(bomId);
    expect(rows[0]?.quantityStatus).toBe('UNKNOWN');
    expect(rows[0]?.quantityPer).toBeNull();
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId)).toHaveLength(1); // CREATE 뿐
  });

  it('★★ TC-BOM-003 — `packQuantity=30` 과 `quantityPer=1/30` 은 **별도로** 저장된다', async () => {
    const parent = await newSku('pack-parent', { status: 'ACTIVE' });
    const component = await newSku('pack-c', { status: 'ACTIVE' });
    const created = await createBom(STAFF, bomInput(parent));
    const line = await createBomLine(
      STAFF,
      created.bom.id,
      lineInput(component, { quantityStatus: 'UNKNOWN', packQuantity: '30' }),
    );

    await bulkConfirmBomLineQuantities(
      STAFF,
      created.bom.id,
      // 1/30 = 0.033333… — **사람이** 계산해 보낸 값이다.
      confirm([{ lineId: line.line.id, quantityPer: '0.033333' }]),
    );

    const rows = await lineRows(created.bom.id);
    expect(rows[0]?.packQuantity?.toFixed()).toBe('30');
    expect(rows[0]?.quantityPer?.toFixed()).toBe('0.033333');
    // ★ 두 값은 서로 다른 사실이며 어느 쪽도 다른 쪽에서 파생되지 않았다.
    expect(rows[0]?.packQuantity?.toFixed()).not.toBe(rows[0]?.quantityPer?.toFixed());
  });

  it('★★ TC-BOM-010 — 서버가 `packQuantity` 로부터 수량을 만들지 않는다', async () => {
    const parent = await newSku('auto-parent', { status: 'ACTIVE' });
    const component = await newSku('auto-c', { status: 'ACTIVE' });
    const created = await createBom(STAFF, bomInput(parent));
    const line = await createBomLine(
      STAFF,
      created.bom.id,
      lineInput(component, { quantityStatus: 'UNKNOWN', packQuantity: '30' }),
    );

    // 이 라인을 **대상에서 빼고** 다른 라인만 확정한다.
    const other = await newSku('auto-c2', { status: 'ACTIVE' });
    const otherLine = await createBomLine(
      STAFF,
      created.bom.id,
      lineInput(other, { quantityStatus: 'UNKNOWN' }),
    );
    await bulkConfirmBomLineQuantities(
      STAFF,
      created.bom.id,
      confirm([{ lineId: otherLine.line.id, quantityPer: '1' }]),
    );

    const rows = await lineRows(created.bom.id);
    const untouched = rows.find((row) => row.id === line.line.id);
    // ⛔ 서버가 `1/30` 도, 자동 `"1"` 도 채우지 않았다.
    expect(untouched?.quantityPer).toBeNull();
    expect(untouched?.quantityStatus).toBe('UNKNOWN');
  });

  it('★ `"2"` 와 `"2.000000"` 은 같은 값이라 실변경이 아니다 (Decimal 비교)', async () => {
    const { bomId, lineIds } = await fixture('decimal-eq');
    // line 2 는 이미 CONFIRMED / 2.5 다. 먼저 "2" 로 확정한다.
    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[2]!, quantityPer: '2' }]),
    );
    const auditsAfterFirst = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);

    // 같은 값을 소수 표기만 바꿔 다시 보낸다 → 실변경 0.
    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[2]!, quantityPer: '2.000000' }]),
    );
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId)).toHaveLength(auditsAfterFirst.length);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. B4 — business no-op · mixed request
// ═══════════════════════════════════════════════════════════════

describe('★★ B4 — 실변경만 write 하고 Audit 도 실변경만 센다', () => {
  it('★★ 전부 이미 확정 + 같은 수량 → write 0 · Audit 0 · 200', async () => {
    const { bomId, lineIds } = await fixture('noop');
    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[0]!, quantityPer: '5' }]),
    );
    const auditsBefore = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);
    const rowsBefore = await lineRows(bomId);

    // 같은 내용을 **새 요청**으로 다시 보낸다 (멱등 키 없음 = replay 아님).
    const result = await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[0]!, quantityPer: '5' }]),
    );

    // 성공이며 현재 BomDetail 을 돌려준다.
    expect(result.replayed).toBe(false);
    expect(result.bom.id).toBe(bomId);
    // ⛔ write 0 · Audit 0.
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId)).toHaveLength(auditsBefore.length);
    expect(await lineRows(bomId)).toEqual(rowsBefore);
  });

  it('★★ mixed — 바뀌는 라인만 UPDATE 되고 Audit 요약이 그 라인만 센다', async () => {
    const { bomId, lineIds } = await fixture('mixed');
    // line 2 를 먼저 "2.5" 로 확정해 둔다(픽스처가 이미 그 값이다).
    const auditsBefore = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);

    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([
        { lineId: lineIds[0]!, quantityPer: '1' }, // UNKNOWN → 변경
        { lineId: lineIds[2]!, quantityPer: '2.5' }, // 이미 같은 값 → 변경 없음
      ]),
    );

    const audits = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);
    expect(audits).toHaveLength(auditsBefore.length + 1);
    const summary = audits.at(-1);
    expect(summary?.action).toBe('UPDATE');
    // ★ confirmedLineCount 는 **실제 변경 수** 1 이다 — 요청 건수 2 가 아니다.
    expect(summary?.afterValue).toMatchObject({
      confirmedLineCount: 1,
      lineIds: [lineIds[0]],
    });
    // ⛔ unchanged 라인은 lineIds 에 없다.
    expect(JSON.stringify(summary?.afterValue)).not.toContain(lineIds[2]!);
  });

  it('★ lineIds 는 id 오름차순으로 결정적이다', async () => {
    const { bomId, lineIds } = await fixture('order');
    // 역순으로 요청해도 요약은 정렬된 순서다.
    const reversed = [...lineIds].reverse();
    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm(reversed.map((lineId) => ({ lineId, quantityPer: '6' }))),
    );
    const audits = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);
    const summary = audits.at(-1)?.afterValue as { lineIds: string[] };
    expect(summary.lineIds).toEqual([...summary.lineIds].sort());
    expect(summary.lineIds).toHaveLength(3);
  });

  it('★ 라인별 Audit 을 만들지 않는다 (D-16) — 383행이면 383건이 될 것이다', async () => {
    const { bomId, lineIds } = await fixture('audit-shape');
    const beforeCounts = await Promise.all(
      lineIds.map(async (id) => (await auditsOf(BOM_LINE_ENTITY_TYPE, id)).length),
    );

    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm(lineIds.map((lineId) => ({ lineId, quantityPer: '8' }))),
    );

    const afterCounts = await Promise.all(
      lineIds.map(async (id) => (await auditsOf(BOM_LINE_ENTITY_TYPE, id)).length),
    );
    // ⛔ BomLine audit 이 한 건도 늘지 않았다.
    expect(afterCounts).toEqual(beforeCounts);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. 원자성 · nested ownership
// ═══════════════════════════════════════════════════════════════

describe('★★ 원자성 — 부분 성공을 만들지 않는다 (D-10)', () => {
  it('★★ 유효한 라인 + `0` 라인 → 전체 rollback · Audit 0', async () => {
    const { bomId, lineIds } = await fixture('atomic');
    const rowsBefore = await lineRows(bomId);
    const auditsBefore = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);

    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          STAFF,
          bomId,
          confirm([
            { lineId: lineIds[0]!, quantityPer: '1' }, // 유효
            { lineId: lineIds[1]!, quantityPer: '0' }, // ⛔ invalid
          ]),
        ),
      ),
    ).toBe(ERROR_CODES.BOM_QTY_INVALID);

    // ★ 유효했던 라인도 바뀌지 않았다.
    expect(await lineRows(bomId)).toEqual(rowsBefore);
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId)).toHaveLength(auditsBefore.length);
  });

  it('★★ 다른 BOM 의 lineId 를 섞으면 404 이고 전체 실패한다 — 조용히 건너뛰지 않는다', async () => {
    const a = await fixture('own-a');
    const b = await fixture('own-b');
    const rowsBefore = await lineRows(a.bomId);

    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          STAFF,
          a.bomId,
          confirm([
            { lineId: a.lineIds[0]!, quantityPer: '1' },
            { lineId: b.lineIds[0]!, quantityPer: '1' }, // ⛔ 다른 BOM
          ]),
        ),
      ),
    ).toBe(ERROR_CODES.BOM_NOT_FOUND);

    expect(await lineRows(a.bomId)).toEqual(rowsBefore);
    // 다른 BOM 도 전혀 건드리지 않았다.
    const bRows = await lineRows(b.bomId);
    expect(bRows[0]?.quantityStatus).toBe('UNKNOWN');
  });

  it('존재하지 않는 lineId 는 404', async () => {
    const { bomId } = await fixture('missing-line');
    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          STAFF,
          bomId,
          confirm([{ lineId: '00000000-0000-4000-8000-000000000000', quantityPer: '1' }]),
        ),
      ),
    ).toBe(ERROR_CODES.BOM_NOT_FOUND);
  });

  it('존재하지 않는 bomId 는 404', async () => {
    const { lineIds } = await fixture('missing-bom');
    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          STAFF,
          '00000000-0000-4000-8000-000000000001',
          confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
        ),
      ),
    ).toBe(ERROR_CODES.BOM_NOT_FOUND);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. topology / 부수효과 없음
// ═══════════════════════════════════════════════════════════════

describe('★★ 수량 전용 — topology 와 packQuantity 를 건드리지 않는다', () => {
  it('★★ 확정 후 두 컬럼 외에는 한 글자도 바뀌지 않았다', async () => {
    const parent = await newSku('side-parent', { status: 'ACTIVE' });
    const component = await newSku('side-c', { status: 'ACTIVE' });
    const created = await createBom(STAFF, bomInput(parent));
    const line = await createBomLine(
      STAFF,
      created.bom.id,
      lineInput(component, {
        quantityStatus: 'UNKNOWN',
        packQuantity: '12',
        alternateGroup: 'ALT-A',
        componentRole: 'SERVICE',
        supplyType: 'TURNKEY',
        isRequired: false,
        note: '유지되어야 한다',
      }),
    );

    const before = (await lineRows(created.bom.id))[0]!;

    await bulkConfirmBomLineQuantities(
      STAFF,
      created.bom.id,
      confirm([{ lineId: line.line.id, quantityPer: '3' }]),
    );

    const after = (await lineRows(created.bom.id))[0]!;
    // 바뀐 것은 정확히 두 개다.
    expect(after.quantityStatus).toBe('CONFIRMED');
    expect(after.quantityPer?.toFixed()).toBe('3');
    // 나머지는 전부 그대로다 — 특히 topology field.
    expect(after.componentSkuId).toBe(before.componentSkuId);
    expect(after.componentRole).toBe(before.componentRole);
    expect(after.alternateGroup).toBe(before.alternateGroup);
    expect(after.isRequired).toBe(before.isRequired);
    expect(after.uom).toBe(before.uom);
    expect(after.lineNo).toBe(before.lineNo);
    expect(after.packQuantity?.toFixed()).toBe(before.packQuantity?.toFixed());
  });

  it('★ optional line(`isRequired=false`)도 똑같이 확정된다 — submit 게이트와 다른 축이다', async () => {
    const parent = await newSku('opt-parent', { status: 'ACTIVE' });
    const component = await newSku('opt-c', { status: 'ACTIVE' });
    const created = await createBom(STAFF, bomInput(parent));
    const line = await createBomLine(
      STAFF,
      created.bom.id,
      lineInput(component, { quantityStatus: 'UNKNOWN', isRequired: false }),
    );

    await bulkConfirmBomLineQuantities(
      STAFF,
      created.bom.id,
      confirm([{ lineId: line.line.id, quantityPer: '2' }]),
    );

    const rows = await lineRows(created.bom.id);
    expect(rows[0]?.quantityStatus).toBe('CONFIRMED');
    expect(rows[0]?.isRequired).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. 편집 가능 상태 matrix (D-6)
// ═══════════════════════════════════════════════════════════════

describe('★★ 편집 가능 상태 7종 matrix (D-6)', () => {
  const ALLOWED = ['DRAFT', 'REJECTED'];
  const DENIED: readonly [string, string][] = [
    ['PENDING_APPROVAL', ERROR_CODES.BOM_NOT_EDITABLE],
    ['APPROVED', ERROR_CODES.BOM_NOT_EDITABLE],
    ['ACTIVE', ERROR_CODES.BOM_ACTIVE_IMMUTABLE],
    ['INACTIVE', ERROR_CODES.BOM_NOT_EDITABLE],
    ['ARCHIVED', ERROR_CODES.BOM_NOT_EDITABLE],
  ];

  it.each(ALLOWED)('%s 는 확정할 수 있다', async (status) => {
    const { bomId, lineIds } = await fixture(`edit-${status}`);
    await setStatus(bomId, status);
    await expect(
      bulkConfirmBomLineQuantities(
        STAFF,
        bomId,
        confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
      ),
    ).resolves.toBeDefined();
  });

  it.each(DENIED)('★ %s 는 %s 로 막힌다', async (status, code) => {
    const { bomId, lineIds } = await fixture(`edit-${status}`);
    await setStatus(bomId, status);
    const rowsBefore = await lineRows(bomId);

    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          STAFF,
          bomId,
          confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
        ),
      ),
    ).toBe(code);
    // write 0.
    expect(await lineRows(bomId)).toEqual(rowsBefore);
  });

  it('★★ TC-BOM-005 — ACTIVE 는 `BOM_ACTIVE_IMMUTABLE` 이며 `BOM_NOT_EDITABLE` 이 아니다', async () => {
    const { bomId, lineIds } = await fixture('active-immutable');
    await setStatus(bomId, 'ACTIVE');
    const code = await codeOf(
      bulkConfirmBomLineQuantities(
        STAFF,
        bomId,
        confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
      ),
    );
    expect(code).toBe(ERROR_CODES.BOM_ACTIVE_IMMUTABLE);
    expect(code).not.toBe(ERROR_CODES.BOM_NOT_EDITABLE);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. 권한 (D-15)
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — 2차 가드 (D-15)', () => {
  it('★ FINANCE 는 read 만 — 확정은 403 이고 write·Audit 이 0 이다', async () => {
    const { bomId, lineIds } = await fixture('perm-finance');
    const rowsBefore = await lineRows(bomId);
    const auditsBefore = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);

    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          FINANCE,
          bomId,
          confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
        ),
      ),
    ).toBe(ERROR_CODES.FORBIDDEN);

    expect(await lineRows(bomId)).toEqual(rowsBefore);
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId)).toHaveLength(auditsBefore.length);
    // 읽기는 여전히 된다.
    await expect(getBom(FINANCE, bomId)).resolves.toMatchObject({ id: bomId });
  });

  it('★ EXECUTIVE 도 확정은 403 이다 (read 는 가능)', async () => {
    const { bomId, lineIds } = await fixture('perm-exec');
    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          EXECUTIVE,
          bomId,
          confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
        ),
      ),
    ).toBe(ERROR_CODES.FORBIDDEN);
    await expect(getBom(EXECUTIVE, bomId)).resolves.toBeDefined();
  });

  it('★★ ADMIN role 이어도 permission 데이터가 없으면 403 — bypass 없음', async () => {
    const { bomId, lineIds } = await fixture('perm-admin');
    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          NO_PERMISSION,
          bomId,
          confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
        ),
      ),
    ).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('★ 권한 검사가 멱등 replay 보다 먼저다 — 권한을 잃으면 replay 도 403', async () => {
    const { bomId, lineIds } = await fixture('perm-replay');
    const key = `k-${randomBytes(6).toString('hex')}`;
    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
      {},
      key,
    );
    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          FINANCE,
          bomId,
          confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
          {},
          key,
        ),
      ),
    ).toBe(ERROR_CODES.FORBIDDEN);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. 멱등 (D-17)
// ═══════════════════════════════════════════════════════════════

describe('★★ 멱등 — scope 는 `bom:{bomId}:line:bulk-confirm` (D-17)', () => {
  it('★★ 같은 키 + 같은 payload → replay 이고 Audit 이 늘지 않는다', async () => {
    const { bomId, lineIds } = await fixture('idem-replay');
    const key = `k-${randomBytes(6).toString('hex')}`;
    const payload = confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]);

    const first = await bulkConfirmBomLineQuantities(STAFF, bomId, payload, {}, key);
    const auditsAfterFirst = await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId);

    const second = await bulkConfirmBomLineQuantities(STAFF, bomId, payload, {}, key);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // ★ 저장된 snapshot 을 그대로 돌려준다.
    expect(second.bom.id).toBe(first.bom.id);
    expect(second.bom.unconfirmedCount).toBe(first.bom.unconfirmedCount);
    expect(await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId)).toHaveLength(auditsAfterFirst.length);
  });

  it('★ 같은 키 + 다른 payload → 409 `IDEMPOTENCY_KEY_REUSED`', async () => {
    const { bomId, lineIds } = await fixture('idem-conflict');
    const key = `k-${randomBytes(6).toString('hex')}`;
    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
      {},
      key,
    );
    expect(
      await codeOf(
        bulkConfirmBomLineQuantities(
          STAFF,
          bomId,
          confirm([{ lineId: lineIds[0]!, quantityPer: '2' }]),
          {},
          key,
        ),
      ),
    ).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  });

  it('★★ scope 에 bomId 가 있으므로 다른 BOM 은 같은 키를 써도 독립이다', async () => {
    const a = await fixture('idem-a');
    const b = await fixture('idem-b');
    const key = `k-${randomBytes(6).toString('hex')}`;

    const first = await bulkConfirmBomLineQuantities(
      STAFF,
      a.bomId,
      confirm([{ lineId: a.lineIds[0]!, quantityPer: '1' }]),
      {},
      key,
    );
    const second = await bulkConfirmBomLineQuantities(
      STAFF,
      b.bomId,
      confirm([{ lineId: b.lineIds[0]!, quantityPer: '1' }]),
      {},
      key,
    );

    expect(first.replayed).toBe(false);
    // ⛔ 다른 BOM 인데 replay 로 오인하지 않는다.
    expect(second.replayed).toBe(false);
    expect(second.bom.id).toBe(b.bomId);
  });

  it('★★ business no-op 과 replay 는 다르다 — 전자는 새 키로 성공 저장된다', async () => {
    const { bomId, lineIds } = await fixture('idem-noop');
    const payload = confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]);
    await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      payload,
      {},
      `k-${randomBytes(6).toString('hex')}`,
    );

    // 같은 내용을 **새 키**로 보낸다 — replay 가 아니라 business no-op 이다.
    const noopKey = `k-${randomBytes(6).toString('hex')}`;
    const noop = await bulkConfirmBomLineQuantities(STAFF, bomId, payload, {}, noopKey);
    expect(noop.replayed).toBe(false);

    // 그 새 키로 다시 보내면 이번엔 replay 다.
    const replay = await bulkConfirmBomLineQuantities(STAFF, bomId, payload, {}, noopKey);
    expect(replay.replayed).toBe(true);

    // 성공 snapshot 이 실제로 저장돼 있다.
    const records = await getPrismaClient().idempotencyRecord.findMany({
      where: { actorId: STAFF_ID, idempotencyKey: noopKey },
      select: { responseStatus: true, routeScope: true },
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.responseStatus).toBe(200);
    expect(records[0]?.routeScope).toBe(`bom:${bomId}:line:bulk-confirm`);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. 응답 · count 정합 (B3 · §32)
// ═══════════════════════════════════════════════════════════════

describe('★★ 응답은 BomDetail 이며 count 가 정확히 움직인다', () => {
  it('★★ unconfirmedCount 는 줄고 lineCount 는 그대로다', async () => {
    const { bomId, lineIds } = await fixture('counts');
    const before = await getBom(STAFF, bomId);
    // UNKNOWN 1 + SUGGESTED 1 = 미확정 2, 전체 3.
    expect(before.lineCount).toBe(3);
    expect(before.unconfirmedCount).toBe(2);

    const result = await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[0]!, quantityPer: '1' }]),
    );

    // 응답이 곧 최신 BomDetail 이다 — 다시 조회하지 않아도 된다.
    expect(result.bom.lineCount).toBe(3);
    expect(result.bom.unconfirmedCount).toBe(1);

    // 목록의 집계도 같은 값이다 — 별도 캐시 컬럼이 없다.
    const list = await listBoms(STAFF, { page: 1 });
    const row = list.items.find((item) => item.id === bomId);
    expect(row?.lineCount).toBe(3);
    expect(row?.unconfirmedCount).toBe(1);
  });

  it('★ 전부 확정하면 unconfirmedCount 가 0 이 된다', async () => {
    const { bomId, lineIds } = await fixture('counts-all');
    const result = await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm(lineIds.map((lineId) => ({ lineId, quantityPer: '1' }))),
    );
    expect(result.bom.unconfirmedCount).toBe(0);
    expect(result.bom.lineCount).toBe(3);
  });

  it('★ 응답 lines 의 Decimal 은 문자열이다', async () => {
    const { bomId, lineIds } = await fixture('resp-decimal');
    const result = await bulkConfirmBomLineQuantities(
      STAFF,
      bomId,
      confirm([{ lineId: lineIds[0]!, quantityPer: '0.033333' }]),
    );
    const line = result.bom.lines.find((entry) => entry.id === lineIds[0]);
    expect(typeof line?.quantityPer).toBe('string');
    expect(line?.quantityPer).toBe('0.033333');
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. 동시성 (§44 · §45)
// ═══════════════════════════════════════════════════════════════

describe('★★ 동시성 — header row lock 으로 직렬화된다 (D-28)', () => {
  it('★★ bulk vs bulk — 서로 다른 수량이 동시에 와도 lost update 가 없다', async () => {
    const { bomId, lineIds } = await fixture('conc-bulk');
    const target = lineIds[0]!;

    const [a, b] = await Promise.all([
      bulkConfirmBomLineQuantities(
        STAFF,
        bomId,
        confirm([{ lineId: target, quantityPer: '11' }]),
      ).then(() => 'ok' as const),
      bulkConfirmBomLineQuantities(
        STAFF2,
        bomId,
        confirm([{ lineId: target, quantityPer: '22' }]),
      ).then(() => 'ok' as const),
    ]);
    // 둘 다 합법이다 — 나중에 커밋한 쪽이 최종값이 된다(덮어쓰기 계약).
    expect([a, b]).toEqual(['ok', 'ok']);

    const rows = await lineRows(bomId);
    const final = rows.find((row) => row.id === target);
    expect(final?.quantityStatus).toBe('CONFIRMED');
    // ★ 최종값은 **둘 중 하나**여야 한다 — 섞인 값이 나오면 lost update 다.
    expect(['11', '22']).toContain(final?.quantityPer?.toFixed());

    // Audit 은 실제 변경 횟수만큼만 남는다 (1 또는 2 — 두 번째가 값이 다르면 2).
    const audits = (await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId)).filter(
      (row) => row.action === 'UPDATE',
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.length).toBeLessThanOrEqual(2);
  });

  it('★★ bulk vs line PATCH — 최종 상태가 직렬 실행 중 하나와 일치한다', async () => {
    const { bomId, lineIds } = await fixture('conc-patch');
    const target = lineIds[0]!;

    const [bulkOutcome, patchOutcome] = await Promise.all([
      bulkConfirmBomLineQuantities(
        STAFF,
        bomId,
        confirm([{ lineId: target, quantityPer: '5' }]),
      ).then(
        () => 'ok' as const,
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
      updateBomLine(STAFF2, bomId, target, {
        quantityPer: '9',
        quantityStatus: 'SUGGESTED',
      }).then(
        () => 'ok' as const,
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
    ]);

    // 둘 다 편집 가능 상태의 합법 명령이므로 성공한다.
    expect(bulkOutcome).toBe('ok');
    expect(patchOutcome).toBe('ok');

    const rows = await lineRows(bomId);
    const final = rows.find((row) => row.id === target)!;
    // ★ 최종 상태는 **둘 중 하나의 완결된 결과**여야 한다 — 섞이면 안 된다.
    //   bulk 가 나중이면 CONFIRMED/5, PATCH 가 나중이면 SUGGESTED/9 다.
    const serialized =
      (final.quantityStatus === 'CONFIRMED' && final.quantityPer?.toFixed() === '5') ||
      (final.quantityStatus === 'SUGGESTED' && final.quantityPer?.toFixed() === '9');
    expect(
      serialized,
      `섞인 상태: ${final.quantityStatus} / ${String(final.quantityPer?.toFixed())}`,
    ).toBe(true);
  });

  it('★★ 같은 멱등 키로 동시 요청 — 한 번만 실행되고 Audit 도 1건이다', async () => {
    const { bomId, lineIds } = await fixture('conc-idem');
    const key = `k-${randomBytes(6).toString('hex')}`;
    const payload = confirm([{ lineId: lineIds[0]!, quantityPer: '3' }]);

    const outcomes = await Promise.all([
      bulkConfirmBomLineQuantities(STAFF, bomId, payload, {}, key).then(
        (result) => (result.replayed ? 'replay' : 'executed'),
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
      bulkConfirmBomLineQuantities(STAFF, bomId, payload, {}, key).then(
        (result) => (result.replayed ? 'replay' : 'executed'),
        (error: { code?: string }) => error.code ?? 'unknown',
      ),
    ]);

    // 최소 한 쪽은 실제 실행이다. 다른 쪽은 replay 이거나(순차화 성공)
    // 동시 claim 경합으로 실패할 수 있다 — 어느 쪽이든 **두 번 실행되지 않는다.**
    expect(outcomes.filter((outcome) => outcome === 'executed').length).toBe(1);

    const audits = (await auditsOf(BOM_HEADER_ENTITY_TYPE, bomId)).filter(
      (row) => row.action === 'UPDATE',
    );
    expect(audits).toHaveLength(1);
  });
});
