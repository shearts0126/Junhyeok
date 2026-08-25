import type { Prisma } from '@/generated/prisma/client';
import { toDecimalString } from '@/shared/decimal';

import { toDateOnlyString } from './dto';

/**
 * BOM 외부 표현 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-14(`BomDetail`·`BomLineView`) · §D-2·§D-9.
 *
 * ⚠️ Decimal 은 **문자열**로 직렬화한다 — `Number()` 변환 금지.
 * ⚠️ `@db.Date` 는 `YYYY-MM-DD`, `@db.Timestamptz` 는 ISO 8601 이다.
 *    date-only 를 timestamp 로 왜곡하면 timezone 에 따라 하루가 밀린다.
 * ⚠️ `destinationWarehouseId`·`issueWarehouseId` 는 **UUID 를 그대로** 낸다 —
 *    이름 join 없음 (T08 미착수, D-31·D-32).
 * ⛔ Prisma relation 객체를 통째로 노출하지 않는다 — 최소 projection 만 낸다.
 * ⛔ 원가·전개 결과를 여기 섞지 않는다 (각 endpoint 담당, D-14).
 */

export interface SkuRefView {
  readonly id: string;
  readonly skuCode: string;
  readonly skuName: string;
}

export interface ComponentSkuRefView extends SkuRefView {
  readonly baseUom: string;
}

export interface SupplierRefView {
  readonly id: string;
  readonly supplierCode: string;
  readonly supplierName: string;
}

/** `BomLine` scalar **18개 전부** + 구성품 최소 projection (D-14). */
export interface BomLineView {
  readonly id: string;
  readonly bomHeaderId: string;
  readonly lineNo: number;
  readonly componentSkuId: string;
  readonly quantityPer: string | null;
  readonly quantityStatus: string;
  readonly uom: string;
  readonly lossRate: string | null;
  readonly componentRole: string;
  readonly supplyType: string | null;
  readonly alternateGroup: string | null;
  readonly isRequired: boolean;
  readonly issueWarehouseId: string | null;
  readonly packQuantity: string | null;
  readonly specification: string | null;
  readonly legacyBomCode: string | null;
  readonly legacyCommonBomCode: string | null;
  readonly note: string | null;
  readonly componentSku: ComponentSkuRefView;
}

export const BOM_LINE_VIEW_INCLUDE = {
  componentSku: { select: { id: true, skuCode: true, skuName: true, baseUom: true } },
} as const satisfies Prisma.BomLineInclude;

export type BomLineRow = Prisma.BomLineGetPayload<{ include: typeof BOM_LINE_VIEW_INCLUDE }>;

export function toBomLineView(row: BomLineRow): BomLineView {
  return {
    id: row.id,
    bomHeaderId: row.bomHeaderId,
    lineNo: row.lineNo,
    componentSkuId: row.componentSkuId,
    quantityPer: row.quantityPer === null ? null : toDecimalString(row.quantityPer),
    quantityStatus: row.quantityStatus,
    uom: row.uom,
    lossRate: row.lossRate === null ? null : toDecimalString(row.lossRate),
    componentRole: row.componentRole,
    supplyType: row.supplyType,
    alternateGroup: row.alternateGroup,
    isRequired: row.isRequired,
    issueWarehouseId: row.issueWarehouseId,
    packQuantity: row.packQuantity === null ? null : toDecimalString(row.packQuantity),
    specification: row.specification,
    legacyBomCode: row.legacyBomCode,
    legacyCommonBomCode: row.legacyCommonBomCode,
    note: row.note,
    componentSku: {
      id: row.componentSku.id,
      skuCode: row.componentSku.skuCode,
      skuName: row.componentSku.skuName,
      baseUom: row.componentSku.baseUom,
    },
  };
}

/** 헤더 표현 — 목록(`lines` 없음)과 상세가 같은 필드를 공유한다 (D-14). */
export interface BomHeaderView {
  readonly id: string;
  readonly parentSkuId: string;
  readonly parentSku: SkuRefView;
  readonly bomType: string;
  readonly version: string;
  readonly status: string;
  readonly outputQty: string;
  readonly outputUom: string;
  /** `YYYY-MM-DD` */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly productionPartnerId: string | null;
  readonly productionPartner: SupplierRefView | null;
  /** ★ 이름 join 없음 — staged scalar 그대로 (D-31·D-32). */
  readonly destinationWarehouseId: string | null;
  readonly overallLossRate: string | null;
  readonly description: string | null;
  readonly changeReason: string | null;
  /** ISO 8601 */
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly activatedAt: string | null;
  /** 진행률 바용 (D-14·D-31). */
  readonly lineCount: number;
  /** `quantityStatus ≠ CONFIRMED` 인 라인 수 — "확정 N / 전체 M" 의 여집합. */
  readonly unconfirmedCount: number;
}

export interface BomDetailView extends BomHeaderView {
  readonly lines: readonly BomLineView[];
}

