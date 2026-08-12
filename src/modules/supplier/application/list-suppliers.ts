import type { Prisma } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';

import { SUPPLIER_PAGE_SIZE, type ListSuppliersQuery } from './dto';
import { SUPPLIER_READ_PERMISSION } from './policy';
import type { SupplierReadClient } from './refs';
import { toSupplierView, type SupplierView } from './views';

/**
 * `GET /api/suppliers` — 거래처 목록 (T06-2, D-2).
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `supplier.read` 를 재검사한다.
 *
 * - `q` 는 supplierCode·supplierName **만** 통합 검색한다 (대소문자 무시 contains).
 *   사업자번호·담당자·연락처 검색은 이번 범위가 아니다.
 * - `supplierType`·`status` 는 exact match. 기본 조회에서 status 자동 필터 없음 —
 *   ACTIVE 만 강제하지 않는다.
 * - 정렬은 `supplierCode ASC, id ASC` 고정 — `sort` 쿼리가 없고 tie-breaker 로
 *   페이지 경계가 흔들리지 않게 한다.
 * - `pageSize` 는 서버 고정 50. 0건이면 `total 0 / totalPages 0`.
 */

export interface SupplierListResult {
  readonly items: readonly SupplierView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface SupplierReadDependencies {
  readonly db?: SupplierReadClient;
}

export async function defaultSupplierClient(): Promise<SupplierReadClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

export async function listSuppliers(
  actor: ActorContext,
  query: ListSuppliersQuery,
  dependencies: SupplierReadDependencies = {},
): Promise<SupplierListResult> {
  assertPermission(actor, SUPPLIER_READ_PERMISSION);

  const db = dependencies.db ?? (await defaultSupplierClient());

  const where: Prisma.SupplierWhereInput = {
    ...(query.supplierType !== undefined ? { supplierType: query.supplierType } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.q !== undefined
      ? {
          OR: [
            { supplierCode: { contains: query.q, mode: 'insensitive' as const } },
            { supplierName: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.supplier.count({ where }),
    db.supplier.findMany({
      where,
      orderBy: [{ supplierCode: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * SUPPLIER_PAGE_SIZE,
      take: SUPPLIER_PAGE_SIZE,
    }),
  ]);

  return {
    items: rows.map(toSupplierView),
    page: query.page,
    pageSize: SUPPLIER_PAGE_SIZE,
    total,
    // ★ 0건이면 0 — Math.max(1, …) 로 올리지 않는다 (T1-6B3 convention).
    totalPages: Math.ceil(total / SUPPLIER_PAGE_SIZE),
  };
}
