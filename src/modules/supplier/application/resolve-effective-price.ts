import type { ConflictError } from '@/shared/errors';

import { supplierPriceChainConflict } from './constraint-errors';
import type { SupplierSkuPriceRow } from './price-views';
import type { SupplierDbClient } from './refs';
import { toDateOnly } from './views';

/**
 * asOf 유효가격 resolver (T06-3 D-22·D-23 · T1-6B4 D-26 batch 확장).
 *
 * REST route 전용 logic 이 아니다 — T1-6B4 공급조건 요약이 이 함수를 쓰고,
 * 향후 T07 BOM cost/explode 도 같은 규칙을 쓴다. 책임은
 * `supplierSkuId → price` 까지다 — SKU → primary SupplierSku 선택은 범위 밖이다.
 *
 * predicate (half-open `[from, to)` 유지):
 *
 *   approvedBy IS NOT NULL
 *   AND effectiveFrom <= asOf
 *   AND (effectiveTo IS NULL OR asOf < effectiveTo)
 *
 * ★ **pending(미승인) 가격은 절대 잡히지 않는다** — 발효는 승인 시점이다.
 * ★ 한 supplierSkuId 에 candidate 가 2건 이상이면 chain 손상이므로
 *   `ORDER BY … LIMIT 1` 로 숨기지 않고 409 `SUPPLIER_PRICE_CHAIN_CONFLICT` 를
 *   던진다 (D-23). 0건은 오류가 아니라 "가격 없음"이다 — 0원 fallback 금지 (D-3).
 *
 * ## 단건 = batch 의 1-id wrapper (T1-6B4 §15)
 *
 * validity semantics 를 **한 군데**로 모으기 위해 단건 resolver 는 batch 를
 * 그대로 호출한다. 외부 동작(반환값·오류·predicate)은 T06-3 과 **한 글자도
 * 다르지 않다**.
 */

export interface ResolveEffectivePriceInput {
  readonly supplierSkuId: string;
  /** UTC 자정 date-only Date — `parseDateOnly`/`parseBusinessDate` 산출값. */
  readonly asOf: Date;
}

export interface ResolveEffectivePricesInput {
  readonly supplierSkuIds: readonly string[];
  /** ★ 한 요청 안에서는 **모든 id 가 같은 asOf** 를 쓴다 (T1-6B4 D-6·D-27). */
  readonly asOf: Date;
}

/**
 * 여러 SupplierSku 의 asOf 유효가격을 **DB 조회 1회**로 해결한다 (D-26).
 *
 * ⛔ id 마다 단건 resolver 를 반복 호출하지 않는다 — N+1 을 만들지 않기 위해
 *    이 함수가 존재한다. 판정 규칙은 단건과 동일하다.
 *
 * 반환은 `Map<supplierSkuId, row | null>` 이며 **입력 id 전부가 key 로 존재**
 * 한다 — 가격이 없는 id 도 `null` 로 담긴다(호출부에서 `has` 검사 불필요).
 *
 * @throws 409 `SUPPLIER_PRICE_CHAIN_CONFLICT` — 어느 한 id 라도 유효 candidate
 *         가 2건 이상이면. 부분 성공으로 숨기지 않는다 (D-18).
 */
export async function resolveEffectiveSupplierPrices(
  db: SupplierDbClient,
  input: ResolveEffectivePricesInput,
): Promise<Map<string, SupplierSkuPriceRow | null>> {
  const outcomes = await resolveEffectiveSupplierPriceOutcomes(db, input);
  const result = new Map<string, SupplierSkuPriceRow | null>();
  // ★ 삽입 순서 순회 — 기존과 정확히 같은 오류가 먼저 던져진다.
  for (const [supplierSkuId, outcome] of outcomes) {
    if (outcome.status === 'ERROR') throw outcome.error;
    result.set(supplierSkuId, outcome.value);
  }
  return result;
}

/** key 하나의 유효가격 해석 결과. `ERROR` 는 오직 chain 2건 이상이다. */
export type EffectiveSupplierPriceOutcome =
  | { readonly status: 'OK'; readonly value: SupplierSkuPriceRow | null }
  | { readonly status: 'ERROR'; readonly error: ConflictError };

/**
 * ★ **T07-8 — key 별 outcome low-level batch reader** (R8-8).
 *
 * strict resolver 는 이것을 감싸 첫 ERROR 에서 throw 하므로 T06-3·T1-6B4·T07-7A/B
 * 의 기존 동작이 바뀌지 않는다. 목록 read-model 만 ERROR 를 root 로 fan-out 한다.
 */
export async function resolveEffectiveSupplierPriceOutcomes(
  db: SupplierDbClient,
  input: ResolveEffectivePricesInput,
): Promise<Map<string, EffectiveSupplierPriceOutcome>> {
  const ids = [...new Set(input.supplierSkuIds)];
  const result = new Map<string, EffectiveSupplierPriceOutcome>(
    ids.map((id) => [id, { status: 'OK', value: null } as EffectiveSupplierPriceOutcome]),
  );
  if (ids.length === 0) return result;

  // ★ IN (...) 한 번 — id 별 top-1 을 SQL 로 자르지 않는다. 잘라 버리면 2건
  //   이상(손상)을 발견할 수 없기 때문이다. 판정은 application 이 한다.
  const rows = await db.supplierSkuPrice.findMany({
    where: {
      supplierSkuId: { in: ids },
      approvedBy: { not: null },
      effectiveFrom: { lte: input.asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.asOf } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  });

  const grouped = new Map<string, SupplierSkuPriceRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.supplierSkuId);
    if (bucket === undefined) grouped.set(row.supplierSkuId, [row]);
    else bucket.push(row);
  }

  for (const [supplierSkuId, candidates] of grouped) {
    if (candidates.length >= 2) {
      result.set(supplierSkuId, {
        status: 'ERROR',
        error: supplierPriceChainConflict({
          supplierSkuId,
          asOf: toDateOnly(input.asOf),
          candidateIds: candidates.map((row) => row.id),
        }),
      });
      continue;
    }
    result.set(supplierSkuId, { status: 'OK', value: candidates[0] ?? null });
  }

  return result;
}

/** 단건 — batch 의 1-id wrapper 다 (§15). 외부 동작은 T06-3 그대로. */
export async function resolveEffectiveSupplierPrice(
  db: SupplierDbClient,
  input: ResolveEffectivePriceInput,
): Promise<SupplierSkuPriceRow | null> {
  const resolved = await resolveEffectiveSupplierPrices(db, {
    supplierSkuIds: [input.supplierSkuId],
    asOf: input.asOf,
  });
  return resolved.get(input.supplierSkuId) ?? null;
}
