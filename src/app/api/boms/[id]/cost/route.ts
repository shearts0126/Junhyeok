import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { costBom, parseCostBomQuery } from '@/modules/bom/application';
import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/boms/{id}/cost` — 다단계 BOM 원가 roll-up (T07-7B).
 *
 * ★ root 는 **URL 이 지정한 exact `BomHeader`** 다 — 같은 상위 SKU 에 asOf 기준
 *   다른 `ACTIVE` 버전이 있어도 재선택하지 않는다. `resolveEffectiveBom` 은
 *   **하위 구성품에만** 적용한다 (D-18 과 같은 비대칭). root `status` 제한 없음.
 *
 *   - query 는 정확히 2개 — `qty`(기본 `"1"`) · `asOf`(기본 KST 업무일자).
 *     그 밖의 키는 **400**. ⛔ `maxLevel` 을 public query 로 두지 않는다.
 *     ⛔ `supplierId`·`priceId`·`currency` override 를 받지 않는다.
 *   - 응답 body 는 `CostResult` — **exact 9 키** + `requestId`. ⛔ 단일
 *     `totalCost` 필드를 두지 않는다. 통화·VAT 가 섞이면 하나의 수로 합칠 수
 *     없기 때문에 `subtotals[]` 로 나눈다 (D-26·D-27).
 *   - ★ `components[]` 는 **terminal cost-bearing occurrence 의 집계**다 —
 *     asOf 유효 `ACTIVE` child BOM 을 가진 **중간 반제품은 제외**한다. 반제품
 *     매입가와 하위 재료비를 동시에 더하면 **이중계상**이다
 *     (`★ T07-7B multi-level roll-up gap closure` R-1·R-2·R-6).
 *   - ★ 수량 미확정은 **경로를 상속**한다 — root → terminal 경로의 어느 라인이든
 *     `quantityStatus !== CONFIRMED` 이면 `QTY_UNCONFIRMED` 다 (R-12).
 *   - 산정 불가는 **`null`** 이며 ⛔ `0` 으로 채우지 않는다. `unitPrice = "0"` 은
 *     **정상 가격**이다 (D-25).
 *   - 깊이 초과 **422** `BOM_MAX_LEVEL_EXCEEDED` · 순환 **422**
 *     `BOM_CYCLE_DETECTED` · 하위 유효 BOM 2건 이상 **409**
 *     `BOM_EFFECTIVE_CONFLICT` · 대표 공급조건 2건 이상 **409**
 *     `BOM_SUPPLIER_SELECTION_CONFLICT` · 가격 chain 2건 이상 **409**
 *     `SUPPLIER_PRICE_CHAIN_CONFLICT`. ⛔ 손상을 provisional 로 숨기거나 부분
 *     응답으로 돌려주지 않는다.
 *   - 없는 BOM 은 **404**, UUID 형식 오류는 **400**.
 *   - 권한은 `bom.read`(A·L·S·F·**E**). generic `/api/boms` GET 정책이 그대로
 *     적용되므로 route-policy 항목을 새로 만들지 않는다. ⛔ `bom.cost` 를
 *     신설하지 않고 supplier 계열 permission 도 요구하지 않는다 (D-15).
 *   - ⛔ read-only — write 0 · AuditLog 0 · 멱등 계약 없음 · lock 없음.
 *
 * 규칙 전문은 `docs/18_설계복구_BOM.md` §D-14·§D-19~§D-27 ·
 * `★ T07-7A cost boundary and quantity gap closure` ·
 * `★ T07-7A direct cost arithmetic gap closure` ·
 * `★ T07-7B multi-level roll-up gap closure`.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: RouteContext<'/api/boms/[id]/cost'>,
): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const query = parseCostBomQuery(new URL(request.url).searchParams);
      const { id } = await context.params;
      const result = await costBom(actor, id, query);

      // ★ `CostResult` 는 `requestId` 를 **body 안에** 갖는다 (D-14) —
      //   explode 의 직접 배열 계약과 다르다. 두 endpoint 는 DTO 가 다르다.
      return NextResponse.json(
        { ...result, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/boms/[id]/cost' },
  );
}
