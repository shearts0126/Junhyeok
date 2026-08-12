import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { parseUpdateSupplierSkuInput, updateSupplierSku } from '@/modules/supplier/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `PATCH /api/supplier-skus/{id}` — 공급조건 종료·버전 생성. `supplier.update` (A·L·S).
 *
 * 공급조건은 effective-dated history 라 **제자리 수정 API 가 아니다** (D-15):
 *
 *   - **mode A (종료)**: body 정확히 `{effectiveTo: "YYYY-MM-DD"}` —
 *     open-ended 종료·기존 종료일 앞당기기. 연장·`null` reopen 불가.
 *   - **mode B (새 버전)**: body 에 `effectiveFrom` + 변경 필드 —
 *     기존 row 를 그 날짜에 닫고 후속 version row 를 만든다(응답은 후속 row).
 *     omitted field 는 기존 값 복사, successor `effectiveTo` 는 명시값 또는
 *     기존 row 의 원래 종료일 상속.
 *
 *   - `supplierId`·`skuId` identity 는 immutable — 보내면 400.
 *   - business field 만 보내면(= `effectiveFrom` 없이) 400 — 과거·현재·미래
 *     어느 row 도 제자리에서 덮어쓰지 않는다 (D-16).
 *   - 버전 경계 위반 422 `SUPPLIER_SKU_VERSION_DATE_INVALID` /
 *     기간 위반 422 `SUPPLIER_SKU_EFFECTIVE_PERIOD_INVALID`.
 *
 * 멱등 계약 없음 — 문서 표의 멱등 칸 `—` 그대로다.
 * 규칙 전문은 `docs/17_설계복구_거래처공급조건.md` §39~.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/supplier-skus/[id]'>,
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

      const patch = parseUpdateSupplierSkuInput(body);
      const supplierSku = await updateSupplierSku(actor, id, patch);

      return NextResponse.json(
        { supplierSku, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/supplier-skus/[id]' },
  );
}
