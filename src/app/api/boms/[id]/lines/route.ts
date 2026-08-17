import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { createBomLine, parseCreateLineInput } from '@/modules/bom/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/boms/{id}/lines` — BOM 라인 추가. `bom.update` (A·L·S).
 *
 *   - 편집 가능 상태는 `DRAFT`·`REJECTED` 뿐 (D-6).
 *   - `lineNo` 생략 시 서버가 `max+1`. `uom` 생략 시 구성품 `baseUom`.
 *     `quantityStatus` 생략 시 `UNKNOWN` — ⛔ 소요량 자동 `"1"` 없음 (D-10).
 *   - `alternateGroup` 은 trim → blank 면 null 로 정규화한다 (D-3).
 *   - ★ **tentative INSERT 이후 상태로 순환을 검사**한다. 순환이면 422
 *     `BOM_CYCLE_DETECTED` 이고 라인·audit·멱등 결과가 **전부 롤백**된다
 *     (D-13·D-28·D-44).
 *   - 중복은 409 `BOM_LINE_DUPLICATE` (순번 / 구성품·대체그룹 두 가지).
 *   - `Idempotency-Key`(선택): scope 는 `bom:{bomId}:line:create` (D-17).
 *
 * ⛔ `GET /api/boms/{id}/lines` 는 만들지 않는다 — 라인은 `GET /api/boms/{id}`
 *    의 `BomDetail` 에 포함된다 (D-14).
 * ⛔ `…/lines/bulk-confirm-qty` 는 T07-4 다.
 *
 * 규칙 전문은 `docs/18_설계복구_BOM.md` §D-9 ~ §D-14 · §D-28.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: RouteContext<'/api/boms/[id]/lines'>,
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

      const input = parseCreateLineInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await createBomLine(actor, id, input, {}, idempotencyKey);

      return NextResponse.json(
        { line: result.line, requestId },
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/boms/[id]/lines' },
  );
}
