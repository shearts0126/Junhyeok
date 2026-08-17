import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';

import { assertUomMatchesBase } from '../domain';
import { withBomCycleGraphLock } from '../infrastructure/cycle-graph-lock';

import { translateBomHeaderWriteError } from './constraint-errors';
import { BOM_HEADER_ENTITY_TYPE, type BomMutateDependencies } from './create-bom';
import { assertNoBomCycleForCandidate } from './cycle-graph';
import {
  assertPeriodOrder,
  parseBomId,
  parseDateOnly,
  toDateOnlyString,
  type UpdateBomInput,
} from './dto';
import { assertBomEditable } from './editability';
import { lockBomHeaderRow } from './locks';
import { BOM_UPDATE_PERMISSION } from './policy';
import { assertProductionPartnerExists, bomNotFound, loadBomSkuRef } from './refs';
import { BOM_HEADER_VIEW_INCLUDE, toBomHeaderView, type BomHeaderView } from './views';

/**
 * `PATCH /api/boms/{id}` — BOM 헤더 수정 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-14(UpdateBomDto) · §D-6(편집 가능 상태)
 *    · §D-13(effectiveFrom 변경 시 cycle 재검사) · §D-28(lock order) · §D-16.
 *
 * ⚠️ **2차 권한 가드** `bom.update`. ⛔ ADMIN bypass 없음.
 *
 * ## 편집 가능 상태 (D-6)
 *
 * `DRAFT`·`REJECTED` 만 허용. `ACTIVE` 는 **422 `BOM_ACTIVE_IMMUTABLE`**,
 * 그 밖(`PENDING_APPROVAL`·`APPROVED`·`INACTIVE`·`ARCHIVED`)은 422
 * `BOM_NOT_EDITABLE`. ⛔ generic `status` PATCH 는 DTO 가 400 으로 막는다.
 *
 * ## ★ `effectiveFrom` 변경은 cycle 재검사 대상이다 (D-13)
 *
 * evaluation date 가 바뀌면 **sibling 선택이 통째로 달라진다** — 어제까지
 * 순환이 아니던 구성이 새 기준일에서는 순환일 수 있다. 그래서 이 경우에만
 * 그래프 lock 을 잡고 다음 순서를 지킨다:
 *
 * ```
 * 1. transaction
 * 2. pg_advisory_xact_lock(BOM_CYCLE_GRAPH)     ← graph read 이전
 * 3. bom_header row lock
 * 4. status 재확인 (lock 이후)
 * 5. tentative UPDATE                            ← 변경 후 상태로 검사한다
 * 6. 변경 후 effectiveFrom 을 evaluation date 로 graph 구성
 * 7. DFS — 순환이면 throw → 트랜잭션 전체 rollback (effectiveFrom 원복)
 * 8. Audit UPDATE
 * 9. commit
 * ```
 *
 * ⛔ graph 를 먼저 읽고 나중에 잠그지 않는다.
 * ★ graph semantics 를 바꾸지 않는 필드만 수정하면 **lock 을 잡지 않는다**
 *   (§D-28 은 cycle-affecting mutation 만 대상으로 한다). `parentSkuId` 는
 *   DTO 가 변경을 막으므로 graph-affecting 필드는 `effectiveFrom` 하나뿐이다.
 *
 * ## no-op
 *
 * 실질 변경이 0이면 **DB write 0 · AuditLog 0** 으로 현재 표현을 그대로
 * 돌려준다(기존 SKU·매핑·거래처 convention). `BomHeader` 에 `updatedAt` 이
 * 없으므로 touch write 자체를 만들지 않는다.
 */

/** 값 비교 전 정규화 — Date/Decimal 을 문자열로 맞춘다. */
type Normalized = string | number | boolean | null;

function normalizeCurrent(
  field: keyof UpdateBomInput,
  row: {
    bomType: string;
    outputQty: unknown;
    outputUom: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    productionPartnerId: string | null;
    destinationWarehouseId: string | null;
    overallLossRate: unknown;
    description: string | null;
    changeReason: string | null;
  },
  view: BomHeaderView,
): Normalized {
  switch (field) {
    case 'bomType':
      return row.bomType;
    case 'outputQty':
      return view.outputQty;
    case 'outputUom':
      return row.outputUom;
    case 'effectiveFrom':
      return toDateOnlyString(row.effectiveFrom);
    case 'effectiveTo':
      return row.effectiveTo === null ? null : toDateOnlyString(row.effectiveTo);
    case 'productionPartnerId':
      return row.productionPartnerId;
    case 'destinationWarehouseId':
      return row.destinationWarehouseId;
    case 'overallLossRate':
      return view.overallLossRate;
    case 'description':
      return row.description;
    case 'changeReason':
      return row.changeReason;
  }
}

/**
 * Decimal 은 문자열 표현이 달라도 같은 값일 수 있다(`"1"` vs `"1.000000"`).
 * ⛔ `Number()` 로 비교하지 않는다 — 후행 0 만 정리해 문자열로 비교한다.
 */
function sameDecimalText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const strip = (value: string): string =>
    value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return strip(a) === strip(b);
}

