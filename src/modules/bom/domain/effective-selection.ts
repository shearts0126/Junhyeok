import { ConflictError, ERROR_CODES } from '@/shared/errors';

/**
 * asOf 유효 BOM **선택 semantics** (T07-2) — 순수 함수. Prisma 를 import 하지 않는다.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-22.
 *
 * DB 조회는 `application/resolve-effective-bom.ts` 가 하고, 이 파일은 **후보
 * 목록에서 하나를 고르는 규칙**만 갖는다. 단건·배치 resolver 가 같은 함수를 쓰기
 * 때문에 선택 규칙이 두 곳으로 갈라지지 않는다.
 *
 * | candidate | 결과 |
 * |---|---|
 * | 0건 | **`null`** — "현재 유효한 BOM 이 없다". 오류가 아니다 |
 * | 1건 | 해당 header |
 * | **2건 이상** | **409 `BOM_EFFECTIVE_CONFLICT`** — 손상이다 |
 *
 * ⛔ `LIMIT 1` / `findFirst` 로 최신 하나를 골라 손상을 숨기지 않는다.
 *    `bom_header_active_period_excl` EXCLUDE 가 있으므로 2건은 정상 경로에서
 *    생길 수 없다 — 생겼다면 드러내야 한다.
 */

export function bomEffectiveConflict(input: {
  readonly parentSkuId: string;
  readonly asOf: string;
  readonly candidateIds: readonly string[];
}): ConflictError {
  return new ConflictError(ERROR_CODES.BOM_EFFECTIVE_CONFLICT, {
    message: `SKU '${input.parentSkuId}' 의 ${input.asOf} 기준 활성 BOM 이 ${input.candidateIds.length}건입니다.`,
    context: { ...input, candidateIds: [...input.candidateIds] },
    publicDetails: { candidateCount: input.candidateIds.length },
    // 데이터 손상이다 — 재시도로 해소되지 않는다.
    retryable: false,
  });
}

/**
 * 후보에서 유효 BOM 하나를 고른다.
 *
 * @throws {ConflictError} `BOM_EFFECTIVE_CONFLICT` — 후보 2건 이상
 */
export function selectEffectiveBom<T extends { readonly id: string }>(
  candidates: readonly T[],
  context: { readonly parentSkuId: string; readonly asOf: string },
): T | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  throw bomEffectiveConflict({
    parentSkuId: context.parentSkuId,
    asOf: context.asOf,
    candidateIds: candidates.map((row) => row.id),
  });
}
