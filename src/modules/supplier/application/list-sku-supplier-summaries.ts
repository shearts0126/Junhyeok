import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { businessDateOf, parseBusinessDate } from '@/shared/business-date';
import { toDecimalString } from '@/shared/decimal';
import { ValidationError } from '@/shared/errors';

import { parseSkuRefId, SUPPLIER_PAGE_SIZE } from './dto';
import { defaultSupplierClient, type SupplierReadDependencies } from './list-suppliers';
import { SUPPLIER_PRICE_READ_PERMISSION, SUPPLIER_READ_PERMISSION } from './policy';
import { skuRefNotFound } from './refs';
import { resolveEffectiveSupplierPrices } from './resolve-effective-price';

/**
 * `GET /api/skus/{id}/supplier-skus` — SKU 상세 ⑥ 공급조건 요약
 * (T1-6B4 supporting API, D-1 ~ D-7).
 *
 * ⚠️ **T1-6B4 전용 read-only supporting API** 다. standalone SupplierSku
 *    management collection API 로 확장하지 않는다 — mutation owner 는 T06-4
 *    `/master/suppliers` 화면이다 (docs/17 §95 D-34·D-35).
 *
 * ## 왜 필요한가
 *
 * SKU → SupplierSku **역조회 경로가 하나도 없었다**. `/api/suppliers/{id}/skus`
 * 는 supplier-centric 이고, `/api/suppliers` 는 `skuId` 를 모르며(미지원
 * 파라미터 400), `/api/supplier-skus` collection route 는 존재하지 않는다.
 * 전 supplier 순회·client N+1 없이 SKU 상세를 만들 수 없어 supporting API 를
 * 정확히 **1개** 추가한다.
 *
 * ## 권한 — 두 capability 를 **모두** 요구한다 (D-3·D-19)
 *
 * 응답에 SupplierSku 정보와 **가격**이 함께 들어가므로
 * `supplier.read` **AND** `supplier_price.read` 다. 현재 role matrix 에서 둘 다
 * A·L·S·F 라는 사실은 우연이며 계약상 별개다 — 하나로 합치지 않는다.
 * proxy(1차)는 경로당 permission 1개라 `supplier.read` 로 잡고, 나머지 하나는
 * 여기 application(2차)에서 본다. ⛔ ADMIN bypass 없음.
 *
 * ## 현재 유효 공급조건만 (D-5)
 *
 * 이 탭은 **history 화면이 아니다** — 과거/미래 이력의 owner 는 T06-4 다.
 *
 *   effectiveFrom <= asOf AND (effectiveTo IS NULL OR asOf < effectiveTo)
 *
 * 종료된 행·미래 시작 행은 제외한다(open-ended 라도 시작이 미래면 제외).
 *
 * ## 업무일자 (D-6·D-27)
 *
 * `asOf` 를 **요청당 한 번** 계산한다(Asia/Seoul). SupplierSku current 판정과
 * recentPrice 판정이 **정확히 같은 값**을 쓴다 — row 마다 `new Date()` 를 다시
 * 부르지 않는다(자정 경계에서 날짜가 갈리지 않게). ⛔ 클라이언트가 `asOf` 를
 * 지정하는 query 를 받지 않는다.
 *
 * ## 가격은 batch 로 (D-15·D-26)
 *
 * 페이지의 supplierSkuId 를 모아 `resolveEffectiveSupplierPrices` 로 **DB 조회
 * 1회**에 해결한다. ⛔ 행마다 단건 resolver 를 반복하지 않는다.
 * 어느 한 행이라도 유효 candidate 가 2건 이상이면 **요청 전체가 409**
 * `SUPPLIER_PRICE_CHAIN_CONFLICT` 다 — 부분 성공으로 숨기지 않는다 (D-18).
 */

// ═══════════════════════════════════════════════════════════════
// 쿼리 — `page` 하나뿐 (D-19)
// ═══════════════════════════════════════════════════════════════

const querySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
});

export type SkuSupplierSummaryQuery = z.infer<typeof querySchema>;

export function parseSkuSupplierSummaryQuery(
  searchParams: URLSearchParams,
): SkuSupplierSummaryQuery {
  const unknownKeys = [...new Set([...searchParams.keys()])].filter((key) => key !== 'page');
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      unknownKeys.map((key) => ({
        path: key,
        message:
          '지원하지 않는 파라미터입니다. (공급조건 요약은 page 만 받습니다 — asOf 는 서버 업무일자로 고정입니다)',
      })),
      { message: '지원하지 않는 목록 파라미터가 있습니다.' },
    );
  }

  const raw: Record<string, string> = {};
  const page = searchParams.get('page');
  if (page !== null) raw['page'] = page;

  const result = querySchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : 'query',
        message: issue.message,
      })),
      { message: '공급조건 요약 쿼리가 올바르지 않습니다.' },
    );
  }
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// View — 전용 축소 projection (D-7)
// ═══════════════════════════════════════════════════════════════

/**
 * ⛔ `SupplierSkuView` 전체를 그대로 내보내지 않는다 — 이 요약에 필요 없는
 *    `orderMultiple`·stored `leadTimeDays`·`purchaseUom`·`currency`·
 *    `effectiveFrom`/`effectiveTo`·`createdAt`·Supplier `status`/`supplierType`
 *    은 노출하지 않는다. 가격도 `unitPrice`·`currency` 둘뿐이다.
 */
