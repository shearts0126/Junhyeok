import type { PrismaClient } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { parseSkuId } from '@/modules/sku/application';

import { assertParentSkuExists } from './parent-sku';
import { BARCODE_READ_PERMISSION } from './policy';
import { toSkuBarcodeView, type SkuBarcodeView } from './views';

/**
 * `GET /api/skus/{id}/barcodes` — 목록 (T04-3).
 *
 * ⚠️ 근거: `docs/10_설계복구_BarcodeCRUD.md` §26.
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `barcode.read` 를 재검사한다.
 *
 * ## V1 계약 — 구체 endpoint 계약이 일반 목록 규약보다 우선한다
 *
 *   - 응답은 **raw 배열**이다 (`{items, page, …}` envelope 아님).
 *     05 §10.4 의 응답 컬럼이 `SkuBarcode[]` 이므로 그것을 따른다.
 *   - pagination 없음 · query filter 없음.
 *   - ★ `ACTIVE` 와 `INACTIVE` 를 **모두 포함**한다. DELETE 가 물리삭제가 아니라
 *     비활성 이력을 남기므로 조회 API 가 그것을 볼 수 있어야 한다.
 *     ⛔ ACTIVE-only 필터를 만들지 않는다.
 *   - 정렬은 `createdAt DESC, id DESC` 로 **결정적**이다.
 *     ⛔ `SkuBarcode` 에는 `updatedAt` 이 없으므로 그 기준 정렬을 발명하지 않는다.
 */

export type BarcodeListClient = Pick<PrismaClient, 'sku' | 'skuBarcode'>;

export interface BarcodeListDependencies {
  readonly db?: BarcodeListClient;
}

async function defaultClient(): Promise<BarcodeListClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

export async function listSkuBarcodes(
  actor: ActorContext,
  rawSkuId: string,
  dependencies: BarcodeListDependencies = {},
): Promise<SkuBarcodeView[]> {
  assertPermission(actor, BARCODE_READ_PERMISSION);
  const skuId = parseSkuId(rawSkuId);

  const db = dependencies.db ?? (await defaultClient());

  // 부모가 없으면 빈 배열이 아니라 404 다 — 잘못된 경로를 성공으로 보이게 하지 않는다.
  await assertParentSkuExists(db, skuId);

  const rows = await db.skuBarcode.findMany({
    where: { skuId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

  return rows.map(toSkuBarcodeView);
}
