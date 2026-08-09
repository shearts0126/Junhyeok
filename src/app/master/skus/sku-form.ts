/**
 * SKU 등록·수정 폼 헬퍼 (T1-6A) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ `@/modules/sku/application` barrel 을 import 하지 않는다 (Prisma 런타임을
 *    끌고 온다). 품목구분 목록은 여기 복제하고 **unit 테스트가 T1-4A
 *    `SKU_ITEM_TYPES` 와의 정합을 고정**한다.
 *
 * ## 계약 준수
 *
 *   - CreateSkuDto/UpdateSkuDto(Zod strict)가 단일 기준이다 — UI 가 규칙을
 *     완화·강화하지 않는다.
 *   - **정규화 금지** — 입력값을 자동 trim/case 변환하지 않는다. 위반은 서버가
 *     400 으로 판정하고 화면은 그 메시지를 보여준다.
 *   - Decimal 은 **문자열 그대로** 주고받는다. `Number()`/`parseFloat()` 로
 *     변환하지 않는다 (정밀도 훼손 금지).
 *   - ⛔ server-managed 필드(`id`·`status`·`hasTransaction`·감사 필드)와 폐기
 *     설계 `negativeStockAllowed` 는 폼·payload 어디에도 없다.
 */

/**
 * 품목구분 선택지 — T1-4A 승인 검증 vocabulary(`SKU_ITEM_TYPES`, 01 §1.4 실측
 * 14종)와 동일. DB 는 String 을 유지하며 enum·CommonCode 로 바꾸지 않는다.
 */
export const SKU_ITEM_TYPE_OPTIONS = [
  'FINISHED_GOOD',
  'KIT_FINISHED_GOOD',
  'NONSALE_FINISHED_GOOD',
  'SEMI_FINISHED_GOOD',
  'PACKAGING_MATERIAL',
  'COMMON_PACKAGING_MATERIAL',
  'KIT_PACKAGING_MATERIAL',
  'MATERIAL',
  'CONSUMABLE',
  'SALON_SUPPLY',
  'SAMPLE',
  'SERVICE',
  'MOLD',
  'ETC',
] as const;

export const SKU_ITEM_TYPE_LABELS: Readonly<Record<string, string>> = {
  FINISHED_GOOD: '완제품',
  KIT_FINISHED_GOOD: '기획세트 완제품',
  NONSALE_FINISHED_GOOD: '완제품 (비매품)',
  SEMI_FINISHED_GOOD: '반제품',
  PACKAGING_MATERIAL: '제품 부자재',
  COMMON_PACKAGING_MATERIAL: '제품 부자재(공용)',
  KIT_PACKAGING_MATERIAL: '기획세트 부자재',
  MATERIAL: '부자재',
  CONSUMABLE: '소모품',
  SALON_SUPPLY: '미용실',
  SAMPLE: '샘플',
  SERVICE: '무형',
  MOLD: '금형',
  ETC: '기타',
};

/** 화면에 존재하는 사용자 편집 필드 전체. 값은 전부 문자열/불리언이다. */
export interface SkuFormValue {
  // ① 기본정보
  skuCode: string;
  skuName: string;
  skuNameEn: string;
  itemType: string;
  sellable: boolean;
  purchasable: boolean;
  manufacturable: boolean;
  discontinuationDate: string;
  note: string;

  // ② 코드·분류
  brandId: string;
  majorCategoryId: string;
  minorCategoryId: string;
  serialNumber: string;
  additionalCode: string;
  erpItemType: string;

  // ③ 재고관리 설정
  baseUom: string;
  purchaseUom: string;
  /** DECIMAL — 문자열 그대로 */
  unitConversionQty: string;
  inventoryManaged: boolean;
  lotManaged: boolean;
  expiryManaged: boolean;
  serialManaged: boolean;
  defaultShelfLifeDays: string;
  minimumRemainingDays: string;
  /** DECIMAL — 문자열 그대로 */
  reconciliationToleranceQty: string;
}

