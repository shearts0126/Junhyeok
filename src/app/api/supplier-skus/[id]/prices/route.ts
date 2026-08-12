import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  createSupplierSkuPrice,
  listSupplierSkuPrices,
  parseCreatePriceInput,
  parseListPricesQuery,
} from '@/modules/supplier/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/supplier-skus/{id}/prices` — 가격이력·asOf 유효가격.
 * `supplier_price.read` (A·L·S·F).
 *   - query 는 `asOf` 하나뿐 (그 밖의 키는 400). pagination 없음.
 *   - asOf 없음 → 승인+미승인 · 과거+현재+미래 전체 이력,
 *     정렬 `effectiveFrom DESC, id DESC`.
 *   - asOf 있음 → 승인된 operational 유효가격 `[]` 또는 1건.
 *     없음은 200 `[]` (404·0원 fallback 아님) / 2건 이상은 409
 *     `SUPPLIER_PRICE_CHAIN_CONFLICT`.
 *   - parent SupplierSku 없으면 404.
 *
 * `POST /api/supplier-skus/{id}/prices` — 가격 등록(미승인 제안행).
 * `supplier_price.create` (A·L·S·F).
 *   - body 정확히 `{unitPrice, currency, vatIncluded, effectiveFrom,
 *     sourceDocument?}`. `unitPrice` 는 **십진 문자열** (JSON number 400,
 *     음수 422 `SUPPLIER_PRICE_UNIT_PRICE_INVALID`, 0 허용).
 *   - 등록 ≠ 발효 — approvedBy=null·effectiveTo=null 로 생성될 뿐, 기존 승인
 *     가격·asOf 결과를 바꾸지 않는다. 발효는 approve 트랜잭션의 몫이다.
 *   - 동일 시작일 409 `SUPPLIER_PRICE_EFFECTIVE_FROM_DUPLICATE`.
 *   - `Idempotency-Key`(선택): scope 는 실제 supplierSkuId 를 포함한다 (D-30).
 *
 * 규칙 전문은 `docs/17_설계복구_거래처공급조건.md` §58~.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/supplier-skus/[id]/prices'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      const query = parseListPricesQuery(new URL(request.url).searchParams);

      const result = await listSupplierSkuPrices(actor, id, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/supplier-skus/[id]/prices' },
  );
}

export async function POST(
  request: Request,
  context: RouteContext<'/api/supplier-skus/[id]/prices'>,
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

      const input = parseCreatePriceInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await createSupplierSkuPrice(actor, id, input, {}, idempotencyKey);

      return NextResponse.json(
        { price: result.price, requestId },
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/supplier-skus/[id]/prices' },
  );
}
