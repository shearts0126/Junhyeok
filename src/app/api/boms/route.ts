import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  createBom,
  listBoms,
  parseCreateBomInput,
  parseListBomsQuery,
} from '@/modules/bom/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/boms` — BOM 목록. `bom.read` (A·L·S·F·**E**).
 *   - query 정확히 7개: `q`·`status`·`bomType`·`parentSkuId`·`effectiveOn`
 *     ·`hasUnknownQty`·`page`. 그 밖의 키는 **400**(조용한 제거 금지).
 *   - `pageSize` 는 서버 고정 50, `sort` 미지원.
 *   - `effectiveOn` 은 반열림 `[from, to)` **기간** 필터이며 status 를
 *     함의하지 않는다. `hasUnknownQty` 는 `quantityStatus='UNKNOWN'` 라인 보유.
 *   - 정렬 `parentSku.skuCode ASC → effectiveFrom DESC → id ASC` 고정.
 *   - 응답에 `lines` 는 없다 — `lineCount`·`unconfirmedCount` 만 (D-14).
 *
 * `POST /api/boms` — BOM 생성. `bom.create` (A·L·S). ★ FINANCE 불가.
 *   - 결과는 항상 `DRAFT` 다. 라인 자동 생성 없음 · 승인/활성화 없음.
 *   - `(parentSkuId, version)` 중복은 409 `BOM_VERSION_DUPLICATE`.
 *   - `Idempotency-Key`(선택): scope 는 `bom:create` (D-17).
 *
 * 규칙 전문은 `docs/18_설계복구_BOM.md` §D-14·§D-15·§D-17·§D-31.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const query = parseListBomsQuery(new URL(request.url).searchParams);
      const result = await listBoms(actor, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/boms' },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const input = parseCreateBomInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await createBom(actor, input, {}, idempotencyKey);

      return NextResponse.json(
        { bom: result.bom, requestId },
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/boms' },
  );
}
