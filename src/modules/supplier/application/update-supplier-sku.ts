import { Prisma } from '@/generated/prisma/client';
import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';

import { supplierSkuVersionDateInvalid, translateSupplierSkuWriteError } from './constraint-errors';
import { SUPPLIER_SKU_ENTITY_TYPE, type SupplierMutateDependencies } from './create-supplier';
import { assertValidPeriod } from './create-supplier-sku';
import {
  parseDateOnly,
  parseSupplierSkuId,
  type CloseSupplierSkuInput,
  type UpdateSupplierSkuInput,
  type VersionSupplierSkuInput,
} from './dto';
import { SUPPLIER_UPDATE_PERMISSION } from './policy';
import { supplierSkuNotFound } from './refs';
import { SUPPLIER_SKU_VIEW_INCLUDE, toSupplierSkuView, type SupplierSkuView } from './views';

/**
 * `PATCH /api/supplier-skus/{id}` — 공급조건 종료 · 버전 생성 (T06-2, D-15·D-16).
 *
 * ⚠️ **2차 권한 가드.** `supplier.update` 를 재검사한다. ADMIN bypass 없음.
 *
 * 공급조건은 effective-dated history 다 — business term 을 **제자리에서 덮어쓰지
 * 않는다.** 과거·현재·미래 어느 row 에도 같은 temporal rule 이 적용된다 (D-16).
 *
 * ## mode A — 종료 (body 정확히 `{effectiveTo}`)
 *
 *   - `effectiveTo > effectiveFrom` (아니면 422 EFFECTIVE_PERIOD_INVALID)
 *   - open-ended → 종료 가능 / 기존 종료일 **앞당기기** 가능
 *   - 기존 종료일 **연장 금지** · `null` reopen 금지 (DTO 가 400)
 *   - 같은 값이면 no-op — 200 현재 행 / DB write 0 / Audit 0
 *   - AuditLog: 기존 row `UPDATE` 1건
 *
 * ## mode B — 새 버전 (body 에 `effectiveFrom` + 실질 변경)
 *
 *   같은 트랜잭션 안에서 **반드시 이 순서**로 (D-27·§30):
 *
 *     ① target row lock (SELECT … FOR UPDATE)
 *     ② 기존 row `effectiveTo = newEffectiveFrom` 로 close   ← 먼저
 *     ③ 후속 version INSERT                                   ← 나중
 *     ④ Audit: 기존 UPDATE + 신규 CREATE (정확히 2건)
 *
 *   new-first 로 하면 old row 가 아직 열려 있어 EXCLUDE overlap ·
 *   현행 대표 partial UNIQUE 와 자기충돌한다.
 *
 *   - `newEffectiveFrom > existing.effectiveFrom` (아니면 422 VERSION_DATE_INVALID)
 *   - 기존 종료일이 있으면 `newEffectiveFrom < existing.effectiveTo`
 *   - omitted field 는 기존 row 값 복사 / 명시 필드는 새 값 (`null` 포함)
 *   - successor `effectiveTo` — 명시되면 그 값, 생략되면 기존 row 의 **원래**
 *     `effectiveTo` 상속
 * ⛔ `supplierId`·`skuId` identity 와 기존 row 의 원래 `effectiveFrom` 은
 *    바꾸지 않는다.
 *
 * ## 동시성
 *
 * target row 를 `FOR UPDATE` 로 잠근다 — 같은 row 를 동시에 versioning 하는
 * 두 요청은 직렬화되고, 뒤진 쪽은 변경된 기간에 대한 422/409 로 끝난다.
 * EXCLUDE·partial UNIQUE 는 언제나 최종 방어선이다.
 */

