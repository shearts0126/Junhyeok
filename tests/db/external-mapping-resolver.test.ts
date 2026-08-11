import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SkuStatus } from '@/generated/prisma/client';
import {
  resolveMany,
  resolveOne,
  type ResolveExternalMappingResult,
} from '@/modules/external-mapping/application';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';

/**
 * SKU 해석 서비스 DB 테스트 (T05-3) — 실제 PostgreSQL.
 *
 * 계약 근거는 `docs/14_설계복구_ExternalMappingResolver.md` 뿐이다.
 *
 * 대역으로 재현할 수 없는 것을 본다:
 *   - `effectiveTo IS NULL` 현행 조건이 실제 `where` 로 적용되는지 (이력 제외)
 *   - `ux_external_mapping_code` 전제 하에서의 code 조회
 *   - barcode·name 에 UNIQUE 가 없어 실제로 다중 후보가 생기는 상황
 *   - resolver 호출 전후 DB 가 **완전히 불변**인지 (pure read)
 *   - SKU 상태(INACTIVE·ARCHIVED·soft-delete)를 걸러내지 않는지
 */

const RUN = randomBytes(4).toString('hex');
const SKU_CODE = (suffix: string) => `TXR-${RUN}-${suffix}`;
const SYS_CODE = (suffix: string) => `TXR-${RUN}-${suffix}`;

let skuSeq = 0;
let sysSeq = 0;

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.skuExternalMapping.deleteMany({
    where: { externalSystem: { systemCode: { startsWith: 'TXR-' } } },
  });
  await client.skuExternalMapping.deleteMany({
    where: { sku: { skuCode: { startsWith: 'TXR-' } } },
  });
  await client.externalSystem.deleteMany({ where: { systemCode: { startsWith: 'TXR-' } } });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TXR-' } } });
}

async function newSku(label: string, status: SkuStatus = 'ACTIVE'): Promise<string> {
  skuSeq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: SKU_CODE(String(skuSeq).padStart(3, '0')),
      skuName: `해석 테스트 SKU (${label})`,
      itemType: 'FINISHED',
      status,
    },
    select: { id: true },
  });
  return row.id;
}

