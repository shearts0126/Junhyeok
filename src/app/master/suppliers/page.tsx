import type { Metadata } from 'next';
import { Suspense } from 'react';

import { SuppliersClient } from './suppliers-client';

/**
 * `/master/suppliers` — 거래처 목록 `SUP-LIST-001` (T06-4, D-1·D-2).
 *
 * 1차 가드: proxy 가 `supplier.read` 를 요구한다 (ADMIN·SCM_LEADER·SCM_STAFF·
 * FINANCE. **EXECUTIVE 제외**).
 * 2차 가드: 화면이 호출하는 모든 API 가 Application Service 에서 재검사한다.
 * 화면 렌더링은 UX 이고, 권한의 근거는 항상 서버다.
 *
 * ⛔ `/master/suppliers/new` 를 만들지 않는다 — 신규 등록은 이 화면의 dialog 다.
 *    상세는 `/master/suppliers/{id}` 로 이동한다.
 */
export const metadata: Metadata = { title: '거래처 관리 — DEEPPOINT SCM OS' };

export const dynamic = 'force-dynamic';

export default function SuppliersPage() {
  return (
    // useSearchParams 를 쓰는 클라이언트 컴포넌트는 Suspense 경계가 필요하다.
    <Suspense
      fallback={<main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm">불러오는 중…</main>}
    >
      <SuppliersClient />
    </Suspense>
  );
}
