import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  createSupplierSku,
  listSupplierSkus,
  parseCreateSupplierSkuInput,
  parseListSupplierSkusQuery,
} from '@/modules/supplier/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/suppliers/{id}/skus` — 공급조건 목록. `supplier.read` (A·L·S·F).
 *   - query 는 `page` 하나뿐 (그 밖의 키는 400). `pageSize` 서버 고정 50.
 *   - **현재+과거+미래 이력 전부** 포함, 정렬 `effectiveFrom DESC, id DESC`.
 *   - parent 거래처가 없으면 404 — 빈 목록으로 위장하지 않는다.
 *   - item 에 SKU 최소 projection(`id/skuCode/skuName/status`)과 파생
 *     `effectiveLeadTimeDays`(G-03 폴백) 포함. ⛔ 가격은 없다 (T06-3).
 *
 * `POST /api/suppliers/{id}/skus` — 공급조건 등록. `supplier.create` (A·L·S).
 *   - body: `{skuId, supplyType, effectiveFrom, supplierSkuCode?, supplierSkuName?,
 *     moq?, orderMultiple?, leadTimeDays?, purchaseUom?, currency?, isPrimary?,
 *     effectiveTo?}`. `moq`/`orderMultiple` 는 **십진 문자열**(JSON number 400).
 *   - 기간 중첩 409 `SUPPLIER_SKU_PERIOD_OVERLAP` / 동일 시작일 409
 *     `SUPPLIER_SKU_EFFECTIVE_FROM_DUPLICATE` / 현행 대표 충돌 409
 *     `SUPPLIER_SKU_PRIMARY_CONFLICT` (자동 교체 없음).
 *   - `Idempotency-Key`(선택): scope 는 실제 supplierId 를 포함한다 (D-24).
 *
 * 규칙 전문은 `docs/17_설계복구_거래처공급조건.md` §39~.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/suppliers/[id]/skus'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      const query = parseListSupplierSkusQuery(new URL(request.url).searchParams);

      const result = await listSupplierSkus(actor, id, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/suppliers/[id]/skus' },
  );
}

export async function POST(
  request: Request,
  context: RouteContext<'/api/suppliers/[id]/skus'>,
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

      const input = parseCreateSupplierSkuInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await createSupplierSku(actor, id, input, {}, idempotencyKey);

      return NextResponse.json(
        { supplierSku: result.supplierSku, requestId },
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/suppliers/[id]/skus' },
  );
}
