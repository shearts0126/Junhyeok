import { z } from 'zod';

import type { PrismaClient } from '@/generated/prisma/client';
import type { AuditHistoryItem } from '@/modules/audit/application/history-view';
import { findAuditHistoryPage } from '@/modules/audit/infrastructure/history-repository';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { ValidationError } from '@/shared/errors';

import { parseSkuId } from './dto';
import { SKU_READ_PERMISSION } from './policy';
import { skuNotFound } from './update-sku';

/**
 * `GET /api/skus/{id}/history` — SKU 변경이력 (T1-6B3).
 *
 * ⚠️ 근거: `docs/16_설계복구_SKU상세잔여탭.md` §27~§40
 *    (2026-08-11 SKU 변경이력 Design Recovery Decision).
 *    원문은 `05 §10.3` 의 한 줄(`page` / `AuditLog[]` / 권한 "전체")이며,
 *    envelope·범위·권한은 그 Recovery 로 확정했다.
 *
 * ## 계층
 *
 *   Route → **이 서비스** → SKU repository(부모 확인) → Audit history read
 *   repository → Prisma. ⛔ Route 에서 Prisma 직접 접근 금지.
 *
 * ## 권한
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `sku.read` 를 재검사한다.
 * ⛔ 신규 `audit.read` · `sku.history.read` 를 만들지 않는다 (`docs/16` §30).
 * ⛔ ADMIN bypass 없음 — `RolePermission` 데이터로만 판정한다.
 *
 * ## 범위 — `Sku` + 그 SKU 의 `SkuBarcode` 뿐
 *
 * ⛔ `SkuExternalMapping` 은 포함하지 않는다 — authoritative 근거가 없다
 *    (`docs/16` §29). Supplier·BOM·CommonCode·SystemSetting 도 마찬가지다.
 *
 * ★ barcode 이력은 **현재 그 SKU 에 속한 barcode id** 로 찾는다. `SkuBarcode` 는
 *   물리삭제가 없고(`status='INACTIVE'` 로만 내려간다) `deletedAt` 컬럼도 없으므로
 *   과거 이력도 전부 찾을 수 있다. `AuditLog` 에 `parentSkuId` 스냅샷을 추가하지
 *   않는다는 기존 결정(`docs/10` §14)을 유지하며, 그 한계는 수용한다.
 */

/** 서버 고정 페이지 크기. ⛔ `pageSize` 쿼리를 받지 않는다 (`docs/16` §30). */
export const SKU_HISTORY_PAGE_SIZE = 50;

/** 이 endpoint 가 조회하는 entityType — 정확히 둘뿐이다. */
export const SKU_HISTORY_ENTITY_TYPES = ['Sku', 'SkuBarcode'] as const;

export type SkuHistoryClient = Pick<PrismaClient, 'sku' | 'skuBarcode' | 'auditLog'>;

export interface SkuHistoryDependencies {
  readonly db?: SkuHistoryClient;
}

export interface SkuHistoryQuery {
  /** 1-base. 생략하면 1. */
  readonly page: number;
}

export interface SkuHistoryResult {
  readonly items: readonly AuditHistoryItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  /** ★ 0건이면 **0** 이다 — `Math.max(1, …)` 로 올리지 않는다 (`docs/16` §32). */
  readonly totalPages: number;
}

const historyQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
});

/**
 * 쿼리는 **`page` 하나뿐**이다. 그 밖의 키는 조용히 무시하지 않고 400 이다
 * (`pageSize` 도 포함 — 서버가 50 으로 고정한다).
 */
export function parseSkuHistoryQuery(searchParams: URLSearchParams): SkuHistoryQuery {
  const unknownKeys = [...new Set([...searchParams.keys()])].filter((key) => key !== 'page');
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      unknownKeys.map((key) => ({
        path: key,
        message: '지원하지 않는 파라미터입니다. (변경이력 조회는 page 만 받습니다)',
      })),
      { message: '지원하지 않는 변경이력 파라미터가 있습니다.' },
    );
  }

  const raw: Record<string, string> = {};
  const page = searchParams.get('page');
  if (page !== null) raw['page'] = page;

  const result = historyQuerySchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : 'page',
        message: issue.message,
      })),
      { message: '변경이력 쿼리가 올바르지 않습니다.' },
    );
  }
  return result.data;
}

async function defaultClient(): Promise<SkuHistoryClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

export async function listSkuHistory(
  actor: ActorContext,
  rawSkuId: string,
  query: SkuHistoryQuery,
  dependencies: SkuHistoryDependencies = {},
): Promise<SkuHistoryResult> {
  assertPermission(actor, SKU_READ_PERMISSION);
  const skuId = parseSkuId(rawSkuId);

  const db = dependencies.db ?? (await defaultClient());

  // ★ 부모가 없으면 404 다 — 빈 이력으로 위장하지 않는다 (`docs/16` §32).
  //   soft-delete 된 SKU 도 404 (기존 `getSku` convention 과 동일).
  const parent = await db.sku.findFirst({
    where: { id: skuId, deletedAt: null },
    select: { id: true },
  });
  if (parent === null) throw skuNotFound(skuId);

  // ★ 고정 1회 선조회 — barcode id 목록. 이후 감사로그는 단일 쿼리다 (N+1 없음).
  const barcodes = await db.skuBarcode.findMany({ where: { skuId }, select: { id: true } });

  const { items, total } = await findAuditHistoryPage(db, {
    targets: [
      { entityType: 'Sku', entityIds: [skuId] },
      { entityType: 'SkuBarcode', entityIds: barcodes.map((row) => row.id) },
    ],
    page: query.page,
    pageSize: SKU_HISTORY_PAGE_SIZE,
  });

  return {
    items,
    page: query.page,
    pageSize: SKU_HISTORY_PAGE_SIZE,
    total,
    totalPages: Math.ceil(total / SKU_HISTORY_PAGE_SIZE),
  };
}
