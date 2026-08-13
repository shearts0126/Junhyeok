import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createActorContext, type ActorContext } from '@/modules/auth/application';
import {
  listSkuSupplierSummaries,
  parseSkuSupplierSummaryQuery,
  resolveEffectiveSupplierPrice,
  resolveEffectiveSupplierPrices,
  SUPPLIER_PRICE_READ_PERMISSION,
  SUPPLIER_READ_PERMISSION,
  parseDateOnly,
} from '@/modules/supplier/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

import { seedRolesAndPermissions } from '../../prisma/seed/roles';

/**
 * SKU 상세 ⑥ 공급조건 요약 supporting API DB 통합 테스트 (T1-6B4, §42·§43).
 *
 * 근거: `docs/16_설계복구_SKU상세잔여탭.md` §41~ (D-1 ~ D-30).
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - **두 permission 을 모두** 요구하는 2차 가드 (D-3·D-19)
 *   - **현재 유효 공급조건만** — 과거 종료·미래 시작 제외, half-open 경계 (D-5)
 *   - recentPrice = asOf 유효 **승인** 가격 · pending 제외 · 0원 보존 (D-14·D-17)
 *   - **batch resolver 가 DB 조회 1회**로 해결하고 chain 손상은 409 (D-18·D-26)
 *   - 단건 resolver 가 batch wrapper 가 된 뒤에도 T06-3 동작이 그대로인지 (§15)
 *   - 축소 projection 에 관리화면 전용 필드가 새지 않는지 (D-7)
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TSS-${RUN}-${suffix}`;

const FULL_ID = 'eeeeeeee-0000-4000-8000-0000000e5001';
const SUPPLIER_ONLY_ID = 'eeeeeeee-0000-4000-8000-0000000e5002';
const PRICE_ONLY_ID = 'eeeeeeee-0000-4000-8000-0000000e5003';
const NOPERM_ID = 'eeeeeeee-0000-4000-8000-0000000e5004';
const ACTOR_IDS = [FULL_ID, SUPPLIER_ONLY_ID, PRICE_ONLY_ID, NOPERM_ID];

/** 두 permission 을 모두 가진 actor (A·L·S·F 상당). */
const FULL: ActorContext = createActorContext({
  userId: FULL_ID,
  email: 'sku-supplier-full@deeppoint.test',
  name: '전체 조회자',
  active: true,
  roles: ['FINANCE'],
  permissions: [SUPPLIER_READ_PERMISSION, SUPPLIER_PRICE_READ_PERMISSION],
  requestId: 'req-sku-supplier-full',
});

/** supplier.read 만 — 가격이 응답에 있으므로 403 이어야 한다. */
const SUPPLIER_ONLY: ActorContext = createActorContext({
  userId: SUPPLIER_ONLY_ID,
  email: 'sku-supplier-sonly@deeppoint.test',
  name: '공급조건만',
  active: true,
  roles: ['SCM_STAFF'],
  permissions: [SUPPLIER_READ_PERMISSION],
  requestId: 'req-sku-supplier-sonly',
});

/** supplier_price.read 만 — 역시 403. */
const PRICE_ONLY: ActorContext = createActorContext({
  userId: PRICE_ONLY_ID,
  email: 'sku-supplier-ponly@deeppoint.test',
  name: '가격만',
  active: true,
  roles: ['FINANCE'],
  permissions: [SUPPLIER_PRICE_READ_PERMISSION],
  requestId: 'req-sku-supplier-ponly',
});

/** EXECUTIVE 상당 + ADMIN 역할 — supplier capability 0. bypass 부재 증명용. */
const NO_PERMISSION: ActorContext = createActorContext({
  userId: NOPERM_ID,
  email: 'sku-supplier-noperm@deeppoint.test',
  name: '권한 없는 관리자',
  active: true,
  roles: ['ADMIN', 'EXECUTIVE'],
  permissions: ['sku.read'],
  requestId: 'req-sku-supplier-noperm',
});

