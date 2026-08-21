import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { listBomHistory, parseBomHistoryQuery } from '@/modules/bom/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/boms/{id}/history` — BOM 변경이력. `bom.read` (T07-8).
 *
 *   - 쿼리는 **`page` 하나뿐**이다. `pageSize` 를 포함한 그 밖의 키는 400 이다
 *     (서버가 `pageSize=50` 으로 고정한다).
 *   - 범위는 **`BomHeader` + 그 BOM 의 모든 `BomLine`** 감사로그이며
 *     ★ **삭제된 라인의 이력도 포함**한다 — 귀속은 audit snapshot 의
 *     `bomHeaderId` 로 판정한다(`★ T07-8 …` U8-2). ⛔ 현재 라인 id 로 `IN`
 *     조회하면 삭제분이 사라진다.
 *   - 정렬 `occurredAt DESC, id DESC`. 응답은 목록 envelope + `requestId`.
 *   - 부모 BOM 이 없으면 **404** — 빈 이력으로 위장하지 않는다.
 *   - `actorId` 는 **UUID 원문**이다. ⛔ 사용자 조회 API 를 만들지 않는다.
 *
 * ⚠️ proxy 1차 가드는 기존 `/api/boms` GET → `bom.read` 정책이 그대로 잡는다.
 * ⛔ read-only 다. ⛔ generic `/api/audit-logs` 를 선구현하지 않는다.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/boms/[id]/history'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      const query = parseBomHistoryQuery(new URL(request.url).searchParams);

      const result = await listBomHistory(actor, id, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/boms/[id]/history' },
  );
}
