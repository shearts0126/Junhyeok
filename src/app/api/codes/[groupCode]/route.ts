import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  createCode,
  listCodes,
  parseActiveFilter,
  parseCreateCodeInput,
} from '@/modules/common-code/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/codes/{groupCode}` — 코드 목록. `common_code.read`.
 *   `?active=true|false|all` (기본 true). 정렬 `sort_order ASC, code ASC`.
 * `POST /api/codes/{groupCode}` — 코드 추가. `common_code.manage`.
 *
 * ⛔ DELETE 핸들러가 없다. 코드는 물리삭제하지 않는다 — PATCH 로 비활성화한다.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/codes/[groupCode]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { groupCode } = await context.params;
      const activeFilter = parseActiveFilter(new URL(request.url).searchParams.get('active'));

      const { group, codes } = await listCodes(actor, groupCode, activeFilter);

      return NextResponse.json(
        { group, codes, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/codes/[groupCode]' },
  );
}

export async function POST(
  request: Request,
  context: RouteContext<'/api/codes/[groupCode]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { groupCode } = await context.params;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const input = parseCreateCodeInput(body);
      const code = await createCode(actor, groupCode, input);

      return NextResponse.json(
        { code, requestId },
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/codes/[groupCode]' },
  );
}
