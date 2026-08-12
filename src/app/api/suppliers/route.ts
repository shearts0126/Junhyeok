import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  createSupplier,
  listSuppliers,
  parseCreateSupplierInput,
  parseListSuppliersQuery,
} from '@/modules/supplier/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/suppliers` — 거래처 목록. `supplier.read` (A·L·S·F — E 제외).
 *   - query: `q, supplierType, status, page` 만 (화이트리스트 밖 키는 400).
 *   - `pageSize` 서버 고정 50, 정렬 `supplierCode ASC, id ASC` 고정.
 *   - 공통 목록 envelope `{items, page, pageSize, total, totalPages}`.
 *
 * `POST /api/suppliers` — 거래처 생성. `supplier.create` (A·L·S).
 *   - body: `{supplierCode, supplierName, supplierType, businessRegistrationNo?,
 *     contactName?, contactPhone?, contactEmail?, defaultLeadTimeDays?, note?}`.
 *   - `status`(항상 ACTIVE)·`defaultWarehouseId`(T08-1 staged)는 입력 불가 — 400.
 *   - 중복 코드 409 `SUPPLIER_CODE_DUPLICATE`.
 *   - `Idempotency-Key` 헤더(선택): 같은 키+같은 내용 재요청은 200 replay.
 *
 * 규칙 전문은 `docs/17_설계복구_거래처공급조건.md` §39~.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const query = parseListSuppliersQuery(new URL(request.url).searchParams);
      const result = await listSuppliers(actor, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/suppliers' },
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

      const input = parseCreateSupplierInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await createSupplier(actor, input, {}, idempotencyKey);

      return NextResponse.json(
        { supplier: result.supplier, requestId },
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/suppliers' },
  );
}
