import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertNoBomCycleForCandidate, buildBomCycleGraph } from '@/modules/bom/application';
import { parseBusinessDate } from '@/shared/business-date';
import { disconnectPrisma, getPrismaClient } from '@/shared/db';
import { ERROR_CODES } from '@/shared/errors';

/**
 * evaluation-date cycle graph DB 테스트 (T07-2) — 실제 PostgreSQL.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-13.
 *
 * ★ 이 파일의 핵심은 **그래프가 어떻게 구성되는가** 다:
 *   ① candidate 는 status 와 무관하게 **강제 투입**된다
 *   ② 그 밖의 parent 는 evaluation date 의 **ACTIVE 0/1건만**
 *   ③ 같은 parent 의 다른 버전(historical/future/DRAFT/APPROVED)은 **절대 union 되지 않는다**
 *
 * ③ 이 깨지면 `A v1 → B` 처럼 **이미 마감된 edge** 가 영구히 살아남아 새 BOM 을
 *   무기한 차단한다(false positive). 그 회귀를 막는 것이 §D-13 의 존재 이유다.
 */

const RUN = randomBytes(4).toString('hex');
const CODE = (suffix: string) => `TBG-${RUN}-${suffix}`;
const asOf = (iso: string) => parseBusinessDate(iso);
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

let seq = 0;

async function cleanup(): Promise<void> {
  const client = getPrismaClient();
  await client.bomLine.deleteMany({
    where: { bomHeader: { parentSku: { skuCode: { startsWith: 'TBG-' } } } },
  });
  await client.bomHeader.deleteMany({
    where: { parentSku: { skuCode: { startsWith: 'TBG-' } } },
  });
  await client.sku.deleteMany({ where: { skuCode: { startsWith: 'TBG-' } } });
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
      skuName: `graph SKU (${label})`,
      itemType: 'FINISHED_GOOD',
    },
    select: { id: true },
  });
  return row.id;
}

type Status = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

/** parent SKU 에 한 버전을 만들고 구성품 라인을 붙인다. */
async function newBom(
  parentSkuId: string,
  input: { from: string; to?: string | null; status?: Status; components: readonly string[] },
): Promise<string> {
  seq += 1;
  const client = getPrismaClient();
  const header = await client.bomHeader.create({
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
  let lineNo = 0;
  for (const componentSkuId of input.components) {
    lineNo += 1;
    await client.bomLine.create({
      data: {
        bomHeaderId: header.id,
        lineNo,
        componentSkuId,
        uom: 'EA',
        componentRole: 'MATERIAL',
      },
    });
  }
  return header.id;
}

function codeOf(error: unknown): string {
  return (error as { code: string }).code;
}

// ═══════════════════════════════════════════════════════════════
// candidate 강제 투입 (D-13 ①)
// ═══════════════════════════════════════════════════════════════

describe('★ candidate 는 status 와 무관하게 강제 투입된다 (D-13)', () => {
  it('DRAFT candidate 의 edge 가 그래프에 들어간다', async () => {
    const a = await newSku('draft상위');
    const b = await newSku('draft부품');

    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [b] },
      evaluationDate: asOf('2026-06-01'),
    });
    expect(graph.rootSkuId).toBe(a);
    expect(graph.substitutedSkuId).toBe(a);
    expect(graph.edges.get(a)).toEqual([b]);
  });

  it('★ candidate 는 DB 에 저장돼 있지 않아도 검사된다 (clone·import 준비 단계)', async () => {
    const a = await newSku('미저장상위');
    const b = await newSku('미저장부품');
    // a 에는 BOM row 가 하나도 없다 — candidate 만으로 그래프가 만들어진다.
    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [b] },
      evaluationDate: asOf('2026-06-01'),
    });
    expect(graph.edges.get(a)).toEqual([b]);
  });

  it('★ candidate 의 parent 는 resolver 결과가 아니라 candidate 자신이다', async () => {
    const a = await newSku('치환상위');
    const stored = await newSku('저장된부품');
    const pending = await newSku('대기부품');
    // DB 에는 A → stored 인 ACTIVE 버전이 있다.
    await newBom(a, { from: '2020-01-01', components: [stored] });

    // 그런데 candidate 는 A → pending 이다. 그래프는 candidate 를 써야 한다.
    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [pending] },
      evaluationDate: asOf('2026-06-01'),
    });
    expect(graph.edges.get(a)).toEqual([pending]);
    expect(graph.edges.get(a)).not.toContain(stored);
  });
});

// ═══════════════════════════════════════════════════════════════
// sibling 선택 (D-13 ②③)
// ═══════════════════════════════════════════════════════════════