/**
 * 목록 `기준원가` cell (T07-8 U8-10 · R8-3).
 *
 * ★ **판별 union** 이다 — "원가가 없다/미확정" 과 "계산 자체가 불가능" 을 절대
 *   같은 것으로 취급하지 않는다.
 *
 * | 상황 | status |
 * |---|---|
 * | 가격 없음 · 수량 미확정 | `AVAILABLE` + `isProvisional = true` |
 * | 실제 0원 | `AVAILABLE` |
 * | 순환 · chain 충돌 등 무결성 오류 | **`UNAVAILABLE`** + `errorCode` |
 *
 * ⛔ 단일 `totalCost` 없음 · ⛔ FX 환산 0 · ⛔ VAT normalize 0.
 * ⛔ `referenceCost` 자체를 `null` 로 만들지 않는다.
 */
export type BomReferenceCostView =
  | {
      readonly status: 'AVAILABLE';
      /** 이 원가를 계산한 기준일 (`effectiveOn ?? 업무일자`). */
      readonly asOf: string;
      /** KRW subtotal 을 `vatIncluded` 별로 **분리 보존**한다 (D-27). */
      readonly krwSubtotals: readonly {
        readonly vatIncluded: boolean;
        readonly amount: string;
      }[];
      /** 계산 가능한 비KRW subtotal 이 있으면 `true` → UI 는 `+` 표식 (D-26). */
      readonly hasOtherCurrency: boolean;
      /** `true` 면 `잠정` 배지. 금액이 partial known sum 이어도 표시는 유지한다. */
      readonly isProvisional: boolean;
    }
  | {
      readonly status: 'UNAVAILABLE';
      readonly asOf: string;
      /** ★ exact 7-code whitelist 중 하나 (R8-6). */
      readonly errorCode: string;
    };

/**
 * 목록 item (T07-8 U8-5).
 *
 * `BomHeaderView` + 목록 전용 파생값 2개. ⛔ 이것 때문에 `BomDetailView` 를
 * 확장하지 않는다 — 상세는 원가·전개를 섞지 않는다 (D-14).
 */
export interface BomListItemView extends BomHeaderView {
  /** ★ schema 컬럼이 아니라 **audit 파생값**이다 (U8-1). */
  readonly lastModifiedAt: string;
  readonly referenceCost: BomReferenceCostView;
}

export const BOM_HEADER_VIEW_INCLUDE = {
  parentSku: { select: { id: true, skuCode: true, skuName: true } },
  productionPartner: { select: { id: true, supplierCode: true, supplierName: true } },
} as const satisfies Prisma.BomHeaderInclude;

export type BomHeaderRow = Prisma.BomHeaderGetPayload<{ include: typeof BOM_HEADER_VIEW_INCLUDE }>;

export interface BomLineCounts {
  readonly lineCount: number;
  readonly unconfirmedCount: number;
}

