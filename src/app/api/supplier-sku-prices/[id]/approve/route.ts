import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { approveSupplierSkuPrice, parseApprovePriceInput } from '@/modules/supplier/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/supplier-sku-prices/{id}/approve` — 가격 승인 = 발효.
 * `supplier_price.approve` (A·L·F — SCM_STAFF 불가).
 *
 *   - body 는 `{note?}` 뿐 (unknown key 400). note 는 trim·blank→null 후
 *     AuditLog.reason 에 쓴다.
 *   - 승인 트랜잭션에서만 chain 이 바뀐다: 승인된 predecessor close(T) +
 *     target `effectiveTo = successor?.effectiveFrom ?? null` +
 *     `approvedBy = actor`. pending 은 chain 계산에서 제외.
 *   - 이미 승인된 가격은 **200 + 현재 view** (write 0 / audit 0) — 별도
 *     ALREADY_APPROVED 없음.
 *   - 자가승인: `allowSelfApprovalSku` 설정을 같은 트랜잭션에서 재조회해
 *     판정 — 위반 403 `SELF_APPROVAL_FORBIDDEN`.
 *   - eligibility 는 price 존재 + 미승인뿐 — future·historical 승인 허용.
 *   - parent `supplier_sku` FOR UPDATE lock 으로 동시 승인을 직렬화한다.
 *
 * 멱등 계약 없음 — repeat approve 가 자연 멱등이다.
 * 규칙 전문은 `docs/17_설계복구_거래처공급조건.md` §58~.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/supplier-sku-prices/[id]/approve'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;

      // ★ body 없는 POST 도 허용한다 — note 는 optional 이다 (SKU approve 와 동일).
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }

      const input = parseApprovePriceInput(body);
      const price = await approveSupplierSkuPrice(actor, id, input);

      return NextResponse.json({ price, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/supplier-sku-prices/[id]/approve' },
  );
}
