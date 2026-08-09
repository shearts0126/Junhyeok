import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  createSku,
  listSkus,
  parseCreateSkuInput,
  parseListSkusQuery,
} from '@/modules/sku/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/skus` — SKU 목록. `sku.read`.
 *   `?q=&status=&itemType=&brandId=&majorCategoryId=&minorCategoryId=&page=&pageSize=&sort=`.
 *   화이트리스트 밖 파라미터는 조용히 무시하지 않고 400 이다
 *   (`hasBom`·`mappingStatus`·`hasIssue` 는 해당 모델 도입 후 지원).
 * `POST /api/skus` — SKU 생성. `sku.create`. 항상 `status=DRAFT` 로 태어난다.
 *   `Idempotency-Key` 헤더(선택, ≤200자): 같은 키+같은 내용 재요청은 저장 결과를
 *   200 으로 replay 하고, 같은 키+다른 내용은 409 IDEMPOTENCY_KEY_REUSED 다.
 *   헤더가 없으면 일반 생성(201)이다. 핵심 판정은 application/shared 계층에
 *   있다 — 이 핸들러는 헤더를 읽어 전달만 한다.
 *
 * ⛔ DELETE 핸들러가 없다(405). SKU 는 물리삭제하지 않는다.
 * ⛔ 승인 워크플로(submit/approve/…)·deactivate·archive 는 T1-4 이후의 별도
 *    endpoint 다 — 이 라우트에 없다.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const query = parseListSkusQuery(new URL(request.url).searchParams);
      const result = await listSkus(actor, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus' },
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

      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));
      const input = parseCreateSkuInput(body);
      const { sku, replayed } = await createSku(actor, input, {}, idempotencyKey);

      // replay 응답도 requestId 는 이번 요청의 새 값이다 — snapshot 에 없다.
      return NextResponse.json(
        { sku, requestId },
        { status: replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus' },
  );
}