export function toBomHeaderView(row: BomHeaderRow, counts: BomLineCounts): BomHeaderView {
  return {
    id: row.id,
    parentSkuId: row.parentSkuId,
    parentSku: {
      id: row.parentSku.id,
      skuCode: row.parentSku.skuCode,
      skuName: row.parentSku.skuName,
    },
    bomType: row.bomType,
    version: row.version,
    status: row.status,
    outputQty: toDecimalString(row.outputQty),
    outputUom: row.outputUom,
    effectiveFrom: toDateOnlyString(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : toDateOnlyString(row.effectiveTo),
    productionPartnerId: row.productionPartnerId,
    productionPartner:
      row.productionPartner === null
        ? null
        : {
            id: row.productionPartner.id,
            supplierCode: row.productionPartner.supplierCode,
            supplierName: row.productionPartner.supplierName,
          },
    destinationWarehouseId: row.destinationWarehouseId,
    overallLossRate: row.overallLossRate === null ? null : toDecimalString(row.overallLossRate),
    description: row.description,
    changeReason: row.changeReason,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
    approvedBy: row.approvedBy,
    activatedAt: row.activatedAt === null ? null : row.activatedAt.toISOString(),
    lineCount: counts.lineCount,
    unconfirmedCount: counts.unconfirmedCount,
  };
}

export function toBomDetailView(row: BomHeaderRow, lines: readonly BomLineRow[]): BomDetailView {
  return {
    ...toBomHeaderView(row, countsOf(lines)),
    lines: lines.map(toBomLineView),
  };
}

/** `unconfirmedCount` = `quantityStatus ≠ CONFIRMED` (D-10 어휘 · D-31 진행률 바). */
export function countsOf(lines: readonly { readonly quantityStatus: string }[]): BomLineCounts {
  return {
    lineCount: lines.length,
    unconfirmedCount: lines.filter((line) => line.quantityStatus !== 'CONFIRMED').length,
  };
}

/**
 * `GET /api/skus/{id}/where-used` 의 한 행 — **line 하나가 한 행**이다 (D-30).
 *
 * ★ 같은 BOM 에 같은 SKU 가 대체그룹만 달리해 여러 line 으로 들어가면 **행이
 *   여러 개** 나온다. 소요량(`quantityPer`)은 line 단위 사실이라 header 단위로
 *   접으면 표현할 수 없기 때문이다(D-30 ⑦탭 "상위 SKU · 버전 · 상태 · 소요량").
 * ⛔ "최신 1건" 같은 임의 선택을 하지 않는다.
 */
export interface BomWhereUsedView {
  readonly bomHeaderId: string;
  readonly parentSkuId: string;
  readonly parentSku: SkuRefView;
  readonly bomType: string;
  readonly version: string;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly lineId: string;
  readonly lineNo: number;
  readonly quantityPer: string | null;
  readonly quantityStatus: string;
  readonly uom: string;
  readonly componentRole: string;
  readonly isRequired: boolean;
  readonly alternateGroup: string | null;
}

export const WHERE_USED_INCLUDE = {
  bomHeader: {
    include: { parentSku: { select: { id: true, skuCode: true, skuName: true } } },
  },
} as const satisfies Prisma.BomLineInclude;

export type WhereUsedRow = Prisma.BomLineGetPayload<{ include: typeof WHERE_USED_INCLUDE }>;

export function toWhereUsedView(row: WhereUsedRow): BomWhereUsedView {
  const header = row.bomHeader;
  return {
    bomHeaderId: header.id,
    parentSkuId: header.parentSkuId,
    parentSku: {
      id: header.parentSku.id,
      skuCode: header.parentSku.skuCode,
      skuName: header.parentSku.skuName,
    },
    bomType: header.bomType,
    version: header.version,
    status: header.status,
    effectiveFrom: toDateOnlyString(header.effectiveFrom),
    effectiveTo: header.effectiveTo === null ? null : toDateOnlyString(header.effectiveTo),
    lineId: row.id,
    lineNo: row.lineNo,
    quantityPer: row.quantityPer === null ? null : toDecimalString(row.quantityPer),
    quantityStatus: row.quantityStatus,
    uom: row.uom,
    componentRole: row.componentRole,
    isRequired: row.isRequired,
    alternateGroup: row.alternateGroup,
  };
}

// ═══════════════════════════════════════════════════════════════
// ExplodedNode — GET /api/boms/{id}/explode (T07-6)
// ═══════════════════════════════════════════════════════════════

/**
 * 전개 결과 한 행 = **한 구성품 라인** (D-14 · D-18).
 *
 * ⚠️ 정본은 `docs/18` `★ T07-6 explosion quantity gap closure` 다 — D-14 의
 *    `requiredQty: string` 은 그 절이 `string | null` 로 **SUPERSEDE** 했다.
 *
 * **exact 12 필드.** ⛔ 다음을 추가하지 않는다: `bomLineId` · `version` ·
 * `alternateGroup` · `isRequired` · `isQuantityUnknown` · `isProvisional` ·
 * `provisionalReasons` · `rawRequiredQty` · `calculationStatus`.
 *
 * | 필드 | 의미 |
 * |---|---|
 * | `level` | root SKU 를 `0` 으로 세는 깊이. **root 직접 구성품 = 1** |
 * | `path` | **조상 skuId 배열**(자기 자신 제외). `path.length === level` |
 * | `bomHeaderId` | 이 구성품을 **전개한 하위 BOM**. leaf 면 `null` |
 * | `requiredQty` | D-19 로 계산한 누적 소요량. 미상이면 `null` (E-1·E-2) |
 * | `isLeaf` | **수량과 무관** — asOf 유효 ACTIVE BOM 이 없으면 `true` (E-3) |
 *
 * ⛔ root `BomHeader` 자체는 node 가 아니다 — `componentRole`·`quantityStatus`
 *    같은 라인 사실이 header 에 없기 때문이며, 배열은 root 의 **직접 구성품**부터
 *    시작한다.
 */
export interface ExplodedNodeView {
  readonly level: number;
  readonly path: readonly string[];
  readonly bomHeaderId: string | null;
  readonly componentSkuId: string;
  readonly componentSku: ComponentSkuRefView;
  readonly componentRole: string;
  readonly quantityPer: string | null;
  readonly lossRate: string | null;
  readonly requiredQty: string | null;
  readonly uom: string;
  readonly isLeaf: boolean;
  readonly quantityStatus: string;
}

/** 전개가 읽는 라인 — 라인 사실 + **소속 header 의 수량 계수**를 함께 읽는다. */
export const EXPLODE_LINE_INCLUDE = {
  componentSku: { select: { id: true, skuCode: true, skuName: true, baseUom: true } },
  bomHeader: { select: { id: true, outputQty: true, overallLossRate: true } },
} as const satisfies Prisma.BomLineInclude;

export type ExplodeLineRow = Prisma.BomLineGetPayload<{ include: typeof EXPLODE_LINE_INCLUDE }>;
