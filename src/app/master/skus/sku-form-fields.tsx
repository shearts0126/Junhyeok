'use client';

import { SKU_ITEM_TYPE_LABELS, SKU_ITEM_TYPE_OPTIONS, type SkuFormValue } from './sku-form';

/**
 * SKU 등록·수정 공용 입력 필드 (T1-6A) — 3개 Core 탭.
 *
 *   ① 기본정보  ② 코드·분류  ③ 재고관리 설정
 *
 * ⛔ `negativeStockAllowed`(음수허용) 는 폐기 설계다 — 토글·필드·hidden input
 *    어떤 형태로도 존재하지 않는다.
 *
 * ## 등록/상세 탭 배열 분리 (T1-6B1)
 *
 * `docs/16_설계복구_SKU상세잔여탭.md` §7. 바코드는 **부모 SKU 가 저장된 뒤에만**
 * 존재할 수 있는 child entity 다(`/api/skus/{id}/barcodes` 가 경로에 `skuId` 를
 * 요구한다). 그래서 등록 화면과 상세 화면이 **서로 다른 탭 배열**을 쓴다.
 *
 * ⛔ 등록 화면에 child entity 탭(바코드·외부매핑)을 disabled·placeholder 로도
 *    두지 않는다.
 * ⛔ 변경이력(T1-6B3)·공급조건(T06)·BOM(T07) 탭은 아직 없다.
 */

/** 등록 화면(`/master/skus/new`) 탭 — child entity 탭이 없다. */
export const SKU_CREATE_TABS = [
  { key: 'basic', label: '기본정보' },
  { key: 'classification', label: '코드·분류' },
  { key: 'inventory', label: '재고관리 설정' },
] as const;

/**
 * 상세 화면(`/master/skus/{id}`) 탭.
 *
 * ★ 순서는 원문 8탭(`05 §11.4`)의 논리 순서를 그대로 따른다 —
 *   ① 기본정보 ② 코드·분류 **③ 바코드 ④ 외부시스템 매핑** ⑤ 재고관리 설정.
 *   구현된 탭만 남기되 **원문 순서를 재배열하지 않는다.**
 */
export const SKU_DETAIL_TABS = [
  { key: 'basic', label: '기본정보' },
  { key: 'classification', label: '코드·분류' },
  { key: 'barcode', label: '바코드' },
  { key: 'externalMapping', label: '외부시스템 매핑' },
  { key: 'inventory', label: '재고관리 설정' },
] as const;

/** 폼 입력 탭 키 — `SkuTabPanel` 이 그리는 탭만 포함한다(바코드 제외). */
export type SkuTabKey = (typeof SKU_CREATE_TABS)[number]['key'];

/** 상세 탭 키 — 폼 탭 + `barcode`. */
export type SkuDetailTabKey = (typeof SKU_DETAIL_TABS)[number]['key'];

export interface CodeOption {
  id: string;
  code: string;
  name: string;
}

interface FieldProps {
  readonly form: SkuFormValue;
  readonly onChange: (patch: Partial<SkuFormValue>) => void;
  readonly disabled: boolean;
  /** `hasTransaction=true` 면 skuCode 를 읽기 전용으로 (T1-2 규칙의 UI 반영). */
  readonly skuCodeLocked?: boolean;
  readonly brandOptions: readonly CodeOption[];
  readonly majorOptions: readonly CodeOption[];
  readonly minorOptions: readonly CodeOption[];
}

function TextField({
  label,
  name,
  value,
  onChange,
  disabled,
  hint,
  mono,
  readOnly,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  hint?: string;
  mono?: boolean;
  readOnly?: boolean;
}) {
  return (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        readOnly={readOnly === true}
        aria-label={label}
        className={`bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-60 ${
          readOnly === true ? 'bg-muted opacity-70' : ''
        } ${mono === true ? 'font-mono' : ''}`}
      />
      {hint !== undefined && <span className="text-muted-foreground block text-xs">{hint}</span>}
    </label>
  );
}

function CheckField({
  label,
  name,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        aria-label={label}
      />
      {label}
    </label>
  );
}

/**
 * 공통코드 선택 — 활성 코드만 새로 선택할 수 있다. 현재 SKU 가 이미 비활성
 * 코드를 참조 중이면 그 값을 지우거나 자동 치환하지 않고 유지 표시한다.
 * ⛔ MAJOR → MINOR 계층 필터는 만들지 않는다 (규칙 미확정).
 */
