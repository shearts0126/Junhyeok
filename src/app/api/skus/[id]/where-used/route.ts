import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { assertNoQueryParams, listBomWhereUsed } from '@/modules/bom/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/skus/{id}/where-used` — 이 SKU 를 **구성품으로 쓰는** BOM (T07-3).
 *
 * ★ 경로는 `/api/skus` 아래지만 **BOM module 이 application owner** 다 —
 *   SKU module 이 BOM 테이블을 직접 읽지 않는다. 권한도 `sku.read` 가 아니라
 *   **`bom.read`**(A·L·S·F·**E**)이며, proxy 에 specific-before-general 정책을
 *   넣어 일반 `/api/skus` GET(`sku.read`)에 shadow 되지 않게 했다 (D-15).
 *
 *   - 한 행 = **한 라인**. 같은 BOM 에 대체그룹만 다른 라인으로 여러 번 쓰이면
 *     행이 여러 개다 — 소요량이 라인 단위 사실이기 때문이다 (D-30).
 *   - ⛔ status·적용기간으로 거르지 않는다 — 근거 없는 필터를 만들지 않는다.
 *   - query 를 하나도 받지 않는다 — 어떤 키든 400.
 *   - 없는 SKU 는 404(빈 배열로 위장하지 않는다), UUID 형식 오류는 400.
 *   - ⛔ AuditLog 없음 · 멱등 계약 없음 · mutation 없음.
 *
 * ⚠️ 이 SKU 가 **상위(parent)인** BOM 은 `GET /api/boms?parentSkuId={id}` 다.
 *    T1-6B5 ⑦ BOM 탭은 두 endpoint 를 함께 소비한다 (D-30).
 *
 * 규칙 전문은 `docs/18_설계복구_BOM.md` §D-30·§D-15.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/skus/[id]/where-used'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      assertNoQueryParams(
        new URL(request.url).searchParams,
        'where-used 조회는 파라미터를 받지 않습니다.',
      );

      const { id } = await context.params;
      const result = await listBomWhereUsed(actor, id);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/where-used' },
  );
}
