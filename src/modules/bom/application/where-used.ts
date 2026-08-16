import { assertPermission, type ActorContext } from '@/modules/auth/application';

import { parseSkuRefId } from './dto';
import { defaultBomClient, type BomReadDependencies } from './list-boms';
import { BOM_READ_PERMISSION } from './policy';
import { skuRefNotFound } from './refs';
import { WHERE_USED_INCLUDE, toWhereUsedView, type BomWhereUsedView } from './views';

/**
 * `GET /api/skus/{id}/where-used` — 이 SKU 를 **구성품으로 쓰는** BOM (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-30(T1-6B5 boundary) · §D-15(route-policy).
 *
 * ## module ownership — 경로는 `/api/skus` 아래지만 **BOM module 이 owner** 다
 *
 * 응답이 전부 `BomHeader`·`BomLine` 사실이므로 SKU module 이 BOM 테이블을 직접
 * 읽지 않는다. 권한도 `sku.read` 가 아니라 **`bom.read`** 다 — proxy 에
 * specific-before-general 정책을 넣어 일반 `/api/skus` GET(`sku.read`)에
 * shadow 되지 않게 한다 (D-15).
 *
 * ## "where-used" 의 의미
 *
 * 이 SKU 가 **component 로 등장하는** 라인들이다. D-30 ⑦탭 항목 2
 * ("이 SKU 가 구성품으로 쓰인 BOM — 상위 SKU · 버전 · 상태 · 소요량")에 대응한다.
 * 항목 1("이 SKU 가 상위인 BOM")은 `GET /api/boms?parentSkuId=` 가 담당한다.
 *
 * ⚠️ docs/18 §D-30 "필요 API" 행의 괄호 표기(`where-used`(상위) / `?parentSkuId=`
 *    (구성품))는 같은 표 안의 ⑦탭 항목 설명과 서로 반대다. where-used 의 보편적
 *    의미와 `?parentSkuId=` 의 자명한 의미가 일치하는 쪽으로 읽었다
 *    (보고서에 deviation 으로 남긴다).
 *
 * ## 한 행 = 한 **라인**
 *
 * 같은 BOM 에 같은 SKU 가 대체그룹만 달리해 여러 라인으로 들어가면 **행이
 * 여러 개** 나온다. `quantityPer` 는 라인 단위 사실이라 header 로 접으면
 * 표현할 수 없다. ⛔ "최신 1건"·dedup 같은 임의 선택을 하지 않는다.
 *
 * ## 필터를 추가하지 않는다
 *
 * status·적용기간으로 거르지 않는다 — docs/18 에 근거가 없다. 어느 상태의
 * BOM 에 쓰이는지는 호출자가 `status` 로 판단한다. query 는 **하나도 받지
 * 않으며** 어떤 키든 400 이다.
 *
 * ⛔ AuditLog 없음 · 멱등 계약 없음 (read).
 */

export interface WhereUsedResult {
  readonly items: readonly BomWhereUsedView[];
}

export async function listBomWhereUsed(
  actor: ActorContext,
  rawSkuId: string,
  dependencies: BomReadDependencies = {},
): Promise<WhereUsedResult> {
  assertPermission(actor, BOM_READ_PERMISSION);
  const skuId = parseSkuRefId(rawSkuId);

  const db = dependencies.db ?? (await defaultBomClient());

  // 없는 SKU 는 404 — 빈 배열로 위장하지 않는다 (T1-6B4 선례).
  const sku = await db.sku.findFirst({
    where: { id: skuId, deletedAt: null },
    select: { id: true },
  });
  if (sku === null) throw skuRefNotFound(skuId);

  const rows = await db.bomLine.findMany({
    where: { componentSkuId: skuId },
    include: WHERE_USED_INCLUDE,
    // 결정적 정렬 — 상위 SKU 코드 → 적용 시작일 최신 → 라인 순번.
    orderBy: [
      { bomHeader: { parentSku: { skuCode: 'asc' } } },
      { bomHeader: { effectiveFrom: 'desc' } },
      { bomHeaderId: 'asc' },
      { lineNo: 'asc' },
    ],
  });

  return { items: rows.map(toWhereUsedView) };
}