describe('★ sibling 은 evaluation date 의 ACTIVE 0/1건만 (D-13)', () => {
  it('유효 ACTIVE sibling 의 구성품이 그래프에 들어간다', async () => {
    const a = await newSku('sib상위');
    const b = await newSku('sib중간');
    const c = await newSku('sib말단');
    await newBom(b, { from: '2020-01-01', components: [c] });

    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [b] },
      evaluationDate: asOf('2026-06-01'),
    });
    expect(graph.edges.get(b)).toEqual([c]);
    expect(graph.edges.get(c)).toEqual([]);
  });

  it('★ 다른 SKU 의 DRAFT / PENDING / APPROVED 는 무시된다', async () => {
    const a = await newSku('무시상위');
    const b = await newSku('무시중간');
    const hidden = await newSku('무시부품');
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] as const) {
      await newBom(b, { from: '2020-01-01', status, components: [hidden] });
    }

    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [b] },
      evaluationDate: asOf('2026-06-01'),
    });
    // b 는 유효 ACTIVE BOM 이 없으므로 leaf 다.
    expect(graph.edges.get(b)).toEqual([]);
    expect(graph.edges.has(hidden)).toBe(false);
  });

  it('★ historical ACTIVE 는 선택되지 않는다', async () => {
    const a = await newSku('과거상위');
    const b = await newSku('과거중간');
    const old = await newSku('과거부품');
    await newBom(b, { from: '2020-01-01', to: '2021-01-01', components: [old] });

    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [b] },
      evaluationDate: asOf('2026-06-01'),
    });
    expect(graph.edges.get(b)).toEqual([]);
  });

  it('★ future ACTIVE 는 선택되지 않는다', async () => {
    const a = await newSku('미래상위');
    const b = await newSku('미래중간');
    const later = await newSku('미래부품');
    await newBom(b, { from: '2099-01-01', components: [later] });

    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [b] },
      evaluationDate: asOf('2026-06-01'),
    });
    expect(graph.edges.get(b)).toEqual([]);
  });

  it('INACTIVE · ARCHIVED 도 선택되지 않는다', async () => {
    const a = await newSku('종료상위');
    const b = await newSku('종료중간');
    const gone = await newSku('종료부품');
    await newBom(b, { from: '2020-01-01', status: 'INACTIVE', components: [gone] });
    await newBom(b, { from: '2021-01-01', status: 'ARCHIVED', components: [gone] });

    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [b] },
      evaluationDate: asOf('2026-06-01'),
    });
    expect(graph.edges.get(b)).toEqual([]);
  });

  it('유효 BOM 이 없는 SKU 는 leaf 다', async () => {
    const a = await newSku('leaf상위');
    const b = await newSku('leaf부품');
    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [b] },
      evaluationDate: asOf('2026-06-01'),
    });
    expect(graph.edges.get(b)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// ★★ false positive 방지 — union 이면 오판하는 케이스
// ═══════════════════════════════════════════════════════════════

describe('★★ historical sibling union false positive 방지 (D-13)', () => {
  /**
   * ```
   *   A v1 ACTIVE [2020-01-01, 2027-01-01) → B     ← 2027-01-01 에 마감됨
   *   A v2 ACTIVE [2027-01-01, ∞)          → D     ← B 를 갖지 않는다
   *   C    ACTIVE [2020-01-01, ∞)          → A
   * ```
   * candidate `B`(구성품 `C`).
   *
   * union 이면 `A→B` 가 살아 있어 `B→C→A→B` 로 **오판**한다.
   * evaluation date 선택이면 `2027-06-01` 에서 `A` 는 `v2` 뿐이라 정상이다.
   */
  async function fixture() {
    const a = await newSku('fpA');
    const b = await newSku('fpB');
    const c = await newSku('fpC');
    const dSku = await newSku('fpD');
    await newBom(a, { from: '2020-01-01', to: '2027-01-01', components: [b] }); // A v1 → B
    await newBom(a, { from: '2027-01-01', components: [dSku] }); //                 A v2 → D
    await newBom(c, { from: '2020-01-01', components: [a] }); //                    C → A
    return { a, b, c, d: dSku };
  }

  it('★ 2027-06-01 기준에서는 순환이 아니다 — A v2 만 선택된다', async () => {
    const { a, b, c, d: dSku } = await fixture();

    const graph = await assertNoBomCycleForCandidate(getPrismaClient(), {
      candidate: { parentSkuId: b, componentSkuIds: [c] },
      evaluationDate: asOf('2027-06-01'),
    });
    expect(graph.edges.get(b)).toEqual([c]);
    expect(graph.edges.get(c)).toEqual([a]);
    // ★ A 의 자식은 v2 의 D 뿐이다 — v1 의 B 가 섞이면 안 된다.
    expect(graph.edges.get(a)).toEqual([dSku]);
    expect(graph.edges.get(a)).not.toContain(b);
  });

  it('★ 반대로 2026-06-01 기준에서는 진짜 순환이다 — A v1 이 선택된다', async () => {
    const { b, c } = await fixture();

    // 같은 candidate 라도 evaluation date 가 다르면 판정이 달라진다.
    let caught: unknown;
    try {
      await assertNoBomCycleForCandidate(getPrismaClient(), {
        candidate: { parentSkuId: b, componentSkuIds: [c] },
        evaluationDate: asOf('2026-06-01'),
      });
    } catch (error) {
      caught = error;
    }
    expect(codeOf(caught)).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);
  });

  it('★ evaluationDate override 로 activate 재검사 semantics 를 표현한다', async () => {
    const { b, c } = await fixture();
    const candidate = { parentSkuId: b, componentSkuIds: [c] };

    // activate 가 T 를 미래로 지정하면 sibling 선택이 통째로 바뀐다 (D-7·D-13).
    await expect(
      assertNoBomCycleForCandidate(getPrismaClient(), {
        candidate,
        evaluationDate: asOf('2030-01-01'),
      }),
    ).resolves.toBeTruthy();
    // 과거 T 로 activate 하면 그 시점 그래프에서 순환이다.
    await expect(
      assertNoBomCycleForCandidate(getPrismaClient(), {
        candidate,
        evaluationDate: asOf('2021-01-01'),
      }),
    ).rejects.toThrow(/순환/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 순환 판정 (D-13 DFS)
// ═══════════════════════════════════════════════════════════════

describe('★ 순환 판정 (TC-BOM-001 · TC-BOM-007)', () => {
  it('직접 자기참조 A→A', async () => {
    const a = await newSku('자기참조');
    let caught: unknown;
    try {
      await assertNoBomCycleForCandidate(getPrismaClient(), {
        candidate: { parentSkuId: a, componentSkuIds: [a] },
        evaluationDate: asOf('2026-06-01'),
      });
    } catch (error) {
      caught = error;
    }
    expect(codeOf(caught)).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);
  });

  it('2단계 A→B→A', async () => {
    const a = await newSku('2단계A');
    const b = await newSku('2단계B');
    await newBom(b, { from: '2020-01-01', components: [a] }); // B → A

    await expect(
      assertNoBomCycleForCandidate(getPrismaClient(), {
        candidate: { parentSkuId: a, componentSkuIds: [b] },
        evaluationDate: asOf('2026-06-01'),
      }),
    ).rejects.toThrow(/순환/);
  });

  it('3단계 A→B→C→A', async () => {
    const a = await newSku('3단계A');
    const b = await newSku('3단계B');
    const c = await newSku('3단계C');
    await newBom(b, { from: '2020-01-01', components: [c] });
    await newBom(c, { from: '2020-01-01', components: [a] });

    await expect(
      assertNoBomCycleForCandidate(getPrismaClient(), {
        candidate: { parentSkuId: a, componentSkuIds: [b] },
        evaluationDate: asOf('2026-06-01'),
      }),
    ).rejects.toThrow(/순환/);
  });

  it('★ 다이아몬드는 정상이다 (DB 그래프에서도)', async () => {
    const a = await newSku('다이아A');
    const b = await newSku('다이아B');
    const c = await newSku('다이아C');
    const dSku = await newSku('다이아D');
    await newBom(b, { from: '2020-01-01', components: [dSku] });
    await newBom(c, { from: '2020-01-01', components: [dSku] });

    await expect(
      assertNoBomCycleForCandidate(getPrismaClient(), {
        candidate: { parentSkuId: a, componentSkuIds: [b, c] },
        evaluationDate: asOf('2026-06-01'),
      }),
    ).resolves.toBeTruthy();
  });

  it('다단계 정상 체인 (완제품 → 반제품 → 부자재)', async () => {
    const finished = await newSku('완제품');
    const bulk = await newSku('반제품');
    const material = await newSku('부자재');
    await newBom(bulk, { from: '2020-01-01', components: [material] });

    const graph = await assertNoBomCycleForCandidate(getPrismaClient(), {
      candidate: { parentSkuId: finished, componentSkuIds: [bulk] },
      evaluationDate: asOf('2026-06-01'),
    });
    expect(graph.edges.get(bulk)).toEqual([material]);
    expect(graph.edges.get(material)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// line → edge 포함 계약 (D-13)
//
// ★ 계약: `BomLine` 에 `componentSkuId` 가 있으면 **무조건 edge** 다.
//   순환은 소요량 계산 가능 여부가 아니라 구조적 참조 관계이기 때문이다.
//   optional line 이라고 `A → B` 를 빼면 `B → A` 가 통과해 실물 순환이 생긴다.
// ═══════════════════════════════════════════════════════════════

/** edge 필터 근거가 **될 수 없는** 속성들. 각 항목이 독립적으로 고정된다. */
const EDGE_VARIANTS = [
  { label: 'isRequired=false', data: { isRequired: false } },
  { label: 'componentRole=SERVICE', data: { componentRole: 'SERVICE' as const } },
  { label: 'componentRole=PACKAGING', data: { componentRole: 'PACKAGING' as const } },
  { label: 'componentRole=PRODUCT', data: { componentRole: 'PRODUCT' as const } },
  { label: 'supplyType=null', data: { supplyType: null } },
  { label: 'supplyType=SELF_SUPPLIED', data: { supplyType: 'SELF_SUPPLIED' as const } },
  { label: 'supplyType=TURNKEY', data: { supplyType: 'TURNKEY' as const } },
  { label: 'alternateGroup=null', data: { alternateGroup: null } },
  { label: 'alternateGroup 값 있음', data: { alternateGroup: 'ALT-EDGE' } },
  {
    label: 'quantityStatus=UNKNOWN + quantityPer=null',
    data: { quantityStatus: 'UNKNOWN' as const, quantityPer: null },
  },
  {
    label: 'quantityStatus=SUGGESTED',
    data: { quantityStatus: 'SUGGESTED' as const, quantityPer: '0.033333' },
  },
  {
    label: 'quantityStatus=CONFIRMED',
    data: { quantityStatus: 'CONFIRMED' as const, quantityPer: '2' },
  },
  { label: 'lossRate 있음', data: { lossRate: '0.05' } },
] as const;

/** 주어진 속성으로 `parent → component` 라인 하나짜리 ACTIVE BOM 을 만든다. */
async function newBomWithLine(
  parentSkuId: string,
  componentSkuId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  seq += 1;
  const client = getPrismaClient();
  const header = await client.bomHeader.create({
    data: {
      parentSkuId,
      bomType: 'MANUFACTURING',
      version: `ev${String(seq).padStart(4, '0')}`,
      status: 'ACTIVE',
      outputUom: 'EA',
      effectiveFrom: d('2020-01-01'),
    },
    select: { id: true },
  });
  await client.bomLine.create({
    data: {
      bomHeaderId: header.id,
      lineNo: 1,
      componentSkuId,
      uom: 'EA',
      componentRole: 'MATERIAL',
      ...extra,
    },
  });
}

describe('★★ line → edge 포함 계약 — 어떤 속성으로도 제외되지 않는다 (D-13)', () => {
  it.each(EDGE_VARIANTS.map((variant) => [variant.label, variant.data] as const))(
    '%s 라인도 graph edge 다',
    async (_label, data) => {
      const parent = await newSku('edge상위');
      const component = await newSku('edge구성품');
      await newBomWithLine(parent, component, { ...data });

      const graph = await buildBomCycleGraph(getPrismaClient(), {
        candidate: { parentSkuId: await newSku('edge루트'), componentSkuIds: [parent] },
        evaluationDate: asOf('2026-06-01'),
      });
      expect(graph.edges.get(parent)).toEqual([component]);
    },
  );

  it.each(EDGE_VARIANTS.map((variant) => [variant.label, variant.data] as const))(
    '★ %s 라인을 통한 역방향 순환도 BOM_CYCLE_DETECTED 다',
    async (_label, data) => {
      const a = await newSku('순환A');
      const b = await newSku('순환B');
      // 기존 구조: B --(해당 속성)--> A
      await newBomWithLine(b, a, { ...data });

      // candidate: A → B  ⇒ A → B → A
      let caught: unknown;
      try {
        await assertNoBomCycleForCandidate(getPrismaClient(), {
          candidate: { parentSkuId: a, componentSkuIds: [b] },
          evaluationDate: asOf('2026-06-01'),
        });
      } catch (error) {
        caught = error;
      }
      expect(codeOf(caught)).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);
    },
  );

  it('★ inventoryManaged=false 인 구성품도 edge 이며 순환을 만든다', async () => {
    const client = getPrismaClient();
    seq += 1;
    const a = await newSku('무재고A');
    const unmanaged = await client.sku.create({
      data: {
        skuCode: CODE(`U${String(seq).padStart(3, '0')}`),
        skuName: '재고관리 안 함',
        itemType: 'FINISHED_GOOD',
        inventoryManaged: false,
      },
      select: { id: true },
    });
    await newBomWithLine(unmanaged.id, a, {});

    let caught: unknown;
    try {
      await assertNoBomCycleForCandidate(client, {
        candidate: { parentSkuId: a, componentSkuIds: [unmanaged.id] },
        evaluationDate: asOf('2026-06-01'),
      });
    } catch (error) {
      caught = error;
    }
    expect(codeOf(caught)).toBe(ERROR_CODES.BOM_CYCLE_DETECTED);
  });

  it('★ 여러 속성이 섞인 라인들이 lineNo 순서대로 전부 edge 다 — 부분 누락 없음', async () => {
    const parent = await newSku('혼합상위');
    const client = getPrismaClient();
    seq += 1;
    const header = await client.bomHeader.create({
      data: {
        parentSkuId: parent,
        bomType: 'MANUFACTURING',
        version: `mix${String(seq).padStart(4, '0')}`,
        status: 'ACTIVE',
        outputUom: 'EA',
        effectiveFrom: d('2020-01-01'),
      },
      select: { id: true },
    });

    const componentIds: string[] = [];
    let lineNo = 0;
    for (const variant of EDGE_VARIANTS) {
      lineNo += 1;
      const componentSkuId = await newSku(`혼합${lineNo}`);
      componentIds.push(componentSkuId);
      await client.bomLine.create({
        data: {
          bomHeaderId: header.id,
          lineNo,
          componentSkuId,
          uom: 'EA',
          componentRole: 'MATERIAL',
          ...variant.data,
        },
      });
    }

    const graph = await buildBomCycleGraph(client, {
      candidate: { parentSkuId: await newSku('혼합루트'), componentSkuIds: [parent] },
      evaluationDate: asOf('2026-06-01'),
    });
    // 하나라도 필터링되면 여기서 길이가 줄어든다.
    expect(graph.edges.get(parent)).toEqual(componentIds);
  });
});

describe('line → edge 포함 규칙 (D-13)', () => {
  it('★ isRequired=false · SERVICE · alternateGroup 라인도 edge 다 — 임의 제외 없음', async () => {
    const a = await newSku('edge상위');
    const b = await newSku('edge중간');
    const optional = await newSku('선택부품');
    const service = await newSku('임가공');

    const client = getPrismaClient();
    const header = await client.bomHeader.create({
      data: {
        parentSkuId: b,
        bomType: 'MANUFACTURING',
        version: `edge-${RUN}`,
        status: 'ACTIVE',
        outputUom: 'EA',
        effectiveFrom: d('2020-01-01'),
      },
      select: { id: true },
    });
    await client.bomLine.createMany({
      data: [
        {
          bomHeaderId: header.id,
          lineNo: 1,
          componentSkuId: optional,
          uom: 'EA',
          componentRole: 'MATERIAL',
          isRequired: false,
          alternateGroup: 'ALT-A',
        },
        {
          bomHeaderId: header.id,
          lineNo: 2,
          componentSkuId: service,
          uom: 'EA',
          componentRole: 'SERVICE',
        },
      ],
    });

    const graph = await buildBomCycleGraph(getPrismaClient(), {
      candidate: { parentSkuId: a, componentSkuIds: [b] },
      evaluationDate: asOf('2026-06-01'),
    });
    // docs/18 에 제외 규정이 없다 — componentSku 관계가 있으면 edge 다.
    expect(graph.edges.get(b)).toEqual([optional, service]);
  });

  it('★ 선택 라인을 통한 순환도 잡는다', async () => {
    const a = await newSku('선택순환A');
    const b = await newSku('선택순환B');
    const client = getPrismaClient();
    const header = await client.bomHeader.create({
      data: {
        parentSkuId: b,
        bomType: 'MANUFACTURING',
        version: `optcycle-${RUN}`,
        status: 'ACTIVE',
        outputUom: 'EA',
        effectiveFrom: d('2020-01-01'),
      },
      select: { id: true },
    });
    await client.bomLine.create({
      data: {
        bomHeaderId: header.id,
        lineNo: 1,
        componentSkuId: a,
        uom: 'EA',
        componentRole: 'PACKAGING',
        isRequired: false,
      },
    });

    await expect(
      assertNoBomCycleForCandidate(getPrismaClient(), {
        candidate: { parentSkuId: a, componentSkuIds: [b] },
        evaluationDate: asOf('2026-06-01'),
      }),
    ).rejects.toThrow(/순환/);
  });
});
