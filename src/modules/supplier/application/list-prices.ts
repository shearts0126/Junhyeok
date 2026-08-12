import { assertPermission, type ActorContext } from '@/modules/auth/application';

import { parseDateOnly, parseSupplierSkuId } from './dto';
import { defaultSupplierClient, type SupplierReadDependencies } from './list-suppliers';
import { SUPPLIER_PRICE_READ_PERMISSION } from './policy';
import type { ListPricesQuery } from './price-dto';
import { toSupplierSkuPriceView, type SupplierSkuPriceView } from './price-views';
import { supplierSkuNotFound } from './refs';
import { resolveEffectiveSupplierPrice } from './resolve-effective-price';

/**
 * `GET /api/supplier-skus/{id}/prices` — 가격이력·asOf 유효가격 (T06-3, D-2~D-5).
 *
 * ⚠️ **2차 권한 가드.** `supplier_price.read` 를 재검사한다. ADMIN bypass 없음.
 *
 * - parent SupplierSku 가 없으면 **404** — 빈 목록으로 위장하지 않는다.
 *   parent 가 과거·현재·미래 기간인지는 보지 않는다 (§48).
 * - `asOf` 없음 → **전체 가격이력** (승인+미승인 · 과거+현재+미래 전부),
 *   정렬 `effectiveFrom DESC, id DESC`, **pagination 없음** (D-5).
 * - `asOf=YYYY-MM-DD` → 승인된 operational 유효가격만 — `[]`(없음) 또는
 *   `[view]`(1건). 2건 이상은 409 `SUPPLIER_PRICE_CHAIN_CONFLICT` (D-23).
 *   "없음"은 200 `[]` 다 — 404도 0원 fallback 도 아니다 (D-3).
 */

export interface SupplierSkuPriceListResult {
  readonly prices: readonly SupplierSkuPriceView[];
}

export async function listSupplierSkuPrices(
  actor: ActorContext,
  rawSupplierSkuId: string,
  query: ListPricesQuery,
  dependencies: SupplierReadDependencies = {},
): Promise<SupplierSkuPriceListResult> {
  assertPermission(actor, SUPPLIER_PRICE_READ_PERMISSION);
  const supplierSkuId = parseSupplierSkuId(rawSupplierSkuId);

  const db = dependencies.db ?? (await defaultSupplierClient());

  const parent = await db.supplierSku.findUnique({
    where: { id: supplierSkuId },
    select: { id: true },
  });
  if (parent === null) throw supplierSkuNotFound(supplierSkuId);

  if (query.asOf !== undefined) {
    const effective = await resolveEffectiveSupplierPrice(db, {
      supplierSkuId,
      asOf: parseDateOnly(query.asOf),
    });
    return { prices: effective === null ? [] : [toSupplierSkuPriceView(effective)] };
  }

  const rows = await db.supplierSkuPrice.findMany({
    where: { supplierSkuId },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  });
  return { prices: rows.map(toSupplierSkuPriceView) };
}
