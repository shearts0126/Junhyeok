import { assertPermission, type ActorContext } from '@/modules/auth/application';

import { parseBomId } from './dto';
import { defaultBomClient, type BomReadDependencies } from './list-boms';
import { BOM_READ_PERMISSION } from './policy';
import { bomNotFound } from './refs';
import {
  BOM_HEADER_VIEW_INCLUDE,
  BOM_LINE_VIEW_INCLUDE,
  toBomDetailView,
  type BomDetailView,
} from './views';

/**
 * `GET /api/boms/{id}` — BOM 상세 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-14 `BomDetail`.
 *
 * ⚠️ **2차 권한 가드** `bom.read`. ⛔ ADMIN bypass 없음. ★ EXECUTIVE 통과.
 *
 * - 라인 정렬은 **`lineNo ASC → id ASC`** 다. D-14 는 명시하지 않았지만 D-9 가
 *   `lineNo` 를 "BOM 안에서 UNIQUE" 한 순번으로 정의했고 D-31 라인 그리드가
 *   `순번` 을 첫 열로 두므로 자연 순서다. `id` tie-breaker 는 형식적이며
 *   (UNIQUE 때문에 실제로 동순위가 없다) 결정성을 보장한다.
 * - 없는 id 는 **404 `BOM_NOT_FOUND`**, UUID 형식 오류는 400.
 * - ⛔ AuditLog 없음 · 멱등 계약 없음 (read).
 */
export async function getBom(
  actor: ActorContext,
  rawBomId: string,
  dependencies: BomReadDependencies = {},
): Promise<BomDetailView> {
  assertPermission(actor, BOM_READ_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const db = dependencies.db ?? (await defaultBomClient());

  const header = await db.bomHeader.findUnique({
    where: { id: bomId },
    include: BOM_HEADER_VIEW_INCLUDE,
  });
  if (header === null) throw bomNotFound(bomId);

  const lines = await db.bomLine.findMany({
    where: { bomHeaderId: bomId },
    include: BOM_LINE_VIEW_INCLUDE,
    orderBy: [{ lineNo: 'asc' }, { id: 'asc' }],
  });

  return toBomDetailView(header, lines);
}
