import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { parseUpdateWarehouseInput, updateWarehouse } from '@/modules/warehouse/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `PATCH /api/warehouses/{id}` — 창고 metadata 수정. `warehouse.update` (A).
 *
 *   - body 는 `{warehouseName?, externalSystemId?, supplierId?, timezone?,
 *     address?}` — 최소 하나 필수(`{}` 는 400).
 *   - `undefined` = 미변경 / `null` = 값 제거. `warehouseName`·`timezone` 은 null 불가.
 *   - `warehouseCode`·`warehouseType` 은 **create-only immutable** — 보내면 400
 *     (§W-D25).
 *   - ★ **`active` 는 보내면 400** 이다 (§W-D27) — `true→false` lifecycle 은
 *     "재고 존재 시 비활성 차단" 을 요구하고 그 안전장치는 current-stock
 *     capability(T09) 없이는 구현할 수 없다. `T2-20` 이 함께 landing 한다.
 *     ⛔ 조용히 무시하지 않는다.
 *   - `defaultLocationId` 도 server-owned 라 400.
 *   - 변경이 전혀 없으면 200 + 현재 행 (DB write·AuditLog 없음, `updatedAt` 불변).
 *   - `IN_TRANSIT` 시스템 예약 창고는 일반 PATCH 금지 — 400 (§W-D12).
 *   - 없으면 404.
 *
 * ⛔ `GET /api/warehouses/{id}` 단건 상세는 이번 범위가 아니다 — 현재
 *    authoritative endpoint inventory(§W-D23)에 없다. 발명하지 않는다.
 *
 * 규칙 전문은 `docs/19_설계복구_Warehouse.md` §W-D25·§W-D26·§W-D27.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/warehouses/[id]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const patch = parseUpdateWarehouseInput(body);
      const warehouse = await updateWarehouse(actor, id, patch);

      return NextResponse.json(
        { warehouse, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/warehouses/[id]' },
  );
}
