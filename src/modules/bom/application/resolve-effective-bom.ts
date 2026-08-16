import { dateOnlyOf } from '@/shared/business-date';

import { selectEffectiveBom } from '../domain/effective-selection';

import type { BomDbClient } from './refs';

/**
 * asOf 유효 BOM resolver (T07-2).
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-22.
 *
 * **internal domain resolver 다 — REST 전용이 아니다.** T06-3 의
 * `resolveEffectiveSupplierPrice` 가 T07·T1-6B4 에 재사용된 것과 같은 구조이며,
 * 소비자는 cycle graph 구성(D-13) · explode(D-18) · cost(D-23) · where-used ·
 * T1-6B5 · 향후 WO/assembly 다.
 *
 * predicate (half-open `[from, to)`):
 *
 * ```
 *   status = 'ACTIVE'
 *   AND effectiveFrom <= asOf
 *   AND (effectiveTo IS NULL OR asOf < effectiveTo)
 * ```
 *
 * ★ 0건은 **오류가 아니다** — `06v2:286` 이 "활성 BOM 0건"을 정상 완료조건으로
 *   둔다. 2건 이상만 손상이며 409 로 드러낸다.
 *
 * ## 단건 = 배치의 1-id wrapper
 *
 * selection semantics 를 **한 군데**로 모으기 위해 단건 resolver 는 배치를 그대로
 * 호출한다. 두 함수가 따로 구현돼 drift 하지 않는다 (T1-6B4
 * `resolveEffectiveSupplierPrices` 와 같은 원칙).
 *
 * ## asOf 는 caller 가 확정한다
 *
 * ⛔ 이 모듈은 `new Date()` 를 호출하지 않는다. 한 request 안에서 effective BOM ·
 *    SupplierSku · Price 가 **같은 asOf** 를 써야 하기 때문이다 (§D-21).
 *    업무일자 기본값 결정은 application/request 계층의 몫이다.
 */

/** resolver 가 돌려주는 header. 라인은 필요할 때 별도로 읽는다. */
export interface EffectiveBomHeaderRow {
  readonly id: string;
  readonly parentSkuId: string;
  readonly version: string;
  readonly status: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
}

export interface ResolveEffectiveBomInput {
  readonly parentSkuId: string;
  /** UTC 자정 date-only `Date` — `parseBusinessDate` 산출값. */
  readonly asOf: Date;
}

export interface ResolveEffectiveBomsInput {
  /** ★ 한 요청 안에서는 **모든 id 가 같은 asOf** 를 쓴다 (§D-21). */
  readonly parentSkuIds: readonly string[];
  readonly asOf: Date;
}

const SELECT = {
  id: true,
  parentSkuId: true,
  version: true,
  status: true,
  effectiveFrom: true,
  effectiveTo: true,
} as const;

/**
 * 여러 상위 SKU 의 asOf 유효 BOM 을 **DB 조회 1회**로 해결한다.
 *
 * ⛔ id 마다 단건 resolver 를 반복 호출하지 않는다 — N+1 을 만들지 않기 위해 이
 *    함수가 존재한다. 반환 Map 에는 **입력 id 전부가 key 로 존재**하며 유효 BOM 이
 *    없는 id 도 `null` 로 담긴다(호출부에서 `has` 검사 불필요).
 *
 * @throws 409 `BOM_EFFECTIVE_CONFLICT` — 어느 한 SKU 라도 후보가 2건 이상이면.
 *         부분 성공으로 숨기지 않는다.
 */
export async function resolveEffectiveBoms(
  db: BomDbClient,
  input: ResolveEffectiveBomsInput,
): Promise<Map<string, EffectiveBomHeaderRow | null>> {
  const ids = [...new Set(input.parentSkuIds)];
  const result = new Map<string, EffectiveBomHeaderRow | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return result;

  // ★ IN (...) 한 번 — SKU 별 top-1 을 SQL 로 자르지 않는다. 잘라 버리면 2건
  //   이상(손상)을 발견할 수 없기 때문이다. 판정은 도메인이 한다.
  const rows = await db.bomHeader.findMany({
    where: {
      parentSkuId: { in: ids },
      status: 'ACTIVE',
      effectiveFrom: { lte: input.asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.asOf } }],
    },
    select: SELECT,
    // 결정성만 확보한다 — 선택은 도메인이 하므로 정렬에 의존하지 않는다.
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  });

  const grouped = new Map<string, EffectiveBomHeaderRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.parentSkuId);
    if (bucket === undefined) grouped.set(row.parentSkuId, [row]);
    else bucket.push(row);
  }

  const asOfLabel = dateOnlyOf(input.asOf);
  for (const [parentSkuId, candidates] of grouped) {
    result.set(parentSkuId, selectEffectiveBom(candidates, { parentSkuId, asOf: asOfLabel }));
  }
  return result;
}

/** 단건 — 배치의 1-id wrapper 다. 외부 동작(반환값·오류·predicate)이 동일하다. */
export async function resolveEffectiveBom(
  db: BomDbClient,
  input: ResolveEffectiveBomInput,
): Promise<EffectiveBomHeaderRow | null> {
  const resolved = await resolveEffectiveBoms(db, {
    parentSkuIds: [input.parentSkuId],
    asOf: input.asOf,
  });
  return resolved.get(input.parentSkuId) ?? null;
}
