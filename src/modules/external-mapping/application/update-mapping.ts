import { auditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction } from '@/shared/db';

import { translateMappingWriteError } from './constraint-errors';
import type { MappingMutateDependencies } from './create-mapping';
import { EXTERNAL_MAPPING_ENTITY_TYPE } from './create-mapping';
import { parseExternalMappingId, type UpdateMappingInput } from './dto';
import { mappingEnded, primaryMustBeClearedBeforeEnd, resolveEffectiveTo } from './effective-date';
import { normalizeIdentifiers } from './normalize';
import { EXTERNAL_MAPPING_UPDATE_PERMISSION } from './policy';
import { findMapping } from './refs';
import {
  deriveMappingStatus,
  MAPPING_STATUS_MATCHED,
  MAPPING_STATUS_UNMATCHED,
  primaryRequiresMatched,
  unmatchedNotInteractive,
} from './status';
import {
  EXTERNAL_MAPPING_VIEW_INCLUDE,
  toExternalMappingView,
  type ExternalMappingView,
} from './views';

/**
 * `PATCH /api/external-mappings/{id}` — 외부 매핑 수정 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §2·§4·§6·§8·§9·§10.
 *
 * ⚠️ **2차 권한 가드.** `external_mapping.update` 를 재검사한다. ADMIN bypass 없음.
 *
 * ## identifier 를 고칠 수 있다 — 원문 gap 을 메운 부분
 *
 * 원 PATCH DTO 는 `{mappingStatus?, isPrimary?, effectiveTo?}` 뿐이라
 * `REVIEW_REQUIRED → MATCHED`("외부코드·바코드 확보 시에만", `05:344`)로 갈
 * 경로가 없었다. V1 은 identifier 3종을 PATCH 대상으로 열고, **상태는
 * prospective state 에서 서버가 파생**한다 — client 가 `mappingStatus` 를
 * 보내지 않는다(보내면 400).
 *
 *   REVIEW_REQUIRED + `{externalProductCode:'P001'}`      → MATCHED
 *   MATCHED        + `{externalProductCode:null, externalBarcode:null}` → REVIEW_REQUIRED
 *   식별자 전부 제거                                        → 422, 행 변경 없음
 *
 * ## 대표 지정에 숨은 side effect 가 없다
 *
 * `isPrimary=true` 로 바꿀 때 기존 대표를 **자동으로 내리지 않는다.**
 * `ux_external_mapping_primary` 가 409 `EXTERNAL_MAPPING_PRIMARY_CONFLICT` 를
 * 만들고, 사용자가 기존 대표를 명시적으로 해제한 뒤 다시 지정해야 한다.
 *
 * ## 변화 없음
 *
 * 요청 결과가 현재 값과 완전히 같으면 **DB UPDATE 도 AuditLog 도 만들지 않고**
 * 현재 행을 200 으로 돌려준다 (`SkuExternalMapping` 에는 `updatedAt` 도 없다).
 *
 * ⛔ `skuId`·`externalSystemId` 는 identity 라 immutable (DTO 가 400).
 * ⛔ `warehouseId`·`effectiveFrom`·`mappingStatus` 도 입력 대상이 아니다.
 * ⛔ 어떤 경로로도 `Sku.skuName` 을 갱신하지 않는다 — 외부 별칭일 뿐이다.
 */

export async function updateExternalMapping(
  actor: ActorContext,
  rawMappingId: string,
  patch: UpdateMappingInput,
  dependencies: MappingMutateDependencies = {},
  now: Date = new Date(),
): Promise<ExternalMappingView> {
  assertPermission(actor, EXTERNAL_MAPPING_UPDATE_PERMISSION);
  const mappingId = parseExternalMappingId(rawMappingId);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  // ★ 정규화는 순수 함수다 — 422 는 트랜잭션 밖에서 끝난다.
  const identifiers = normalizeIdentifiers(patch);

  return run(async (tx) => {
    const current = await findMapping(tx, mappingId);
    const before = toExternalMappingView(current);

    // ★ ingestion 계층이 의미를 확정하기 전까지 interactive API 는 손대지 않는다.
    if (current.mappingStatus === MAPPING_STATUS_UNMATCHED)
      throw unmatchedNotInteractive(mappingId);

    // ★ 종료된 매핑은 이력이다 — mutable 하게 만들지 않는다.
    if (current.effectiveTo !== null) throw mappingEnded(mappingId, current.effectiveTo);

    const nextCode =
      identifiers.externalProductCode === undefined
        ? current.externalProductCode
        : identifiers.externalProductCode;
    const nextName =
      identifiers.externalProductName === undefined
        ? current.externalProductName
        : identifiers.externalProductName;
    const nextBarcode =
      identifiers.externalBarcode === undefined
        ? current.externalBarcode
        : identifiers.externalBarcode;
    const nextNote = patch.note === undefined ? current.note : patch.note;
    const nextIsPrimary = patch.isPrimary ?? current.isPrimary;

    // ★ prospective state 로 파생 — 식별자가 전부 사라지면 422 (행 변경 없음).
    const nextStatus = deriveMappingStatus({
      externalProductCode: nextCode,
      externalProductName: nextName,
      externalBarcode: nextBarcode,
    });

    if (nextIsPrimary && nextStatus !== MAPPING_STATUS_MATCHED) throw primaryRequiresMatched();

    let nextEffectiveTo: Date | null = current.effectiveTo;
    if (patch.effectiveTo !== undefined) {
      // ★ 대표 매핑 종료는 primary 해제를 **명시적으로** 함께 요구한다 —
      //   자동으로 내려주면 숨은 side effect 이고, 내리지 않으면 종료된 대표가
      //   그 (SKU, 시스템) 조합의 새 대표를 영구히 막는다.
      if (current.isPrimary && patch.isPrimary !== false) {
        throw primaryMustBeClearedBeforeEnd(mappingId);
      }
      nextEffectiveTo = resolveEffectiveTo(patch.effectiveTo, current.effectiveFrom, now);
    }

    // ★ no-op — write 도 감사로그도 만들지 않는다.
    if (
      nextCode === current.externalProductCode &&
      nextName === current.externalProductName &&
      nextBarcode === current.externalBarcode &&
      nextNote === current.note &&
      nextIsPrimary === current.isPrimary &&
      nextStatus === current.mappingStatus &&
      nextEffectiveTo === current.effectiveTo
    ) {
      return before;
    }

    let updated;
    try {
      updated = await tx.skuExternalMapping.update({
        where: { id: mappingId },
        data: {
          externalProductCode: nextCode,
          externalProductName: nextName,
          externalBarcode: nextBarcode,
          note: nextNote,
          isPrimary: nextIsPrimary,
          mappingStatus: nextStatus,
          effectiveTo: nextEffectiveTo,
        },
        include: EXTERNAL_MAPPING_VIEW_INCLUDE,
      });
    } catch (error) {
      translateMappingWriteError(error, {
        skuId: current.skuId,
        externalSystemId: current.externalSystemId,
        externalProductCode: nextCode,
      });
    }

    const after = toExternalMappingView(updated);

    // ★ 매핑 해제(effectiveTo 설정)도 V1 에서는 `UPDATE` 다 —
    //   `UNMAP`·`DEACTIVATE` 같은 신규 action 을 발명하지 않는다.
    await logger.write(tx, {
      actor,
      entityType: EXTERNAL_MAPPING_ENTITY_TYPE,
      entityId: mappingId,
      action: 'UPDATE',
      beforeValue: before,
      afterValue: after,
    });

    return after;
  });
}
