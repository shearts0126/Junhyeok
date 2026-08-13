import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  assertNoSupplierDetailQuery,
  getSupplier,
  parseUpdateSupplierInput,
  updateSupplier,
} from '@/modules/supplier/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/suppliers/{id}` — 거래처 단건 상세. `supplier.read` (A·L·S·F).
 *
 *   - T06-4 supporting API 다 (D-9·D-36) — `/master/suppliers/{id}` 의
 *     새로고침·deep-link·공유 URL 이 목록 cache 없이 성립하게 한다.
 *     목록의 `q` 는 코드·이름 contains 검색이라 id exact lookup 이 불가능하다.
 *   - 응답은 **PATCH 와 동일한 `{supplier, requestId}`** — 기존 `SupplierView`
 *     를 그대로 쓰고 별도 detail view 를 만들지 않는다.
 *   - **쿼리 파라미터를 받지 않는다** — 어떤 키든 400.
 *   - 없으면 404. ⛔ AuditLog·멱등 계약 없음. ⛔ 공급조건·가격 join 없음.
 *
 * `PATCH /api/suppliers/{id}` — 거래처 수정. `supplier.update` (A·L·S).
 *
 *   - body 는 `{supplierName?, supplierType?, businessRegistrationNo?, contactName?,
 *     contactPhone?, contactEmail?, defaultLeadTimeDays?, note?}` — 최소 하나 필수.
 *   - `undefined` = 미변경 / `null` = 값 제거. `supplierName`·`supplierType` 은 null 불가.
 *   - `supplierCode` 는 create-only immutable — 보내면 400 (D-7).
 *   - `status`·`defaultWarehouseId` 도 mutation 대상이 아니다 — 보내면 400 (D-6·D-9).
 *   - 변경이 전혀 없으면 200 + 현재 행 (DB write·AuditLog 없음).
 *
 * 규칙 전문은 `docs/17_설계복구_거래처공급조건.md` §39~(T06-2)·§80~(T06-4).
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/suppliers/[id]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      assertNoSupplierDetailQuery(new URL(request.url).searchParams);

      const supplier = await getSupplier(actor, id);

      return NextResponse.json(
        { supplier, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/suppliers/[id]' },
  );
}

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/suppliers/[id]'>,
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

      const patch = parseUpdateSupplierInput(body);
      const supplier = await updateSupplier(actor, id, patch);

      return NextResponse.json(
        { supplier, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/suppliers/[id]' },
  );
}
