import type { PrismaClient } from '@/generated/prisma/client';
import type { TransactionClient } from '@/shared/db';
import { DomainError, ERROR_CODES } from '@/shared/errors';

import type { PostingCommandPayload } from './posting-command';

/**
 * Posting 참조 데이터 로드 + 검증 ② (T2-5).
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.2 ②
 *    (*"참조 무결성 — SKU/창고/로케이션/채널 존재·활성"*) · §8.12
 *    `const refs = await this.loadReferences(cmd)` / `assertAllExistAndUsable(refs)`.
 *
 * ## read-only 다
 *
 * ⛔ 여기서 DB 에 쓰지 않는다. `$transaction` 도 열지 않는다.
 * ⛔ `InventoryTransaction`·`InventoryLedgerEntry`·`InventoryBalance`·
 *    `AuditLog` 에 접근하지 않는다 — 원장·잔고는 `eslint-rules/inventory-boundary.ts`
 *    가 `src/modules/inventory/infrastructure/**` 로 제한하며, Phase-1 검증은
 *    그 테이블을 읽을 이유가 없다.
 *
 * ## 미존재는 generic `NOT_FOUND` 다
 *
 * ★ `SKU_NOT_FOUND` 를 만들지 않는다. `docs/19 §W-D34` 가 `WAREHOUSE_NOT_FOUND`
 *   전용 코드를 명시적으로 거부했고, BOM 의 `productionPartnerNotFound()` 도
 *   같은 방식이다(`src/shared/errors/codes.ts:113` 주석). `docs/04 §8.2` 의
 *   `SKU_NOT_FOUND` 는 `docs/05 §10.18` 오류 카탈로그에 등재되어 있지 않다.
 *
 * ★ 반면 `WAREHOUSE_INACTIVE` 는 "존재하지만 업무규칙상 쓸 수 없다" 이므로
 *   404 도 400 도 아닌 **422** 다 (`SKU_ACTIVE_UPDATE_RESTRICTED` 와 같은 결).
 *
 * ## 채널은 여기 없다
 *
 * ⛔ `channelId` 를 이 파일에서 검증하지 않는다 — `Channel` 모델이 없고,
 *    `InventoryLedgerEntry.channelId` 가 `common_code.id` 를 가리킨다는
 *    authoritative relation 문장도 없다. 채널 검증은 `ports.ts` 의 port 다.
 */

// ═══════════════════════════════════════════════════════════════
// 좁힌 read client
// ═══════════════════════════════════════════════════════════════

/**
 * Phase-1 이 읽는 모델은 **정확히 3개**다.
 *
 * ⛔ 넓히지 않는다 — 넓히는 순간 Phase-1 이 무엇을 읽는지 타입으로 알 수 없게
 *    되고, 재고 테이블 접근 경로가 열린다.
 */
export type PostingReadClient = Pick<PrismaClient, 'sku' | 'warehouse' | 'warehouseLocation'>;

export type PostingDbClient = PostingReadClient | TransactionClient;

// ═══════════════════════════════════════════════════════════════
// 참조 뷰
// ═══════════════════════════════════════════════════════════════

/**
 * SKU 참조.
 *
 * ⛔ `lotManaged`·`expiryManaged`·`serialManaged`·`minimumRemainingDays` 를
 *    싣지 않는다 — 검증 ⑦ 은 **T2-8** 소유이며, 그 task 가 필요한 열을 select
 *    에 추가한다. 쓰지 않을 값을 미리 실어 두지 않는다.
 * ⛔ `status` 도 싣지 않는다 — SKU lifecycle 규칙(`ACTIVE`/`DISCONTINUED`
 *    출고전용)은 `docs/04` v0.1 §8.2 에만 있고 **v0.2 §8.2 에서는 해당 칸이
 *    비어 있다**. 정본이 정하지 않은 것을 허용으로도 금지로도 고정하지 않는다.
 */
export interface PostingSkuRef {
  readonly id: string;
  readonly inventoryManaged: boolean;
}

