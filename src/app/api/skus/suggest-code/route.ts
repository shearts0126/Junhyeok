import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { parseSuggestSkuCodeInput, suggestSkuCode } from '@/modules/sku/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/skus/suggest-code` — 다음 SKU 코드 추천. `sku.suggest_code`.
 *
 * 요청 `{brandId, majorId, minorId}` (3개 필수), 응답 `{suggestedCode, serialNumber}`.
 * 규칙은 `docs/09_설계복구_SKU코드추천.md` (STANDARD_PRODUCT_V1).
 *
 * ⚠️ 구 경로 `/api/skus/{id}/suggest-code` 는 supersede 되었다 — 구현하지 않으며
 *    redirect·alias 도 두지 않는다.
 * ⛔ **저장하지 않는다.** Sku·AuditLog·IdempotencyRecord 어느 것도 만들지 않으며
 *    `Idempotency-Key` 도 적용하지 않는다. 계산·판정은 전부 Application Service
 *    에 있고 이 핸들러는 인증·파싱·응답만 한다.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const input = parseSuggestSkuCodeInput(body);
      const { suggestedCode, serialNumber } = await suggestSkuCode(actor, input);

      return NextResponse.json(
        { suggestedCode, serialNumber, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/suggest-code' },
  );
}
