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
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/skus` — SKU 목록. `sku.read`.
 *   `?q=&status=&itemType=&brandId=&majorCategoryId=&minorCategoryId=&page=&pageSize=&sort=`.
 *   화이트리스트 밖 파라미터는 조용히 무시하지 않고 400 이다
 *   (`hasBom`·`mappingStatus`·`hasIssue` 는 해당 모델 도입 후 지원).
 * `POST /api/skus` — SKU 생성. `sku.create`. 항상 `status=DRAFT` 로 태어난다.
 *
 * ⛔ DELETE 핸들러가 없다(405). SKU 는 물리삭제하지 않는다.
 * ⛔ 승인 워크플로(submit/approve/…)·deactivate·archive 는 T1-4 이후의 별도
 *    endpoint 다 — 이 라우트에 없다.
 *
 * ⚠️ POST idempotency: 전역 규칙(같은 키+같은 내용 → 이전 결과 재응답 /
 *    같은 키+다른 내용 → 409 IDEMPOTENCY_KEY_REUSED)을 뒷받침할 영속
 *    기반이 아직 repo 에 없다. skuCode UNIQUE 는 대체재가 아니다.
 *    T1-3 완료 blocker 로 보고되어 있으며, 기반 도입 Task 에서 적용한다.
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

      const input = parseCreateSkuInput(body);
      const sku = await createSku(actor, input);

      return NextResponse.json(
        { sku, requestId },
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/skus' },
  );
}
