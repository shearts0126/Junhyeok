import type { SupplierSku } from '@/generated/prisma/client';
import { ConflictError, ERROR_CODES } from '@/shared/errors';

import type { SupplierDbClient } from './refs';
import { toDateOnly } from './views';

/**
 * asOf 대표 공급조건 resolver (T07-7A · `docs/18` §D-23).
 *
 * REST route 전용이 아니다 — BOM 원가(T07-7A/B)가 소비하며 permission 과 무관한
 * **순수 selection resolver** 다. 책임은 `skuId → primary SupplierSku` 까지이고
 * 가격은 `resolveEffectiveSupplierPrices`(D-24)의 몫이다.
 *
 * predicate (half-open `[from, to)`):
 *
 * ```
 *   skuId = :componentSkuId
 *   AND isPrimary = true
 *   AND effectiveFrom <= asOf
 *   AND (effectiveTo IS NULL OR asOf < effectiveTo)
 * ```
 *
 * | candidate | 결과 |
 * |---|---|
 * | 0건 | **`null`** — 오류가 아니라 `NO_PRIMARY_SUPPLIER` provisional 상태다. ⛔ 0원 대체 금지 |
 * | 1건 | 그 행 |
 * | **2건 이상** | **409 `BOM_SUPPLIER_SELECTION_CONFLICT`** — 데이터 손상 |
 *
 * ## ⛔ `LIMIT 1` 을 쓰지 않는 이유
 *
 * partial UNIQUE `ux_supplier_sku_primary_current` 는 **`effective_to IS NULL`
 * 인 행만** 덮는다. 과거 asOf 를 조회하면 이미 종료된 대표 행이 여럿 걸릴 수
 * 있으므로 **2건 이상 분기가 실제로 필요하다.** 하나를 골라 숨기면 손상이
 * 조용히 원가에 반영된다.
 *
 * ## ⛔ `Supplier.status` 로 자동 필터링하지 않는다
 *
 * 근거가 없고, 거래처가 `INACTIVE` 라도 **과거 시점 원가는 그 거래처 가격으로
 * 계산되는 것이 맞다** (D-23).
 *
 * ## ⛔ `listSkuSupplierSummaries`(T1-6B4)를 재사용하지 않는다
 *
 * 그쪽은 "현재 유효 공급조건 **전부** 나열"하는 UI 요약이라 이 선택 문제를
 * 풀지 않는다. D-23 이 별도 resolver 를 두라고 명시한다.
 *
 * ## asOf 는 caller 가 확정한다
 *
 * ⛔ `new Date()` 를 호출하지 않는다 — 한 request 안에서 effective BOM ·
 *    SupplierSku · Price 가 **같은 asOf** 를 써야 하기 때문이다 (§D-21).
 */

/** resolver 가 돌려주는 행. 가격은 별도 resolver 가 붙인다. */
export type PrimarySupplierSkuRow = SupplierSku;

export interface ResolvePrimarySupplierSkuInput {
  readonly skuId: string;
  /** UTC 자정 date-only `Date`. */
  readonly asOf: Date;
}

export interface ResolvePrimarySupplierSkusInput {
  /** ★ 한 요청 안에서는 **모든 id 가 같은 asOf** 를 쓴다 (§D-21). */
  readonly skuIds: readonly string[];
  readonly asOf: Date;
}

export function bomSupplierSelectionConflict(context: {
  readonly skuId: string;
  readonly asOf: string;
  readonly candidateIds: readonly string[];
}): ConflictError {
  return new ConflictError(ERROR_CODES.BOM_SUPPLIER_SELECTION_CONFLICT, {
    message: `같은 기준일에 대표 공급조건이 2건 이상입니다 — 공급처 선택이 손상되었습니다.`,
    context: { ...context, candidateIds: [...context.candidateIds] },
    publicDetails: { candidateCount: context.candidateIds.length },
  });
}