/**
 * 창고 참조.
 *
 * ★ `defaultLocationId` 를 반드시 싣는다 — `docs/04 §8.12` 의
 *   `normalizeStockKey(e, refs)` 가 `refs` 로부터 default 로케이션을 얻는다.
 *   그 **치환 자체는 T2-6 소유**이고, T2-5 는 재료만 준비한다.
 */
export interface PostingWarehouseRef {
  readonly id: string;
  readonly active: boolean;
  readonly defaultLocationId: string;
}

/** 로케이션 참조. `(warehouseId, id)` 조합이 곧 정합성이다. */
export interface PostingLocationRef {
  readonly id: string;
  readonly warehouseId: string;
}

/** 검증 ②가 확인해야 할 `(창고, 로케이션)` 조합. */
export interface PostingLocationKey {
  readonly warehouseId: string;
  readonly locationId: string;
}

/**
 * `loadReferences()` 의 반환.
 *
 * 요청된 id 목록을 함께 들고 있다 — `docs/04 §8.12` 의
 * `assertAllExistAndUsable(refs)` 가 **refs 하나만** 받기 때문이다.
 *
 * ⛔ 새 도메인 개념을 붙이지 않는다. `normalizedEntries`·`groups`·
 *    `transactionNo`·`balance`·`ledger`·`exceptions` 어느 것도 여기 없다.
 */
export interface PostingReferences {
  /** 요청에 등장한 SKU id (중복 제거). */
  readonly skuIds: readonly string[];
  /** 요청에 등장한 창고 id (중복 제거). */
  readonly warehouseIds: readonly string[];
  /** 요청이 **명시한** `(창고, 로케이션)` 조합 (중복 제거). */
  readonly locationKeys: readonly PostingLocationKey[];

  sku(skuId: string): PostingSkuRef | undefined;
  warehouse(warehouseId: string): PostingWarehouseRef | undefined;
  location(warehouseId: string, locationId: string): PostingLocationRef | undefined;
}

// ═══════════════════════════════════════════════════════════════
// 오류
// ═══════════════════════════════════════════════════════════════

export function skuRefNotFound(skuId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `SKU '${skuId}' 이(가) 없습니다.`,
    context: { skuId },
  });
}

export function warehouseRefNotFound(warehouseId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `창고 '${warehouseId}' 이(가) 없습니다.`,
    context: { warehouseId },
  });
}

/**
 * 로케이션 미존재 **또는 다른 창고 소속**.
 *
 * ★ 두 경우를 구분해 알리지 않는다 — 요청자 입장에서는 "이 창고에 그 로케이션이
 *   없다" 로 동일하며, 존재 여부를 창고 넘어 노출하지 않는 편이 안전하다.
 *   `InventoryLedgerEntry` 의 `(warehouseId, locationId)` composite FK 와 같은
 *   불변식을 application 단에서 미리 확인하는 것이다.
 */
export function locationRefNotFound(warehouseId: string, locationId: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `창고 '${warehouseId}' 에 로케이션 '${locationId}' 이(가) 없습니다.`,
    context: { warehouseId, locationId },
  });
}

/** 존재하지만 비활성인 창고 — 업무규칙 거부이므로 **422** 다. */
export function warehouseInactive(warehouseId: string): DomainError {
  return new DomainError(ERROR_CODES.WAREHOUSE_INACTIVE, {
    message: `창고 '${warehouseId}' 은(는) 비활성 상태입니다.`,
    publicDetails: { warehouseId },
    publicHint: '활성 창고를 지정하거나 창고를 다시 활성화한 뒤 진행하세요.',
  });
}

// ═══════════════════════════════════════════════════════════════
// ② 로드
// ═══════════════════════════════════════════════════════════════

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * 검증 ② 전반 — 참조 데이터를 **한 번에** 읽는다 (`docs/04:529`).
 *
 * ★ entry 수만큼 질의하지 않는다. `docs/04 §8.0` 의 *"짧은 트랜잭션 — 검증에
 *   필요한 참조 데이터는 트랜잭션 진입 전에 로드한다"* 원칙이며, 여기서는
 *   트랜잭션 자체가 없으므로 더더욱 왕복을 줄인다.
 *
 * ⛔ `locationId` 가 없는 entry 는 조회 대상에 넣지 않는다 — 그 entry 의
 *    로케이션은 `warehouse.defaultLocationId` 로 **T2-6 이** 정한다.
 */
