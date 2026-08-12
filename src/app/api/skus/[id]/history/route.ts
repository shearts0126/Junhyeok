import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { listSkuHistory, parseSkuHistoryQuery } from '@/modules/sku/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/skus/{id}/history` — SKU 변경이력. `sku.read` (T1-6B3).
 *
 *   - 쿼리는 **`page` 하나뿐**이다. `pageSize` 를 포함한 그 밖의 키는 400 이다
 *     (서버가 `pageSize=50` 으로 고정한다).
 *   - 범위는 **`Sku` + 그 SKU 의 `SkuBarcode`** 감사로그다.
 *     ⛔ `SkuExternalMapping`·Supplier·BOM 이력은 포함하지 않는다.
 *   - 정렬 `occurredAt DESC, id DESC`. 응답은 목록 envelope
 *     (`items/page/pageSize/total/totalPages`).
 *   - 부모 SKU 가 없으면 **404** — 빈 이력으로 위장하지 않는다.
 *     이력이 0건이면 200 + `items: []` · `total: 0` · `totalPages: 0`.
 *   - item projection 에 `approvedBy`·AuditLog 의 `requestId`·`sessionId`·
 *     `ipAddress` 를 **넣지 않는다** — global `/admin/audit-logs` 의 범위다.
 *
 * ⚠️ proxy 1차 가드는 기존 `/api/skus` GET → `sku.read` 정책이 그대로 잡는다 —
 *    별도 route policy 를 추가하지 않는다.
 * ⛔ read-only 다. AuditLog write path·불변 트리거·스키마를 건드리지 않는다.
 *
 * 규칙 전문은 `docs/16_설계복구_SKU상세잔여탭.md` §27~§40.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/skus/[id]/history'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      const query = parseSkuHistoryQuery(new URL(request.url).searchParams);

      const result = await listSkuHistory(actor, id, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/history' },
  );
}
