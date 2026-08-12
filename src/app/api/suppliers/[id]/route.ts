import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { parseUpdateSupplierInput, updateSupplier } from '@/modules/supplier/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `PATCH /api/suppliers/{id}` — 거래처 수정. `supplier.update` (A·L·S).
 *
 *   - body 는 `{supplierName?, supplierType?, businessRegistrationNo?, contactName?,
 *     contactPhone?, contactEmail?, defaultLeadTimeDays?, note?}` — 최소 하나 필수.
 *   - `undefined` = 미변경 / `null` = 값 제거. `supplierName`·`supplierType` 은 null 불가.
 *   - `supplierCode` 는 create-only immutable — 보내면 400 (D-7).
 *   - `status`·`defaultWarehouseId` 도 mutation 대상이 아니다 — 보내면 400 (D-6·D-9).
 *   - 변경이 전혀 없으면 200 + 현재 행 (DB write·AuditLog 없음).
 *
 * ⛔ GET 단건 상세는 T06-2 범위가 아니다 (D-1) — 필요해지면 T06-4 PRE-FLIGHT 에서
 *    supporting API 로 검토한다.
 * 규칙 전문은 `docs/17_설계복구_거래처공급조건.md` §39~.
 */
export const dynamic = 'force-dynamic';

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
