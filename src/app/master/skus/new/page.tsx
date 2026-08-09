import type { Metadata } from 'next';

import { NewSkuClient } from './new-sku-client';

/**
 * `/master/skus/new` — 신규 SKU 등록 (T1-6A).
 *
 * 1차 가드: proxy 가 `/master/skus` prefix 에서 `sku.read` 를 요구한다.
 * 2차 가드: `POST /api/skus` 가 `sku.create` 를 재검사한다 — 화면의 버튼 숨김은
 * UX 일 뿐 최종 판정은 서버다.
 */
export const metadata: Metadata = { title: '신규 SKU 등록 — DEEPPOINT SCM OS' };

export const dynamic = 'force-dynamic';

export default function NewSkuPage() {
  return <NewSkuClient />;
}