/**
 * 신규 등록 폼 초기값 — **Prisma/DTO 의 실제 기본값**과 일치시킨다.
 * (`base_uom='EA'`, `unit_conversion_qty=1`, `inventory_managed=true`,
 *  나머지 불리언 false, `reconciliation_tolerance_qty=0`. D-03: lot·expiry·
 *  serial 은 기본 미관리.) 임의 기본값을 새로 만들지 않는다.
 */
export function emptySkuForm(): SkuFormValue {
  return {
    skuCode: '',
    skuName: '',
    skuNameEn: '',
    itemType: '',
    sellable: false,
    purchasable: false,
    manufacturable: false,
    discontinuationDate: '',
    note: '',
    brandId: '',
    majorCategoryId: '',
    minorCategoryId: '',
    serialNumber: '',
    additionalCode: '',
    erpItemType: '',
    baseUom: 'EA',
    purchaseUom: '',
    unitConversionQty: '1',
    inventoryManaged: true,
    lotManaged: false,
    expiryManaged: false,
    serialManaged: false,
    defaultShelfLifeDays: '',
    minimumRemainingDays: '',
    reconciliationToleranceQty: '0',
  };
}

/** 상세 응답(SkuView)에서 폼 값으로. 서버가 준 표현을 그대로 옮긴다. */
export interface SkuViewLike {
  skuCode: string;
  skuName: string;
  skuNameEn: string | null;
  itemType: string;
  sellable: boolean;
  purchasable: boolean;
  manufacturable: boolean;
  discontinuationDate: string | null;
  note: string | null;
  brand: { id: string } | null;
  majorCategory: { id: string } | null;
  minorCategory: { id: string } | null;
  serialNumber: string | null;
  additionalCode: string | null;
  erpItemType: string | null;
  baseUom: string;
  purchaseUom: string | null;
  unitConversionQty: string;
  inventoryManaged: boolean;
  lotManaged: boolean;
  expiryManaged: boolean;
  serialManaged: boolean;
  defaultShelfLifeDays: number | null;
  minimumRemainingDays: number | null;
  reconciliationToleranceQty: string;
}

export function skuFormFromView(view: SkuViewLike): SkuFormValue {
  return {
    skuCode: view.skuCode,
    skuName: view.skuName,
    skuNameEn: view.skuNameEn ?? '',
    itemType: view.itemType,
    sellable: view.sellable,
    purchasable: view.purchasable,
    manufacturable: view.manufacturable,
    discontinuationDate: view.discontinuationDate ?? '',
    note: view.note ?? '',
    brandId: view.brand?.id ?? '',
    majorCategoryId: view.majorCategory?.id ?? '',
    minorCategoryId: view.minorCategory?.id ?? '',
    serialNumber: view.serialNumber ?? '',
    additionalCode: view.additionalCode ?? '',
    erpItemType: view.erpItemType ?? '',
    baseUom: view.baseUom,
    purchaseUom: view.purchaseUom ?? '',
    // ★ Decimal 은 서버가 준 문자열 그대로 — 숫자 변환 없음.
    unitConversionQty: view.unitConversionQty,
    inventoryManaged: view.inventoryManaged,
    lotManaged: view.lotManaged,
    expiryManaged: view.expiryManaged,
    serialManaged: view.serialManaged,
    defaultShelfLifeDays:
      view.defaultShelfLifeDays === null ? '' : String(view.defaultShelfLifeDays),
    minimumRemainingDays:
      view.minimumRemainingDays === null ? '' : String(view.minimumRemainingDays),
    reconciliationToleranceQty: view.reconciliationToleranceQty,
  };
}

/** 폼의 불리언 필드 — 항상 확정 값이므로 create 에서 명시 전달한다. */
const BOOLEAN_FIELDS = [
  'sellable',
  'purchasable',
  'manufacturable',
  'inventoryManaged',
  'lotManaged',
  'expiryManaged',
  'serialManaged',
] as const;

