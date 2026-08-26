import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  assertNoLocationListQuery,
  createWarehouseLocation,
  listWarehouseLocations,
  parseCreateLocationInput,
} from '@/modules/warehouse/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/warehouses/{id}/locations` — 로케이션 목록. `warehouse.read` (A·L·S).
 *   - **쿼리 파라미터를 받지 않는다** — 어떤 키든 400 (§W-D32).
 *   - 페이지네이션 없음. 정렬 `locationCode ASC, id ASC`.
 *   - active·inactive 모두 포함하며 **DEFAULT 도 포함**한다.
 *   - parent 창고가 없으면 404 (빈 배열 아님).
 *   - ★ 정상 창고라면 DEFAULT 가 반드시 있으므로 **0건일 수 없다**.
 *
 * `POST /api/warehouses/{id}/locations` — 로케이션 추가. **`warehouse.update`** (A).
 *   - ⛔ location 전용 permission 을 만들지 않는다 (§W-D23).
 *   - body: `{locationCode, locationName, locationType?}`.
 *   - `id`·`warehouseId`·`active` 는 입력 불가 — 400 (§W-D33).
 *   - ★ `locationCode` 가 예약어 `DEFAULT`(대소문자 무시)면 **400** (§W-D9) —
 *     자동 생성만이 DEFAULT 의 owner 다. 단 일반 코드는 대소문자를 보존한다.
 *   - `(warehouseId, locationCode)` 중복은 **generic `CONFLICT`(409)** 다 —
 *     ⛔ 로케이션 전용 error code 를 만들지 않는다 (§W-D34). 어떤 중복인지는
 *     `publicDetails.warehouseId`·`publicDetails.locationCode` 로 구분한다.
 *   - `IN_TRANSIT` 창고에는 추가 로케이션을 만들지 않는다 — 400 (§W-D12).
 *   - `Idempotency-Key` 헤더(선택): scope 에 실제 `warehouseId` 가 들어간다.
 *
 * ⛔ `PATCH`·`DELETE` 로케이션 endpoint 는 존재하지 않는다 (§W-D10) — 따라서
 *    DEFAULT 의 rename·deactivate·delete 기능도 없다. 발명하지 않는다.
 *
 * 규칙 전문은 `docs/19_설계복구_Warehouse.md` §W-D32·§W-D33·§W-D34.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/warehouses/[id]/locations'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      assertNoLocationListQuery(new URL(request.url).searchParams);

      const result = await listWarehouseLocations(actor, id);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/warehouses/[id]/locations' },
  );
}

export async function POST(
  request: Request,
  context: RouteContext<'/api/warehouses/[id]/locations'>,
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

      const input = parseCreateLocationInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await createWarehouseLocation(actor, id, input, {}, idempotencyKey);

      return NextResponse.json(
        { location: result.location, requestId },
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/warehouses/[id]/locations' },
  );
}
