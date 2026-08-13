import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  listSkuSupplierSummaries,
  parseSkuSupplierSummaryQuery,
} from '@/modules/supplier/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/skus/{id}/supplier-skus` — SKU 상세 ⑥ 공급조건 요약 (T1-6B4).
 *
 * **T1-6B4 전용 read-only supporting API** 다 — standalone SupplierSku 관리
 * collection API 가 아니다. mutation 은 전부 T06-4 `/master/suppliers` 화면이
 * 담당한다 (docs/17 §95).
 *
 *   - 권한: **`supplier.read` AND `supplier_price.read`** (D-3·D-19). proxy 는
 *     경로당 1개라 `supplier.read` 로 잡고, 나머지는 application 2차 가드가
 *     본다. ⛔ ADMIN bypass 없음.
 *   - **현재 유효 공급조건만** 반환한다 (D-5) — 과거 종료·미래 시작 행 제외.
 *     이력은 T06-4 관리화면의 몫이다.
 *   - `asOf` 는 **서버 업무일자(Asia/Seoul)** 로 요청당 한 번 계산하며
 *     응답에 그대로 담는다 — ⛔ 클라이언트가 지정하는 query 가 없다 (D-6).
 *   - `recentPrice` 는 asOf 유효 **승인** 가격이다 — 페이지 전체를 batch 로
 *     한 번에 해결한다(N+1 없음, D-26). 어느 행이든 유효 candidate 2건 이상은
 *     요청 전체 409 `SUPPLIER_PRICE_CHAIN_CONFLICT` (D-18).
 *   - query 는 `page` 하나뿐 — 그 밖의 키는 400. pageSize 는 서버 고정 50.
 *   - 없는 SKU 는 404, UUID 형식 오류는 400.
 *   - ⛔ AuditLog 없음 · 멱등 계약 없음 · mutation 없음 (D-28).
 *
 * 규칙 전문은 `docs/16_설계복구_SKU상세잔여탭.md` §41~.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/skus/[id]/supplier-skus'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      const query = parseSkuSupplierSummaryQuery(new URL(request.url).searchParams);

      const result = await listSkuSupplierSummaries(actor, id, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/supplier-skus' },
  );
}
