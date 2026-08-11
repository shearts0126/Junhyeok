import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@/shared/errors';

import {
  MAPPING_STATUSES,
  resolveMany,
  resolveOne,
  type ExternalMappingLookupRow,
  type ExternalMappingResolverPort,
  type ResolveExternalMappingInput,
  type ResolveExternalMappingResult,
} from './application';

/**
 * SKU 해석 서비스 단위 테스트 (T05-3).
 *
 * 계약 근거는 `docs/14_설계복구_ExternalMappingResolver.md` 뿐이다.
 * 실 PostgreSQL 동작은 `tests/db/external-mapping-resolver.test.ts` 에서 본다.
 *
 * ⚠️ resolver 는 **pure read** 라 조회 포트만 대역으로 바꾸면 판정 로직 전체를
 *    대역으로 검증할 수 있다. 그래서 여기서 truth table 을 촘촘히 고정한다.
 */

const SYS_A = '11111111-1111-4111-8111-111111111111';
const SYS_B = '22222222-2222-4222-8222-222222222222';
const SKU_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SKU_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SKU_C = 'cccccccc-0000-4000-8000-000000000003';

interface Row {
  readonly skuId: string;
  readonly externalSystemId?: string;
  readonly externalProductCode?: string | null;
  readonly externalBarcode?: string | null;
  readonly externalProductName?: string | null;
}

/**
 * 대역 포트 — **현행 매핑만** 담는다.
 *
 * ★ 종료된 매핑(`effectiveTo != null`)은 Prisma 포트가 `where` 로 이미 걸러내므로
 *   여기 넣지 않는다. "이력 제외"는 DB 테스트에서 실제 행으로 검증한다.
 */
function portOf(rows: readonly Row[]): ExternalMappingResolverPort & { calls: string[] } {
  const all: ExternalMappingLookupRow[] = rows.map((row) => ({
    skuId: row.skuId,
    externalSystemId: row.externalSystemId ?? SYS_A,
    externalProductCode: row.externalProductCode ?? null,
    externalBarcode: row.externalBarcode ?? null,
    externalProductName: row.externalProductName ?? null,
  }));

  const calls: string[] = [];
  const pick = (
    field: 'externalProductCode' | 'externalBarcode' | 'externalProductName',
    systemIds: readonly string[],
    values: readonly string[],
  ) =>
    all.filter(
      (row) =>
        systemIds.includes(row.externalSystemId) &&
        row[field] !== null &&
        values.includes(row[field] as string),
    );

  return {
    calls,
    async findExistingSystemIds(systemIds) {
      calls.push('systems');
      return new Set(systemIds.filter((id) => id === SYS_A || id === SYS_B));
    },
    async findCurrentByCodes(systemIds, codes) {
      calls.push('codes');
      return pick('externalProductCode', systemIds, codes);
    },
    async findCurrentByBarcodes(systemIds, barcodes) {
      calls.push('barcodes');
      return pick('externalBarcode', systemIds, barcodes);
    },
    async findCurrentByNames(systemIds, names) {
      calls.push('names');
      return pick('externalProductName', systemIds, names);
    },
  };
}

function resolve(
  rows: readonly Row[],
  input: Omit<ResolveExternalMappingInput, 'externalSystemId'> & { externalSystemId?: string },
): Promise<ResolveExternalMappingResult> {
  return resolveOne({ externalSystemId: SYS_A, ...input }, { port: portOf(rows) });
}

// ═══════════════════════════════════════════════════════════════
// 확정 매칭 (§6·§7)
// ═══════════════════════════════════════════════════════════════

