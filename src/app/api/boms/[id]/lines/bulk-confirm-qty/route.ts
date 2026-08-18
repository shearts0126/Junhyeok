import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  assertNoQueryParams,
  bulkConfirmBomLineQuantities,
  parseBulkConfirmQtyInput,
} from '@/modules/bom/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/boms/{id}/lines/bulk-confirm-qty` — 소요량 일괄 확정 (T07-4).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-10 · §D-15 · §D-17 +
 *    "T07-4 bulk-confirm gap closure".
 *
 * ## proxy 1차 가드
 *
 * 이 경로는 D-15 의 `{ prefix:'/api/boms', contains:'/lines', methods:['POST'],
 * permission:'bom.update' }` 에 잡힌다 — 일반 `POST /api/boms`(`bom.create`)
 * 규칙보다 **앞**에 있으므로 shadow 되지 않는다. route-policy 는 T07-3 이 이미
 * 등록했고 **이번 Task 에서 바꾸지 않는다.**
 *
 * ## 2차 가드
 *
 * `bulkConfirmBomLineQuantities` 가 `assertPermission(bom.update)` 를 다시
 * 수행한다. ⛔ ADMIN bypass 없음 · route 에서 role 이름을 비교하지 않는다.
 * ⛔ route 는 Prisma 를 직접 만지지 않는다 — 전부 application service 다.
 *
 * ## 응답
 *
 * 최초 실행·replay 모두 **200 `{bom, requestId}`** 다. 생성이 아니므로 201 을
 * 쓰지 않고, 확정 직후 `unconfirmedCount` 를 바로 보여주기 위해 204 도 쓰지
 * 않는다.
 *
 * ⛔ query 를 하나도 받지 않는다 — 무엇이 오든 400.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/boms/[id]/lines/bulk-confirm-qty'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { id } = await context.params;
      assertNoQueryParams(
        new URL(request.url).searchParams,
        '소요량 일괄 확정은 파라미터를 받지 않습니다.',
      );

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const input = parseBulkConfirmQtyInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await bulkConfirmBomLineQuantities(actor, id, input, {}, idempotencyKey);

      return NextResponse.json(
        { bom: result.bom, requestId },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/boms/[id]/lines/bulk-confirm-qty' },
  );
}
