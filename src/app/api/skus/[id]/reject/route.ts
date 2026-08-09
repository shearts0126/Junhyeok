import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { parseRejectSkuInput, rejectSku } from '@/modules/sku/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/skus/{id}/reject` — 반려. `sku.approve` (승인/반려 동일 authority).
 * PENDING_APPROVAL → REJECTED. 본문 `{ reason }` **필수** (trimmed nonblank).
 * approvedAt/approvedBy 를 설정하지 않는다.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/skus/[id]/reject'>,
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
        throw new ValidationError([
          { path: 'body', message: 'JSON 본문이 필요합니다. (reason 필수)' },
        ]);
      }

      const input = parseRejectSkuInput(body);
      const { sku } = await rejectSku(actor, id, input);

      return NextResponse.json({ sku, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/skus/[id]/reject' },
  );
}