/** 업무일자를 고정한다 — 실행일에 따라 결과가 흔들리지 않게. */
const NOW = new Date('2026-08-13T01:00:00.000Z'); // KST 2026-08-13 10:00
const AS_OF = '2026-08-13';

let seq = 0;

function next(prefix: string): string {
  seq += 1;
  return CODE(`${prefix}${String(seq).padStart(3, '0')}`);
}

async function newSkuId(): Promise<string> {
  const row = await getPrismaClient().sku.create({
    data: { skuCode: next('K'), skuName: `요약 SKU ${seq}`, itemType: 'FINISHED_GOOD' },
    select: { id: true },
  });
  return row.id;
}

async function newSupplierId(
  supplierCode: string,
  defaultLeadTimeDays: number | null = null,
): Promise<string> {
  const row = await getPrismaClient().supplier.create({
    data: {
      supplierCode,
      supplierName: `요약 거래처 ${supplierCode}`,
      supplierType: 'MANUFACTURER',
      defaultLeadTimeDays,
    },
    select: { id: true },
  });
  return row.id;
}

interface TermOptions {
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly leadTimeDays?: number | null;
  readonly moq?: string | null;
  readonly isPrimary?: boolean;
  readonly supplierSkuCode?: string | null;
  readonly supplierSkuName?: string | null;
}

