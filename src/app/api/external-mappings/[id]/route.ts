import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  parseUpdateMappingInput,
  updateExternalMapping,
} from '@/modules/external-mapping/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `PATCH /api/external-mappings/{id}` — 수정. `external_mapping.update` (A·L·S).
 *
 *   - body 는 `{externalProductCode?, externalProductName?, externalBarcode?,
 *     isPrimary?, effectiveTo?, note?}` 만 허용, 최소 하나 필수 (`{}` 는 400).
 *   - `mappingStatus` 는 identifier prospective state 에서 **서버가 파생**한다.
 *     `{mappingStatus}` 를 보내면 400 이다.
 *   - `skuId`·`externalSystemId` 는 identity 라 immutable (보내면 400).
 *   - 매핑 해제는 `effectiveTo` 설정이다 — **DELETE 는 없다**.
 *     대표 매핑을 종료하려면 같은 요청에 `isPrimary:false` 가 있어야 한다.
 *   - 변경이 전혀 없으면 200 + 현재 행 (DB write·AuditLog 없음).
 *
 * 규칙 전문은 `docs/13_설계복구_외부상품매핑CRUD.md`.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/external-mappings/[id]'>,
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

      const patch = parseUpdateMappingInput(body);
      const mapping = await updateExternalMapping(actor, id, patch);

      return NextResponse.json(
        { mapping, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/external-mappings/[id]' },
  );
}
