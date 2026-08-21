import type { AuditHistoryItem } from './history-view';

/**
 * BOM 귀속 audit read **port** (T07-8).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` `★ T07-8 BOM UI read-model gap closure`
 *    U8-1 · U8-2 · U8-13.
 *
 * ## 왜 port 인가
 *
 * BOM application 이 audit **infrastructure** 를 직접 import 하면 모듈 경계가
 * 무너진다. 계층은 다음과 같다 (R8 §28).
 *
 * ```
 * Route → BOM Application → Audit read port(여기) → Audit Infrastructure
 * ```
 *
 * ⛔ BOM route·application 에서 Prisma·raw SQL 을 직접 만지지 않는다.
 * ⛔ infrastructure 를 dynamic import 로 우회하지 않는다.
 * ⛔ generic audit browser(`/api/audit-logs`)를 선구현하지 않는다.
 */

export interface BomAuditHistoryPage {
  readonly items: readonly AuditHistoryItem[];
  readonly total: number;
}

export interface BomAuditReadPort {
  /** 한 BOM 의 변경이력 한 페이지 — `BomHeader` + **삭제분 포함** 모든 `BomLine`. */
  readBomAuditHistoryPage(input: {
    readonly bomId: string;
    readonly page: number;
    readonly pageSize: number;
  }): Promise<BomAuditHistoryPage>;

  /**
   * 여러 BOM 의 최신 활동 시각 — 목록 `수정일` 의 공급원 (U8-1).
   * 값이 있는 id 만 담긴다. fallback 은 호출부가 정한다 (U8-3).
   */
  readLatestBomActivityByBomIds(bomIds: readonly string[]): Promise<Map<string, Date>>;
}

/** 기본 구현 — Prisma client 를 붙여 infrastructure 를 감싼다. */
export async function defaultBomAuditReadPort(): Promise<BomAuditReadPort> {
  const [{ getPrismaClient }, repository] = await Promise.all([
    import('@/shared/db'),
    import('../infrastructure/history-repository'),
  ]);
  const db = getPrismaClient();

  return {
    readBomAuditHistoryPage: (input) => repository.findBomAuditHistoryPage(db, input),
    readLatestBomActivityByBomIds: (bomIds) => repository.findLatestBomActivityByBomIds(db, bomIds),
  };
}
