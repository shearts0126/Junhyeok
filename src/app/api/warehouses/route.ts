import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  createWarehouse,
  listWarehouses,
  parseCreateWarehouseInput,
  parseListWarehousesQuery,
} from '@/modules/warehouse/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/warehouses` — 창고 목록. `warehouse.read` (A·L·S — **F·E 제외**).
 *   - query: `warehouseType, active, page` 만 (화이트리스트 밖 키는 400).
 *   - `pageSize` 서버 고정 50, 정렬 `warehouseCode ASC, id ASC` 고정.
 *   - ⛔ `active=true` 자동 필터 없음 — 비활성 창고도 포함된다.
 *   - 공통 목록 envelope `{items, page, pageSize, total, totalPages}`.
 *
 * `POST /api/warehouses` — 창고 생성. `warehouse.create` (A).
 *   - body: `{warehouseCode, warehouseName, warehouseType, externalSystemId?,
 *     supplierId?, timezone?, address?}`.
 *   - `id`·`defaultLocationId`·`active` 는 입력 불가 — 400.
 *   - ★ **DEFAULT 로케이션이 같은 트랜잭션에서 자동 생성**된다 (§00 G-05).
 *   - `IN_TRANSIT` 유형·코드는 시스템 예약이라 400 (§W-D12).
 *   - 중복 코드 409 `WAREHOUSE_CODE_DUPLICATE`.
 *   - `Idempotency-Key` 헤더(선택): 같은 키+같은 내용 재요청은 200 replay 이며
 *     **DEFAULT child 를 다시 만들지 않는다**.
 *
 * 규칙 전문은 `docs/19_설계복구_Warehouse.md` §W-D22~§W-D36.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const query = parseListWarehousesQuery(new URL(request.url).searchParams);
      const result = await listWarehouses(actor, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/warehouses' },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const input = parseCreateWarehouseInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await createWarehouse(actor, input, {}, idempotencyKey);

      return NextResponse.json(
        {
          warehouse: result.warehouse,
          defaultLocation: result.defaultLocation,
          requestId,
        },
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/warehouses' },
  );
}