/**
 * 여러 SKU 의 asOf 대표 공급조건을 **DB 조회 1회**로 해결한다.
 *
 * ⛔ id 마다 단건 resolver 를 반복 호출하지 않는다 — N+1 을 만들지 않기 위해 이
 *    함수가 존재한다. 반환 Map 에는 **입력 id 전부가 key 로 존재**하며 대표가
 *    없는 id 도 `null` 로 담긴다(호출부에서 `has` 검사 불필요).
 *
 * @throws 409 `BOM_SUPPLIER_SELECTION_CONFLICT` — 어느 한 SKU 라도 후보가 2건
 *         이상이면. 부분 성공으로 숨기지 않는다.
 */
export async function resolvePrimarySupplierSkus(
  db: SupplierDbClient,
  input: ResolvePrimarySupplierSkusInput,
): Promise<Map<string, PrimarySupplierSkuRow | null>> {
  const outcomes = await resolvePrimarySupplierSkuOutcomes(db, input);
  const result = new Map<string, PrimarySupplierSkuRow | null>();
  // ★ 삽입 순서 순회 — 기존과 정확히 같은 오류가 먼저 던져진다.
  for (const [skuId, outcome] of outcomes) {
    if (outcome.status === 'ERROR') throw outcome.error;
    result.set(skuId, outcome.value);
  }
  return result;
}

/** key 하나의 대표 공급조건 해석 결과. `ERROR` 는 오직 대표 2건 이상이다. */
export type PrimarySupplierSkuOutcome =
  | { readonly status: 'OK'; readonly value: PrimarySupplierSkuRow | null }
  | { readonly status: 'ERROR'; readonly error: ConflictError };

/**
 * ★ **T07-8 — key 별 outcome low-level batch reader** (R8-8).
 *
 * strict `resolvePrimarySupplierSkus` 는 이것을 감싸 첫 ERROR 에서 throw 하므로
 * 기존 동작이 바뀌지 않는다. 목록 read-model 만 ERROR 를 root 로 fan-out 한다.
 */
export async function resolvePrimarySupplierSkuOutcomes(
  db: SupplierDbClient,
  input: ResolvePrimarySupplierSkusInput,
): Promise<Map<string, PrimarySupplierSkuOutcome>> {
  const ids = [...new Set(input.skuIds)];
  const result = new Map<string, PrimarySupplierSkuOutcome>(
    ids.map((id) => [id, { status: 'OK', value: null } as PrimarySupplierSkuOutcome]),
  );
  if (ids.length === 0) return result;

  // ★ IN (...) 한 번 — SKU 별 top-1 을 SQL 로 자르지 않는다. 잘라 버리면 2건
  //   이상(손상)을 발견할 수 없다. ⛔ Supplier.status 를 where 에 넣지 않는다.
  const rows = await db.supplierSku.findMany({
    where: {
      skuId: { in: ids },
      isPrimary: true,
      effectiveFrom: { lte: input.asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.asOf } }],
    },
    // 결정성만 확보한다 — 선택은 아래 판정이 하므로 정렬에 의존하지 않는다.
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  });

  const grouped = new Map<string, PrimarySupplierSkuRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.skuId);
    if (bucket === undefined) grouped.set(row.skuId, [row]);
    else bucket.push(row);
  }

  const asOfLabel = toDateOnly(input.asOf);
  for (const [skuId, candidates] of grouped) {
    if (candidates.length >= 2) {
      result.set(skuId, {
        status: 'ERROR',
        error: bomSupplierSelectionConflict({
          skuId,
          asOf: asOfLabel,
          candidateIds: candidates.map((row) => row.id),
        }),
      });
      continue;
    }
    result.set(skuId, { status: 'OK', value: candidates[0] ?? null });
  }

  return result;
}

/** 단건 — batch 의 1-id wrapper 다. 외부 동작(반환·오류·predicate)이 동일하다. */
export async function resolvePrimarySupplierSku(
  db: SupplierDbClient,
  input: ResolvePrimarySupplierSkuInput,
): Promise<PrimarySupplierSkuRow | null> {
  const resolved = await resolvePrimarySupplierSkus(db, {
    skuIds: [input.skuId],
    asOf: input.asOf,
  });
  return resolved.get(input.skuId) ?? null;
}
