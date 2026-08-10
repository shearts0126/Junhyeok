import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  createSkuBarcode,
  listSkuBarcodes,
  parseCreateBarcodeInput,
} from '@/modules/barcode/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/skus/{id}/barcodes` — 바코드 목록. `barcode.read`.
 *   ACTIVE·INACTIVE 를 모두 포함한 **raw 배열**이다 (pagination·filter 없음).
 *   정렬은 `createdAt DESC, id DESC`.
 *
 * `POST /api/skus/{id}/barcodes` — 바코드 추가. `barcode.create`.
 *   - body 는 `{barcode, barcodeType, isPrimary?}` 만 허용 (unknown field 400).
 *   - `-`·공란 등 미입력 표시값은 오류가 아니라 **204 No Content** (저장 없음).
 *   - 지수표기·확인필요·형식오류는 422, 정규화 결과가 100자 초과면 400.
 *   - 활성 중복 409 `BARCODE_DUPLICATE` / 활성 대표 중복 409 `BARCODE_PRIMARY_CONFLICT`.
 *   - `Idempotency-Key` 헤더(선택, ≤200자): 같은 키+같은 내용 재요청은 200 replay.
 *
 * ⛔ DataIssue 를 만들지 않는다 (docs/10 §1).
 * 규칙 전문은 `docs/10_설계복구_BarcodeCRUD.md`.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/skus/[id]/barcodes'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      const barcodes = await listSkuBarcodes(actor, id);

      return NextResponse.json(
        { barcodes, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/barcodes' },
  );
}

export async function POST(
  request: Request,
  context: RouteContext<'/api/skus/[id]/barcodes'>,
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

      const input = parseCreateBarcodeInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await createSkuBarcode(actor, id, input, {}, idempotencyKey);

      // ★ 미입력 표시값 — 저장하지 않았으므로 본문이 없다. 오류가 아니다.
      if (result.kind === 'EMPTY') {
        return new NextResponse(null, {
          status: 204,
          headers: { 'Cache-Control': 'no-store' },
        }) as NextResponse;
      }

      return NextResponse.json(
        { barcode: result.barcode, requestId },
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/barcodes' },
  );
}
