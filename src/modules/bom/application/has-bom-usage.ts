import { defaultBomClient } from './list-boms';
import type { BomDbClient } from './refs';

/**
 * `hasBomUsage(skuId)` — SKU archive 판정용 **internal read provider** (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-32 "hasBomUsage provider".
 *
 * ```sql
 *      EXISTS (SELECT 1 FROM bom_header WHERE parent_sku_id    = :skuId)
 *   OR EXISTS (SELECT 1 FROM bom_line   WHERE component_sku_id = :skuId)
 * ```
 *
 * ## REST endpoint 가 아니다
 *
 * `canArchiveSku({hasTransaction, hasBomUsage})` 와
 * `SkuArchiveBlocker='BOM_USAGE'` 는 이미 순수 함수로 완성돼 있다
 * (`src/modules/sku/domain/archive-eligibility.ts`). T07-3 은 그 입력을
 * 만들어 줄 read service 만 노출한다.
 *
 * ⛔ T07-3 은 `sku.archive` API 를 만들지 않는다 — T1-4B 의 몫이다.
 * ⛔ 여기에 permission guard 를 두지 않는다. 호출자(T1-4B `sku.archive`)가
 *    자신의 권한을 이미 검사한 뒤 사실만 물어보는 provider 이기 때문이다.
 *    (같은 이유로 route 도, audit 도 없다.)
 *
 * ## status·이력과 무관한 **사실**이다
 *
 * `archive-eligibility.ts:26` 이 "상위 SKU(parent)든 구성품(component)이든"
 * 으로 범위를 이미 확정했다. ⛔ `status` 로 걸러 usage 를 숨기지 않는다 —
 * `ARCHIVED`·`INACTIVE` BOM 에 쓰였더라도 **쓰인 적이 있다는 사실**은 남는다.
 * 이력을 지우면 archive 가 참조 무결성을 잃는다.
 *
 * ⛔ 라인 속성(`isRequired`·`componentRole`·`quantityStatus`)으로도 거르지
 *    않는다 — cycle edge 계약(D-13)과 같은 이유로 "참조 사실" 자체가 기준이다.
 *
 * ## 성능
 *
 * 전체 row 를 읽지 않는다. 두 `findFirst({select:{id:true}})` 를 병렬로 돌리며
 * 각각 `bom_header(parent_sku_id, status)` 인덱스와 T07-1 이 역전개용으로 만든
 * `@@index([componentSkuId])` 를 탄다.
 */
export interface HasBomUsageDependencies {
  readonly db?: BomDbClient;
}

export async function hasBomUsage(
  skuId: string,
  dependencies: HasBomUsageDependencies = {},
): Promise<boolean> {
  const db = dependencies.db ?? (await defaultBomClient());

  const [asParent, asComponent] = await Promise.all([
    db.bomHeader.findFirst({ where: { parentSkuId: skuId }, select: { id: true } }),
    db.bomLine.findFirst({ where: { componentSkuId: skuId }, select: { id: true } }),
  ]);

  return asParent !== null || asComponent !== null;
}
