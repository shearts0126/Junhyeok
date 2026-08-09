import type { Metadata } from 'next';
import { Suspense } from 'react';

import { SkusListClient } from './skus-client';

/**
 * `/master/skus` — SKU 목록 (T1-5A).
 *
 * 1차 가드: proxy 가 `sku.read` 를 요구한다 (5개 역할 전부 보유).
 * 2차 가드: 화면이 호출하는 모든 API 가 Application Service 에서 재검사한다.
 * 화면 렌더링은 UX 이고, 권한의 근거는 항상 서버다.
 *
 * ⛔ SKU 상세 화면(`/master/skus/[id]`)은 T1-6 — 여기서 만들지 않는다.
 */
export const metadata: Metadata = { title: 'SKU 목록 — DEEPPOINT SCM OS' };

export const dynamic = 'force-dynamic';

export default function SkusListPage() {
  return (
    // useSearchParams 를 쓰는 클라이언트 컴포넌트는 Suspense 경계가 필요하다.
    <Suspense
      fallback={<main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm">불러오는 중…</main>}
    >
      <SkusListClient />
    </Suspense>
  );
}
