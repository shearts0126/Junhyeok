import type { Metadata } from 'next';
import { Suspense } from 'react';

import { BomDetailClient } from './bom-detail-client';

/**
 * `/master/boms/{id}` — BOM 상세 (T07-8, D-31).
 *
 * 탭 4개 — 구성품 / 전개 / 원가 / 변경이력.
 * 1차 가드는 proxy 의 `/master/boms` → `bom.read` 정책이 그대로 잡는다.
 *
 * ★ `ACTIVE` 는 전체 읽기전용 + 배너 + `버전 생성` 버튼이다 (D-31).
 * ⛔ mutation control 은 permission 이 없으면 **렌더하지 않는다**(disabled 아님).
 */
export const metadata: Metadata = { title: 'BOM 상세 — DEEPPOINT SCM OS' };

export const dynamic = 'force-dynamic';

export default async function BomDetailPage({ params }: PageProps<'/master/boms/[id]'>) {
  const { id } = await params;
  return (
    <Suspense
      fallback={<main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm">불러오는 중…</main>}
    >
      <BomDetailClient bomId={id} />
    </Suspense>
  );
}
