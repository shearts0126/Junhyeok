import { NextResponse } from 'next/server';

import { listRoles, resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/roles` — 역할 목록. `role.read` 권한을 요구한다.
 *
 * 2겹 가드의 확인 지점이다.
 *   1차: proxy 가 route policy 로 `role.read` 를 확인
 *   2차: `listRoles` 가 `assertPermission` 으로 다시 확인
 *
 * 1차를 지워도 2차가 막아야 한다.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const roles = await listRoles(actor);

      return NextResponse.json({ roles }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/roles' },
  );
}
