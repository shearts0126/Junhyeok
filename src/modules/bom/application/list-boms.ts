import type { Prisma } from '@/generated/prisma/client';
import {
  defaultBomAuditReadPort,
  type BomAuditReadPort,
} from '@/modules/audit/application/bom-activity';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { businessDateOf } from '@/shared/business-date';

import { costBomsBatch, type BomCostFacts } from './cost-boms-batch';
import { BOM_PAGE_SIZE, parseDateOnly, toDateOnlyString, type ListBomsQuery } from './dto';
import { BOM_READ_PERMISSION } from './policy';
import type { BomCostReadClient, BomReadClient } from './refs';
import {
  BOM_HEADER_VIEW_INCLUDE,
  toBomHeaderView,
  type BomListItemView,
  type BomReferenceCostView,
} from './views';

/**
 * `GET /api/boms` — BOM 목록 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-31(검색·필터 7종) · §D-14(응답·페이지)
 *    · §D-5(반열림 기간) · §D-10(소요량 상태 어휘).
 *
 * ⚠️ **2차 권한 가드.** proxy 통과를 신뢰하지 않고 `bom.read` 를 재검사한다.
 *    ⛔ ADMIN bypass 없음. ★ EXECUTIVE 도 통과한다 (D-15).
 *
 * ## 필터
 *
 * | query | 의미 |
 * |---|---|
 * | `q` | 상위 SKU 의 `skuCode`·`skuName` 통합 검색(contains, 대소문자 무시) |
 * | `status` | exact. ⛔ 기본 조회에서 자동 status 필터 없음 |
 * | `bomType` | exact |
 * | `parentSkuId` | exact — T1-6B5 ⑦탭 "이 SKU 가 상위인 BOM" 이 이걸 쓴다 (D-30) |
 * | `effectiveOn` | **반열림 기간 필터** (아래) |
 * | `hasUnknownQty` | `quantityStatus = 'UNKNOWN'` 라인 보유 여부 (아래) |
 * | `page` | 1-base. 크기는 서버 고정 50 |
 *
 * ### `effectiveOn` — 기간 필터이며 **status 를 함의하지 않는다**
 *
 * ```
 *   effectiveFrom <= D AND (effectiveTo IS NULL OR effectiveTo > D)
 * ```
 *
 * D-5·D-22 와 **정확히 같은 반열림 `[from, to)`** predicate 다.
 *
 * ⚠️ docs/18 은 `effectiveOn` 을 D-31 필터 목록에 넣었을 뿐 "ACTIVE 만"이라고
 *    쓰지 않았다. status 를 함의하도록 만들면 `?effectiveOn=X&status=DRAFT` 가
 *    **항상 0건**이 되어 두 필터가 서로를 무효화한다. 따라서 **기간만** 본다 —
 *    ACTIVE 로 좁히려면 `status=ACTIVE` 를 함께 준다. (문서 미기재 항목이므로
 *    보고서에 deviation 으로 남긴다.)
 *
 * ### `hasUnknownQty` — `UNKNOWN` 라인 보유 여부
 *
 * D-10 이 `UNKNOWN` 을 독립 상태로 정의하고 D-31 UX 가 "① `UNKNOWN` 행 빨간
 * 배경"으로 이 상태만 강조하므로, 이름 그대로 `quantityStatus = 'UNKNOWN'` 을
 * 본다. ⛔ `quantityPer IS NULL` 로 판정하지 않는다 — 두 값의 정합은 D-10 이
 * 보장하지만 **필터의 근거는 상태 컬럼**이다. `false` 는 그런 라인이 0건인
 * BOM(라인이 아예 없는 BOM 포함)이다.
 *
 * ### 정렬
 *
 * `parentSku.skuCode ASC → effectiveFrom DESC → id ASC` 고정.
 * ⛔ `version` 으로 정렬하지 않는다 — D-4 가 "버전 순서는 `effectiveFrom` 이
 *    정한다"고 못박았다. `id` tie-breaker 로 페이지 경계가 흔들리지 않는다.
 *    (docs/18 에 목록 ordering 명시가 없어 D-4 로부터 유도했다 — deviation 보고.)
 */

export interface BomListResult {
  readonly items: readonly BomListItemView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface BomReadDependencies {
  readonly db?: BomReadClient;
  /** ★ T07-8 — 목록 `수정일` 용 audit read port (U8-1). 테스트가 주입한다. */
  readonly auditPort?: BomAuditReadPort;
}

export async function defaultBomClient(): Promise<BomReadClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

export function bomListWhere(query: ListBomsQuery): Prisma.BomHeaderWhereInput {
  const asOf = query.effectiveOn === undefined ? undefined : parseDateOnly(query.effectiveOn);

  return {
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.bomType !== undefined ? { bomType: query.bomType } : {}),
    ...(query.parentSkuId !== undefined ? { parentSkuId: query.parentSkuId } : {}),
    ...(query.q !== undefined
      ? {
          parentSku: {
            OR: [
              { skuCode: { contains: query.q, mode: 'insensitive' as const } },
              { skuName: { contains: query.q, mode: 'insensitive' as const } },
            ],
          },
        }
      : {}),
    // 반열림 `[from, to)` — D-5·D-22 와 같은 predicate.
    ...(asOf === undefined
      ? {}
      : {
          effectiveFrom: { lte: asOf },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
        }),
    ...(query.hasUnknownQty === undefined
      ? {}
      : query.hasUnknownQty === 'true'
        ? { lines: { some: { quantityStatus: 'UNKNOWN' } } }
        : { lines: { none: { quantityStatus: 'UNKNOWN' } } }),
  };
}

