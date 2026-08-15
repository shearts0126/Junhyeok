import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrismaClient } from '@/shared/db';

/**
 * BomHeader · BomLine 스키마·DB 제약 테스트 (T07-1) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md`
 *       (2026-08-13 BOM Design Recovery Decision — D-1 ~ D-32)
 *
 * T07-1 은 스키마·migration 단계다. 도메인(T07-2)·CRUD API(T07-3)·소요량(T07-4)·
 * 워크플로(T07-5)·전개(T07-6)·원가(T07-7)·화면(T07-8)이 전부 없으므로, 모든 검증은
 * **PostgreSQL 제약이 직접 거부/허용**하는지를 본다.
 *
 * ⚠️ `prisma migrate diff` 는 **표현식 인덱스·EXCLUDE·extension 을 보지 못한다.**
 *    raw SQL 을 빼먹어도 drift gate 는 통과한다 — 아래 카탈로그 테스트가
 *    `bom_header_active_period_excl` · `ux_bom_line_component_group` ·
 *    `bom_header_effective_period_check` 의 **유일한 방어선**이다.
 *
 * ⚠️ staged scalar 2종(`destination_warehouse_id`·`issue_warehouse_id`)에 FK 가
 *    **없는 것**도 함께 고정한다. FK 누락 사고가 아니라 T08-1 을 기다리는 의도된
 *    상태이며, T08-1 이 구현될 때 이 테스트는 **반대 방향으로 바뀌어야 한다**.
 *
 * ⛔ 순환(cycle)·상태 전이·소요량 정합·UOM 일치는 여기서 검증하지 않는다 —
 *    전부 application semantics 이며 T07-2 이후다.
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TBM-${RUN}-${suffix}`;

const USER_A = 'dddddddd-0000-4000-8000-0000000b7001';
const USER_B = 'dddddddd-0000-4000-8000-0000000b7002';
const USER_IDS = [USER_A, USER_B];

/** 어떤 테이블에도 없는 UUID — staged scalar 가 FK 없이 저장되는지 확인용. */
const ORPHAN_WAREHOUSE_ID = 'eeeeeeee-0000-4000-8000-0000000b7009';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

let seq = 0;

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TBM-' } } } },
  });
  await client.bomHeader.deleteMany({
    where: { parentSku: { skuCode: { startsWith: 'TBM-' } } },
  });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TBM-' } } });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TBM-' } } });
  await client.user.deleteMany({ where: { id: { in: USER_IDS } } });
}

