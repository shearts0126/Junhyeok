import { assertPermission, type ActorContext } from '@/modules/auth/application';

import { SUPPLIER_PAGE_SIZE, parseSupplierId, type ListSupplierSkusQuery } from './dto';
import { defaultSupplierClient, type SupplierReadDependencies } from './list-suppliers';
import { SUPPLIER_READ_PERMISSION } from './policy';
import { supplierNotFound } from './refs';
import { SUPPLIER_SKU_VIEW_INCLUDE, toSupplierSkuView, type SupplierSkuView } from './views';

/**
 * `GET /api/suppliers/{id}/skus` — 공급조건 목록 (T06-2, D-10).
 *
 * ⚠️ **2차 권한 가드.** `supplier.read` 를 재검사한다.
 *
 * - parent Supplier 가 없으면 **404** — 빈 목록으로 위장하지 않는다.
 * - **현재 + 과거 + 미래 이력을 모두 포함**한다 — `effectiveTo IS NULL` 자동
 *   필터 없음. current-only 쿼리도 이번에 추가하지 않는다 (D-10).
 * - 정렬 `effectiveFrom DESC, id DESC` — 최신 기간 우선, tie-breaker 고정.
 * - `pageSize` 는 서버 고정 50.
 * ⛔ 가격을 join 하지 않는다 — `supplier_sku_price` 조회가 없어야 한다 (D-30).
 */

export interface SupplierSkuListResult {
  readonly items: readonly SupplierSkuView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export async function listSupplierSkus(
  actor: ActorContext,
  rawSupplierId: string,
  query: ListSupplierSkusQuery,
  dependencies: SupplierReadDependencies = {},
): Promise<SupplierSkuListResult> {
  assertPermission(actor, SUPPLIER_READ_PERMISSION);
  const supplierId = parseSupplierId(rawSupplierId);

  const db = dependencies.db ?? (await defaultSupplierClient());

  const parent = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (parent === null) throw supplierNotFound(supplierId);

  const where = { supplierId };
  const [total, rows] = await Promise.all([
    db.supplierSku.count({ where }),
    db.supplierSku.findMany({
      where,
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * SUPPLIER_PAGE_SIZE,
      take: SUPPLIER_PAGE_SIZE,
      include: SUPPLIER_SKU_VIEW_INCLUDE,
    }),
  ]);

  return {
    items: rows.map(toSupplierSkuView),
    page: query.page,
    pageSize: SUPPLIER_PAGE_SIZE,
    total,
    totalPages: Math.ceil(total / SUPPLIER_PAGE_SIZE),
  };
}
