import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { listCodeGroups } from '@/modules/common-code/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/code-groups` — 코드 그룹 목록. `common_code.read`.
 *
 * 그룹 생성·수정 API 는 없다 — 그룹은 seed·migration 관리 대상이다.
 * ⛔ DELETE 도 없다.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const groups = await listCodeGroups(actor);

      return NextResponse.json({ groups, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/code-groups' },
  );
}