function CodeSelect({
  label,
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  name: string;
  value: string;
  options: readonly CodeOption[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const inOptions = value === '' || options.some((option) => option.id === value);
  return (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label={label}
        className="bg-background h-9 w-full rounded-md border px-2 text-sm disabled:opacity-60"
      >
        <option value="">(없음)</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.code} — {option.name}
          </option>
        ))}
        {!inOptions && <option value={value}>(기존 선택값 유지 — 비활성/미확인 코드)</option>}
      </select>
      {!inOptions && (
        <span className="text-muted-foreground block text-xs">
          기존 참조를 보존합니다. 새로 선택하면 활성 코드만 지정할 수 있습니다.
        </span>
      )}
    </label>
  );
}

export function SkuBasicFields({ form, onChange, disabled, skuCodeLocked }: FieldProps) {
  const itemTypeUnmapped =
    form.itemType !== '' && !(SKU_ITEM_TYPE_OPTIONS as readonly string[]).includes(form.itemType);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <TextField
        label="SKU 코드 *"
        name="skuCode"
        value={form.skuCode}
        onChange={(value) => onChange({ skuCode: value })}
        disabled={disabled}
        readOnly={skuCodeLocked === true}
        mono
        hint={
          skuCodeLocked === true
            ? '거래 이력이 있어 코드를 변경할 수 없습니다. (서버 규칙이 최종 판정)'
            : '원본 코드를 그대로 입력하세요 — 공백·대소문자를 자동 보정하지 않습니다.'
        }
      />
      <TextField
        label="상품명 *"
        name="skuName"
        value={form.skuName}
        onChange={(value) => onChange({ skuName: value })}
        disabled={disabled}
      />
      <TextField
        label="영문 상품명"
        name="skuNameEn"
        value={form.skuNameEn}
        onChange={(value) => onChange({ skuNameEn: value })}
        disabled={disabled}
      />
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">품목구분 *</span>
        <select
          name="itemType"
          value={form.itemType}
          onChange={(event) => onChange({ itemType: event.target.value })}
          disabled={disabled}
          aria-label="품목구분 *"
          className="bg-background h-9 w-full rounded-md border px-2 text-sm disabled:opacity-60"
        >
          <option value="">(선택)</option>
          {SKU_ITEM_TYPE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {SKU_ITEM_TYPE_LABELS[option] ?? option} ({option})
            </option>
          ))}
          {/* 기존 값이 14종 밖이면 조용히 치환하지 않고 보존 표시한다. */}
          {itemTypeUnmapped && <option value={form.itemType}>{form.itemType} — 미매핑</option>}
        </select>
        {itemTypeUnmapped && (
          <span className="text-muted-foreground block text-xs">
            현재 값이 승인 검증 품목구분 목록에 없습니다 — 값은 보존되며 승인 요청 시 검증에서
            확인됩니다.
          </span>
        )}
      </label>

      <fieldset className="space-y-2 md:col-span-2">
        <legend className="text-muted-foreground text-xs">거래 유형</legend>
        <div className="flex flex-wrap gap-4">
          <CheckField
            label="판매 가능"
            name="sellable"
            checked={form.sellable}
            onChange={(checked) => onChange({ sellable: checked })}
            disabled={disabled}
          />
          <CheckField
            label="구매 가능"
            name="purchasable"
            checked={form.purchasable}
            onChange={(checked) => onChange({ purchasable: checked })}
            disabled={disabled}
          />
          <CheckField
            label="생산 가능"
            name="manufacturable"
            checked={form.manufacturable}
            onChange={(checked) => onChange({ manufacturable: checked })}
            disabled={disabled}
          />
        </div>
      </fieldset>

      <TextField
        label="단종 예정일 (YYYY-MM-DD)"
        name="discontinuationDate"
        value={form.discontinuationDate}
        onChange={(value) => onChange({ discontinuationDate: value })}
        disabled={disabled}
        mono
      />
      <label className="space-y-1 text-xs md:col-span-2">
        <span className="text-muted-foreground">비고</span>
        <textarea
          name="note"
          value={form.note}
          onChange={(event) => onChange({ note: event.target.value })}
          disabled={disabled}
          aria-label="비고"
          rows={3}
          className="bg-background w-full rounded-md border px-3 py-2 text-sm disabled:opacity-60"
        />
      </label>
    </div>
  );
}