export async function loadReferences(
  db: PostingDbClient,
  command: PostingCommandPayload,
): Promise<PostingReferences> {
  const skuIds = uniqueStrings(command.entries.map((entry) => entry.skuId));
  const warehouseIds = uniqueStrings(command.entries.map((entry) => entry.warehouseId));

  const locationKeys: PostingLocationKey[] = [];
  const seenLocationKeys = new Set<string>();
  for (const entry of command.entries) {
    if (entry.locationId === undefined) continue;
    const key = `${entry.warehouseId} ${entry.locationId}`;
    if (seenLocationKeys.has(key)) continue;
    seenLocationKeys.add(key);
    locationKeys.push({ warehouseId: entry.warehouseId, locationId: entry.locationId });
  }

  const [skuRows, warehouseRows, locationRows] = await Promise.all([
    db.sku.findMany({
      where: { id: { in: skuIds } },
      select: { id: true, inventoryManaged: true },
    }),
    db.warehouse.findMany({
      where: { id: { in: warehouseIds } },
      select: { id: true, active: true, defaultLocationId: true },
    }),
    locationKeys.length === 0
      ? Promise.resolve([])
      : db.warehouseLocation.findMany({
          where: {
            OR: locationKeys.map((key) => ({ warehouseId: key.warehouseId, id: key.locationId })),
          },
          select: { id: true, warehouseId: true },
        }),
  ]);

  const skus = new Map(skuRows.map((row) => [row.id, row satisfies PostingSkuRef]));
  const warehouses = new Map(
    warehouseRows.map((row) => [row.id, row satisfies PostingWarehouseRef]),
  );
  const locations = new Map(
    locationRows.map((row) => [`${row.warehouseId} ${row.id}`, row satisfies PostingLocationRef]),
  );

  return {
    skuIds,
    warehouseIds,
    locationKeys,
    sku: (skuId) => skus.get(skuId),
    warehouse: (warehouseId) => warehouses.get(warehouseId),
    location: (warehouseId, locationId) => locations.get(`${warehouseId} ${locationId}`),
  };
}

/**
 * 검증 ② 후반 — 로드된 참조가 전부 존재하고 사용 가능한가 (`docs/04:530`).
 *
 * ```
 * SKU 존재                       → NOT_FOUND (404)
 * 창고 존재                       → NOT_FOUND (404)
 * 창고 active                     → WAREHOUSE_INACTIVE (422)
 * locationId 제공 시 존재·소속     → NOT_FOUND (404)
 * locationId 미제공               → 검사 대상 없음 (T2-6 이 default 로 치환)
 * ```
 *
 * ★ `Warehouse.active` 는 `prisma/schema.prisma:1205` 에 **실재한다**.
 *   `docs/19 §W-D27` 이 유예한 것은 `true↔false` **mutation** 과 `PATCH active`
 *   이지 컬럼을 읽는 것이 아니다 — *"`active` 컬럼은 T08-1 schema 에 **존재**
 *   하고 신규 창고는 항상 `true` 다"*.
 *
 * ⛔ 채널은 여기서 보지 않는다 (port).
 * ⛔ SKU lifecycle status 는 여기서 보지 않는다 (v0.2 미기재).
 *
 * @throws {DomainError} `NOT_FOUND`(404) · `WAREHOUSE_INACTIVE`(422)
 */
export function assertAllExistAndUsable(refs: PostingReferences): void {
  for (const skuId of refs.skuIds) {
    if (refs.sku(skuId) === undefined) throw skuRefNotFound(skuId);
  }

  for (const warehouseId of refs.warehouseIds) {
    const warehouse = refs.warehouse(warehouseId);
    if (warehouse === undefined) throw warehouseRefNotFound(warehouseId);
    if (!warehouse.active) throw warehouseInactive(warehouseId);
  }

  for (const key of refs.locationKeys) {
    if (refs.location(key.warehouseId, key.locationId) === undefined) {
      throw locationRefNotFound(key.warehouseId, key.locationId);
    }
  }
}
