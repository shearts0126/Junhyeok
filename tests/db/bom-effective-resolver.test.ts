import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveEffectiveBom, resolveEffectiveBoms } from '@/modules/bom/application';
import { parseBusinessDate } from '@/shared/business-date';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

/**
 * `resolveEffectiveBom(s)` DB 테스트 (T07-2) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-22.
 *
 * predicate:
 * ```
 *   status = 'ACTIVE'
 *   AND effectiveFrom <= asOf
 *   AND (effectiveTo IS NULL OR asOf < effectiveTo)
 * ```
 *
 * ★ 핵심은 `findFirst()` 가 아니라 **half-open `[from,to)` + 0/1/2+ 무결성 계약**
 *   이라는 점이다. 경계 두 개(`from == asOf` 포함 / `to == asOf` 제외)를 특히 고정한다.
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TBR-${RUN}-${suffix}`;
const asOf = (iso: string) => parseBusinessDate(iso);
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

let seq = 0;

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TBR-' } } } },
  });
  await client.bomHeader.deleteMany({
    where: { parentSku: { skuCode: { startsWith: 'TBR-' } } },
  });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TBR-' } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await disconnectPrisma().catch(() => undefined);
});

async function newSku(label: string): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().sku.create({
    data: {
      skuCode: CODE(`K${String(seq).padStart(3, '0')}`),
      skuName: `resolver SKU (${label})`,
      itemType: 'FINISHED_GOOD',
    },
    select: { id: true },
  });
  return row.id;
}

interface HeaderInput {
  readonly from: string;
  readonly to?: string | null;
  readonly status?: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
}

async function newHeader(parentSkuId: string, input: HeaderInput): Promise<string> {
  seq += 1;
  const row = await getPrismaClient().bomHeader.create({
    data: {
      parentSkuId,
      bomType: 'MANUFACTURING',
      version: `v${String(seq).padStart(4, '0')}`,
      status: input.status ?? 'ACTIVE',
      outputUom: 'EA',
      effectiveFrom: d(input.from),
      effectiveTo: input.to === undefined || input.to === null ? null : d(input.to),
    },
    select: { id: true },
  });
  return row.id;
}

describe('★ resolveEffectiveBom — 경계 (D-22)', () => {
  it('1. 유효 BOM 이 없으면 null 이다 — 오류가 아니다', async () => {
    const sku = await newSku('없음');
    await expect(
      resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2026-06-01') }),
    ).resolves.toBeNull();
  });

  it('★ 2. effectiveFrom == asOf 는 포함된다', async () => {
    const sku = await newSku('시작일포함');
    const id = await newHeader(sku, { from: '2026-06-01', to: '2027-01-01' });

    const row = await resolveEffectiveBom(getPrismaClient(), {
      parentSkuId: sku,
      asOf: asOf('2026-06-01'),
    });
    expect(row?.id).toBe(id);
  });

  it('★ 3. effectiveTo == asOf 는 제외된다 (half-open)', async () => {
    const sku = await newSku('종료일제외');
    await newHeader(sku, { from: '2026-01-01', to: '2026-06-01' });

    await expect(
      resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2026-06-01') }),
    ).resolves.toBeNull();
  });

  it('4. 구간 내부는 포함된다 · 시작 이전은 제외된다', async () => {
    const sku = await newSku('내부');
    const id = await newHeader(sku, { from: '2026-01-01', to: '2027-01-01' });

    expect(
      (await resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2026-06-01') }))
        ?.id,
    ).toBe(id);
    await expect(
      resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2025-12-31') }),
    ).resolves.toBeNull();
  });

  it('★ 5. 마감된 predecessor 다음에는 successor 가 선택된다 (D-7 chain)', async () => {
    const sku = await newSku('체인');
    const v1 = await newHeader(sku, { from: '2020-01-01', to: '2027-01-01' });
    const v2 = await newHeader(sku, { from: '2027-01-01', to: null });

    expect(
      (await resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2026-06-01') }))
        ?.id,
    ).toBe(v1);
    expect(
      (await resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2027-01-01') }))
        ?.id,
    ).toBe(v2);
    expect(
      (await resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2030-01-01') }))
        ?.id,
    ).toBe(v2);
  });

  it('6. 미래 버전은 아직 선택되지 않는다', async () => {
    const sku = await newSku('미래');
    await newHeader(sku, { from: '2099-01-01', to: null });
    await expect(
      resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2026-06-01') }),
    ).resolves.toBeNull();
  });

  it('7. gap 구간은 null 이다', async () => {
    const sku = await newSku('갭');
    await newHeader(sku, { from: '2020-01-01', to: '2021-01-01' });
    await newHeader(sku, { from: '2026-01-01', to: null });

    await expect(
      resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2023-06-01') }),
    ).resolves.toBeNull();
  });

  it('★ ACTIVE 가 아닌 버전은 선택되지 않는다 — 기간이 맞아도', async () => {
    const sku = await newSku('비활성');
    for (const status of [
      'DRAFT',
      'PENDING_APPROVAL',
      'APPROVED',
      'INACTIVE',
      'ARCHIVED',
    ] as const) {
      await newHeader(sku, { from: '2026-01-01', to: null, status });
    }
    await expect(
      resolveEffectiveBom(getPrismaClient(), { parentSkuId: sku, asOf: asOf('2026-06-01') }),
    ).resolves.toBeNull();
  });
});

describe('★ resolveEffectiveBoms — batch (D-22)', () => {
  it('8. 입력 id 전부가 key 로 존재하고 없는 것은 null 이다', async () => {
    const hit = await newSku('배치있음');
    const miss = await newSku('배치없음');
    const id = await newHeader(hit, { from: '2026-01-01', to: null });

    const map = await resolveEffectiveBoms(getPrismaClient(), {
      parentSkuIds: [hit, miss],
      asOf: asOf('2026-06-01'),
    });
    expect(map.size).toBe(2);
    expect(map.get(hit)?.id).toBe(id);
    expect(map.has(miss)).toBe(true);
    expect(map.get(miss)).toBeNull();
  });

  it('9. 중복 입력 id 는 한 번만 처리된다', async () => {
    const sku = await newSku('중복입력');
    const id = await newHeader(sku, { from: '2026-01-01', to: null });

    const map = await resolveEffectiveBoms(getPrismaClient(), {
      parentSkuIds: [sku, sku, sku],
      asOf: asOf('2026-06-01'),
    });
    expect(map.size).toBe(1);
    expect(map.get(sku)?.id).toBe(id);
  });

  it('빈 입력은 빈 Map 이다 — 쿼리를 날리지 않는다', async () => {
    const map = await resolveEffectiveBoms(getPrismaClient(), {
      parentSkuIds: [],
      asOf: asOf('2026-06-01'),
    });
    expect(map.size).toBe(0);
  });

  it('10. 여러 SKU 를 한 번에 해결하며 각자 자기 버전을 고른다', async () => {
    const a = await newSku('배치A');
    const b = await newSku('배치B');
    const aId = await newHeader(a, { from: '2020-01-01', to: '2027-01-01' });
    await newHeader(a, { from: '2027-01-01', to: null });
    const bId = await newHeader(b, { from: '2020-01-01', to: null });

    const map = await resolveEffectiveBoms(getPrismaClient(), {
      parentSkuIds: [a, b],
      asOf: asOf('2026-06-01'),
    });
    expect(map.get(a)?.id).toBe(aId);
    expect(map.get(b)?.id).toBe(bId);
  });

  it('단건은 배치의 wrapper 다 — 같은 결과를 준다', async () => {
    const sku = await newSku('wrapper');
    const id = await newHeader(sku, { from: '2026-01-01', to: null });

    const single = await resolveEffectiveBom(getPrismaClient(), {
      parentSkuId: sku,
      asOf: asOf('2026-06-01'),
    });
    const batch = await resolveEffectiveBoms(getPrismaClient(), {
      parentSkuIds: [sku],
      asOf: asOf('2026-06-01'),
    });
    expect(single?.id).toBe(id);
    expect(batch.get(sku)?.id).toBe(id);
  });
});

describe('★ 2건 이상 = 손상 → 409 BOM_EFFECTIVE_CONFLICT (D-22)', () => {
  /**
   * ⚠️ `bom_header_active_period_excl` EXCLUDE 때문에 **정상 경로로는 겹치는
   *    ACTIVE 두 건을 만들 수 없다.** 손상 상태를 재현하려면 제약을 잠시
   *    비활성화해야 하는데, 그것은 다른 DB 테스트 파일과 공유하는 스키마를
   *    흔든다. 따라서 여기서는 **제약이 정말로 막는다는 사실**만 확인하고,
   *    2건 이상 → 409 는 도메인 단위 테스트(`bom-domain-rules.test.ts`
   *    `selectEffectiveBom`)가 고정한다.
   */
  it('EXCLUDE 가 있어 겹치는 ACTIVE 2건을 만들 수 없다 (defensive guard 의 전제)', async () => {
    const sku = await newSku('손상불가');
    await newHeader(sku, { from: '2026-01-01', to: null });
    await expect(newHeader(sku, { from: '2026-06-01', to: null })).rejects.toThrow(
      /bom_header_active_period_excl|conflicting key value/i,
    );
  });

  it('★ 제약을 우회해 손상을 심으면 resolver 가 409 로 드러낸다', async () => {
    const sku = await newSku('손상재현');
    const client = getPrismaClient();

    // 같은 트랜잭션 안에서만 제약을 미뤄 손상을 만든다 — 커밋하지 않고 롤백한다.
    // (`ALTER TABLE ... DISABLE` 이 아니라 트랜잭션 내 raw INSERT + rollback 이라
    //  다른 테스트 파일의 스키마를 건드리지 않는다.)
    let observed: string | null = null;
    await client
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE bom_header DROP CONSTRAINT bom_header_active_period_excl`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO bom_header (id, parent_sku_id, bom_type, version, status, output_qty,
                                   output_uom, effective_from, created_at)
           VALUES (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'dup-1', 'ACTIVE', 1, 'EA',
                   DATE '2026-01-01', now()),
                  (gen_random_uuid(), $1::uuid, 'MANUFACTURING', 'dup-2', 'ACTIVE', 1, 'EA',
                   DATE '2026-02-01', now())`,
          sku,
        );

        try {
          await resolveEffectiveBom(tx, { parentSkuId: sku, asOf: asOf('2026-06-01') });
        } catch (error) {
          observed = (error as { code: string }).code;
        }
        // ⚠️ 반드시 롤백한다 — 제약 삭제와 손상 행이 남으면 안 된다.
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if ((error as Error).message !== 'rollback') throw error;
      });

    expect(observed).toBe(ERROR_CODES.BOM_EFFECTIVE_CONFLICT);

    // 롤백되어 제약과 데이터가 원상복구됐는지 확인한다.
    const rows = await client.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE conname = 'bom_header_active_period_excl'`,
    );
    expect(rows).toHaveLength(1);
    expect(await client.bomHeader.count({ where: { parentSkuId: sku } })).toBe(0);
  });
});