/** 문자열 그대로 전송하는 필드 (trim·case 변환 없음). */
const TEXT_FIELDS = [
  'skuCode',
  'skuName',
  'skuNameEn',
  'itemType',
  'discontinuationDate',
  'note',
  'brandId',
  'majorCategoryId',
  'minorCategoryId',
  'serialNumber',
  'additionalCode',
  'erpItemType',
  'baseUom',
  'purchaseUom',
  // Decimal 도 **문자열**로 보낸다 (DTO 계약).
  'unitConversionQty',
  'reconciliationToleranceQty',
] as const;

/** 정수 필드 — DTO 가 JSON number(0 이상 정수)를 요구한다. */
const INTEGER_FIELDS = ['defaultShelfLifeDays', 'minimumRemainingDays'] as const;

/** 정수 문자열 → number. 정수가 아니면 원문을 그대로 보내 서버가 400 판정한다. */
function integerPayloadValue(raw: string): number | string {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/**
 * 신규 등록 payload — 비어 있는 선택 필드는 **생략**한다(DB 기본값 적용).
 * 불리언은 폼에 확정 값이 있으므로 명시 전달한다.
 *
 * ⛔ server-managed 필드는 어떤 경우에도 포함하지 않는다.
 */
export function buildCreatePayload(form: SkuFormValue): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const field of TEXT_FIELDS) {
    const value = form[field];
    // 빈 입력은 "미제공" 이다 — null 을 보내지 않는다(생성 시점엔 해제 개념이 없다).
    if (value !== '') payload[field] = value;
  }
  for (const field of INTEGER_FIELDS) {
    const value = form[field];
    if (value !== '') payload[field] = integerPayloadValue(value);
  }
  for (const field of BOOLEAN_FIELDS) {
    payload[field] = form[field];
  }

  return payload;
}

/**
 * 수정 payload — **실제로 바뀐 필드만** 담는다.
 *
 * ⚠️ 모든 필드를 무조건 보내면, 건드리지 않은 비활성 CommonCode 참조까지
 *    다시 전송되어 서버가 "비활성 코드 신규 선택" 으로 거부한다. 현재 backend
 *    정책은 "그 필드를 건드리지 않으면 기존 inactive reference 허용" 이므로
 *    변경 필드 중심 PATCH 여야 한다.
 *
 * 값이 비워진 nullable 필드는 `null`(해제)로 보낸다.
 */
export function buildUpdatePayload(
  original: SkuFormValue,
  current: SkuFormValue,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  /** 비우면 null 로 해제되는 nullable 필드. */
  const nullableText = new Set<string>([
    'skuNameEn',
    'discontinuationDate',
    'note',
    'brandId',
    'majorCategoryId',
    'minorCategoryId',
    'serialNumber',
    'additionalCode',
    'erpItemType',
    'purchaseUom',
  ]);

  for (const field of TEXT_FIELDS) {
    if (original[field] === current[field]) continue;
    const value = current[field];
    if (value === '') {
      // NOT NULL 필드(skuCode·skuName·itemType·baseUom·Decimal)는 빈 값을 null
      // 로 바꾸지 않는다 — 원문 그대로 보내 서버가 400 으로 판정한다.
      payload[field] = nullableText.has(field) ? null : value;
    } else {
      payload[field] = value;
    }
  }

  for (const field of INTEGER_FIELDS) {
    if (original[field] === current[field]) continue;
    payload[field] = current[field] === '' ? null : integerPayloadValue(current[field]);
  }

  for (const field of BOOLEAN_FIELDS) {
    if (original[field] !== current[field]) payload[field] = current[field];
  }

  return payload;
}

/** 변경 없음 판정 — `PATCH {}` 로 서버 400 을 유발하지 않기 위한 UI 판정. */
export function hasSkuFormChanges(original: SkuFormValue, current: SkuFormValue): boolean {
  return Object.keys(buildUpdatePayload(original, current)).length > 0;
}
