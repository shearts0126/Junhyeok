import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { deactivateSku, parseDeactivateSkuInput } from '@/modules/sku/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/skus/{id}/deactivate` — 사용중지. `sku.deactivate`. ACTIVE → INACTIVE.
 *
 * 본문 `{ reason? }` — 문서가 필수라 명시하지 않아 임의 필수화하지 않는다.
 * 기존 approvedAt/approvedBy 는 유지된다.
 *
 * ⚠️ "활성 BOM 사용 중이면 경고"는 BOM 모델 부재로 T1-4B 연기 (docs/08 §5) —
 *    경고 부재가 사용중지 자체를 막지 않는다.
 * ⛔ archive 라우트는 T1-4B — stub 도 두지 않는다 (404 유지).
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/skus/[id]/deactivate'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }

      const input = parseDeactivateSkuInput(body);
      const { sku } = await deactivateSku(actor, id, input);

      return NextResponse.json({ sku, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/skus/[id]/deactivate' },
  );
}
