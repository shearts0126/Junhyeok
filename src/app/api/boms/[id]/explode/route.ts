import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { explodeBom, parseExplodeBomQuery } from '@/modules/bom/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/boms/{id}/explode` — 다단계 BOM 전개 (T07-6).
 *
 * ★ root 는 **URL 이 지정한 exact `BomHeader`** 다 — 같은 상위 SKU 에 asOf 기준
 *   다른 `ACTIVE` 버전이 있어도 재선택하지 않는다. `resolveEffectiveBom` 은
 *   **하위 구성품에만** 적용한다 (D-18).
 *
 *   - query 는 정확히 3개 — `qty`(기본 `"1"`) · `asOf`(기본 업무일자) ·
 *     `maxLevel`(기본 `BOM_MAX_LEVEL`). 그 밖의 키는 **400**.
 *   - 응답은 **평면 `ExplodedNode[]`** 이며 `level`·`path` 로 트리를 복원한다.
 *     ⛔ 합산하지 않는다 — 다이아몬드는 경로별로 각각 남는다 (D-20).
 *   - 미확정 수량은 오류가 아니다 — `requiredQty = null` 이고 **구조 전개는
 *     계속**한다 (`★ T07-6 explosion quantity gap closure`).
 *   - 깊이 초과 **422** `BOM_MAX_LEVEL_EXCEEDED` · 순환 **422**
 *     `BOM_CYCLE_DETECTED` · 하위 유효 BOM 2건 이상 **409**
 *     `BOM_EFFECTIVE_CONFLICT`. ⛔ 조용히 절단하거나 하나를 골라 숨기지 않는다.
 *   - 없는 BOM 은 **404**, UUID 형식 오류는 **400**.
 *   - 권한은 `bom.read`(A·L·S·F·**E**). generic `/api/boms` GET 정책이 그대로
 *     적용되므로 route-policy 항목을 새로 만들지 않는다 (D-15).
 *   - ⛔ read-only — write 0 · AuditLog 0 · 멱등 계약 없음 · lock 없음.
 *
 * 규칙 전문은 `docs/18_설계복구_BOM.md` §D-18·§D-19·§D-20·§D-21·§D-22 ·
 * `★ T07-6 explosion quantity gap closure`.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/boms/[id]/explode'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const query = parseExplodeBomQuery(new URL(request.url).searchParams);
      const { id } = await context.params;
      const result = await explodeBom(actor, id, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/boms/[id]/explode' },
  );
}
