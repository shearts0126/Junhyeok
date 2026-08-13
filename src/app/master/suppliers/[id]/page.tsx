import type { Metadata } from 'next';
import { Suspense } from 'react';

import { SupplierDetailClient } from './supplier-detail-client';

/**
 * `/master/suppliers/[id]` — 거래처 상세 `SUP-DETAIL-001` (T06-4, D-1·D-10).
 *
 * 1차 가드: proxy 가 `/master/suppliers` prefix 로 `supplier.read` 를 요구한다.
 * 2차 가드: 화면이 호출하는 모든 API 가 Application Service 에서 재검사한다.
 *
 * **탭 3개 고정**: ① 기본정보 ② 공급조건 ③ 가격이력 (`docs/02:148` 순서).
 * placeholder 탭이 없다. 가격이력 탭은 `supplier_price.read` 가 있을 때만 보인다.
 *
 * 새로고침·deep-link·공유 URL 은 supporting API `GET /api/suppliers/{id}` 로
 * 성립한다 — 목록 cache 에 의존하지 않는다 (D-9).
 */
export const metadata: Metadata = { title: '거래처 상세 — DEEPPOINT SCM OS' };

export const dynamic = 'force-dynamic';

export default async function SupplierDetailPage({ params }: PageProps<'/master/suppliers/[id]'>) {
  const { id } = await params;
  return (
    <Suspense
      fallback={<main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm">불러오는 중…</main>}
    >
      <SupplierDetailClient supplierId={id} />
    </Suspense>
  );
}
