import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  deactivateSkuBarcode,
  parseUpdateBarcodeInput,
  updateSkuBarcode,
} from '@/modules/barcode/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `PATCH  /api/skus/{id}/barcodes/{bid}` — 바코드 수정. `barcode.update`.
 *   - body 는 `{isPrimary?, status?}` 만 허용하며 최소 하나 필수 (`{}` 는 400).
 *   - ⛔ `barcode` 값은 생성 후 불변 — 수정하려면 비활성 후 새로 추가한다.
 *   - 대표 자동 교체 없음 — 충돌은 409 `BARCODE_PRIMARY_CONFLICT`.
 *   - 변화가 없으면 write 없이 200.
 *
 * `DELETE /api/skus/{id}/barcodes/{bid}` — **비활성**. `barcode.deactivate`.
 *   - 물리삭제가 아니라 `status='INACTIVE'`. 응답 200 + 갱신된 행.
 *   - 이미 INACTIVE 면 write 없이 200 (반복 호출 idempotent, 409 아님).
 *
 * 두 메서드 모두 `{bid}` 가 다른 SKU 의 바코드면 404 다 — 존재를 노출하지 않는다.
 * ⛔ `Idempotency-Key` 인프라를 붙이지 않는다 (멱등 대상은 POST 뿐 — docs/10 §28).
 * 규칙 전문은 `docs/10_설계복구_BarcodeCRUD.md`.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/skus/[id]/barcodes/[bid]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id, bid } = await context.params;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const patch = parseUpdateBarcodeInput(body);
      const barcode = await updateSkuBarcode(actor, id, bid, patch);

      return NextResponse.json(
        { barcode, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/barcodes/[bid]' },
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext<'/api/skus/[id]/barcodes/[bid]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id, bid } = await context.params;
      const barcode = await deactivateSkuBarcode(actor, id, bid);

      return NextResponse.json(
        { barcode, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/barcodes/[bid]' },
  );
}
