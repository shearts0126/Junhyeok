import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { assertNoQueryParams, cloneBom, parseCloneBomInput } from '@/modules/bom/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/boms/{id}/clone` — 버전 복제. `bom.create`.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-4 · §D-6 · §D-13 · §D-16 · §D-17 +
 *    `★ T07-5 workflow gap closure` W-4 ~ W-9.
 *
 * - body `{newVersion, effectiveFrom, changeReason}` **전부 필수**.
 * - source 는 **모든 status** 에서 가능하며 결과는 언제나 새 `DRAFT` 다.
 * - ★ workflow 중 **유일하게 멱등 키를 받는다** (D-17). scope 는
 *   `bom:{sourceBomId}:clone`, 최초 **201** / replay **200** (W-8·W-9).
 * - 복제 직후 새 `effectiveFrom` 기준 cycle 검사 — 실패 시 전체 rollback.
 * - ⛔ query 를 하나도 받지 않는다 — 무엇이 오든 400.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/boms/[id]/clone'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      assertNoQueryParams(new URL(request.url).searchParams, '복제는 파라미터를 받지 않습니다.');

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const input = parseCloneBomInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await cloneBom(actor, id, input, {}, idempotencyKey);

      return NextResponse.json(
        { bom: result.bom, requestId },
        // ★ 최초 201 / replay 200 — 기존 create + 멱등 선례와 같다 (W-8).
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/boms/[id]/clone' },
  );
}