describe('★ 1순위 코드 · 2순위 바코드 — 확정 매칭', () => {
  it('1. 코드 단일 → MATCHED / CODE / autoApplicable', async () => {
    const result = await resolve([{ skuId: SKU_A, externalProductCode: 'P001' }], {
      externalProductCode: 'P001',
    });

    expect(result).toEqual({
      resolutionStatus: 'MATCHED',
      matchedSkuId: SKU_A,
      matchMethod: 'CODE',
      autoApplicable: true,
      requiresReview: false,
      candidateSkuIds: [SKU_A],
      reasonCode: 'CODE_MATCH',
    });
  });

  it('2. 바코드 단일 → MATCHED / BARCODE / autoApplicable', async () => {
    const result = await resolve([{ skuId: SKU_B, externalBarcode: '8809619961373' }], {
      externalBarcode: '8809619961373',
    });

    expect(result).toEqual({
      resolutionStatus: 'MATCHED',
      matchedSkuId: SKU_B,
      matchMethod: 'BARCODE',
      autoApplicable: true,
      requiresReview: false,
      candidateSkuIds: [SKU_B],
      reasonCode: 'BARCODE_MATCH',
    });
  });

  it('3. ★ 상품명 단일 → REVIEW_REQUIRED / NAME / 자동 적용 금지 (TC-INV-026)', async () => {
    const result = await resolve([{ skuId: SKU_C, externalProductName: '외부 상품 A' }], {
      externalProductName: '외부 상품 A',
    });

    expect(result).toEqual({
      resolutionStatus: 'REVIEW_REQUIRED',
      // 후보 반환은 허용된다 — 그러나 자동 반영 대상이 아니다.
      matchedSkuId: SKU_C,
      matchMethod: 'NAME',
      autoApplicable: false,
      requiresReview: true,
      candidateSkuIds: [SKU_C],
      reasonCode: 'NAME_ONLY_REVIEW_REQUIRED',
    });
  });

  it('4. 아무 것도 못 찾으면 UNMATCHED / NO_MATCH', async () => {
    const result = await resolve([{ skuId: SKU_A, externalProductCode: 'P001' }], {
      externalProductCode: 'ZZZ',
      externalProductName: '없는 이름',
    });

    expect(result).toEqual({
      resolutionStatus: 'UNMATCHED',
      matchedSkuId: null,
      matchMethod: 'UNMATCHED',
      autoApplicable: false,
      requiresReview: true,
      candidateSkuIds: [],
      reasonCode: 'NO_MATCH',
    });
  });

  it('5. 식별자가 전부 비어 있어도 오류가 아니라 UNMATCHED 다', async () => {
    for (const input of [
      {},
      { externalProductCode: null, externalBarcode: null, externalProductName: null },
      { externalProductCode: '   ', externalProductName: '' },
    ]) {
      const result = await resolve([{ skuId: SKU_A, externalProductCode: 'P001' }], input);
      expect(result.resolutionStatus, JSON.stringify(input)).toBe('UNMATCHED');
      expect(result.reasonCode).toBe('NO_MATCH');
    }
  });

  it('6. 코드·바코드가 같은 SKU → CODE MATCH (코드가 상위)', async () => {
    const result = await resolve(
      [{ skuId: SKU_A, externalProductCode: 'P001', externalBarcode: '8809619961373' }],
      { externalProductCode: 'P001', externalBarcode: '8809619961373' },
    );

    expect(result.resolutionStatus).toBe('MATCHED');
    expect(result.matchMethod).toBe('CODE');
    expect(result.matchedSkuId).toBe(SKU_A);
    expect(result.candidateSkuIds).toEqual([SKU_A]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 충돌 · 모호성 (§7·§8·§10)
// ═══════════════════════════════════════════════════════════════

describe('★ 코드 ↔ 바코드 충돌', () => {
  it('7. 코드 → A, 바코드 → B → CONFLICT (임의 선택 없음)', async () => {
    const result = await resolve(
      [
        { skuId: SKU_A, externalProductCode: 'P001' },
        { skuId: SKU_B, externalBarcode: '8809619961373' },
      ],
      { externalProductCode: 'P001', externalBarcode: '8809619961373' },
    );

    expect(result).toEqual({
      resolutionStatus: 'CONFLICT',
      matchedSkuId: null,
      matchMethod: 'UNMATCHED',
      autoApplicable: false,
      requiresReview: true,
      candidateSkuIds: [SKU_A, SKU_B],
      reasonCode: 'IDENTIFIER_CONFLICT',
    });
  });

  it('8. 코드 → A, 바코드 → {A, B} → CONFLICT', async () => {
    const result = await resolve(
      [
        { skuId: SKU_A, externalProductCode: 'P001' },
        { skuId: SKU_A, externalBarcode: '8809619961373' },
        { skuId: SKU_B, externalBarcode: '8809619961373' },
      ],
      { externalProductCode: 'P001', externalBarcode: '8809619961373' },
    );

    expect(result.resolutionStatus).toBe('CONFLICT');
    expect(result.reasonCode).toBe('IDENTIFIER_CONFLICT');
    expect(result.candidateSkuIds).toEqual([SKU_A, SKU_B]);
  });

  it('9. 코드 없음 + 바코드 → {A, B} → AMBIGUOUS (상품명으로 내려가지 않는다)', async () => {
    const result = await resolve(
      [
        { skuId: SKU_A, externalBarcode: '8809619961373' },
        { skuId: SKU_B, externalBarcode: '8809619961373' },
        // 상품명으로는 단일 후보가 있지만 fallback 하지 않는다.
        { skuId: SKU_C, externalProductName: '외부 상품 A' },
      ],
      { externalBarcode: '8809619961373', externalProductName: '외부 상품 A' },
    );

    expect(result.resolutionStatus).toBe('AMBIGUOUS');
    expect(result.reasonCode).toBe('BARCODE_AMBIGUOUS');
    expect(result.matchedSkuId).toBeNull();
    expect(result.candidateSkuIds).toEqual([SKU_A, SKU_B]);
  });

  it('10. ★ 같은 바코드 행이 여러 개여도 SKU 가 하나면 모호하지 않다', async () => {
    const result = await resolve(
      [
        { skuId: SKU_A, externalBarcode: '8809619961373' },
        { skuId: SKU_A, externalBarcode: '8809619961373', externalProductName: '다른 별칭' },
      ],
      { externalBarcode: '8809619961373' },
    );

    // row count 가 아니라 distinct SKU count 로 판정한다.
    expect(result.resolutionStatus).toBe('MATCHED');
    expect(result.matchMethod).toBe('BARCODE');
    expect(result.candidateSkuIds).toEqual([SKU_A]);
  });
});

describe('★ 상품명 모호성', () => {
  it('11. 같은 상품명 행이 여러 개여도 SKU 가 하나면 단일 후보다', async () => {
    const result = await resolve(
      [
        { skuId: SKU_A, externalProductName: '외부 상품 A' },
        { skuId: SKU_A, externalProductName: '외부 상품 A', externalProductCode: 'OTHER' },
      ],
      { externalProductName: '외부 상품 A' },
    );

    expect(result.resolutionStatus).toBe('REVIEW_REQUIRED');
    expect(result.matchedSkuId).toBe(SKU_A);
    expect(result.candidateSkuIds).toEqual([SKU_A]);
  });

  it('12. 상품명 → {A, B} → AMBIGUOUS / NAME_AMBIGUOUS', async () => {
    const result = await resolve(
      [
        { skuId: SKU_B, externalProductName: '외부 상품 A' },
        { skuId: SKU_A, externalProductName: '외부 상품 A' },
      ],
      { externalProductName: '외부 상품 A' },
    );

    expect(result).toEqual({
      resolutionStatus: 'AMBIGUOUS',
      matchedSkuId: null,
      matchMethod: 'UNMATCHED',
      autoApplicable: false,
      requiresReview: true,
      candidateSkuIds: [SKU_A, SKU_B],
      reasonCode: 'NAME_AMBIGUOUS',
    });
  });
});

describe('★ 상품명은 상위 식별자를 override 하지 않는다 (§10)', () => {
  it('13. 코드 확정 + 상품명이 다른 SKU → CODE MATCH 유지', async () => {
    const result = await resolve(
      [
        { skuId: SKU_A, externalProductCode: 'P001' },
        { skuId: SKU_B, externalProductName: '외부 상품 A' },
      ],
      { externalProductCode: 'P001', externalProductName: '외부 상품 A' },
    );

    expect(result.resolutionStatus).toBe('MATCHED');
    expect(result.matchMethod).toBe('CODE');
    expect(result.matchedSkuId).toBe(SKU_A);
    expect(result.reasonCode).not.toBe('IDENTIFIER_CONFLICT');
  });

  it('14. 바코드 확정 + 상품명이 다른 SKU → BARCODE MATCH 유지', async () => {
    const result = await resolve(
      [
        { skuId: SKU_A, externalBarcode: '8809619961373' },
        { skuId: SKU_B, externalProductName: '외부 상품 A' },
      ],
      { externalBarcode: '8809619961373', externalProductName: '외부 상품 A' },
    );

    expect(result.resolutionStatus).toBe('MATCHED');
    expect(result.matchMethod).toBe('BARCODE');
    expect(result.matchedSkuId).toBe(SKU_A);
  });
});

// ═══════════════════════════════════════════════════════════════
// current / scope (§11) — 대역 포트가 현행 행만 담는 전제
// ═══════════════════════════════════════════════════════════════

describe('★ 조회 범위 — 시스템 경계', () => {
  it('15~17. 다른 외부시스템의 동일 code/barcode/name 은 섞이지 않는다', async () => {
    const rows: Row[] = [
      { skuId: SKU_B, externalSystemId: SYS_B, externalProductCode: 'P001' },
      { skuId: SKU_B, externalSystemId: SYS_B, externalBarcode: '8809619961373' },
      { skuId: SKU_B, externalSystemId: SYS_B, externalProductName: '외부 상품 A' },
    ];

    const result = await resolve(rows, {
      externalProductCode: 'P001',
      externalBarcode: '8809619961373',
      externalProductName: '외부 상품 A',
    });
    expect(result.resolutionStatus).toBe('UNMATCHED');

    // 같은 시스템으로 조회하면 찾는다.
    const inB = await resolveOne(
      { externalSystemId: SYS_B, externalProductCode: 'P001' },
      { port: portOf(rows) },
    );
    expect(inB.matchedSkuId).toBe(SKU_B);
  });

  it('18. current 기준은 effectiveTo IS NULL 이다 — 포트가 이력 행을 주지 않는다', async () => {
    // 이력 제외는 Prisma `where` 계약이라 DB 테스트가 최종 근거다.
    // 여기서는 "현행 행이 없으면 UNMATCHED" 라는 판정만 고정한다.
    const result = await resolve([], { externalProductCode: 'P001' });
    expect(result.resolutionStatus).toBe('UNMATCHED');
  });
});

// ═══════════════════════════════════════════════════════════════
// 정규화 (§9)
// ═══════════════════════════════════════════════════════════════

describe('★ 입력 정규화 — T05-2 규칙 재사용, 새 규칙 없음', () => {
  it('19. 코드는 trim 만 하고 대소문자를 구분한다', async () => {
    const rows: Row[] = [{ skuId: SKU_A, externalProductCode: 'P001' }];

    expect((await resolve(rows, { externalProductCode: '  P001  ' })).matchedSkuId).toBe(SKU_A);
    // 대소문자를 접지 않는다.
    expect((await resolve(rows, { externalProductCode: 'p001' })).resolutionStatus).toBe(
      'UNMATCHED',
    );
  });

  it('20. 상품명도 trim 만 하고 대소문자를 구분한다', async () => {
    const rows: Row[] = [{ skuId: SKU_A, externalProductName: 'Serum A' }];

    expect((await resolve(rows, { externalProductName: '  Serum A  ' })).matchedSkuId).toBe(SKU_A);
    expect((await resolve(rows, { externalProductName: 'serum a' })).resolutionStatus).toBe(
      'UNMATCHED',
    );
  });

  it('21. ★ fuzzy·부분일치를 하지 않는다', async () => {
    const rows: Row[] = [{ skuId: SKU_A, externalProductName: '딥포인트 세럼 30ml' }];

    for (const term of ['딥포인트 세럼', '세럼 30ml', '딥포인트  세럼 30ml', '딥포인트세럼30ml']) {
      const result = await resolve(rows, { externalProductName: term });
      expect(result.resolutionStatus, term).toBe('UNMATCHED');
    }
    // 정확히 같을 때만 찾는다.
    expect((await resolve(rows, { externalProductName: '딥포인트 세럼 30ml' })).matchedSkuId).toBe(
      SKU_A,
    );
  });

  it('바코드는 T04-2 규칙대로 공백·하이픈이 제거된 값으로 조회된다', async () => {
    const rows: Row[] = [{ skuId: SKU_A, externalBarcode: '8809619961373' }];
    expect((await resolve(rows, { externalBarcode: ' 880-961 9961373 ' })).matchedSkuId).toBe(
      SKU_A,
    );
  });
});

describe('★ 잘못된 바코드 입력 (§9)', () => {
  const rows: Row[] = [
    { skuId: SKU_A, externalProductCode: 'P001' },
    { skuId: SKU_C, externalProductName: '외부 상품 A' },
  ];

  it('22. 잘못된 바코드만 있고 다른 match 가 없으면 UNMATCHED / INVALID_BARCODE', async () => {
    for (const raw of ['8.80962E+12', '확인필요', 'ABC123']) {
      const result = await resolve(rows, { externalBarcode: raw });
      expect(result.resolutionStatus, raw).toBe('UNMATCHED');
      expect(result.reasonCode, raw).toBe('INVALID_BARCODE');
      expect(result.matchedSkuId).toBeNull();
    }
  });

  it('23. 유효한 코드 + 잘못된 바코드 → CODE MATCH (예외를 던지지 않는다)', async () => {
    const result = await resolve(rows, {
      externalProductCode: 'P001',
      externalBarcode: '확인필요',
    });

    expect(result.resolutionStatus).toBe('MATCHED');
    expect(result.matchMethod).toBe('CODE');
    expect(result.matchedSkuId).toBe(SKU_A);
  });

  it('24. 잘못된 바코드 + 단일 상품명 → REVIEW_REQUIRED / NAME', async () => {
    const result = await resolve(rows, {
      externalBarcode: 'ABC123',
      externalProductName: '외부 상품 A',
    });

    expect(result.resolutionStatus).toBe('REVIEW_REQUIRED');
    expect(result.matchMethod).toBe('NAME');
    expect(result.matchedSkuId).toBe(SKU_C);
    expect(result.reasonCode).toBe('NAME_ONLY_REVIEW_REQUIRED');
  });

  it('EMPTY 표시 바코드는 잘못된 입력이 아니다 — NO_MATCH 로 끝난다', async () => {
    const result = await resolve(rows, { externalBarcode: '-' });
    expect(result.reasonCode).toBe('NO_MATCH');
  });
});

// ═══════════════════════════════════════════════════════════════
// 후보 목록 결정성 (§15)
// ═══════════════════════════════════════════════════════════════

describe('★ candidateSkuIds — distinct + 오름차순', () => {
  it('25·26. 중복이 제거되고 DB 반환 순서와 무관하게 정렬된다', async () => {
    const shuffled: Row[] = [
      { skuId: SKU_C, externalBarcode: '8809619961373' },
      { skuId: SKU_A, externalBarcode: '8809619961373' },
      { skuId: SKU_C, externalBarcode: '8809619961373' },
      { skuId: SKU_B, externalBarcode: '8809619961373' },
      { skuId: SKU_A, externalBarcode: '8809619961373' },
    ];

    const result = await resolve(shuffled, { externalBarcode: '8809619961373' });
    expect(result.candidateSkuIds).toEqual([SKU_A, SKU_B, SKU_C]);

    // 입력 행 순서를 뒤집어도 같은 결과다.
    const reversed = await resolve([...shuffled].reverse(), {
      externalBarcode: '8809619961373',
    });
    expect(reversed).toEqual(result);
  });
});

// ═══════════════════════════════════════════════════════════════
// SKU eligibility · T05-2 계약 불변 (§12·§1)
// ═══════════════════════════════════════════════════════════════

describe('★ SKU 상태로 결과를 거르지 않는다 (§12)', () => {
  it('27~29. resolver 는 identity 만 본다 — 매핑이 있으면 그대로 반환한다', async () => {
    // ⚠️ resolver 는 SKU 상태를 조회조차 하지 않는다. 포트가 돌려준 매핑의
    //    `skuId` 를 그대로 낸다. INACTIVE·DISCONTINUED·ARCHIVED·deleted 여부는
    //    downstream(posting·reconciliation)의 책임이다.
    const result = await resolve([{ skuId: SKU_A, externalProductCode: 'P001' }], {
      externalProductCode: 'P001',
    });
    expect(result.matchedSkuId).toBe(SKU_A);

    // 실제 SKU 상태별 동작은 DB 테스트에서 실 행으로 고정한다.
    expect(result.autoApplicable).toBe(true);
  });
});

describe('★ T05-2 계약 불변 (§1)', () => {
  it('30. MappingStatus enum 은 3종 그대로이고 resolver 결과와 별개다', async () => {
    expect(MAPPING_STATUSES).toEqual(['MATCHED', 'UNMATCHED', 'REVIEW_REQUIRED']);

    // resolver 의 status 집합은 5종이며 DB enum 이 아니다.
    const statuses = new Set<string>();
    statuses.add(
      (await resolve([{ skuId: SKU_A, externalProductCode: 'P' }], {})).resolutionStatus,
    );
    expect(statuses.has('UNMATCHED')).toBe(true);
  });

  it('★ matchMethod 는 4종뿐이다 — AMBIGUOUS·CONFLICT 를 넣지 않았다 (T17-1 호환)', async () => {
    const results = await Promise.all([
      resolve([{ skuId: SKU_A, externalProductCode: 'P001' }], { externalProductCode: 'P001' }),
      resolve([{ skuId: SKU_A, externalBarcode: '880' }], { externalBarcode: '880' }),
      resolve([{ skuId: SKU_A, externalProductName: 'N' }], { externalProductName: 'N' }),
      resolve([], { externalProductCode: 'X' }),
      resolve(
        [
          { skuId: SKU_A, externalBarcode: '880' },
          { skuId: SKU_B, externalBarcode: '880' },
        ],
        { externalBarcode: '880' },
      ),
      resolve(
        [
          { skuId: SKU_A, externalProductCode: 'P001' },
          { skuId: SKU_B, externalBarcode: '880' },
        ],
        { externalProductCode: 'P001', externalBarcode: '880' },
      ),
    ]);

    for (const result of results) {
      expect(['CODE', 'BARCODE', 'NAME', 'UNMATCHED']).toContain(result.matchMethod);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// externalSystemId 검증 (§5)
// ═══════════════════════════════════════════════════════════════

describe('★ externalSystemId 는 필수이며 존재해야 한다', () => {
  it('없는 시스템은 "매핑 없음"이 아니라 404 다', async () => {
    await expect(
      resolveOne(
        { externalSystemId: '99999999-9999-4999-8999-999999999999', externalProductCode: 'P001' },
        { port: portOf([]) },
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND, httpStatus: 404 });
  });

  it('UUID 형식이 아니면 404 다 (Prisma 오류로 새지 않는다)', async () => {
    await expect(
      resolveOne({ externalSystemId: 'not-a-uuid' }, { port: portOf([]) }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND, httpStatus: 404 });
  });
});

// ═══════════════════════════════════════════════════════════════
// resolveMany (§15)
// ═══════════════════════════════════════════════════════════════

describe('★ resolveMany — resolveOne 과 동일 semantics · N+1 금지', () => {
  const rows: Row[] = [
    { skuId: SKU_A, externalProductCode: 'P001' },
    { skuId: SKU_B, externalBarcode: '8809619961373' },
    { skuId: SKU_C, externalProductName: '외부 상품 A' },
    { skuId: SKU_A, externalBarcode: '7000000000001' },
    { skuId: SKU_B, externalBarcode: '7000000000001' },
  ];

  const inputs: ResolveExternalMappingInput[] = [
    { externalSystemId: SYS_A, externalProductCode: 'P001' },
    { externalSystemId: SYS_A, externalBarcode: '8809619961373' },
    { externalSystemId: SYS_A, externalProductName: '외부 상품 A' },
    { externalSystemId: SYS_A, externalProductCode: 'ZZZ' },
    { externalSystemId: SYS_A, externalBarcode: '7000000000001' },
    { externalSystemId: SYS_A, externalProductCode: 'P001', externalBarcode: '8809619961373' },
  ];

  it('1. 같은 입력에 대해 resolveOne 과 deep-equal 이다', async () => {
    const many = await resolveMany(inputs, { port: portOf(rows) });
    for (const [index, input] of inputs.entries()) {
      const one = await resolveOne(input, { port: portOf(rows) });
      expect(many[index], JSON.stringify(input)).toEqual(one);
    }
  });

  it('2·3. CODE/BARCODE/NAME/UNMATCHED·AMBIGUOUS·CONFLICT 가 섞인 배치를 처리한다', async () => {
    const results = await resolveMany(inputs, { port: portOf(rows) });

    expect(results.map((r) => r.resolutionStatus)).toEqual([
      'MATCHED',
      'MATCHED',
      'REVIEW_REQUIRED',
      'UNMATCHED',
      'AMBIGUOUS',
      'CONFLICT',
    ]);
    expect(results.map((r) => r.matchMethod)).toEqual([
      'CODE',
      'BARCODE',
      'NAME',
      'UNMATCHED',
      'UNMATCHED',
      'UNMATCHED',
    ]);
  });

  it('5. 입력 순서와 출력 순서가 1:1 이다', async () => {
    const results = await resolveMany(inputs, { port: portOf(rows) });
    expect(results).toHaveLength(inputs.length);

    const reordered = await resolveMany([...inputs].reverse(), { port: portOf(rows) });
    expect(reordered).toEqual([...results].reverse());
  });

  it('4·7. ★ 조회 키를 dedupe 하고 kind 별 1회씩만 조회한다 (N+1 아님)', async () => {
    const port = portOf(rows);
    const many: ResolveExternalMappingInput[] = Array.from({ length: 50 }, (_, index) => ({
      externalSystemId: SYS_A,
      externalProductCode: index % 2 === 0 ? 'P001' : 'ZZZ',
      externalProductName: '외부 상품 A',
    }));

    await resolveMany(many, { port });

    // 입력 50건이어도 조회는 systems·codes·barcodes·names 각 1회다.
    expect(port.calls).toEqual(['systems', 'codes', 'barcodes', 'names']);
  });

  it('상위 식별자로 전부 확정되면 상품명 조회를 아예 하지 않는다', async () => {
    const port = portOf(rows);
    await resolveMany([{ externalSystemId: SYS_A, externalProductCode: 'P001' }], { port });
    expect(port.calls).toEqual(['systems', 'codes', 'barcodes']);
  });

  it('6. 후보 정렬은 배치에서도 결정적이다', async () => {
    const first = await resolveMany(inputs, { port: portOf(rows) });
    const second = await resolveMany(inputs, { port: portOf([...rows].reverse()) });
    expect(second).toEqual(first);
  });

  it('빈 배열은 빈 배열이다 (조회 없음)', async () => {
    const port = portOf(rows);
    expect(await resolveMany([], { port })).toEqual([]);
    expect(port.calls).toEqual([]);
  });
});
