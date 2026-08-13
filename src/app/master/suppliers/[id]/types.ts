/**
 * 거래처 상세 화면이 쓰는 API 응답 shape (T06-4) — 타입 선언만.
 *
 * ⚠️ backend view 를 그대로 옮긴 것이며, 화면이 임의 필드를 추가하지 않는다.
 *    `attachmentId`·`defaultWarehouseId`·`destinationWarehouseId` 는 API 가
 *    애초에 내보내지 않는다 (D-20·D-26).
 */

export interface SupplierDetail {
  id: string;
  supplierCode: string;
  supplierName: string;
  supplierType: string;
  businessRegistrationNo: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  defaultLeadTimeDays: number | null;
  status: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierSkuItem {
  id: string;
  supplierId: string;
  skuId: string;
  supplierSkuCode: string | null;
  supplierSkuName: string | null;
  supplyType: string;
  moq: string | null;
  orderMultiple: string | null;
  /** 저장값. `null` 미입력 / `0` 즉시납 — 둘을 합치지 않는다 (G-03). */
  leadTimeDays: number | null;
  /** 파생값 — `leadTimeDays ?? supplier.defaultLeadTimeDays ?? null`. */
  effectiveLeadTimeDays: number | null;
  purchaseUom: string | null;
  currency: string;
  isPrimary: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  sku: { id: string; skuCode: string; skuName: string; status: string };
}

export interface SupplierSkuListResponse {
  items: SupplierSkuItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PriceItem {
  id: string;
  supplierSkuId: string;
  unitPrice: string;
  currency: string;
  vatIncluded: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceDocument: string | null;
  createdBy: string | null;
  /** null = 미승인. 승인 상태는 이 필드로만 파생한다 (D-25). */
  approvedBy: string | null;
  createdAt: string;
}

export interface PriceListResponse {
  prices: PriceItem[];
}

export interface SkuOption {
  id: string;
  skuCode: string;
  skuName: string;
}
