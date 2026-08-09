import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { approveSku, parseApproveSkuInput } from '@/modules/sku/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/skus/{id}/approve` — 승인. `sku.approve`. PENDING_APPROVAL → ACTIVE.
 *
 * 본문 `{ note? }`. 트랜잭션 안에서 최신 `allowSelfApprovalSku` 로 자가승인을
 * 판정하고(false + 작성자 본인 → 403 SELF_APPROVAL_FORBIDDEN), V1~V9 를
 * **재검증**한다 — ERROR FAIL 이 새로 생기면 PENDING 유지 + 422.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/skus/[id]/approve'>,
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

      const input = parseApproveSkuInput(body);
      const { sku, validation } = await approveSku(actor, id, input);

      return NextResponse.json(
        { sku, validation, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/approve' },
  );
}
