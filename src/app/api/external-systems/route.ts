import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  listExternalSystems,
  parseListExternalSystemsQuery,
} from '@/modules/external-mapping/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/external-systems` — 외부시스템 lookup. `external_mapping.read` (A·L·S·F).
 *
 *   - 외부 매핑 관리 화면(T05-4A)의 **선택 수단 전용**이다.
 *   - pagination·query parameter 없음. 알 수 없는 파라미터는 400.
 *   - 정렬 `systemCode ASC, id ASC`. `active=false` 도 숨기지 않는다.
 *
 * ⛔ ExternalSystem CRUD 를 만들지 않는다 — 이 GET 하나뿐이다.
 * 규칙 전문은 `docs/15_설계복구_ExternalMapping관리UI.md` §5~§8.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      parseListExternalSystemsQuery(new URL(request.url).searchParams);
      const result = await listExternalSystems(actor);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/external-systems' },
  );
}
