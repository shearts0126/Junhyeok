import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { parseSubmitSkuInput, submitSku } from '@/modules/sku/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/skus/{id}/submit` — 승인 요청. `sku.submit`. DRAFT → PENDING_APPROVAL.
 *
 * 본문 `{ note? }`. 승인 전 검증 V1~V9(docs/08) 를 수행해 ERROR FAIL 이면
 * 상태변경 없이 422 + 검증 결과, 통과하면 응답에 `validation`(WARNING 포함)을 담는다.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/skus/[id]/submit'>,
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
        body = undefined; // note 는 선택 — 본문 없는 요청은 {} 로 취급한다.
      }

      const input = parseSubmitSkuInput(body);
      const { sku, validation } = await submitSku(actor, id, input);

      return NextResponse.json(
        { sku, validation, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/submit' },
  );
}
