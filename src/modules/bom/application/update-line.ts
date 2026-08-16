import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';

import {
  assertComponentEligible,
  assertNotSelfComponent,
  assertQuantityConsistency,
  assertUomMatchesBase,
} from '../domain';
import { withBomCycleGraphLock } from '../infrastructure/cycle-graph-lock';

import { translateBomLineWriteError } from './constraint-errors';
import { type BomMutateDependencies } from './create-bom';
import { BOM_LINE_ENTITY_TYPE } from './create-line';
import { assertNoBomCycleForCandidate } from './cycle-graph';
import { normalizeAlternateGroup, parseBomId, parseBomLineId, type UpdateLineInput } from './dto';
import { assertBomEditable } from './editability';
import { lockBomHeaderRow, lockSkuRows } from './locks';
import { BOM_UPDATE_PERMISSION } from './policy';
import { bomLineNotFound, bomNotFound, loadBomSkuRef } from './refs';
import { BOM_LINE_VIEW_INCLUDE, toBomLineView, type BomLineView } from './views';

/**
 * `PATCH /api/boms/{id}/lines/{lineId}` — BOM 라인 수정 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-14(UpdateLineDto) · §D-6 · §D-9 ~ §D-13
 *    · §D-28 · §D-16.
 *
 * ⚠️ **2차 권한 가드** `bom.update`. ⛔ ADMIN bypass 없음.
 *
 * ## nested ownership — 소속이 다르면 **404**
 *
 * `lineId` 가 존재해도 다른 BOM 의 라인이면 이 경로에서는 없는 것이다.
 * ⛔ 403 이나 "다른 BOM 소속" 응답으로 타 BOM 의 존재를 드러내지 않는다.
 *
 * ## ★ `componentSkuId` 변경은 topology 를 바꾼다
 *
 * D-14 의 `UpdateLineDto` 는 `lineNo` 만 제외했으므로 `componentSkuId` 는
 * **변경 가능**하다. 따라서:
 *
 *   - **old component 와 new component 를 모두** 결정적 순서로 잠근다
 *   - tentative UPDATE 이후 상태로 cycle 을 다시 본다
 *
 * ⛔ `bomHeaderId` 변경(라인 이동)은 DTO 가 400 으로 막는다.
 *
 * ## lock 순서 (D-28)
 *
 * advisory lock → bom_header row lock → sku row lock(id ASC) →
 * status 재확인 → 검증 → tentative UPDATE → graph read → DFS → audit → commit.
 *
 * ## no-op
 *
 * 실질 변경 0이면 DB write 0 · AuditLog 0 · cycle 검사도 하지 않는다
 * (그래프가 바뀌지 않았으므로 재검사할 것이 없다).
 */

type Normalized = string | number | boolean | null;

function currentValueOf(field: keyof UpdateLineInput, view: BomLineView): Normalized {
  switch (field) {
    case 'componentSkuId':
      return view.componentSkuId;
    case 'quantityPer':
      return view.quantityPer;
    case 'quantityStatus':
      return view.quantityStatus;
    case 'uom':
      return view.uom;
    case 'lossRate':
      return view.lossRate;
    case 'componentRole':
      return view.componentRole;
    case 'supplyType':
      return view.supplyType;
    case 'alternateGroup':
      return view.alternateGroup;
    case 'isRequired':
      return view.isRequired;
    case 'issueWarehouseId':
      return view.issueWarehouseId;
    case 'packQuantity':
      return view.packQuantity;
    case 'specification':
      return view.specification;
    case 'note':
      return view.note;
  }
}

/** ⛔ `Number()` 로 비교하지 않는다 — 후행 0 만 정리해 문자열로 비교한다. */
function sameDecimalText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const strip = (value: string): string =>
    value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return strip(a) === strip(b);
}

const PATCHABLE = [
  'componentSkuId',
  'quantityPer',
  'quantityStatus',
  'uom',
  'lossRate',
  'componentRole',
  'supplyType',
  'alternateGroup',
  'isRequired',
  'issueWarehouseId',
  'packQuantity',
  'specification',
  'note',
] as const satisfies readonly (keyof UpdateLineInput)[];

const DECIMAL_FIELDS = new Set<keyof UpdateLineInput>(['quantityPer', 'lossRate', 'packQuantity']);