async function newTermId(
  supplierId: string,
  skuId: string,
  options: TermOptions = {},
): Promise<string> {
  const row = await getPrismaClient().supplierSku.create({
    data: {
      supplierId,
      skuId,
      supplyType: 'SELF_SUPPLIED',
      effectiveFrom: parseDateOnly(options.effectiveFrom ?? '2026-01-01'),
      effectiveTo:
        options.effectiveTo === undefined || options.effectiveTo === null
          ? null
          : parseDateOnly(options.effectiveTo),
      leadTimeDays: options.leadTimeDays ?? null,
      moq: options.moq ?? null,
      isPrimary: options.isPrimary ?? false,
      supplierSkuCode: options.supplierSkuCode ?? null,
      supplierSkuName: options.supplierSkuName ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

async function addPrice(
  supplierSkuId: string,
  unitPrice: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  approved: boolean,
): Promise<string> {
  const row = await getPrismaClient().supplierSkuPrice.create({
    data: {
      supplierSkuId,
      unitPrice,
      currency: 'KRW',
      vatIncluded: false,
      effectiveFrom: parseDateOnly(effectiveFrom),
      effectiveTo: effectiveTo === null ? null : parseDateOnly(effectiveTo),
      createdBy: FULL_ID,
      approvedBy: approved ? FULL_ID : null,
    },
    select: { id: true },
  });
  return row.id;
}

const query = { page: 1 } as const;

async function summarize(actor: ActorContext, skuId: string, page = 1) {
  return listSkuSupplierSummaries(actor, skuId, { page }, { now: NOW });
}

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await client.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`,
    ACTOR_IDS,
  );
  await client.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER USER');
  await client.supplierSkuPrice.deleteMany({
    where: { supplierSku: { supplier: { supplierCode: { startsWith: 'TSS-' } } } },
  });
  await client.supplierSku.deleteMany({
    where: { supplier: { supplierCode: { startsWith: 'TSS-' } } },
  });
  await client.supplier.deleteMany({ where: { supplierCode: { startsWith: 'TSS-' } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TSS-' } } });
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
      { id: FULL_ID, email: 'sku-supplier-full@deeppoint.test', name: '전체 조회자' },
      { id: SUPPLIER_ONLY_ID, email: 'sku-supplier-sonly@deeppoint.test', name: '공급조건만' },
      { id: PRICE_ONLY_ID, email: 'sku-supplier-ponly@deeppoint.test', name: '가격만' },
      { id: NOPERM_ID, email: 'sku-supplier-noperm@deeppoint.test', name: '권한 없는 관리자' },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 권한 · 입력 (§42-1~11)
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — 두 capability 를 모두 요구한다 (D-3·D-19)', () => {
  it('1. malformed SKU UUID → 400', async () => {
    await expect(summarize(FULL, 'not-a-uuid')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('2. 없는 SKU → 404', async () => {
    await expect(summarize(FULL, '00000000-0000-4000-8000-00000000f001')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('★ 3. supplier.read 만 있으면 403 — 가격이 응답에 들어가기 때문', async () => {
    const skuId = await newSkuId();
    await expect(summarize(SUPPLIER_ONLY, skuId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('★ 4. supplier_price.read 만 있어도 403', async () => {
    const skuId = await newSkuId();
    await expect(summarize(PRICE_ONLY, skuId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('★ 5·7. 권한 없는 ADMIN·EXECUTIVE 는 403 — bypass 없음', async () => {
    const skuId = await newSkuId();
    await expect(summarize(NO_PERMISSION, skuId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('6. 두 permission 을 모두 가진 FINANCE 는 200 이다', async () => {
    const skuId = await newSkuId();
    await expect(summarize(FULL, skuId)).resolves.toMatchObject({ total: 0 });
  });

  it('8·9. 0건이면 items [] · total 0 · totalPages 0 · pageSize 50', async () => {
    const skuId = await newSkuId();
    const result = await summarize(FULL, skuId);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
    expect(result.pageSize).toBe(50);
    expect(result.asOf).toBe(AS_OF);
  });

  it('10·11. page 검증 · unknown query 400 (asOf 포함)', () => {
    expect(parseSkuSupplierSummaryQuery(new URLSearchParams('')).page).toBe(1);
    expect(parseSkuSupplierSummaryQuery(new URLSearchParams('page=3')).page).toBe(3);
    for (const bad of ['page=0', 'page=-1', 'page=abc']) {
      expect(() => parseSkuSupplierSummaryQuery(new URLSearchParams(bad)), bad).toThrow();
    }
    // ★ asOf 는 서버 업무일자 고정이라 클라이언트가 지정할 수 없다 (D-6).
    for (const bad of ['asOf=2026-01-01', 'pageSize=10', 'sort=x', 'foo=1']) {
      expect(() => parseSkuSupplierSummaryQuery(new URLSearchParams(bad)), bad).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 현재 유효 공급조건만 (§42-12~17)
// ═══════════════════════════════════════════════════════════════

describe('★ 현재 유효 공급조건만 반환한다 (D-5)', () => {
  it('12~15. 현재만 · 과거 제외 · 미래 제외 · half-open 경계', async () => {
    const skuId = await newSkuId();
    // ⚠️ 거래처를 나눈다 — T06-1 EXCLUDE 가 같은 (supplier, sku) 안에서 기간
    //    중첩을 막기 때문이다. 실제로도 한 SKU 는 여러 거래처에서 공급받는다.
    const currentSupplier = await newSupplierId(next('S'));
    const pastSupplier = await newSupplierId(next('S'));
    const futureSupplier = await newSupplierId(next('S'));
    const endedTodaySupplier = await newSupplierId(next('S'));

    const current = await newTermId(currentSupplier, skuId, {
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    });
    // 과거 — 이미 종료.
    await newTermId(pastSupplier, skuId, {
      effectiveFrom: '2025-01-01',
      effectiveTo: '2026-01-01',
    });
    // 미래 시작 (open-ended 라도 제외).
    await newTermId(futureSupplier, skuId, { effectiveFrom: '2099-01-01', effectiveTo: null });
    // ★ 오늘 종료 = half-open 이라 **이미 미적용**.
    await newTermId(endedTodaySupplier, skuId, { effectiveFrom: '2026-02-01', effectiveTo: AS_OF });

    const result = await summarize(FULL, skuId);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(current);
    expect(result.total).toBe(1);
  });

  it('★ 15b. 종료일이 내일이면 오늘은 아직 유효하다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const term = await newTermId(supplierId, skuId, {
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-08-14',
    });
    const result = await summarize(FULL, skuId);
    expect(result.items.map((item) => item.id)).toEqual([term]);
  });

  it('★ 15c. 시작일이 오늘이면 포함된다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const term = await newTermId(supplierId, skuId, { effectiveFrom: AS_OF });
    const result = await summarize(FULL, skuId);
    expect(result.items.map((item) => item.id)).toEqual([term]);
  });

  it('★ 16. Supplier.status 로 필터하지 않는다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    await getPrismaClient().supplier.update({
      where: { id: supplierId },
      data: { status: 'INACTIVE' },
    });
    await newTermId(supplierId, skuId);

    const result = await summarize(FULL, skuId);
    expect(result.items).toHaveLength(1);
    // status 는 projection 에도 없다 (D-13).
    expect('status' in (result.items[0]?.supplier ?? {})).toBe(false);
  });

  it('17. 정렬은 supplierCode ASC 고정 — isPrimary 우선 정렬이 아니다', async () => {
    const skuId = await newSkuId();
    const codeB = next('SB');
    const codeA = next('SA');
    const supplierB = await newSupplierId(codeB);
    const supplierA = await newSupplierId(codeA);
    // 대표를 코드가 뒤인 쪽에 둔다 — 그래도 코드순이어야 한다.
    await newTermId(supplierB, skuId, { isPrimary: true });
    await newTermId(supplierA, skuId);

    const result = await summarize(FULL, skuId);
    expect(result.items.map((item) => item.supplier.supplierCode)).toEqual(
      [codeA, codeB].sort((left, right) => left.localeCompare(right)),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// projection (§42-18~21)
// ═══════════════════════════════════════════════════════════════

describe('★ 축소 projection (D-7)', () => {
  it('18~21. exact 필드 · MOQ Decimal 문자열 · leadTime fallback · 0 보존', async () => {
    const skuId = await newSkuId();
    // 거래처 기본 리드타임 30, 공급조건 미입력 → 적용값 30.
    const supplierId = await newSupplierId(next('S'), 30);
    await newTermId(supplierId, skuId, {
      moq: '12.500000',
      leadTimeDays: null,
      supplierSkuCode: 'SC-1',
    });

    const result = await summarize(FULL, skuId);
    const item = result.items[0];

    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        'id',
        'supplierId',
        'supplier',
        'supplierSkuCode',
        'supplierSkuName',
        'moq',
        'effectiveLeadTimeDays',
        'supplyType',
        'isPrimary',
        'recentPrice',
      ].sort(),
    );
    // ⛔ 관리화면 전용 필드가 새지 않는다.
    for (const forbidden of [
      'orderMultiple',
      'leadTimeDays',
      'purchaseUom',
      'currency',
      'effectiveFrom',
      'effectiveTo',
      'createdAt',
      'destinationWarehouseId',
    ]) {
      expect(forbidden in (item ?? {}), forbidden).toBe(false);
    }
    // ★ Decimal 은 문자열 그대로.
    expect(item?.moq).toBe('12.5');
    // ★ 파생 리드타임 — 거래처 기본값 fallback.
    expect(item?.effectiveLeadTimeDays).toBe(30);
  });

  it('★ 21b. 공급조건 리드타임 0 은 0 으로 남는다 — 거래처 기본값으로 덮이지 않는다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'), 30);
    await newTermId(supplierId, skuId, { leadTimeDays: 0 });

    const result = await summarize(FULL, skuId);
    expect(result.items[0]?.effectiveLeadTimeDays).toBe(0);
  });

  it('★ 21c. 양쪽 다 없으면 null 이다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'), null);
    await newTermId(supplierId, skuId, { leadTimeDays: null });

    const result = await summarize(FULL, skuId);
    expect(result.items[0]?.effectiveLeadTimeDays).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// recentPrice (§42-22~29)
// ═══════════════════════════════════════════════════════════════

describe('★ recentPrice — asOf 유효 승인 가격 (D-14·D-17)', () => {
  it('22·23. 승인 가격을 반환하고 pending 은 제외한다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const term = await newTermId(supplierId, skuId);

    await addPrice(term, '1000', '2026-01-01', null, true);
    // pending — 오늘 유효 구간이지만 승인 전이라 잡히면 안 된다.
    await addPrice(term, '9999', '2026-08-01', null, false);

    const result = await summarize(FULL, skuId);
    expect(result.items[0]?.recentPrice).toEqual({ unitPrice: '1000', currency: 'KRW' });
  });

  it('24. 가격이 없으면 null 이다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    await newTermId(supplierId, skuId);

    const result = await summarize(FULL, skuId);
    expect(result.items[0]?.recentPrice).toBeNull();
  });

  it('★ 25. 0원 승인 가격은 그대로 "0" 이다 — 가격 없음(null)과 다르다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const term = await newTermId(supplierId, skuId);
    await addPrice(term, '0', '2026-01-01', null, true);

    const result = await summarize(FULL, skuId);
    expect(result.items[0]?.recentPrice).toEqual({ unitPrice: '0', currency: 'KRW' });
  });

  it('26·27·28. 미래 승인 가격은 시작 전 제외 · 시작일 포함 · 종료 경계 제외', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const term = await newTermId(supplierId, skuId);

    // 오늘 이전 시작 + 오늘 종료 → half-open 이라 **미적용**.
    await addPrice(term, '100', '2026-01-01', AS_OF, true);
    // 오늘 시작 → **적용**.
    await addPrice(term, '200', AS_OF, '2026-12-01', true);
    // 미래 시작 → 제외.
    await addPrice(term, '300', '2026-12-01', null, true);

    const result = await summarize(FULL, skuId);
    expect(result.items[0]?.recentPrice?.unitPrice).toBe('200');
  });

  it('★ 29. 유효 승인 가격이 2건이면 요청 전체가 409 다 — 부분 성공으로 숨기지 않는다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const healthy = await newTermId(supplierId, skuId);
    const supplierId2 = await newSupplierId(next('SZ'));
    const broken = await newTermId(supplierId2, skuId);

    await addPrice(healthy, '100', '2026-01-01', null, true);
    // API 로는 만들 수 없는 손상 상태 — 둘 다 open-ended 승인.
    await addPrice(broken, '200', '2026-01-01', null, true);
    await addPrice(broken, '300', '2026-02-01', null, true);

    await expect(summarize(FULL, skuId)).rejects.toMatchObject({
      code: 'SUPPLIER_PRICE_CHAIN_CONFLICT',
      httpStatus: 409,
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// asOf 일관성 · audit · mutation (§42-30~32)
// ═══════════════════════════════════════════════════════════════

describe('★ asOf 일관성 · read-only (D-6·D-28)', () => {
  it('30. 모든 행이 같은 asOf 를 쓰고 응답이 그 값을 담는다', async () => {
    const skuId = await newSkuId();
    const supplierA = await newSupplierId(next('S'));
    const supplierB = await newSupplierId(next('S'));
    const termA = await newTermId(supplierA, skuId);
    const termB = await newTermId(supplierB, skuId);
    // 두 행 모두 오늘 시작 가격 — 같은 기준일을 써야 둘 다 잡힌다.
    await addPrice(termA, '100', AS_OF, null, true);
    await addPrice(termB, '200', AS_OF, null, true);

    const result = await summarize(FULL, skuId);
    expect(result.asOf).toBe(AS_OF);
    expect(result.items.map((item) => item.recentPrice?.unitPrice).sort()).toEqual(['100', '200']);
  });

  it('31·32. AuditLog 를 만들지 않고 데이터도 바꾸지 않는다', async () => {
    const client = getPrismaClient();
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const term = await newTermId(supplierId, skuId);
    await addPrice(term, '100', '2026-01-01', null, true);

    const auditBefore = await client.auditLog.count({ where: { actorId: FULL_ID } });
    const termBefore = await client.supplierSku.findUniqueOrThrow({ where: { id: term } });

    await summarize(FULL, skuId);
    await summarize(FULL, skuId);

    expect(await client.auditLog.count({ where: { actorId: FULL_ID } })).toBe(auditBefore);
    expect(await client.supplierSku.findUniqueOrThrow({ where: { id: term } })).toEqual(termBefore);
  });
});

// ═══════════════════════════════════════════════════════════════
// batch resolver (§43)
// ═══════════════════════════════════════════════════════════════

describe('★ batch price resolver (D-26·§43)', () => {
  it('빈 입력은 DB 를 건드리지 않고 빈 Map 을 준다', async () => {
    const result = await resolveEffectiveSupplierPrices(getPrismaClient(), {
      supplierSkuIds: [],
      asOf: parseDateOnly(AS_OF),
    });
    expect(result.size).toBe(0);
  });

  it('입력 id 전부가 key 로 존재한다 — 가격 없는 id 도 null 로 담긴다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const withPrice = await newTermId(supplierId, skuId);
    const supplierId2 = await newSupplierId(next('S'));
    const without = await newTermId(supplierId2, skuId);
    await addPrice(withPrice, '150', '2026-01-01', null, true);

    const result = await resolveEffectiveSupplierPrices(getPrismaClient(), {
      supplierSkuIds: [withPrice, without],
      asOf: parseDateOnly(AS_OF),
    });
    expect(result.size).toBe(2);
    expect(result.has(without)).toBe(true);
    expect(result.get(without)).toBeNull();
    expect(result.get(withPrice)?.unitPrice.toString()).toBe('150');
  });

  it('중복 id 를 줘도 한 번만 처리한다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const term = await newTermId(supplierId, skuId);
    await addPrice(term, '150', '2026-01-01', null, true);

    const result = await resolveEffectiveSupplierPrices(getPrismaClient(), {
      supplierSkuIds: [term, term, term],
      asOf: parseDateOnly(AS_OF),
    });
    expect(result.size).toBe(1);
  });

  it('pending·경계 조건이 단건과 동일하다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const term = await newTermId(supplierId, skuId);
    await addPrice(term, '100', '2026-01-01', AS_OF, true); // 오늘 종료 → 제외
    await addPrice(term, '0', AS_OF, null, true); // 오늘 시작 → 적용(0원)
    await addPrice(term, '999', '2026-09-01', null, false); // pending → 제외

    const asOf = parseDateOnly(AS_OF);
    const batch = await resolveEffectiveSupplierPrices(getPrismaClient(), {
      supplierSkuIds: [term],
      asOf,
    });
    const single = await resolveEffectiveSupplierPrice(getPrismaClient(), {
      supplierSkuId: term,
      asOf,
    });
    expect(batch.get(term)?.id).toBe(single?.id);
    expect(single?.unitPrice.toString()).toBe('0');
  });

  it('★ 한 id 라도 candidate 2건이면 batch·단건 모두 409 다 (§15 regression)', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    const term = await newTermId(supplierId, skuId);
    await addPrice(term, '100', '2026-01-01', null, true);
    await addPrice(term, '200', '2026-02-01', null, true);

    const asOf = parseDateOnly(AS_OF);
    await expect(
      resolveEffectiveSupplierPrices(getPrismaClient(), { supplierSkuIds: [term], asOf }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_PRICE_CHAIN_CONFLICT' });
    // ★ 단건이 batch wrapper 가 된 뒤에도 T06-3 동작이 그대로다.
    await expect(
      resolveEffectiveSupplierPrice(getPrismaClient(), { supplierSkuId: term, asOf }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_PRICE_CHAIN_CONFLICT' });
  });
});

// ═══════════════════════════════════════════════════════════════
// pagination
// ═══════════════════════════════════════════════════════════════

describe('pagination — 서버 고정 50 (D-21)', () => {
  it('page 를 넘기면 skip 이 적용되고 pageSize 는 50 그대로다', async () => {
    const skuId = await newSkuId();
    const supplierId = await newSupplierId(next('S'));
    await newTermId(supplierId, skuId);

    const page2 = await summarize(FULL, skuId, 2);
    expect(page2.items).toHaveLength(0);
    expect(page2.page).toBe(2);
    expect(page2.pageSize).toBe(50);
    expect(page2.total).toBe(1);
    expect(page2.totalPages).toBe(1);
    // query 계약도 그대로다.
    expect(query.page).toBe(1);
  });
});
