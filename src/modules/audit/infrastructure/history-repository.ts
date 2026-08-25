import type { Prisma, PrismaClient } from '@/generated/prisma/client';

import { toAuditHistoryItem, type AuditHistoryItem } from '../application/history-view';

/**
 * 감사로그 이력 read repository (T1-6B3).
 *
 * ⚠️ 근거: `docs/16_설계복구_SKU상세잔여탭.md` §35·§36.
 *
 * ## 이 파일이 하는 일
 *
 * `(entityType, entityId[])` 조합 여러 개를 **한 번의 쿼리**로 읽어 정렬·페이징한다.
 * `audit_log` 의 `(entity_type, entity_id, occurred_at DESC)` 인덱스가 각 조합을
 * Bitmap Index Scan 으로 처리한다 (T1-6B3 PRE-FLIGHT §32 실측).
 *
 * ## 반드시 DB 에서 끝낸다
 *
 * ⛔ application 에서 "Sku 페이지"와 "Barcode 페이지"를 따로 가져와 merge 하지
 *    않는다 — 그러면 `total` 과 페이지 경계가 부정확해진다. `count` · `ORDER BY` ·
 *    `skip` · `take` 를 **최종 predicate 에 대해** DB 가 수행한다.
 * ⛔ N+1 없음 — 이 함수는 정확히 쿼리 2회(count + findMany)를 쓴다.
 *
 * ## 범위
 *
 * ⛔ generic audit browser(전 엔티티 검색·actor 필터·기간 필터)를 만들지 않는다.
 *    `GET /api/audit-logs` 는 별도 Task 다 (`05 §10.16`).
 * ⛔ AuditLog 는 불변이다 — 이 모듈은 **read-only** 이며 write path 를 건드리지 않는다.
 */

export type AuditReadClient = Pick<PrismaClient, 'auditLog'>;

/** 한 entityType 과 그에 속한 entityId 집합. `entityIds` 가 비면 무시된다. */
export interface AuditHistoryTarget {
  readonly entityType: string;
  readonly entityIds: readonly string[];
}

export interface AuditHistoryPageQuery {
  readonly targets: readonly AuditHistoryTarget[];
  /** 1-base */
  readonly page: number;
  readonly pageSize: number;
}

export interface AuditHistoryPage {
  readonly items: readonly AuditHistoryItem[];
  readonly total: number;
}

/** ⚠️ 저장 필드 전체를 읽지 않는다 — projection 이 곧 응답 계약이다. */
const HISTORY_SELECT = {
  id: true,
  entityType: true,
  entityId: true,
  action: true,
  beforeValue: true,
  afterValue: true,
  actorId: true,
  occurredAt: true,
  reason: true,
} as const satisfies Prisma.AuditLogSelect;

export async function findAuditHistoryPage(
  db: AuditReadClient,
  query: AuditHistoryPageQuery,
): Promise<AuditHistoryPage> {
  const clauses: Prisma.AuditLogWhereInput[] = query.targets
    .filter((target) => target.entityIds.length > 0)
    .map((target) => ({
      entityType: target.entityType,
      entityId: { in: [...target.entityIds] },
    }));

  // 대상이 하나도 없으면 쿼리하지 않는다 — `OR: []` 는 전체 조회가 되어 위험하다.
  if (clauses.length === 0) return { items: [], total: 0 };

  const where: Prisma.AuditLogWhereInput = { OR: clauses };

  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      // ★ `occurredAt` 은 트랜잭션 시각이라 동률이 흔하다 — `id DESC` 가
      //   결정적 tie-breaker 다 (`docs/16` §31).
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: HISTORY_SELECT,
    }),
  ]);

  return { items: rows.map(toAuditHistoryItem), total };
}

// ═══════════════════════════════════════════════════════════════
// BOM 귀속 read (T07-8)
// 근거: `docs/18` `★ T07-8 BOM UI read-model gap closure` U8-1·U8-2·U8-13
// ═══════════════════════════════════════════════════════════════

/** ⚠️ audit 의 `entityType` 문자열 — BOM 모듈 상수와 값이 같아야 한다. */
const BOM_HEADER_AUDIT_ENTITY = 'BomHeader';
const BOM_LINE_AUDIT_ENTITY = 'BomLine';

