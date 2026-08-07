import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { parseUpdateCodePatch, updateCode } from '@/modules/common-code/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `PATCH /api/codes/{groupCode}/{code}` — 코드 수정. `common_code.manage`.
 *
 * 수정 가능: `name`·`parentCode`·`sortOrder`·`attributes`·`active`.
 * `code`·`group` 은 생성 후 불변이다.
 *
 * ⛔ DELETE 핸들러가 없다. "삭제" = `{ "active": false }` (비활성화).
 *    동일 값 PATCH 는 400 — "변경할 내용이 없습니다."
 */
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/codes/[groupCode]/[code]'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const { groupCode, code } = await context.params;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const patch = parseUpdateCodePatch(body);
      const updated = await updateCode(actor, groupCode, code, patch);

      return NextResponse.json(
        { code: updated, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/codes/[groupCode]/[code]' },
  );
}
