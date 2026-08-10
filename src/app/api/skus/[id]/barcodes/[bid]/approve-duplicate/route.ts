import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { approveDuplicateBarcode, parseApproveDuplicateInput } from '@/modules/barcode/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/skus/{id}/barcodes/{bid}/approve-duplicate` — 중복 예외 **승인**.
 * `barcode.approve_duplicate` (ADMIN·SCM_LEADER).
 *
 *   - body `{reason}` **필수** (trim 후 비어 있으면 400). 저장값은 trim 된 문자열.
 *   - 대상은 `status='PENDING_DUPLICATE'` · `duplicateException=false` ·
 *     `approvedBy=null` 인 후보뿐이다. 소유권 불일치는 404.
 *   - 승인 직전 실제 중복(cross-SKU ACTIVE)을 **다시 확인**한다 — 사라졌으면 422.
 *   - 성공: `PENDING_DUPLICATE → ACTIVE`, `duplicateException=true`,
 *     `exceptionReason`, `approvedBy` 만 바뀐다.
 *   - 이미 승인된 행에 재호출하면 **200 no-op** — 최초 승인자 기록을 덮어쓰지 않는다.
 *   - 후보가 `isPrimary=true` 인데 활성 대표가 이미 있으면 409
 *     `BARCODE_PRIMARY_CONFLICT` 이고 전체 롤백된다(기존 대표 자동 해제 없음).
 *
 * ⛔ `Idempotency-Key` 인프라를 붙이지 않는다 — 재호출 안전성은 상태 semantics 로 처리한다.
 * 규칙 전문은 `docs/11_설계복구_Barcode중복예외승인.md`.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/skus/[id]/barcodes/[bid]/approve-duplicate'>,
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

      const input = parseApproveDuplicateInput(body);
      const barcode = await approveDuplicateBarcode(actor, id, bid, input);

      return NextResponse.json(
        { barcode, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus/[id]/barcodes/[bid]/approve-duplicate' },
  );
}