export interface SkuSupplierSummaryView {
  readonly id: string;
  readonly supplierId: string;
  readonly supplier: {
    readonly id: string;
    readonly supplierCode: string;
    readonly supplierName: string;
  };
  readonly supplierSkuCode: string | null;
  readonly supplierSkuName: string | null;
  /** Decimal 문자열. `null` = 미입력. ⛔ 숫자 변환 금지. */
  readonly moq: string | null;
  /**
   * **적용** 리드타임 — `leadTimeDays ?? supplier.defaultLeadTimeDays ?? null`.
   * 이 탭은 입력값 관리 화면이 아니라 실제 적용조건 요약이라 derived 값을 쓴다
   * (D-9). `0` 은 즉시납이며 `—` 로 뭉개지 않는다 (G-03).
   */
  readonly effectiveLeadTimeDays: number | null;
  readonly supplyType: string;
  readonly isPrimary: boolean;
  /** asOf 유효 **승인** 가격. 없으면 null — 0원(`"0"`)과 구분한다 (D-17). */
  readonly recentPrice: { readonly unitPrice: string; readonly currency: string } | null;
}

export interface SkuSupplierSummaryResult {
  readonly items: readonly SkuSupplierSummaryView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  /** 이번 요청이 current·recentPrice 판정에 쓴 업무일자 `YYYY-MM-DD`. */
  readonly asOf: string;
}

export interface SkuSupplierSummaryDependencies extends SupplierReadDependencies {
  /** 테스트에서 업무일자를 고정할 때만 주입한다. 운영은 실제 시각이다. */
  readonly now?: Date;
}

export async function listSkuSupplierSummaries(
  actor: ActorContext,
  rawSkuId: string,
  query: SkuSupplierSummaryQuery,
  dependencies: SkuSupplierSummaryDependencies = {},
): Promise<SkuSupplierSummaryResult> {
  // ★ 두 capability 를 모두 본다 — 가격이 응답에 들어가기 때문이다 (D-3).
  assertPermission(actor, SUPPLIER_READ_PERMISSION);
  assertPermission(actor, SUPPLIER_PRICE_READ_PERMISSION);

  const skuId = parseSkuRefId(rawSkuId);
  const db = dependencies.db ?? (await defaultSupplierClient());

  // parent SKU — SKU 상세와 같은 existence 규칙이다 (soft-delete 는 없는 것으로).
  // ⛔ ACTIVE only·purchasable 같은 eligibility 를 발명하지 않는다 (§5).
  const sku = await db.sku.findFirst({
    where: { id: skuId, deletedAt: null },
    select: { id: true },
  });
  if (sku === null) throw skuRefNotFound(skuId);

  // ★ 요청당 한 번 — 이 값 하나로 current·recentPrice 를 모두 판정한다 (D-6).
  const asOfText = businessDateOf(dependencies.now ?? new Date());
  const asOf = parseBusinessDate(asOfText);

  // half-open `[from, to)` — 종료된 행·미래 시작 행을 제외한다 (D-5).
  const where: Prisma.SupplierSkuWhereInput = {
    skuId,
    effectiveFrom: { lte: asOf },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
  };

  const [total, rows] = await Promise.all([
    db.supplierSku.count({ where }),
    db.supplierSku.findMany({
      where,
      // 고정 정렬 (D-20) — ⛔ isPrimary 우선 정렬을 발명하지 않는다.
      orderBy: [{ supplier: { supplierCode: 'asc' } }, { supplierId: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * SUPPLIER_PAGE_SIZE,
      take: SUPPLIER_PAGE_SIZE,
      include: {
        supplier: {
          select: { id: true, supplierCode: true, supplierName: true, defaultLeadTimeDays: true },
        },
      },
    }),
  ]);

  // ★ 이 페이지 전체를 한 번에 — N+1 금지 (D-26).
  const prices = await resolveEffectiveSupplierPrices(db, {
    supplierSkuIds: rows.map((row) => row.id),
    asOf,
  });

  const items = rows.map((row) => {
    const price = prices.get(row.id) ?? null;
    return {
      id: row.id,
      supplierId: row.supplierId,
      supplier: {
        id: row.supplier.id,
        supplierCode: row.supplier.supplierCode,
        supplierName: row.supplier.supplierName,
      },
      supplierSkuCode: row.supplierSkuCode,
      supplierSkuName: row.supplierSkuName,
      moq: row.moq === null ? null : toDecimalString(row.moq),
      // ★ `??` 만 쓴다 — `0` 은 falsy 지만 유효한 저장값이다 (G-03).
      effectiveLeadTimeDays: row.leadTimeDays ?? row.supplier.defaultLeadTimeDays ?? null,
      supplyType: row.supplyType,
      isPrimary: row.isPrimary,
      recentPrice:
        price === null
          ? null
          : { unitPrice: toDecimalString(price.unitPrice), currency: price.currency },
    } satisfies SkuSupplierSummaryView;
  });

  return {
    items,
    page: query.page,
    pageSize: SUPPLIER_PAGE_SIZE,
    total,
    totalPages: Math.ceil(total / SUPPLIER_PAGE_SIZE),
    asOf: asOfText,
  };
}
