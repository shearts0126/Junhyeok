import type { Metadata } from 'next';

import { SkuDetailClient } from './sku-detail-client';

/**
 * `/master/skus/{id}` — SKU 상세·수정 (T1-6A).
 *
 * 1차 가드: proxy 가 `/master/skus` prefix 에서 `sku.read` 를 요구한다.
 * 2차 가드: 화면이 부르는 모든 API(`GET`/`PATCH /api/skus/{id}`, 워크플로
 * endpoint)가 Application Service 에서 권한을 재검사한다.
 *
 * ⛔ 바코드·외부매핑·공급조건·BOM·변경이력 탭은 T1-6B.
 */
export const metadata: Metadata = { title: 'SKU 상세 — DEEPPOINT SCM OS' };

export const dynamic = 'force-dynamic';

export default async function SkuDetailPage(context: PageProps<'/master/skus/[id]'>) {
  const { id } = await context.params;
  return <SkuDetailClient skuId={id} />;
}
