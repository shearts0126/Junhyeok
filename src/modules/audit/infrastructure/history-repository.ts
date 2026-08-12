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