const PATCHABLE = [
  'bomType',
  'outputQty',
  'outputUom',
  'effectiveFrom',
  'effectiveTo',
  'productionPartnerId',
  'destinationWarehouseId',
  'overallLossRate',
  'description',
  'changeReason',
] as const satisfies readonly (keyof UpdateBomInput)[];

const DECIMAL_FIELDS = new Set<keyof UpdateBomInput>(['outputQty', 'overallLossRate']);

async function performUpdate(
  tx: TransactionClient,
  actor: ActorContext,
  bomId: string,
  patch: UpdateBomInput,
  logger: AuditLogger,
): Promise<BomHeaderView> {
  await lockBomHeaderRow(tx, bomId);

  const current = await tx.bomHeader.findUnique({
    where: { id: bomId },
    include: BOM_HEADER_VIEW_INCLUDE,
  });
  if (current === null) throw bomNotFound(bomId);

  // ★ lock 이후 재확인 — 동시 activate 와의 경합을 여기서 확정한다.
  assertBomEditable(bomId, current.status);

  const lineRows = await tx.bomLine.findMany({
    where: { bomHeaderId: bomId },
    select: { componentSkuId: true, quantityStatus: true, lineNo: true },
    orderBy: [{ lineNo: 'asc' }],
  });
  const counts = {
    lineCount: lineRows.length,
    unconfirmedCount: lineRows.filter((line) => line.quantityStatus !== 'CONFIRMED').length,
  };
  const before = toBomHeaderView(current, counts);

  const data: Record<string, unknown> = {};
  for (const field of PATCHABLE) {
    const next = patch[field];
    if (next === undefined) continue;
    const currentValue = normalizeCurrent(field, current, before);
    if (DECIMAL_FIELDS.has(field)) {
      if (sameDecimalText(next as string | null, currentValue as string | null)) continue;
    } else if (next === currentValue) {
      continue;
    }
    data[field] =
      field === 'effectiveFrom' || field === 'effectiveTo'
        ? next === null
          ? null
          : parseDateOnly(next as string)
        : next;
  }

  // ★ no-op — DB write 0 / AuditLog 0.
  if (Object.keys(data).length === 0) return before;

  // 변경 **후** 값으로 기간 순서를 다시 본다 — 한쪽만 바뀌는 PATCH 를 놓치지 않는다.
  const nextFrom = patch.effectiveFrom ?? before.effectiveFrom;
  const nextTo = patch.effectiveTo === undefined ? before.effectiveTo : patch.effectiveTo;
  assertPeriodOrder(nextFrom, nextTo);

  if (patch.outputUom !== undefined && 'outputUom' in data) {
    const parent = await loadBomSkuRef(tx, current.parentSkuId);
    assertUomMatchesBase({
      uom: patch.outputUom,
      baseUom: parent.baseUom,
      skuId: current.parentSkuId,
    });
  }
  if ('productionPartnerId' in data && data['productionPartnerId'] !== null) {
    await assertProductionPartnerExists(tx, data['productionPartnerId'] as string);
  }

  let updated;
  try {
    updated = await tx.bomHeader.update({
      where: { id: bomId },
      data,
      include: BOM_HEADER_VIEW_INCLUDE,
    });
  } catch (error) {
    translateBomHeaderWriteError(error, current.version);
  }

  // ★ D-13 — evaluation date 가 바뀌었으면 **변경 후 상태로** 순환을 다시 본다.
  //   실패하면 트랜잭션 전체가 롤백되어 effectiveFrom 도 원복된다.
  if ('effectiveFrom' in data) {
    await assertNoBomCycleForCandidate(tx, {
      candidate: {
        parentSkuId: current.parentSkuId,
        componentSkuIds: lineRows.map((line) => line.componentSkuId),
        bomHeaderId: bomId,
      },
      evaluationDate: data['effectiveFrom'] as Date,
    });
  }

  const after = toBomHeaderView(updated, counts);

  await logger.write(tx, {
    actor,
    entityType: BOM_HEADER_ENTITY_TYPE,
    entityId: bomId,
    action: 'UPDATE',
    beforeValue: before,
    afterValue: after,
  });

  return after;
}

export async function updateBom(
  actor: ActorContext,
  rawBomId: string,
  patch: UpdateBomInput,
  dependencies: BomMutateDependencies = {},
): Promise<BomHeaderView> {
  assertPermission(actor, BOM_UPDATE_PERMISSION);
  const bomId = parseBomId(rawBomId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  // graph semantics 를 바꾸는 필드는 `effectiveFrom` 하나다 (parentSkuId 는
  // DTO 가 변경을 막는다). 그 경우에만 전역 graph lock 을 잡는다.
  const affectsGraph = patch.effectiveFrom !== undefined;

  return run(async (tx) => {
    if (!affectsGraph) return performUpdate(tx, actor, bomId, patch, logger);
    // ★ advisory lock 을 **가장 먼저** — graph read 이전이다 (D-28).
    return withBomCycleGraphLock(tx, () => performUpdate(tx, actor, bomId, patch, logger));
  });
}
