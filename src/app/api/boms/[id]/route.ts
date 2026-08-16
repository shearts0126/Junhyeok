import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  assertNoQueryParams,
  getBom,
  parseUpdateBomInput,
  updateBom,
} from '@/modules/bom/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET   /api/boms/{id}` — BOM 상세(라인 포함). `bom.read` (A·L·S·F·**E**).
 *   - `BomDetail` = 헤더 + `lineCount`·`unconfirmedCount` + `lines`(D-14).
 *   - 라인 정렬 `lineNo ASC → id ASC`. 없는 id 는 404, UUID 오류는 400.
 *   - query 를 받지 않는다 — 어떤 키든 400.
 *
 * `PATCH /api/boms/{id}` — BOM 헤더 수정. `bom.update` (A·L·S).
 *   - `DRAFT`·`REJECTED` 만 편집 가능. `ACTIVE` 는 422 `BOM_ACTIVE_IMMUTABLE`,
 *     나머지는 422 `BOM_NOT_EDITABLE` (D-6).
 *   - ⛔ `parentSkuId`·`version`·`status` 는 DTO 가 400 으로 막는다.
 *   - ★ `effectiveFrom` 변경은 **변경 후 기준일로 cycle 재검사**를 거친다.
 *     순환이면 422 이고 변경 자체가 롤백된다 (D-13·D-28).
 *   - 실질 변경 0 이면 200 + DB write 0 + Audit 0.
 *
 * ⛔ `DELETE /api/boms/{id}` 는 만들지 않는다 — 물리삭제 금지. `DRAFT`·
 *    `REJECTED` 헤더는 T07-5 의 `archive` 로 감춘다.
 *
 * 규칙 전문은 `docs/18_설계복구_BOM.md` §D-6·§D-13·§D-14.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/boms/[id]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      assertNoQueryParams(
        new URL(request.url).searchParams,
        'BOM 상세 조회는 파라미터를 받지 않습니다.',
      );

      const { id } = await context.params;
      const bom = await getBom(actor, id);

      return NextResponse.json({ bom, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/boms/[id]' },
  );
}

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/boms/[id]'>,
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

      const patch = parseUpdateBomInput(body);
      const bom = await updateBom(actor, id, patch);

      return NextResponse.json({ bom, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/boms/[id]' },
  );
}
