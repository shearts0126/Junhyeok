import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { getSku, parseUpdateSkuInput, updateSku } from '@/modules/sku/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET   /api/skus/{id}` — SKU 단건 조회. `sku.read`.
 *   id 는 UUID (형식 오류 400 / 없거나 soft-delete 면 404).
 * `PATCH /api/skus/{id}` — SKU 부분 수정. `sku.update`.
 *   - `{}` 는 400 — 변경할 필드를 최소 하나 지정해야 한다.
 *   - `status` 변경은 이 API 로 불가(400) — 상태전이는 별도 워크플로 endpoint.
 *   - `skuCode` 변경은 T1-2 규칙(`hasTransaction` → 422 SKU_CODE_IMMUTABLE)을 따른다.
 *   - ACTIVE SKU 의 일반 수정은 허용 필드 정책 확정 전까지 422 로 차단된다.
 *
 * ⛔ DELETE 핸들러가 없다(405). SKU 는 물리삭제하지 않는다.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/skus/[id]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      const sku = await getSku(actor, id);

      return NextResponse.json({ sku, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/skus/[id]' },
  );
}

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/skus/[id]'>,
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
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const patch = parseUpdateSkuInput(body);
      const sku = await updateSku(actor, id, patch);

      return NextResponse.json({ sku, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/skus/[id]' },
  );
}