export async function listBoms(
  actor: ActorContext,
  query: ListBomsQuery,
  dependencies: BomReadDependencies = {},
): Promise<BomListResult> {
  assertPermission(actor, BOM_READ_PERMISSION);

  const db = dependencies.db ?? (await defaultBomClient());
  const where = bomListWhere(query);

  const [total, rows] = await Promise.all([
    db.bomHeader.count({ where }),
    db.bomHeader.findMany({
      where,
      include: BOM_HEADER_VIEW_INCLUDE,
      orderBy: [{ parentSku: { skuCode: 'asc' } }, { effectiveFrom: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * BOM_PAGE_SIZE,
      take: BOM_PAGE_SIZE,
    }),
  ]);

  // ★ 라인 수·미확정 수는 페이지 전체를 **한 번에** 읽는다 (N+1 없음).
  //   목록은 `lines` 본문을 내지 않으므로 상태 컬럼만 가져온다 (D-14).
  const ids = rows.map((row) => row.id);
  const lines =
    ids.length === 0
      ? []
      : await db.bomLine.findMany({
          where: { bomHeaderId: { in: ids } },
          select: { bomHeaderId: true, quantityStatus: true },
        });

  const counts = new Map<string, { lineCount: number; unconfirmedCount: number }>(
    ids.map((id) => [id, { lineCount: 0, unconfirmedCount: 0 }]),
  );
  for (const line of lines) {
    const bucket = counts.get(line.bomHeaderId);
    if (bucket === undefined) continue;
    bucket.lineCount += 1;
    if (line.quantityStatus !== 'CONFIRMED') bucket.unconfirmedCount += 1;
  }

  // ★ U8-1 — `수정일` 은 schema 컬럼이 아니라 audit 파생값이며 **batch 1회**다.
  //   ⛔ audit infrastructure 를 직접 부르지 않고 port 를 통한다 (R8 §28).
  const auditPort = dependencies.auditPort ?? (await defaultBomAuditReadPort());
  const activity =
    ids.length === 0 ? new Map<string, Date>() : await auditPort.readLatestBomActivityByBomIds(ids);

  // ★ U8-7 — 기준일은 `effectiveOn ?? 업무일자`. ⛔ 8번째 query 없음.
  const referenceAsOf = parseDateOnly(query.effectiveOn ?? businessDateOf(new Date()));
  const referenceAsOfLabel = toDateOnlyString(referenceAsOf);

  // ★ U8-8 · R8-2 — **multi-root batch + root 별 실패 격리**.
  //   ⛔ `for (bom) costBom(...)` 금지 · ⛔ 바깥 try/catch 금지.
  const costs =
    ids.length === 0
      ? new Map<string, BomCostFacts>()
      : await costBomsBatch(db as unknown as BomCostReadClient, {
          bomHeaderIds: ids,
          asOf: referenceAsOf,
          // ★ U8-6 — 제품 1 unit. ⛔ `outputQty` 로 치환하지 않는다.
          requestedQty: '1',
        });

  return {
    items: rows.map((row) => ({
      ...toBomHeaderView(row, counts.get(row.id) ?? { lineCount: 0, unconfirmedCount: 0 }),
      // ★ U8-3 — audit 이 0건일 때만 `createdAt` 으로 되돌아간다.
      lastModifiedAt: (activity.get(row.id) ?? row.createdAt).toISOString(),
      referenceCost: toReferenceCostView(referenceAsOfLabel, costs.get(row.id)),
    })),
    page: query.page,
    pageSize: BOM_PAGE_SIZE,
    // ★ 0건이면 0 — Math.max(1, …) 로 올리지 않는다 (기존 convention).
    total,
    totalPages: Math.ceil(total / BOM_PAGE_SIZE),
  };
}

/**
 * 원가 사실 → 목록 cell (U8-10 · R8-3).
 *
 * ⛔ 단일 총액 없음 · ⛔ FX 0 · ⛔ KRW 의 VAT 두 bucket 을 합치지 않는다.
 * ★ `UNAVAILABLE` 에 `AVAILABLE` 전용 필드를 섞지 않는다 (R8-5).
 */
function toReferenceCostView(asOf: string, facts: BomCostFacts | undefined): BomReferenceCostView {
  if (facts?.status === 'UNAVAILABLE') {
    return { status: 'UNAVAILABLE', asOf, errorCode: facts.errorCode };
  }
  const subtotals = facts?.status === 'AVAILABLE' ? facts.subtotals : [];
  return {
    status: 'AVAILABLE',
    asOf,
    // ★ `vatIncluded` 별로 **분리 보존**한다 (D-27).
    krwSubtotals: subtotals
      .filter((row) => row.currency === 'KRW')
      .map((row) => ({ vatIncluded: row.vatIncluded, amount: row.amount })),
    // ★ 계산 가능한 비KRW 가 있으면 `+` 표식 (D-26). ⛔ 더하지 않는다.
    hasOtherCurrency: subtotals.some((row) => row.currency !== 'KRW'),
    isProvisional: facts?.status === 'AVAILABLE' ? facts.isProvisional : false,
  };
}
