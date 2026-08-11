import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ExternalMappingsClient } from './external-mappings-client';

/**
 * `/master/external-mappings` — 외부 상품 매핑 관리 `EXT-MAP-001` (T05-4A).
 *
 * 1차 가드: proxy 가 `external_mapping.read` 를 요구한다 (ADMIN·SCM_LEADER·
 * SCM_STAFF·FINANCE. EXECUTIVE 제외).
 * 2차 가드: 화면이 호출하는 모든 API 가 Application Service 에서 재검사한다.
 * 화면 렌더링은 UX 이고, 권한의 근거는 항상 서버다.
 *
 * ⛔ 별도 상세/신규 페이지가 없다 — 신규·수정은 이 화면의 dialog 다.
 * ⛔ 미매칭 목록·일괄 매핑·엑셀 업로드는 T05-4B (T15·T17 선행 필요).
 */
export const metadata: Metadata = { title: '외부 상품 매핑 — DEEPPOINT SCM OS' };

export const dynamic = 'force-dynamic';

export default function ExternalMappingsPage() {
  return (
    // useSearchParams 를 쓰는 클라이언트 컴포넌트는 Suspense 경계가 필요하다.
    <Suspense
      fallback={<main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm">불러오는 중…</main>}
    >
      <ExternalMappingsClient />
    </Suspense>
  );
}