export function SkuClassificationFields({
  form,
  onChange,
  disabled,
  brandOptions,
  majorOptions,
  minorOptions,
}: FieldProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <CodeSelect
        label="브랜드"
        name="brandId"
        value={form.brandId}
        options={brandOptions}
        onChange={(value) => onChange({ brandId: value })}
        disabled={disabled}
      />
      <div />
      <CodeSelect
        label="대분류"
        name="majorCategoryId"
        value={form.majorCategoryId}
        options={majorOptions}
        onChange={(value) => onChange({ majorCategoryId: value })}
        disabled={disabled}
      />
      <CodeSelect
        label="소분류"
        name="minorCategoryId"
        value={form.minorCategoryId}
        options={minorOptions}
        onChange={(value) => onChange({ minorCategoryId: value })}
        disabled={disabled}
      />
      <TextField
        label="품번 (앞자리 0 보존)"
        name="serialNumber"
        value={form.serialNumber}
        onChange={(value) => onChange({ serialNumber: value })}
        disabled={disabled}
        mono
      />
      <TextField
        label="추가 코드"
        name="additionalCode"
        value={form.additionalCode}
        onChange={(value) => onChange({ additionalCode: value })}
        disabled={disabled}
        mono
      />
      <TextField
        label="ERP 구분 (원문 보존)"
        name="erpItemType"
        value={form.erpItemType}
        onChange={(value) => onChange({ erpItemType: value })}
        disabled={disabled}
        mono
      />
    </div>
  );
}

export function SkuInventoryFields({ form, onChange, disabled }: FieldProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <TextField
        label="기본 단위"
        name="baseUom"
        value={form.baseUom}
        onChange={(value) => onChange({ baseUom: value })}
        disabled={disabled}
        mono
      />
      <TextField
        label="구매 단위"
        name="purchaseUom"
        value={form.purchaseUom}
        onChange={(value) => onChange({ purchaseUom: value })}
        disabled={disabled}
        mono
      />
      <TextField
        label="입수량 (0 초과)"
        name="unitConversionQty"
        value={form.unitConversionQty}
        onChange={(value) => onChange({ unitConversionQty: value })}
        disabled={disabled}
        mono
        hint="문자열로 전송됩니다 — 소수 정밀도가 보존됩니다."
      />
      <TextField
        label="대사 허용오차 (0 이상)"
        name="reconciliationToleranceQty"
        value={form.reconciliationToleranceQty}
        onChange={(value) => onChange({ reconciliationToleranceQty: value })}
        disabled={disabled}
        mono
      />

      <fieldset className="space-y-2 md:col-span-2">
        <legend className="text-muted-foreground text-xs">재고 관리 방식</legend>
        <div className="flex flex-wrap gap-4">
          <CheckField
            label="재고 관리"
            name="inventoryManaged"
            checked={form.inventoryManaged}
            onChange={(checked) => onChange({ inventoryManaged: checked })}
            disabled={disabled}
          />
          <CheckField
            label="LOT 관리"
            name="lotManaged"
            checked={form.lotManaged}
            onChange={(checked) => onChange({ lotManaged: checked })}
            disabled={disabled}
          />
          <CheckField
            label="유통기한 관리"
            name="expiryManaged"
            checked={form.expiryManaged}
            onChange={(checked) => onChange({ expiryManaged: checked })}
            disabled={disabled}
          />
          <CheckField
            label="시리얼 관리"
            name="serialManaged"
            checked={form.serialManaged}
            onChange={(checked) => onChange({ serialManaged: checked })}
            disabled={disabled}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          오픈 시 전 SKU 가 LOT·유통기한·시리얼 미관리로 시작합니다 (D-03).
        </p>
      </fieldset>

      <TextField
        label="기본 유통기한(일)"
        name="defaultShelfLifeDays"
        value={form.defaultShelfLifeDays}
        onChange={(value) => onChange({ defaultShelfLifeDays: value })}
        disabled={disabled}
        mono
      />
      <TextField
        label="최소 잔여일수"
        name="minimumRemainingDays"
        value={form.minimumRemainingDays}
        onChange={(value) => onChange({ minimumRemainingDays: value })}
        disabled={disabled}
        mono
      />
    </div>
  );
}

export function SkuTabPanel({ tab, ...props }: FieldProps & { tab: SkuTabKey }) {
  if (tab === 'basic') return <SkuBasicFields {...props} />;
  if (tab === 'classification') return <SkuClassificationFields {...props} />;
  return <SkuInventoryFields {...props} />;
}
