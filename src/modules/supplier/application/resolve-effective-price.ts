import { supplierPriceChainConflict } from './constraint-errors';
import type { SupplierSkuPriceRow } from './price-views';
import type { SupplierDbClient } from './refs';
import { toDateOnly } from './views';

/**
 * asOf 유효가격 resolver (T06-3, D-22·D-23) — **reusable application service** 다.
 *
 * REST route 전용 logic 이 아니다 — 향후 T07 BOM cost/explode·T1-6B4 recent
 * price 가 같은 함수를 쓴다. 단 책임은 `supplierSkuId → price` 까지다 —
 * SKU → primary SupplierSku 선택은 범위 밖이다.
 *
 * predicate (half-open `[from, to)` 유지):
 *
 *   approvedBy IS NOT NULL
 *   AND effectiveFrom <= asOf
 *   AND (effectiveTo IS NULL OR asOf < effectiveTo)
 *
 * ★ **pending(미승인) 가격은 절대 잡히지 않는다** — 발효는 승인 시점이다 (§4).
 * ★ candidate 를 **2건까지** 조회한다 — 2건 이상이면 chain 손상이므로
 *   `ORDER BY … LIMIT 1` 로 숨기지 않고 409 `SUPPLIER_PRICE_CHAIN_CONFLICT` 를
 *   던진다 (D-23). 0건은 오류가 아니라 "가격 없음"이다 — 0원 fallback 금지 (D-3).
 */

export interface ResolveEffectivePriceInput {
  readonly supplierSkuId: string;
  /** UTC 자정 date-only Date — `parseDateOnly` 산출값. */
  readonly asOf: Date;
}

export async function resolveEffectiveSupplierPrice(
  db: SupplierDbClient,
  input: ResolveEffectivePriceInput,
): Promise<SupplierSkuPriceRow | null> {
  const candidates = await db.supplierSkuPrice.findMany({
    where: {
      supplierSkuId: input.supplierSkuId,
      approvedBy: { not: null },
      effectiveFrom: { lte: input.asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.asOf } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    // ★ 정확히 2 — 1건 초과 여부만 판정하면 되고, 손상 규모 전체를 읽지 않는다.
    take: 2,
  });

  if (candidates.length >= 2) {
    throw supplierPriceChainConflict({
      supplierSkuId: input.supplierSkuId,
      asOf: toDateOnly(input.asOf),
      candidateIds: candidates.map((row) => row.id),
    });
  }

  return candidates[0] ?? null;
}
