import type { Metadata } from 'next';
import { Suspense } from 'react';

import { BomsClient } from './boms-client';

/**
 * `/master/boms` — BOM 목록 (T07-8, D-30·D-31).
 *
 * 1차 가드: proxy 가 `bom.read` 를 요구한다 (ADMIN·SCM_LEADER·SCM_STAFF·
 * FINANCE·**EXECUTIVE**). 2차 가드는 화면이 부르는 모든 API 가 다시 검사한다.
 *
 * ★ **이 화면이 BOM mutation 의 유일한 owner** 다 (D-30). SKU 상세 ⑦탭은
 *   read-only 이며 여기로 링크만 준다.
 * ⛔ `/master/boms/new` 를 만들지 않는다 — 신규 등록은 이 화면의 dialog 다.
 */
export const metadata: Metadata = { title: 'BOM 관리 — DEEPPOINT SCM OS' };

export const dynamic = 'force-dynamic';

export default function BomsPage() {
  return (
    // useSearchParams 를 쓰는 클라이언트 컴포넌트는 Suspense 경계가 필요하다.
    <Suspense
      fallback={<main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm">불러오는 중…</main>}
    >
      <BomsClient />
    </Suspense>
  );
}
