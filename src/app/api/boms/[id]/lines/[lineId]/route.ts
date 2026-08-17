import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { deleteBomLine, parseUpdateLineInput, updateBomLine } from '@/modules/bom/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `PATCH  /api/boms/{id}/lines/{lineId}` — 라인 수정. `bom.update` (A·L·S).
 * `DELETE /api/boms/{id}/lines/{lineId}` — 라인 삭제. `bom.update` (A·L·S).
 *
 *   - 두 메서드 모두 편집 가능 상태는 `DRAFT`·`REJECTED` 뿐 (D-6).
 *   - ★ **nested ownership** — `lineId` 가 존재해도 다른 BOM 소속이면 **404** 다.
 *     403 이나 다른 응답으로 타 BOM 의 존재를 드러내지 않는다.
 *   - PATCH 는 `componentSkuId` 변경을 허용하므로 topology 가 바뀔 수 있다 →
 *     **변경 후 상태로 cycle 재검사**, 순환이면 422 + 전체 롤백 (D-13·D-28).
 *   - PATCH 실질 변경 0 이면 200 + DB write 0 + Audit 0 + cycle 검사 없음.
 *   - DELETE 응답은 **204 No Content**. 이미 없는 라인의 재삭제는 404 다.
 *   - ⛔ 두 메서드 모두 `Idempotency-Key` 를 받지 않는다 (D-17).
 *
 * 규칙 전문은 `docs/18_설계복구_BOM.md` §D-6·§D-9·§D-13·§D-14·§D-28.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/boms/[id]/lines/[lineId]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id, lineId } = await context.params;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const patch = parseUpdateLineInput(body);
      const line = await updateBomLine(actor, id, lineId, patch);

      return NextResponse.json({ line, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/boms/[id]/lines/[lineId]' },
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext<'/api/boms/[id]/lines/[lineId]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id, lineId } = await context.params;
      await deleteBomLine(actor, id, lineId);

      return new NextResponse(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store' },
      });
    },
    { route: '/api/boms/[id]/lines/[lineId]' },
  );
}
