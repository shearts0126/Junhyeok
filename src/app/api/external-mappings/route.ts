import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  createExternalMapping,
  listExternalMappings,
  parseCreateMappingInput,
  parseListMappingsQuery,
} from '@/modules/external-mapping/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKeyHeader } from '@/shared/idempotency';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET  /api/external-mappings` — 목록. `external_mapping.read` (A·L·S·F).
 *   - 공통 목록 envelope `{items, page, pageSize, total, totalPages}`.
 *   - query: `q, externalSystemId, skuId, mappingStatus, page, pageSize`
 *     (화이트리스트 밖 키는 400 — 조용히 무시하지 않는다).
 *   - 정렬 `createdAt DESC, id DESC` 고정. `sort` 는 V1 미지원.
 *
 * `POST /api/external-mappings` — 생성. `external_mapping.create` (A·L·S).
 *   - body 는 `{skuId, externalSystemId, externalProductCode?, externalProductName?,
 *     externalBarcode?, isPrimary?, note?}` 만 허용 (unknown field 400).
 *   - `mappingStatus` 는 **server-derived** — 입력하면 400.
 *   - `warehouseId` 는 T08-1 전까지 입력 불가 — 입력하면 400, 저장값은 항상 null.
 *   - 식별자가 하나도 없으면 422 `EXTERNAL_MAPPING_IDENTIFIER_REQUIRED`.
 *   - 현행 외부코드 중복 409 `EXTERNAL_MAPPING_CODE_DUPLICATE` /
 *     대표 충돌 409 `EXTERNAL_MAPPING_PRIMARY_CONFLICT`.
 *   - `Idempotency-Key` 헤더(선택, ≤200자): 같은 키+같은 내용 재요청은 200 replay.
 *
 * ⛔ `/import` · `/unmatched` 는 이 Task 범위가 아니다 (stub 도 만들지 않는다).
 * 규칙 전문은 `docs/13_설계복구_외부상품매핑CRUD.md`.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const query = parseListMappingsQuery(new URL(request.url).searchParams);
      const result = await listExternalMappings(actor, query);

      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/external-mappings' },
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

      const input = parseCreateMappingInput(body);
      const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get(IDEMPOTENCY_KEY_HEADER));

      const result = await createExternalMapping(actor, input, {}, idempotencyKey);

      return NextResponse.json(
        { mapping: result.mapping, requestId },
        { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/external-mappings' },
  );
}
