import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/me` — 현재 사용자와 권한.
 *
 * 역할이 없어도 접근할 수 있다. `roles`·`permissions` 가 빈 배열로 나간다.
 * 로컬 사용자 미등록·비활성은 403 이다 (`resolveActor`).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      return NextResponse.json(
        {
          user: { id: actor.userId, email: actor.email, name: actor.name },
          roles: actor.roles,
          permissions: actor.permissions,
          requestId: actor.requestId,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/me' },
  );
}