async function newSystem(label: string): Promise<string> {
  sysSeq += 1;
  const row = await getPrismaClient().externalSystem.create({
    data: {
      systemCode: SYS_CODE(String(sysSeq).padStart(3, '0')),
      systemName: `외부시스템 (${label})`,
      systemType: 'WMS',
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * 매핑을 **직접 INSERT** 한다.
 *
 * ⚠️ T05-2 API 를 쓰지 않는 이유: 이 테스트는 (a) 이력 행, (b) 같은 바코드가
 *    여러 SKU 를 가리키는 상태처럼 **interactive API 가 만들 수 없거나
 *    만들 이유가 없는 데이터 형태**에서 resolver 가 어떻게 판정하는지를 본다.
 *    migration·legacy 로 들어올 수 있는 실제 형태다.
 */
async function mapping(data: {
  skuId: string;
  externalSystemId: string;
  externalProductCode?: string | null;
  externalBarcode?: string | null;
  externalProductName?: string | null;
  mappingStatus?: 'MATCHED' | 'REVIEW_REQUIRED' | 'UNMATCHED';
  effectiveTo?: Date | null;
}): Promise<string> {
  const row = await getPrismaClient().skuExternalMapping.create({
    data: {
      skuId: data.skuId,
      externalSystemId: data.externalSystemId,
      externalProductCode: data.externalProductCode ?? null,
      externalBarcode: data.externalBarcode ?? null,
      externalProductName: data.externalProductName ?? null,
      mappingStatus: data.mappingStatus ?? 'MATCHED',
      effectiveTo: data.effectiveTo ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(cleanup);

afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

// ═══════════════════════════════════════════════════════════════
// 1~2. code 조회 · 이력 제외
// ═══════════════════════════════════════════════════════════════

describe('★ 1순위 코드 — 현행 매핑만', () => {
  it('1. (system, code) 현행 UNIQUE 전제 하에서 단일 매칭된다', async () => {
    const skuId = await newSku('code-hit');
    const systemId = await newSystem('code-hit');
    await mapping({ skuId, externalSystemId: systemId, externalProductCode: 'P001' });

    const result = await resolveOne({ externalSystemId: systemId, externalProductCode: 'P001' });

    expect(result).toEqual({
      resolutionStatus: 'MATCHED',
      matchedSkuId: skuId,
      matchMethod: 'CODE',
      autoApplicable: true,
      requiresReview: false,
      candidateSkuIds: [skuId],
      reasonCode: 'CODE_MATCH',
    });
  });

  it('2. ★ 종료된(effectiveTo != null) 코드 매핑은 제외된다', async () => {
    const oldSku = await newSku('code-historical');
    const systemId = await newSystem('code-historical');
    await mapping({
      skuId: oldSku,
      externalSystemId: systemId,
      externalProductCode: 'P001',
      effectiveTo: new Date('2026-01-31T00:00:00.000Z'),
    });

    const result = await resolveOne({ externalSystemId: systemId, externalProductCode: 'P001' });
    expect(result.resolutionStatus).toBe('UNMATCHED');
    expect(result.reasonCode).toBe('NO_MATCH');

    // 같은 코드로 현행 매핑을 새로 만들면 그것만 잡힌다 (partial UNIQUE 밖이라 공존 가능).
    const currentSku = await newSku('code-current');
    await mapping({ skuId: currentSku, externalSystemId: systemId, externalProductCode: 'P001' });

    const after = await resolveOne({ externalSystemId: systemId, externalProductCode: 'P001' });
    expect(after.matchedSkuId).toBe(currentSku);
    expect(after.candidateSkuIds).toEqual([currentSku]);
  });

  it('7. 이력·현행이 섞여도 current lookup 은 effectiveTo IS NULL 행만 본다', async () => {
    const systemId = await newSystem('mixed-current');
    const historical = await newSku('mixed-historical');
    const current = await newSku('mixed-current-sku');

    await mapping({
      skuId: historical,
      externalSystemId: systemId,
      externalBarcode: '8809619961381',
      externalProductName: '혼합 상품',
      effectiveTo: new Date('2026-02-28T00:00:00.000Z'),
    });
    await mapping({
      skuId: current,
      externalSystemId: systemId,
      externalBarcode: '8809619961381',
      externalProductName: '혼합 상품',
    });

    const byBarcode = await resolveOne({
      externalSystemId: systemId,
      externalBarcode: '8809619961381',
    });
    expect(byBarcode.matchedSkuId).toBe(current);
    expect(byBarcode.candidateSkuIds).toEqual([current]);

    const byName = await resolveOne({
      externalSystemId: systemId,
      externalProductName: '혼합 상품',
    });
    expect(byName.matchedSkuId).toBe(current);
    expect(byName.resolutionStatus).toBe('REVIEW_REQUIRED');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3~5. 바코드 · 상품명 다중 후보
// ═══════════════════════════════════════════════════════════════

describe('★ 2순위 바코드 — distinct SKU 수로 모호성을 판정한다', () => {
  it('3. 같은 바코드 현행 행이 2개여도 같은 SKU 면 단일 후보다', async () => {
    const skuId = await newSku('barcode-same-sku');
    const systemId = await newSystem('barcode-same-sku');

    // ⚠️ externalBarcode 에는 UNIQUE 가 없어 이런 행이 실제로 만들어진다.
    await mapping({ skuId, externalSystemId: systemId, externalBarcode: '8809619961374' });
    await mapping({
      skuId,
      externalSystemId: systemId,
      externalBarcode: '8809619961374',
      externalProductName: '다른 별칭',
    });

    const result = await resolveOne({
      externalSystemId: systemId,
      externalBarcode: '8809619961374',
    });
    expect(result.resolutionStatus).toBe('MATCHED');
    expect(result.matchMethod).toBe('BARCODE');
    expect(result.candidateSkuIds).toEqual([skuId]);
  });

  it('4. ★ 같은 바코드가 서로 다른 SKU 를 가리키면 AMBIGUOUS 다', async () => {
    const systemId = await newSystem('barcode-ambiguous');
    const skuA = await newSku('barcode-amb-a');
    const skuB = await newSku('barcode-amb-b');
    await mapping({ skuId: skuA, externalSystemId: systemId, externalBarcode: '8809619961375' });
    await mapping({ skuId: skuB, externalSystemId: systemId, externalBarcode: '8809619961375' });

    const result = await resolveOne({
      externalSystemId: systemId,
      externalBarcode: '8809619961375',
    });

    expect(result.resolutionStatus).toBe('AMBIGUOUS');
    expect(result.reasonCode).toBe('BARCODE_AMBIGUOUS');
    expect(result.matchedSkuId).toBeNull();
    expect(result.candidateSkuIds).toEqual([skuA, skuB].sort());
  });

  it('5. ★ 같은 상품명이 서로 다른 SKU 를 가리키면 AMBIGUOUS 다', async () => {
    const systemId = await newSystem('name-ambiguous');
    const skuA = await newSku('name-amb-a');
    const skuB = await newSku('name-amb-b');
    await mapping({
      skuId: skuA,
      externalSystemId: systemId,
      externalProductName: '중복 상품명',
      mappingStatus: 'REVIEW_REQUIRED',
    });
    await mapping({
      skuId: skuB,
      externalSystemId: systemId,
      externalProductName: '중복 상품명',
      mappingStatus: 'REVIEW_REQUIRED',
    });

    const result = await resolveOne({
      externalSystemId: systemId,
      externalProductName: '중복 상품명',
    });

    expect(result.resolutionStatus).toBe('AMBIGUOUS');
    expect(result.reasonCode).toBe('NAME_AMBIGUOUS');
    expect(result.matchedSkuId).toBeNull();
    expect(result.candidateSkuIds).toEqual([skuA, skuB].sort());
  });

  it('★ 상품명 단일 후보는 REVIEW_REQUIRED 로 반환된다 (자동 반영 금지)', async () => {
    const skuId = await newSku('name-single');
    const systemId = await newSystem('name-single');
    await mapping({
      skuId,
      externalSystemId: systemId,
      externalProductName: '단일 상품명',
      mappingStatus: 'REVIEW_REQUIRED',
    });

    const result = await resolveOne({
      externalSystemId: systemId,
      externalProductName: '단일 상품명',
    });

    expect(result.resolutionStatus).toBe('REVIEW_REQUIRED');
    expect(result.matchedSkuId).toBe(skuId);
    expect(result.matchMethod).toBe('NAME');
    expect(result.autoApplicable).toBe(false);
    expect(result.requiresReview).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. code ↔ barcode 충돌
// ═══════════════════════════════════════════════════════════════

describe('★ 코드 ↔ 바코드 충돌', () => {
  it('6. 서로 다른 SKU 를 가리키면 CONFLICT 이고 임의 선택하지 않는다', async () => {
    const systemId = await newSystem('conflict');
    const skuA = await newSku('conflict-code');
    const skuB = await newSku('conflict-barcode');
    await mapping({ skuId: skuA, externalSystemId: systemId, externalProductCode: 'P-CONF' });
    await mapping({ skuId: skuB, externalSystemId: systemId, externalBarcode: '8809619961376' });

    const result = await resolveOne({
      externalSystemId: systemId,
      externalProductCode: 'P-CONF',
      externalBarcode: '8809619961376',
    });

    expect(result.resolutionStatus).toBe('CONFLICT');
    expect(result.reasonCode).toBe('IDENTIFIER_CONFLICT');
    expect(result.matchedSkuId).toBeNull();
    expect(result.candidateSkuIds).toEqual([skuA, skuB].sort());
  });

  it('같은 SKU 를 가리키면 CODE MATCH 다 (상위 우선)', async () => {
    const skuId = await newSku('agree');
    const systemId = await newSystem('agree');
    await mapping({
      skuId,
      externalSystemId: systemId,
      externalProductCode: 'P-AGREE',
      externalBarcode: '8809619961377',
    });

    const result = await resolveOne({
      externalSystemId: systemId,
      externalProductCode: 'P-AGREE',
      externalBarcode: '8809619961377',
    });
    expect(result.matchMethod).toBe('CODE');
    expect(result.matchedSkuId).toBe(skuId);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8~10. pure read — 부작용 0
// ═══════════════════════════════════════════════════════════════

describe('★ pure read — 호출 전후 DB 가 완전히 동일하다', () => {
  it('8·9·10. 매핑·SKU·AuditLog 어느 것도 늘거나 변하지 않는다', async () => {
    const client = getPrismaClient();
    const systemId = await newSystem('pure-read');
    const skuA = await newSku('pure-a');
    const skuB = await newSku('pure-b');
    await mapping({ skuId: skuA, externalSystemId: systemId, externalProductCode: 'P-PURE' });
    await mapping({ skuId: skuB, externalSystemId: systemId, externalBarcode: '8809619961378' });
    await mapping({
      skuId: skuB,
      externalSystemId: systemId,
      externalProductName: '순수조회 상품',
      mappingStatus: 'REVIEW_REQUIRED',
    });

    const snapshot = async () => ({
      mappings: await client.skuExternalMapping.count(),
      mappingRows: await client.skuExternalMapping.findMany({
        where: { externalSystemId: systemId },
        orderBy: { id: 'asc' },
      }),
      skus: await client.sku.count(),
      skuRows: await client.sku.findMany({
        where: { id: { in: [skuA, skuB] } },
        orderBy: { id: 'asc' },
      }),
      systems: await client.externalSystem.count(),
      audit: await client.auditLog.count(),
      idempotency: await client.idempotencyRecord.count(),
    });

    const before = await snapshot();

    // 모든 분기를 한 번씩 태운다 — MATCHED·REVIEW_REQUIRED·CONFLICT·UNMATCHED.
    await resolveMany([
      { externalSystemId: systemId, externalProductCode: 'P-PURE' },
      { externalSystemId: systemId, externalBarcode: '8809619961378' },
      { externalSystemId: systemId, externalProductName: '순수조회 상품' },
      {
        externalSystemId: systemId,
        externalProductCode: 'P-PURE',
        externalBarcode: '8809619961378',
      },
      { externalSystemId: systemId, externalProductCode: '없는코드' },
      { externalSystemId: systemId, externalBarcode: '확인필요' },
    ]);

    const after = await snapshot();
    expect(after).toEqual(before);

    // ⛔ DataIssue·InventoryException 테이블은 아직 존재하지도 않는다 —
    //    미매칭/모호/충돌의 영속화 책임은 T05-3 에 없다 (T17-2).
    const tables = await client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('data_issue', 'inventory_exception', 'external_inventory_snapshot')`;
    expect(tables).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// SKU eligibility (§12)
// ═══════════════════════════════════════════════════════════════

describe('★ SKU 상태로 결과를 거르지 않는다', () => {
  it('INACTIVE · DISCONTINUED · ARCHIVED · soft-delete 매핑도 그대로 해석된다', async () => {
    const systemId = await newSystem('eligibility');
    const cases: ReadonlyArray<readonly [SkuStatus, string]> = [
      ['INACTIVE', 'P-INACTIVE'],
      ['DISCONTINUED', 'P-DISCONTINUED'],
      ['ARCHIVED', 'P-ARCHIVED'],
    ];

    for (const [status, code] of cases) {
      const skuId = await newSku(`eligibility-${status}`, status);
      await mapping({ skuId, externalSystemId: systemId, externalProductCode: code });

      const result = await resolveOne({ externalSystemId: systemId, externalProductCode: code });
      expect(result.matchedSkuId, status).toBe(skuId);
      expect(result.autoApplicable, status).toBe(true);
    }

    // soft-delete 된 SKU 도 identity 관점에서는 필터링하지 않는다.
    const deletedSku = await newSku('eligibility-deleted');
    await mapping({
      skuId: deletedSku,
      externalSystemId: systemId,
      externalProductCode: 'P-DELETED',
    });
    await getPrismaClient().sku.update({
      where: { id: deletedSku },
      data: { deletedAt: new Date() },
    });

    const deleted = await resolveOne({
      externalSystemId: systemId,
      externalProductCode: 'P-DELETED',
    });
    expect(deleted.matchedSkuId).toBe(deletedSku);
  });
});

// ═══════════════════════════════════════════════════════════════
// externalSystemId 검증 · 시스템 경계
// ═══════════════════════════════════════════════════════════════

describe('★ externalSystemId', () => {
  it('없는 시스템은 404 다 (매핑 없음이 아니다)', async () => {
    await expect(
      resolveOne({
        externalSystemId: '00000000-0000-4000-8000-000000000000',
        externalProductCode: 'P001',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('다른 시스템의 동일 코드는 섞이지 않는다', async () => {
    const skuId = await newSku('scope');
    const systemA = await newSystem('scope-a');
    const systemB = await newSystem('scope-b');
    await mapping({ skuId, externalSystemId: systemA, externalProductCode: 'P-SCOPE' });

    expect(
      (await resolveOne({ externalSystemId: systemA, externalProductCode: 'P-SCOPE' }))
        .matchedSkuId,
    ).toBe(skuId);
    expect(
      (await resolveOne({ externalSystemId: systemB, externalProductCode: 'P-SCOPE' }))
        .resolutionStatus,
    ).toBe('UNMATCHED');
  });
});

// ═══════════════════════════════════════════════════════════════
// resolveMany — 실 DB
// ═══════════════════════════════════════════════════════════════

describe('★ resolveMany (실 DB)', () => {
  it('resolveOne 과 deep-equal 이고 입력 순서를 유지한다', async () => {
    const systemId = await newSystem('batch');
    const skuA = await newSku('batch-a');
    const skuB = await newSku('batch-b');
    const skuC = await newSku('batch-c');

    await mapping({ skuId: skuA, externalSystemId: systemId, externalProductCode: 'B-001' });
    await mapping({ skuId: skuB, externalSystemId: systemId, externalBarcode: '8809619961379' });
    await mapping({
      skuId: skuC,
      externalSystemId: systemId,
      externalProductName: '배치 상품',
      mappingStatus: 'REVIEW_REQUIRED',
    });

    const inputs = [
      { externalSystemId: systemId, externalProductCode: 'B-001' },
      { externalSystemId: systemId, externalBarcode: '8809619961379' },
      { externalSystemId: systemId, externalProductName: '배치 상품' },
      { externalSystemId: systemId, externalProductCode: '없음' },
    ];

    const many = await resolveMany(inputs);
    expect(many.map((r) => r.resolutionStatus)).toEqual([
      'MATCHED',
      'MATCHED',
      'REVIEW_REQUIRED',
      'UNMATCHED',
    ]);

    const ones: ResolveExternalMappingResult[] = [];
    for (const input of inputs) ones.push(await resolveOne(input));
    expect(many).toEqual(ones);
  });

  it('중복 입력이어도 결과가 결정적이다', async () => {
    const skuId = await newSku('batch-dup');
    const systemId = await newSystem('batch-dup');
    await mapping({ skuId, externalSystemId: systemId, externalProductCode: 'DUP-001' });

    const input = { externalSystemId: systemId, externalProductCode: 'DUP-001' };
    const results = await resolveMany([input, input, input]);

    expect(results).toHaveLength(3);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});