beforeAll(async () => {
  await cleanup();
  await getPrismaClient().user.createMany({
    data: [
      { id: USER_A, email: 'bom-a@deeppoint.test', name: 'BOM 작성자' },
      { id: USER_B, email: 'bom-b@deeppoint.test', name: 'BOM 승인자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

async function newSku(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `BOM 테스트 SKU (${label})`,
      itemType: 'FINISHED_GOOD',
    },
    select: { id: true },
  });
  return row.id;
}

async function newSupplier(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().supplier.create({
    data: {
      supplierCode: CODE(`S${String(seq).padStart(3, '0')}`),
      supplierName: `BOM 조립처 (${label})`,
      supplierType: 'MANUFACTURER',
    },
    select: { id: true },
  });
  return row.id;
}

interface HeaderInput {
  readonly version?: string;
  readonly status?:
    'DRAFT' | 'PENDING_APPROVAL' | 'REJECTED' | 'APPROVED' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  readonly from: string;
  readonly to?: string | null;
  readonly productionPartnerId?: string | null;
  readonly destinationWarehouseId?: string | null;
}

async function newHeader(parentSkuId: string, input: HeaderInput): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().bomHeader.create({
    data: {
      parentSkuId,
      bomType: 'MANUFACTURING',
      version: input.version ?? `v${String(seq).padStart(3, '0')}`,
      status: input.status ?? 'DRAFT',
      outputUom: 'EA',
      effectiveFrom: d(input.from),
      effectiveTo: input.to === undefined || input.to === null ? null : d(input.to),
      ...(input.productionPartnerId === undefined
        ? {}
        : { productionPartnerId: input.productionPartnerId }),
      ...(input.destinationWarehouseId === undefined
        ? {}
        : { destinationWarehouseId: input.destinationWarehouseId }),
    },
    select: { id: true },
  });
  return row.id;
}

interface LineInput {
  readonly lineNo?: number;
  readonly alternateGroup?: string | null;
  readonly issueWarehouseId?: string | null;
}

let lineSeq = 0;

async function newLine(
  bomHeaderId: string,
  componentSkuId: string,
  input: LineInput = {},
): Promise<string> {
  lineSeq += 1;
  const row = await getPrismaClient().bomLine.create({
    data: {
      bomHeaderId,
      componentSkuId,
      lineNo: input.lineNo ?? lineSeq,
      uom: 'EA',
      componentRole: 'MATERIAL',
      ...(input.alternateGroup === undefined ? {} : { alternateGroup: input.alternateGroup }),
      ...(input.issueWarehouseId === undefined ? {} : { issueWarehouseId: input.issueWarehouseId }),
    },
    select: { id: true },
  });
  return row.id;
}

// ═══════════════════════════════════════════════════════════════
// 1. BomHeader — 기본 · 버전 UNIQUE (D-2 · D-4)
// ═══════════════════════════════════════════════════════════════

describe('BomHeader 기본 (D-2)', () => {
  it('1. 최소 필드로 생성되고 default 가 적용된다', async () => {
    const skuId = await newSku('기본');
    const id = await newHeader(skuId, { from: '2026-01-01' });

    const row = await getPrismaClient().bomHeader.findUniqueOrThrow({ where: { id } });
    // ★ status default 는 DRAFT, outputQty default 는 1 이다.
    expect(row.status).toBe('DRAFT');
    expect(row.outputQty.toString()).toBe('1');
    expect(row.effectiveTo).toBeNull();
    // 승인·활성화 타임스탬프는 전부 비어 있다 (T07-5 가 채운다).
    expect(row.approvedAt).toBeNull();
    expect(row.approvedBy).toBeNull();
    expect(row.activatedAt).toBeNull();
  });

  it('2. ★ (parentSkuId, version) 중복은 거부된다 (D-4)', async () => {
    const skuId = await newSku('버전중복');
    await newHeader(skuId, { version: 'v1.0', from: '2026-01-01' });

    await expect(newHeader(skuId, { version: 'v1.0', from: '2027-01-01' })).rejects.toThrow(
      /Unique constraint/i,
    );
  });

  it('3. 다른 상위 SKU 라면 같은 version 을 쓸 수 있다', async () => {
    const skuA = await newSku('버전A');
    const skuB = await newSku('버전B');
    await newHeader(skuA, { version: 'v1.0', from: '2026-01-01' });

    await expect(newHeader(skuB, { version: 'v1.0', from: '2026-01-01' })).resolves.toBeTruthy();
  });

  it('★ version 은 case-sensitive 다 — v1.0 과 V1.0 은 다른 버전이다 (D-4)', async () => {
    const skuId = await newSku('대소문자');
    await newHeader(skuId, { version: 'v1.0', from: '2026-01-01' });

    await expect(newHeader(skuId, { version: 'V1.0', from: '2026-01-01' })).resolves.toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 적용기간 — CHECK · ACTIVE EXCLUDE (D-5 · D-7)
// ═══════════════════════════════════════════════════════════════

describe('★ 적용기간 CHECK (D-5)', () => {
  it('9. effectiveTo <= effectiveFrom 은 거부된다', async () => {
    const skuId = await newSku('기간CHECK');

    // 역전 구간
    await expect(newHeader(skuId, { from: '2026-06-01', to: '2026-01-01' })).rejects.toThrow(
      /bom_header_effective_period_check|violates check constraint/i,
    );
    // zero-length (같은 날) — half-open 이라 빈 구간이다
    await expect(newHeader(skuId, { from: '2026-06-01', to: '2026-06-01' })).rejects.toThrow(
      /bom_header_effective_period_check|violates check constraint/i,
    );
  });

  it('8. effectiveTo=null 은 무기한으로 허용된다', async () => {
    const skuId = await newSku('무기한');
    await expect(newHeader(skuId, { from: '2026-01-01', to: null })).resolves.toBeTruthy();
  });
});

describe('★★ ACTIVE 적용기간 EXCLUDE (D-5 · D-7)', () => {
  it('4. 같은 상위 SKU 의 ACTIVE 기간이 겹치면 거부된다', async () => {
    const skuId = await newSku('중첩');
    await newHeader(skuId, { status: 'ACTIVE', from: '2026-01-01', to: '2027-01-01' });

    // 부분 중첩
    await expect(
      newHeader(skuId, { status: 'ACTIVE', from: '2026-06-01', to: '2027-06-01' }),
    ).rejects.toThrow(/bom_header_active_period_excl|conflicting key value/i);
  });

  it('4-b. 완전 포함 · 동일 시작일 · open-ended 중첩도 전부 거부된다', async () => {
    const skuId = await newSku('중첩변형');
    await newHeader(skuId, { status: 'ACTIVE', from: '2026-01-01', to: '2027-01-01' });

    // 완전 포함
    await expect(
      newHeader(skuId, { status: 'ACTIVE', from: '2026-03-01', to: '2026-04-01' }),
    ).rejects.toThrow(/bom_header_active_period_excl|conflicting key value/i);
    // 동일 시작일
    await expect(
      newHeader(skuId, { status: 'ACTIVE', from: '2026-01-01', to: '2026-02-01' }),
    ).rejects.toThrow(/bom_header_active_period_excl|conflicting key value/i);
    // open-ended 가 기존 구간을 삼킨다
    await expect(
      newHeader(skuId, { status: 'ACTIVE', from: '2025-01-01', to: null }),
    ).rejects.toThrow(/bom_header_active_period_excl|conflicting key value/i);
  });

  it('★ 5. half-open 경계는 겹치지 않는다 — [A,T) 와 [T,B) 는 둘 다 ACTIVE 가능', async () => {
    const skuId = await newSku('경계');
    await newHeader(skuId, { status: 'ACTIVE', from: '2026-01-01', to: '2027-01-01' });

    // ★ 이것이 D-7 의 버전 교체다 — predecessor 를 T 로 마감하고 successor 가 T 에 시작한다.
    await expect(
      newHeader(skuId, { status: 'ACTIVE', from: '2027-01-01', to: null }),
    ).resolves.toBeTruthy();
  });

  it('6. 겹치지 않는 ACTIVE 구간은 여러 개 허용된다 (gap 도 정상)', async () => {
    const skuId = await newSku('비중첩');
    await newHeader(skuId, { status: 'ACTIVE', from: '2020-01-01', to: '2021-01-01' });
    await newHeader(skuId, { status: 'ACTIVE', from: '2023-01-01', to: '2024-01-01' });
    await expect(
      newHeader(skuId, { status: 'ACTIVE', from: '2026-01-01', to: null }),
    ).resolves.toBeTruthy();

    const rows = await getPrismaClient().bomHeader.count({
      where: { parentSkuId: skuId, status: 'ACTIVE' },
    });
    expect(rows).toBe(3);
  });

  it('★★ 7. ACTIVE 가 아닌 status 는 기간이 겹쳐도 허용된다 — SupplierSku 와 다르다', async () => {
    const skuId = await newSku('비활성중첩');
    // 완전히 같은 기간을 여러 후보 버전이 동시에 준비한다 (D-5).
    await newHeader(skuId, { status: 'DRAFT', from: '2026-01-01', to: '2027-01-01' });
    await newHeader(skuId, { status: 'PENDING_APPROVAL', from: '2026-01-01', to: '2027-01-01' });
    await newHeader(skuId, { status: 'APPROVED', from: '2026-01-01', to: '2027-01-01' });
    await newHeader(skuId, { status: 'REJECTED', from: '2026-01-01', to: '2027-01-01' });
    await newHeader(skuId, { status: 'INACTIVE', from: '2026-01-01', to: '2027-01-01' });
    await expect(
      newHeader(skuId, { status: 'ARCHIVED', from: '2026-01-01', to: '2027-01-01' }),
    ).resolves.toBeTruthy();

    // 그 위에 ACTIVE 하나는 여전히 들어간다 (EXCLUDE 는 ACTIVE 끼리만 본다).
    await expect(
      newHeader(skuId, { status: 'ACTIVE', from: '2026-01-01', to: '2027-01-01' }),
    ).resolves.toBeTruthy();
  });

  it('다른 상위 SKU 라면 같은 기간에 ACTIVE 를 가질 수 있다', async () => {
    const skuA = await newSku('활성A');
    const skuB = await newSku('활성B');
    await newHeader(skuA, { status: 'ACTIVE', from: '2026-01-01', to: null });
    await expect(
      newHeader(skuB, { status: 'ACTIVE', from: '2026-01-01', to: null }),
    ).resolves.toBeTruthy();
  });

  it('★ DRAFT → ACTIVE 로 UPDATE 할 때도 EXCLUDE 가 적용된다', async () => {
    const skuId = await newSku('전이중첩');
    await newHeader(skuId, { status: 'ACTIVE', from: '2026-01-01', to: null });
    const draftId = await newHeader(skuId, { status: 'DRAFT', from: '2026-06-01', to: null });

    await expect(
      getPrismaClient().bomHeader.update({
        where: { id: draftId },
        data: { status: 'ACTIVE' },
      }),
    ).rejects.toThrow(/bom_header_active_period_excl|conflicting key value/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. BomLine — lineNo UNIQUE · 중복 구성품 (D-3 · D-9)
// ═══════════════════════════════════════════════════════════════

describe('BomLine lineNo UNIQUE (D-2)', () => {
  it('10. 같은 헤더 안에서 lineNo 중복은 거부된다', async () => {
    const parent = await newSku('라인번호');
    const child = await newSku('라인번호부품');
    const headerId = await newHeader(parent, { from: '2026-01-01' });
    await newLine(headerId, child, { lineNo: 1 });

    const other = await newSku('라인번호부품2');
    await expect(newLine(headerId, other, { lineNo: 1 })).rejects.toThrow(/Unique constraint/i);
  });

  it('11. 다른 헤더라면 같은 lineNo 를 쓸 수 있다', async () => {
    const parent = await newSku('라인번호헤더');
    const child = await newSku('라인번호헤더부품');
    const h1 = await newHeader(parent, { version: 'v1', from: '2026-01-01' });
    const h2 = await newHeader(parent, { version: 'v2', from: '2027-01-01' });
    await newLine(h1, child, { lineNo: 1 });

    await expect(newLine(h2, child, { lineNo: 1 })).resolves.toBeTruthy();
  });

  it('BomLine 기본값 — quantityPer null · quantityStatus UNKNOWN · isRequired true', async () => {
    const parent = await newSku('라인기본');
    const child = await newSku('라인기본부품');
    const headerId = await newHeader(parent, { from: '2026-01-01' });
    const lineId = await newLine(headerId, child);

    const row = await getPrismaClient().bomLine.findUniqueOrThrow({ where: { id: lineId } });
    // ★ 소요량은 비어 있고 **1 이 자동 입력되지 않는다** (§00 G-02, D-10).
    expect(row.quantityPer).toBeNull();
    expect(row.quantityStatus).toBe('UNKNOWN');
    expect(row.isRequired).toBe(true);
    expect(row.packQuantity).toBeNull();
    expect(row.alternateGroup).toBeNull();
  });
});

describe('★★ 중복 구성품 차단 — COALESCE 표현식 UNIQUE (D-3)', () => {
  it('★ Case A. 같은 헤더 · 같은 구성품 · alternateGroup NULL 2행 → 두 번째 거부', async () => {
    const parent = await newSku('중복A');
    const child = await newSku('중복A부품');
    const headerId = await newHeader(parent, { from: '2026-01-01' });
    await newLine(headerId, child, { lineNo: 1, alternateGroup: null });

    // ⚠️ 일반 UNIQUE 였다면 PostgreSQL 이 NULL 을 서로 다른 값으로 보아 **통과**한다.
    //    `COALESCE(alternate_group, '')` 표현식 인덱스만 이것을 막는다.
    await expect(newLine(headerId, child, { lineNo: 2, alternateGroup: null })).rejects.toThrow(
      /Unique constraint|ux_bom_line_component_group/i,
    );
  });

  it('Case B. 같은 헤더 · 같은 구성품 · 같은 alternateGroup 2행 → 두 번째 거부', async () => {
    const parent = await newSku('중복B');
    const child = await newSku('중복B부품');
    const headerId = await newHeader(parent, { from: '2026-01-01' });
    await newLine(headerId, child, { lineNo: 1, alternateGroup: 'ALT-A' });

    await expect(newLine(headerId, child, { lineNo: 2, alternateGroup: 'ALT-A' })).rejects.toThrow(
      /Unique constraint|ux_bom_line_component_group/i,
    );
  });

  it('★ Case C. alternateGroup 이 다르면 같은 구성품도 복수 라인 허용', async () => {
    const parent = await newSku('중복C');
    const child = await newSku('중복C부품');
    const headerId = await newHeader(parent, { from: '2026-01-01' });
    await newLine(headerId, child, { lineNo: 1, alternateGroup: 'ALT-A' });

    await expect(
      newLine(headerId, child, { lineNo: 2, alternateGroup: 'ALT-B' }),
    ).resolves.toBeTruthy();
  });

  it('Case C-2. NULL 과 non-null 은 다른 그룹이다', async () => {
    const parent = await newSku('중복C2');
    const child = await newSku('중복C2부품');
    const headerId = await newHeader(parent, { from: '2026-01-01' });
    await newLine(headerId, child, { lineNo: 1, alternateGroup: null });

    await expect(
      newLine(headerId, child, { lineNo: 2, alternateGroup: 'ALT-A' }),
    ).resolves.toBeTruthy();
  });

  it('Case D. 다른 헤더라면 같은 구성품 · NULL 그룹도 둘 다 허용', async () => {
    const parent = await newSku('중복D');
    const child = await newSku('중복D부품');
    const h1 = await newHeader(parent, { version: 'v1', from: '2026-01-01' });
    const h2 = await newHeader(parent, { version: 'v2', from: '2027-01-01' });
    await newLine(h1, child, { lineNo: 1, alternateGroup: null });

    await expect(newLine(h2, child, { lineNo: 1, alternateGroup: null })).resolves.toBeTruthy();
  });

  it("★ 센티넬 확인 — alternate_group='' 는 NULL 과 같은 키로 충돌한다", async () => {
    const parent = await newSku('센티넬');
    const child = await newSku('센티넬부품');
    const headerId = await newHeader(parent, { from: '2026-01-01' });
    await newLine(headerId, child, { lineNo: 1, alternateGroup: null });

    // ⚠️ DB 는 ''(센티넬)과 NULL 을 같은 키로 접는다. 이것이 의도된 동작이며,
    //    그래서 API 는 blank 를 null 로 정규화해 ''가 저장되지 않게 한다 (T07-3, D-3).
    await expect(newLine(headerId, child, { lineNo: 2, alternateGroup: '' })).rejects.toThrow(
      /Unique constraint|ux_bom_line_component_group/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. relation · FK (D-2 · D-32)
// ═══════════════════════════════════════════════════════════════

describe('FK 무결성 (D-2)', () => {
  it('16·17. 없는 parentSku / componentSku 는 거부된다', async () => {
    const missing = '00000000-0000-4000-8000-00000000dead';
    await expect(newHeader(missing, { from: '2026-01-01' })).rejects.toThrow(
      /Foreign key constraint/i,
    );

    const parent = await newSku('FK부모');
    const headerId = await newHeader(parent, { from: '2026-01-01' });
    await expect(newLine(headerId, missing)).rejects.toThrow(/Foreign key constraint/i);
  });

  it('18. 실재하는 Supplier 를 productionPartner 로 저장할 수 있다', async () => {
    const parent = await newSku('조립처');
    const supplierId = await newSupplier('조립처');
    const headerId = await newHeader(parent, {
      from: '2026-01-01',
      productionPartnerId: supplierId,
    });

    const row = await getPrismaClient().bomHeader.findUniqueOrThrow({
      where: { id: headerId },
      include: { productionPartner: { select: { id: true } } },
    });
    expect(row.productionPartner?.id).toBe(supplierId);
  });

  it('★ 19. 없는 productionPartner 는 거부된다 — staged scalar 가 아니라 진짜 FK 다', async () => {
    const parent = await newSku('조립처없음');
    await expect(
      newHeader(parent, {
        from: '2026-01-01',
        productionPartnerId: '00000000-0000-4000-8000-00000000beef',
      }),
    ).rejects.toThrow(/Foreign key constraint/i);
  });

  it('사용 중인 SKU 는 삭제되지 않는다 (RESTRICT)', async () => {
    const parent = await newSku('삭제제한');
    const child = await newSku('삭제제한부품');
    const headerId = await newHeader(parent, { from: '2026-01-01' });
    await newLine(headerId, child);

    await expect(getPrismaClient().sku.delete({ where: { id: parent } })).rejects.toThrow(
      /Foreign key constraint|violates foreign key/i,
    );
    await expect(getPrismaClient().sku.delete({ where: { id: child } })).rejects.toThrow(
      /Foreign key constraint|violates foreign key/i,
    );
    // 라인이 있는 헤더도 지워지지 않는다 (CASCADE 아님).
    await expect(getPrismaClient().bomHeader.delete({ where: { id: headerId } })).rejects.toThrow(
      /Foreign key constraint|violates foreign key/i,
    );
  });

  it('actor(User) FK 는 RESTRICT 다 — 승인 사실이 사용자 삭제로 지워지지 않는다', async () => {
    const parent = await newSku('작성자');
    await getPrismaClient().bomHeader.create({
      data: {
        parentSkuId: parent,
        bomType: 'KIT',
        version: 'actor-1',
        outputUom: 'EA',
        effectiveFrom: d('2026-01-01'),
        createdBy: USER_A,
        approvedBy: USER_B,
        approvedAt: new Date(),
      },
    });

    await expect(getPrismaClient().user.delete({ where: { id: USER_B } })).rejects.toThrow(
      /Foreign key constraint|violates foreign key/i,
    );
  });
});

describe('★ staged scalar — Warehouse FK 가 없다 (D-32)', () => {
  it('20. 존재하지 않는 창고 UUID 를 헤더·라인에 저장할 수 있다', async () => {
    const parent = await newSku('staged');
    const child = await newSku('staged부품');
    const headerId = await newHeader(parent, {
      from: '2026-01-01',
      destinationWarehouseId: ORPHAN_WAREHOUSE_ID,
    });
    const lineId = await newLine(headerId, child, { issueWarehouseId: ORPHAN_WAREHOUSE_ID });

    const header = await getPrismaClient().bomHeader.findUniqueOrThrow({ where: { id: headerId } });
    const line = await getPrismaClient().bomLine.findUniqueOrThrow({ where: { id: lineId } });
    // ⚠️ 이것은 FK 누락 사고가 아니라 T08-1 을 기다리는 **의도된 staged state** 다.
    //    T08-1 이 Warehouse 를 만들면 이 테스트는 반대 방향으로 바뀌어야 한다.
    expect(header.destinationWarehouseId).toBe(ORPHAN_WAREHOUSE_ID);
    expect(line.issueWarehouseId).toBe(ORPHAN_WAREHOUSE_ID);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. 카탈로그 — raw SQL 객체가 실제로 존재하는가
//
// ⚠️ drift gate 는 이 셋을 보지 못한다. 여기가 유일한 방어선이다.
// ═══════════════════════════════════════════════════════════════

interface CatalogRow {
  readonly name: string;
  readonly definition: string;
}

async function constraintDef(table: string, name: string): Promise<CatalogRow[]> {
  return getPrismaClient().$queryRawUnsafe<CatalogRow[]>(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = $2`,
    table,
    name,
  );
}

describe('★★ 카탈로그 — raw SQL 제약 (21·22·23)', () => {
  it('21. bom_header_active_period_excl 이 EXCLUDE 이고 ACTIVE 조건을 갖는다', async () => {
    const [row] = await constraintDef('bom_header', 'bom_header_active_period_excl');
    expect(row).toBeDefined();
    expect(row?.definition).toContain('EXCLUDE USING gist');
    expect(row?.definition).toContain('parent_sku_id');
    // half-open `[)` 여야 한다 — `[]`/`()` 로 바뀌면 경계 동작이 달라진다.
    expect(row?.definition).toContain("'[)'");
    // ★ ACTIVE 한정. 이 WHERE 절이 빠지면 DRAFT 후보 버전을 만들 수 없다.
    expect(row?.definition).toMatch(/WHERE \(\(status = 'ACTIVE'/);
  });

  it('CHECK bom_header_effective_period_check 이 존재한다', async () => {
    const [row] = await constraintDef('bom_header', 'bom_header_effective_period_check');
    expect(row).toBeDefined();
    expect(row?.definition).toContain('effective_to');
    expect(row?.definition).toContain('effective_from');
  });

  it('★ 22. ux_bom_line_component_group 이 COALESCE 표현식 UNIQUE 다', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<CatalogRow[]>(
      `SELECT indexname AS name, indexdef AS definition
         FROM pg_indexes
        WHERE tablename = 'bom_line' AND indexname = 'ux_bom_line_component_group'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]?.definition ?? '';
    expect(def).toContain('UNIQUE');
    expect(def).toContain('bom_header_id');
    expect(def).toContain('component_sku_id');
    // ★ COALESCE 가 없으면 NULL 중복이 통과한다 (Case A 가 이것을 실증한다).
    expect(def.toUpperCase()).toContain('COALESCE');
    // ⛔ NULLS NOT DISTINCT 로 바꾸지 않았는지 확인 (00 §C-09).
    expect(def.toUpperCase()).not.toContain('NULLS NOT DISTINCT');
  });

  it('23. 선언한 index 가 전부 존재한다', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('bom_header','bom_line')`,
    );
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      'bom_header_pkey',
      'bom_header_parent_sku_id_version_key',
      'bom_header_parent_sku_id_status_idx',
      'bom_header_active_period_excl',
      'bom_line_pkey',
      'bom_line_bom_header_id_line_no_key',
      'bom_line_component_sku_id_idx',
      'ux_bom_line_component_group',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it('btree_gist 가 설치되어 있다 (T06-1 이 이미 설치 — 재설치 없음)', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<{ extname: string }[]>(
      `SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('★ 25. 컬럼 타입·정밀도가 계약과 같다 (D-2)', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<
      {
        table_name: string;
        column_name: string;
        data_type: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
        character_maximum_length: number | null;
        is_nullable: string;
      }[]
    >(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale,
              character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_name IN ('bom_header','bom_line')`,
    );
    const col = (t: string, c: string) =>
      rows.find((r) => r.table_name === t && r.column_name === c);

    // 날짜는 DATE 다 (timestamp 아님) — asOf 판정이 시간대에 흔들리면 안 된다.
    expect(col('bom_header', 'effective_from')?.data_type).toBe('date');
    expect(col('bom_header', 'effective_from')?.is_nullable).toBe('NO');
    expect(col('bom_header', 'effective_to')?.data_type).toBe('date');
    expect(col('bom_header', 'effective_to')?.is_nullable).toBe('YES');

    // 수량은 (18,6), 손실률은 (8,6) — 서로 다르다.
    expect(col('bom_header', 'output_qty')?.numeric_precision).toBe(18);
    expect(col('bom_header', 'output_qty')?.numeric_scale).toBe(6);
    expect(col('bom_header', 'overall_loss_rate')?.numeric_precision).toBe(8);
    expect(col('bom_header', 'overall_loss_rate')?.numeric_scale).toBe(6);
    expect(col('bom_line', 'quantity_per')?.numeric_precision).toBe(18);
    expect(col('bom_line', 'quantity_per')?.numeric_scale).toBe(6);
    // ★ pack_quantity 는 quantity_per 과 **다른 컬럼**이며 정밀도는 같다.
    expect(col('bom_line', 'pack_quantity')?.numeric_precision).toBe(18);
    expect(col('bom_line', 'pack_quantity')?.numeric_scale).toBe(6);
    expect(col('bom_line', 'loss_rate')?.numeric_precision).toBe(8);
    expect(col('bom_line', 'loss_rate')?.numeric_scale).toBe(6);

    // 문자열 길이
    expect(col('bom_header', 'version')?.character_maximum_length).toBe(20);
    expect(col('bom_header', 'output_uom')?.character_maximum_length).toBe(20);
    expect(col('bom_line', 'uom')?.character_maximum_length).toBe(20);
    expect(col('bom_line', 'alternate_group')?.character_maximum_length).toBe(50);
    expect(col('bom_line', 'legacy_bom_code')?.character_maximum_length).toBe(100);

    // ★ quantity_per 은 nullable 이어야 한다 — 383행이 전량 미확정으로 들어온다.
    expect(col('bom_line', 'quantity_per')?.is_nullable).toBe('YES');
  });

  it('★ 24. enum 값이 계약과 정확히 같다 (D-2)', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<{ typname: string; label: string }[]>(
      `SELECT t.typname, e.enumlabel AS label
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN ('BomStatus','BomType','ComponentRole','QuantityStatus')
        ORDER BY t.typname, e.enumsortorder`,
    );
    const values = (name: string) => rows.filter((r) => r.typname === name).map((r) => r.label);

    expect(values('BomStatus')).toEqual([
      'DRAFT',
      'PENDING_APPROVAL',
      'REJECTED',
      'APPROVED',
      'ACTIVE',
      'INACTIVE',
      'ARCHIVED',
    ]);
    expect(values('BomType')).toEqual(['MANUFACTURING', 'KIT', 'REPACK']);
    expect(values('ComponentRole')).toEqual(['PRODUCT', 'MATERIAL', 'PACKAGING', 'SERVICE']);
    expect(values('QuantityStatus')).toEqual(['CONFIRMED', 'SUGGESTED', 'UNKNOWN']);
  });

  it('⛔ BOM 에 attachment 컬럼이 없다 (D-32)', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('bom_header','bom_line') AND column_name LIKE '%attachment%'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('⛔ staged scalar 2종에 FK 가 없다 (D-32)', async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<{ conname: string }[]>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f'
          AND c.conrelid IN ('bom_header'::regclass, 'bom_line'::regclass)
          AND a.attname IN ('destination_warehouse_id', 'issue_warehouse_id')`,
    );
    expect(rows).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. EXCLUDE 동시성 — 두 트랜잭션이 같은 구간을 ACTIVE 로 만들 수 없다
//
// ⛔ cycle advisory lock 동시성은 T07-2 다 (docs/18 §D-28 acceptance).
// ═══════════════════════════════════════════════════════════════

describe('★ EXCLUDE 동시성 (T07-1 범위)', () => {
  it('같은 parent 의 겹치는 ACTIVE 를 두 트랜잭션이 동시에 넣으면 하나만 성공한다', async () => {
    const skuId = await newSku('동시활성');
    const client = getPrismaClient();

    const insert = (version: string, from: string) =>
      client.$transaction(async (tx) => {
        await tx.bomHeader.create({
          data: {
            parentSkuId: skuId,
            bomType: 'MANUFACTURING',
            version,
            status: 'ACTIVE',
            outputUom: 'EA',
            effectiveFrom: d(from),
            effectiveTo: null,
          },
        });
      });

    // 겹치는 두 open-ended 구간 — 동시에 실행한다.
    const results = await Promise.allSettled([
      insert('conc-1', '2026-01-01'),
      insert('conc-2', '2026-06-01'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // ★ DB 가 둘 다 허용하면 안 된다.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const active = await client.bomHeader.count({
      where: { parentSkuId: skuId, status: 'ACTIVE' },
    });
    expect(active).toBe(1);
  });
});