async function performUpdateLine(
  tx: TransactionClient,
  actor: ActorContext,
  bomId: string,
  lineId: string,
  patch: UpdateLineInput,
  logger: AuditLogger,
): Promise<BomLineView> {
  await lockBomHeaderRow(tx, bomId);

  const header = await tx.bomHeader.findUnique({
    where: { id: bomId },
    select: { id: true, parentSkuId: true, status: true, effectiveFrom: true },
  });
  if (header === null) throw bomNotFound(bomId);
  assertBomEditable(bomId, header.status);

  // ★ 소속 확인은 `bomHeaderId` 를 조건에 포함해서 한다 — 다른 BOM 의 라인은 404.
  const currentRow = await tx.bomLine.findFirst({
    where: { id: lineId, bomHeaderId: bomId },
    include: BOM_LINE_VIEW_INCLUDE,
  });
  if (currentRow === null) throw bomLineNotFound(bomId, lineId);

  const before = toBomLineView(currentRow);

  // old·new component 를 모두 잠근다 (id ASC 는 헬퍼가 보장).
  await lockSkuRows(tx, [
    header.parentSkuId,
    before.componentSkuId,
    ...(patch.componentSkuId === undefined ? [] : [patch.componentSkuId]),
  ]);

  const data: Record<string, unknown> = {};
  for (const field of PATCHABLE) {
    const next = patch[field];
    if (next === undefined) continue;
    const currentValue = currentValueOf(field, before);
    // ★ blank → null 최종 방어선 (D-3) — 비교도 정규화 후에 한다.
    if (field === 'alternateGroup') {
      const normalized = normalizeAlternateGroup(next as string | null);
      if (normalized === currentValue) continue;
      data[field] = normalized;
      continue;
    }
    if (DECIMAL_FIELDS.has(field)) {
      if (sameDecimalText(next as string | null, currentValue as string | null)) continue;
    } else if (next === currentValue) {
      continue;
    }
    data[field] = next;
  }

  // ★ no-op — DB write 0 / AuditLog 0 / cycle 검사 없음.
  if (Object.keys(data).length === 0) return before;

  const nextComponentSkuId =
    (data['componentSkuId'] as string | undefined) ?? before.componentSkuId;

  if ('componentSkuId' in data) {
    assertNotSelfComponent({
      parentSkuId: header.parentSkuId,
      componentSkuId: nextComponentSkuId,
      lineNo: before.lineNo,
    });
  }

  const component = await loadBomSkuRef(tx, nextComponentSkuId);
  if ('componentSkuId' in data) {
    assertComponentEligible({
      skuId: component.id,
      status: component.status,
      lineNo: before.lineNo,
    });
  }

  // D-11 — 구성품이 바뀌면 기존 uom 이 새 baseUom 과 맞아야 한다. uom 을 함께
  // 주지 않았다면 새 구성품의 baseUom 으로 서버가 맞춘다(생략 시 채우기 규칙).
  const requestedUom = data['uom'] as string | undefined;
  if (requestedUom !== undefined) {
    assertUomMatchesBase({
      uom: requestedUom,
      baseUom: component.baseUom,
      skuId: component.id,
      lineNo: before.lineNo,
    });
  } else if ('componentSkuId' in data && before.uom !== component.baseUom) {
    data['uom'] = component.baseUom;
  }

  // D-10 — 변경 **후** 조합으로 정합을 본다 (한쪽만 바뀌는 PATCH 를 놓치지 않는다).
  const nextStatus = (data['quantityStatus'] as string | undefined) ?? before.quantityStatus;
  const nextQty =
    'quantityPer' in data ? (data['quantityPer'] as string | null) : before.quantityPer;
  assertQuantityConsistency({
    quantityPer: nextQty,
    quantityStatus: nextStatus as 'CONFIRMED' | 'SUGGESTED' | 'UNKNOWN',
    lineNo: before.lineNo,
  });

  let updated;
  try {
    updated = await tx.bomLine.update({
      where: { id: lineId },
      data,
      include: BOM_LINE_VIEW_INCLUDE,
    });
  } catch (error) {
    translateBomLineWriteError(error, before.lineNo);
  }

  // ★ topology 가 바뀐 경우에만 그래프를 다시 본다 — UPDATE **이후** 상태로.
  if ('componentSkuId' in data) {
    const afterLines = await tx.bomLine.findMany({
      where: { bomHeaderId: bomId },
      select: { componentSkuId: true },
      orderBy: [{ lineNo: 'asc' }],
    });
    await assertNoBomCycleForCandidate(tx, {
      candidate: {
        parentSkuId: header.parentSkuId,
        componentSkuIds: afterLines.map((line) => line.componentSkuId),
        bomHeaderId: bomId,
      },
      evaluationDate: header.effectiveFrom,
    });
  }

  const after = toBomLineView(updated);

  await logger.write(tx, {
    actor,
    entityType: BOM_LINE_ENTITY_TYPE,
    entityId: lineId,
    action: 'UPDATE',
    beforeValue: before,
    afterValue: after,
  });

  return after;
}

export async function updateBomLine(
  actor: ActorContext,
  rawBomId: string,
  rawLineId: string,
  patch: UpdateLineInput,
  dependencies: BomMutateDependencies = {},
): Promise<BomLineView> {
  assertPermission(actor, BOM_UPDATE_PERMISSION);
  const bomId = parseBomId(rawBomId);
  const lineId = parseBomLineId(rawLineId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) =>
    withBomCycleGraphLock(tx, () => performUpdateLine(tx, actor, bomId, lineId, patch, logger)),
  );
}