/**
 * ★ **`BomLine` audit 을 그 BOM 에 귀속시키는 predicate** (U8-2).
 *
 * ⛔ **현재 존재하는 `BomLine` id 로 `entityId IN (...)` 하지 않는다** — `BomLine`
 *    은 물리삭제되므로(`deleteBomLine`) 그 방식은 **삭제된 라인의 CREATE·UPDATE·
 *    DELETE 이력을 통째로 잃는다.** SKU 선례(`SkuBarcode`)는 삭제가 없어 이
 *    문제를 겪지 않았다.
 *
 * ★ 대신 audit snapshot 안의 `bomHeaderId` 로 판정한다. `BomLine` audit 을 남기는
 *   4곳(`create-line`·`update-line`·`delete-line`·`clone-bom`)이 **전부
 *   `BomLineView` 를 직렬화**하고 그 타입은 `bomHeaderId` 를 required 로 갖는다.
 */
function bomScopedWhere(bomId: string): Prisma.AuditLogWhereInput {
  return {
    OR: [
      { entityType: BOM_HEADER_AUDIT_ENTITY, entityId: bomId },
      {
        entityType: BOM_LINE_AUDIT_ENTITY,
        OR: [
          { beforeValue: { path: ['bomHeaderId'], equals: bomId } },
          { afterValue: { path: ['bomHeaderId'], equals: bomId } },
        ],
      },
    ],
  };
}

export interface BomAuditHistoryPageQuery {
  readonly bomId: string;
  /** 1-base */
  readonly page: number;
  readonly pageSize: number;
}

/**
 * 한 BOM 의 변경이력 한 페이지 (U8-13).
 *
 * ⛔ N+1 없음 — `count` + `findMany` 정확히 2회이며 정렬·페이징을 DB 가 한다.
 */
export async function findBomAuditHistoryPage(
  db: AuditReadClient,
  query: BomAuditHistoryPageQuery,
): Promise<AuditHistoryPage> {
  const where = bomScopedWhere(query.bomId);

  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: HISTORY_SELECT,
    }),
  ]);

  return { items: rows.map(toAuditHistoryItem), total };
}

/**
 * ★ **여러 BOM 의 `lastModifiedAt` 을 한 번에** (U8-1·U8-4).
 *
 * ⛔ 목록 50건마다 쿼리하지 않는다 — 이 함수가 존재하는 이유다.
 *    반환 `Map` 에는 값이 있는 id 만 담기며 fallback 은 호출부가 정한다.
 */
export async function findLatestBomActivityByBomIds(
  db: AuditReadClient,
  bomIds: readonly string[],
): Promise<Map<string, Date>> {
  const ids = [...new Set(bomIds)];
  const result = new Map<string, Date>();
  if (ids.length === 0) return result;

  // ── header — `groupBy` 로 id 별 MAX(occurredAt) 를 DB 가 계산한다.
  const headerRows = await db.auditLog.groupBy({
    by: ['entityId'],
    where: { entityType: BOM_HEADER_AUDIT_ENTITY, entityId: { in: ids } },
    _max: { occurredAt: true },
  });
  for (const row of headerRows) {
    const at = row._max.occurredAt;
    if (at !== null) result.set(row.entityId, at);
  }

  // ── line — `bomHeaderId` 가 JSONB 안이라 `groupBy` 로 접을 수 없다.
  //    ★ **요청한 id 들로 좁힌 단일 쿼리** 다 — OR 절 수는 page size(50)로 묶인다.
  //    ⛔ id 마다 쿼리하지 않고 ⛔ 전체 BomLine audit 을 스캔하지도 않는다.
  const lineRows = await db.auditLog.findMany({
    where: {
      entityType: BOM_LINE_AUDIT_ENTITY,
      OR: ids.flatMap((id) => [
        { beforeValue: { path: ['bomHeaderId'], equals: id } },
        { afterValue: { path: ['bomHeaderId'], equals: id } },
      ]),
    },
    select: { occurredAt: true, beforeValue: true, afterValue: true },
  });

  const wanted = new Set(ids);
  for (const row of lineRows) {
    const bomId = bomHeaderIdOf(row.afterValue) ?? bomHeaderIdOf(row.beforeValue);
    if (bomId === null || !wanted.has(bomId)) continue;
    const current = result.get(bomId);
    if (current === undefined || row.occurredAt > current) result.set(bomId, row.occurredAt);
  }

  return result;
}

/** audit snapshot 에서 `bomHeaderId` 를 꺼낸다. 없으면 `null`. */
function bomHeaderIdOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)['bomHeaderId'];
  return typeof candidate === 'string' ? candidate : null;
}
