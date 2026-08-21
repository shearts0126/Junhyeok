import { z } from 'zod';

import {
  defaultBomAuditReadPort,
  type BomAuditReadPort,
} from '@/modules/audit/application/bom-activity';
import type { AuditHistoryItem } from '@/modules/audit/application/history-view';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { ValidationError } from '@/shared/errors';

import { parseBomId } from './dto';
import { defaultBomClient } from './list-boms';
import { BOM_READ_PERMISSION } from './policy';
import { bomNotFound, type BomReadClient } from './refs';

/**
 * `GET /api/boms/{id}/history` — BOM 변경이력 (T07-8).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-31(변경이력 탭) ·
 *    `★ T07-8 BOM UI read-model gap closure` U8-2·U8-13.
 *    선례는 T1-6B3 `GET /api/skus/{id}/history` 다.
 *
 * ## 범위 — **삭제된 라인까지** 포함한다
 *
 * `BomHeader` + 그 BOM 의 **모든** `BomLine` audit 이다.
 *
 * ⛔ 현재 존재하는 `BomLine` id 로 `IN` 조회하면 **삭제된 라인의 이력이 통째로
 *    사라진다** — `deleteBomLine` 이 물리삭제하기 때문이다. SKU 선례가
 *    `SkuBarcode` id 를 모아 쓴 것을 그대로 복사하면 안 되는 지점이다.
 *    귀속은 audit snapshot 의 `bomHeaderId` 로 판정한다 (U8-2).
 *
 * ⛔ 사용자 이름 조회 API 를 만들지 않는다 — `actorId` UUID 원문이다.
 * ⛔ generic `/api/audit-logs` 를 선구현하지 않는다.
 * ⛔ read-only — write 0 · lock 0.
 */

export const BOM_HISTORY_PAGE_SIZE = 50;

const historyQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
});

export type BomHistoryQuery = z.infer<typeof historyQuerySchema>;

export interface BomHistoryResult {
  readonly items: readonly AuditHistoryItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface BomHistoryDependencies {
  readonly db?: BomReadClient;
  readonly auditPort?: BomAuditReadPort;
}

export function parseBomHistoryQuery(searchParams: URLSearchParams): BomHistoryQuery {
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

export async function listBomHistory(
  actor: ActorContext,
  rawBomId: string,
  query: BomHistoryQuery,
  dependencies: BomHistoryDependencies = {},
): Promise<BomHistoryResult> {
  // ⚠️ 2차 권한 가드 — ⛔ ADMIN bypass 없음. ★ EXECUTIVE 도 통과한다 (D-15).
  assertPermission(actor, BOM_READ_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const db = dependencies.db ?? (await defaultBomClient());

  // ★ 부모가 없으면 404 — 빈 이력으로 위장하지 않는다.
  const parent = await db.bomHeader.findUnique({ where: { id: bomId }, select: { id: true } });
  if (parent === null) throw bomNotFound(bomId);

  // ⛔ 라인 id 를 모으지 않는다 — 삭제된 라인이 빠지기 때문이다 (U8-2).
  const auditPort = dependencies.auditPort ?? (await defaultBomAuditReadPort());
  const { items, total } = await auditPort.readBomAuditHistoryPage({
    bomId,
    page: query.page,
    pageSize: BOM_HISTORY_PAGE_SIZE,
  });

  return {
    items,
    page: query.page,
    pageSize: BOM_HISTORY_PAGE_SIZE,
    total,
    totalPages: Math.ceil(total / BOM_HISTORY_PAGE_SIZE),
  };
}