async function lockSupplierSkuRow(tx: TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM supplier_sku WHERE id = ${id}::uuid FOR UPDATE`;
}

type SupplierSkuRecord = Prisma.SupplierSkuGetPayload<{
  include: typeof SUPPLIER_SKU_VIEW_INCLUDE;
}>;

async function findRow(tx: TransactionClient, id: string): Promise<SupplierSkuRecord> {
  const row = await tx.supplierSku.findUnique({
    where: { id },
    include: SUPPLIER_SKU_VIEW_INCLUDE,
  });
  if (row === null) throw supplierSkuNotFound(id);
  return row;
}

async function performClose(
  tx: TransactionClient,
  actor: ActorContext,
  current: SupplierSkuRecord,
  input: CloseSupplierSkuInput,
  logger: AuditLogger,
): Promise<SupplierSkuView> {
  const before = toSupplierSkuView(current);
  const nextTo = parseDateOnly(input.effectiveTo);

  // [from, to) — 시작일과 같거나 이르면 길이 0 이하 구간이다.
  assertValidPeriod(current.effectiveFrom, nextTo);

  if (current.effectiveTo !== null) {
    if (nextTo.getTime() > current.effectiveTo.getTime()) {
      throw supplierSkuVersionDateInvalid(
        '이미 종료된 공급조건의 종료일은 연장할 수 없습니다 — 앞당기기만 가능합니다. ' +
          '기간을 늘리려면 새 버전을 만드세요.',
      );
    }
    if (nextTo.getTime() === current.effectiveTo.getTime()) {
      // 같은 값 — 실질 변화 없음. DB write 0 / Audit 0.
      return before;
    }
  }

  const updated = await tx.supplierSku.update({
    where: { id: current.id },
    data: { effectiveTo: nextTo },
    include: SUPPLIER_SKU_VIEW_INCLUDE,
  });
  const after = toSupplierSkuView(updated);

  await logger.write(tx, {
    actor,
    entityType: SUPPLIER_SKU_ENTITY_TYPE,
    entityId: current.id,
    action: 'UPDATE',
    beforeValue: before,
    afterValue: after,
  });

  return after;
}

async function performVersion(
  tx: TransactionClient,
  actor: ActorContext,
  current: SupplierSkuRecord,
  input: VersionSupplierSkuInput,
  logger: AuditLogger,
): Promise<SupplierSkuView> {
  const before = toSupplierSkuView(current);
  const newFrom = parseDateOnly(input.effectiveFrom);

  if (newFrom.getTime() <= current.effectiveFrom.getTime()) {
    throw supplierSkuVersionDateInvalid(
      '새 버전의 시작일은 기존 공급조건의 시작일보다 늦어야 합니다.',
    );
  }
  if (current.effectiveTo !== null && newFrom.getTime() >= current.effectiveTo.getTime()) {
    throw supplierSkuVersionDateInvalid(
      '새 버전의 시작일은 기존 공급조건의 종료 경계일보다 앞서야 합니다.',
    );
  }

  // successor 종료일 — 명시되면 그 값, 생략되면 기존 row 의 **원래** 종료일 상속.
  const successorTo =
    input.effectiveTo === undefined
      ? current.effectiveTo
      : input.effectiveTo === null
        ? null
        : parseDateOnly(input.effectiveTo);
  assertValidPeriod(newFrom, successorTo);

  // ── ② old close 가 먼저다 — new-first 는 EXCLUDE·primary 와 자기충돌한다 ──
  const closed = await tx.supplierSku.update({
    where: { id: current.id },
    data: { effectiveTo: newFrom },
    include: SUPPLIER_SKU_VIEW_INCLUDE,
  });

  // ── ③ successor INSERT — omitted 는 복사, supplied 는 새 값 ──────────────
  // `??` 를 쓰지 않는다 — 명시적 null(값 제거)과 undefined(미변경)를 구분해야 한다.
  const pick = <T, U>(supplied: T | undefined, inherited: U): T | U =>
    supplied === undefined ? inherited : supplied;

  let successor: SupplierSkuRecord;
  try {
    successor = await tx.supplierSku.create({
      data: {
        // ★ identity 는 기존 값 그대로 (D-15).
        supplierId: current.supplierId,
        skuId: current.skuId,
        effectiveFrom: newFrom,
        effectiveTo: successorTo,
        supplierSkuCode: pick(input.supplierSkuCode, current.supplierSkuCode),
        supplierSkuName: pick(input.supplierSkuName, current.supplierSkuName),
        supplyType: pick(input.supplyType, current.supplyType),
        moq: pick<string | null, Prisma.Decimal | null>(input.moq, current.moq),
        orderMultiple: pick<string | null, Prisma.Decimal | null>(
          input.orderMultiple,
          current.orderMultiple,
        ),
        leadTimeDays: pick(input.leadTimeDays, current.leadTimeDays),
        purchaseUom: pick(input.purchaseUom, current.purchaseUom),
        currency: pick(input.currency, current.currency),
        isPrimary: pick(input.isPrimary, current.isPrimary),
        // destinationWarehouseId 는 staged — API 대상이 아니며 복사하지 않는다
        // (현재 API 로는 항상 null 이다).
      },
      include: SUPPLIER_SKU_VIEW_INCLUDE,
    });
  } catch (error) {
    translateSupplierSkuWriteError(error);
  }

  const closedView = toSupplierSkuView(closed);
  const successorView = toSupplierSkuView(successor);

  // ── ④ Audit 정확히 2건 — 같은 business transaction ───────────────────────
  await logger.write(tx, {
    actor,
    entityType: SUPPLIER_SKU_ENTITY_TYPE,
    entityId: current.id,
    action: 'UPDATE',
    beforeValue: before,
    afterValue: closedView,
  });
  await logger.write(tx, {
    actor,
    entityType: SUPPLIER_SKU_ENTITY_TYPE,
    entityId: successor.id,
    action: 'CREATE',
    beforeValue: null,
    afterValue: successorView,
  });

  // ★ 응답은 후속 version row 다.
  return successorView;
}

export async function updateSupplierSku(
  actor: ActorContext,
  rawSupplierSkuId: string,
  patch: UpdateSupplierSkuInput,
  dependencies: SupplierMutateDependencies = {},
): Promise<SupplierSkuView> {
  assertPermission(actor, SUPPLIER_UPDATE_PERMISSION);
  const supplierSkuId = parseSupplierSkuId(rawSupplierSkuId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    // ① lock 이 조회보다 먼저 — lock 해제 후 최신 상태를 읽어야 판정이 정확하다.
    await lockSupplierSkuRow(tx, supplierSkuId);
    const current = await findRow(tx, supplierSkuId);

    return patch.mode === 'close'
      ? performClose(tx, actor, current, patch.input, logger)
      : performVersion(tx, actor, current, patch.input, logger);
  });
}
