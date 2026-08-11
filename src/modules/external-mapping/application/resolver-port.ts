import type { PrismaClient } from '@/generated/prisma/client';

/**
 * Resolver 조회 포트 (T05-3).
 *
 * ⚠️ 근거: `docs/14_설계복구_ExternalMappingResolver.md` §12·§13.
 *
 * business matching logic 을 Prisma adapter 에 넣지 않기 위해 **조회만** 담당하는
 * 얇은 포트를 둔다. 우선순위·모호성·충돌 판정은 전부 `resolve-mapping.ts` 의
 * 순수 로직이다.
 *
 * ★ 모든 조회는 **현행 매핑**(`effectiveTo IS NULL`)만 본다 — 종료된 이력은
 *   resolver 대상이 아니다.
 * ★ 세 조회 모두 **키 집합을 한 번에** 받는다. 입력 N 건이어도 쿼리 수는
 *   `시스템 1 + 코드 1 + 바코드 1 + 상품명 1` 로 상수다 (N+1 금지).
 */

/** 조회 결과 행 — 판정에 필요한 최소 컬럼만. */
export interface ExternalMappingLookupRow {
  readonly skuId: string;
  readonly externalSystemId: string;
  readonly externalProductCode: string | null;
  readonly externalBarcode: string | null;
  readonly externalProductName: string | null;
}

export interface ExternalMappingResolverPort {
  /** 존재하는 `externalSystemId` 집합을 돌려준다. */
  findExistingSystemIds(systemIds: readonly string[]): Promise<ReadonlySet<string>>;
  findCurrentByCodes(
    systemIds: readonly string[],
    codes: readonly string[],
  ): Promise<readonly ExternalMappingLookupRow[]>;
  findCurrentByBarcodes(
    systemIds: readonly string[],
    barcodes: readonly string[],
  ): Promise<readonly ExternalMappingLookupRow[]>;
  findCurrentByNames(
    systemIds: readonly string[],
    names: readonly string[],
  ): Promise<readonly ExternalMappingLookupRow[]>;
}

export type ResolverPrismaClient = Pick<PrismaClient, 'externalSystem' | 'skuExternalMapping'>;

const LOOKUP_SELECT = {
  skuId: true,
  externalSystemId: true,
  externalProductCode: true,
  externalBarcode: true,
  externalProductName: true,
} as const;

/**
 * Prisma 구현.
 *
 * ⚠️ 조회는 `(systemIds × keys)` 교차 집합을 한 번에 가져오고, **정확한
 *    (system, key) 짝 맞춤은 메모리에서** 한다. 시스템·키가 섞여 들어와도
 *    쿼리 수를 늘리지 않기 위한 의도적 설계다.
 */
export function createPrismaResolverPort(db: ResolverPrismaClient): ExternalMappingResolverPort {
  const byField = async (
    field: 'externalProductCode' | 'externalBarcode' | 'externalProductName',
    systemIds: readonly string[],
    values: readonly string[],
  ): Promise<readonly ExternalMappingLookupRow[]> => {
    if (systemIds.length === 0 || values.length === 0) return [];
    return db.skuExternalMapping.findMany({
      where: {
        // ★ 현행 매핑만 — 종료된 이력은 제외한다.
        effectiveTo: null,
        externalSystemId: { in: [...systemIds] },
        [field]: { in: [...values] },
      },
      select: LOOKUP_SELECT,
    });
  };

  return {
    async findExistingSystemIds(systemIds) {
      if (systemIds.length === 0) return new Set<string>();
      const rows = await db.externalSystem.findMany({
        where: { id: { in: [...systemIds] } },
        select: { id: true },
      });
      return new Set(rows.map((row) => row.id));
    },
    findCurrentByCodes: (systemIds, codes) => byField('externalProductCode', systemIds, codes),
    findCurrentByBarcodes: (systemIds, barcodes) => byField('externalBarcode', systemIds, barcodes),
    findCurrentByNames: (systemIds, names) => byField('externalProductName', systemIds, names),
  };
}
