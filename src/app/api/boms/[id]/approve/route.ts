import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { assertNoQueryParams, approveBom, parseApproveBomInput } from '@/modules/bom/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/boms/{id}/approve` — 승인 `bom.approve`.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-6 · §D-15 · §D-17 +
 *    `★ T07-5 workflow gap closure` W-8.
 *
 * - 응답은 **200 `{bom, requestId}`** — workflow 6종이 모두 같다.
 * - ⛔ `Idempotency-Key` 를 받지 않는다 (D-17). 자연 멱등이며 이미 목표
 *   상태면 **200 no-op**(write 0 · Audit 0)이다.
 * - ⛔ query 를 하나도 받지 않는다 — 무엇이 오든 400.
 * - route 는 Prisma 를 직접 만지지 않는다. 2차 권한 가드는 서비스가 한다.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/boms/[id]/approve'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      assertNoQueryParams(new URL(request.url).searchParams, '승인는 파라미터를 받지 않습니다.');

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        // 본문 없는 요청은 `{}` 로 취급한다 — 필수 필드가 있으면 그대로 400 이다.
        body = undefined;
      }

      const input = parseApproveBomInput(body);
      const result = await approveBom(actor, id, input);

      return NextResponse.json(
        { bom: result.bom, requestId },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/boms/[id]/approve' },
  );
}
