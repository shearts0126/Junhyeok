import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  parseRequestDuplicateCandidateInput,
  requestDuplicateCandidate,
} from '@/modules/barcode/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/skus/{id}/barcodes/duplicate-candidates` — 중복 예외 **요청**.
 * `barcode.request_duplicate`.
 *
 * 일반 `POST /api/skus/{id}/barcodes` 는 그대로 409 `BARCODE_DUPLICATE` 다 —
 * 사용자가 의도적으로 바코드 공유를 요청할 때만 이 경로를 쓴다.
 *
 *   - body 는 `{barcode, barcodeType, isPrimary?}` 만 허용 (unknown field 400).
 *   - 다른 SKU 가 **활성으로 사용 중인 동일 바코드**가 없으면 422
 *     `BARCODE_DUPLICATE_EXCEPTION_NOT_APPLICABLE` (같은 SKU 안의 중복도 대상 아님).
 *   - 성공 시 `status='PENDING_DUPLICATE'` 후보를 만들고 **201**.
 *   - 동일 내용의 후보가 이미 있으면 **200**(새 row·AuditLog 없음),
 *     내용이 다르면 409 `BARCODE_DUPLICATE_CANDIDATE_EXISTS`.
 *   - `Idempotency-Key` 헤더(선택): 같은 키+같은 내용 재요청은 200 replay.
 *
 * 규칙 전문은 `docs/11_설계복구_Barcode중복예외승인.md`.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/skus/[id]/barcodes/duplicate-candidates'>,
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

      const input = parseRequestDuplicateCandidateInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await requestDuplicateCandidate(actor, id, input, {}, idempotencyKey);

      // 새로 만든 경우만 201 — replay·기존 후보 반환은 200 이다.
      const status = result.replayed || result.existing ? 200 : 201;
      return NextResponse.json(
        { barcode: result.barcode, requestId },
        { status, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/barcodes/duplicate-candidates' },
  );
}
