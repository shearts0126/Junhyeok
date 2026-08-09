import { describe, expect, it } from 'vitest';

import { SKU_ITEM_TYPES, createSkuSchema, updateSkuSchema } from '@/modules/sku/application';

import {
  SKU_ITEM_TYPE_OPTIONS,
  buildCreatePayload,
  buildUpdatePayload,
  emptySkuForm,
  hasSkuFormChanges,
  skuFormFromView,
  type SkuFormValue,
  type SkuViewLike,
} from './sku-form';

/**
 * SKU 등록·수정 폼 헬퍼 테스트 (T1-6A).
 *
 * 폼이 만들어내는 payload 가 **실제 Zod DTO 를 통과**하는지, 그리고 금지된
 * 필드가 절대 섞이지 않는지를 고정한다.
 */

const VIEW: SkuViewLike = {
  skuCode: 'FB-HC-SH-001',
  skuName: '테스트 SKU',
  skuNameEn: null,
  itemType: 'FINISHED_GOOD',
  sellable: false,
  purchasable: false,
  manufacturable: false,
  discontinuationDate: null,
  note: null,
  brand: { id: '11111111-1111-4111-8111-111111111111' },
  majorCategory: null,
  minorCategory: null,
  serialNumber: '00123',
  additionalCode: null,
  erpItemType: null,
  baseUom: 'EA',
  purchaseUom: null,
  unitConversionQty: '2.5',
  inventoryManaged: true,
  lotManaged: false,
  expiryManaged: false,
  serialManaged: false,
  defaultShelfLifeDays: null,
  minimumRemainingDays: 30,
  reconciliationToleranceQty: '0',
};

/** 서버 관리 필드 + 폐기 설계 — payload 에 절대 없어야 한다. */
const FORBIDDEN_KEYS = [
  'id',
  'status',
  'hasTransaction',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'approvedAt',
  'approvedBy',
  'deletedAt',
  'negativeStockAllowed',
];

describe('★ itemType 선택지 정합', () => {
  it('T1-4A SKU_ITEM_TYPES 14종과 정확히 일치한다 (복제본 드리프트 방지)', () => {
    expect([...SKU_ITEM_TYPE_OPTIONS]).toEqual([...SKU_ITEM_TYPES]);
  });
});

describe('emptySkuForm — Prisma/DTO 기본값 정합', () => {
  it('DB 기본값과 일치한다 (baseUom EA, 입수량 1, 재고관리 true, 나머지 false, 허용오차 0)', () => {
    const form = emptySkuForm();
    expect(form.baseUom).toBe('EA');
    expect(form.unitConversionQty).toBe('1');
    expect(form.reconciliationToleranceQty).toBe('0');
    expect(form.inventoryManaged).toBe(true);
    // ✏️ D-03 — LOT·유통기한·시리얼은 기본 미관리
    expect(form.lotManaged).toBe(false);
    expect(form.expiryManaged).toBe(false);
    expect(form.serialManaged).toBe(false);
    expect(form.sellable).toBe(false);
  });

  it('★ 폼에 negativeStockAllowed 같은 폐기·서버관리 필드가 없다', () => {
    const keys = Object.keys(emptySkuForm());
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

describe('buildCreatePayload', () => {
  function filledForm(): SkuFormValue {
    return {
      ...emptySkuForm(),
      skuCode: 'FB-HC-SH-100',
      skuName: '신규 상품',
      itemType: 'FINISHED_GOOD',
    };
  }

  it('★ 생성 payload 가 실제 CreateSkuDto 를 통과한다', () => {
    const payload = buildCreatePayload(filledForm());
    const result = createSkuSchema.safeParse(payload);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('★ 서버 관리·폐기 필드가 payload 에 없다', () => {
    const keys = Object.keys(buildCreatePayload(filledForm()));
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('빈 선택 필드는 생략된다 — DB 기본값이 적용되도록', () => {
    const payload = buildCreatePayload(filledForm());
    expect(payload).not.toHaveProperty('skuNameEn');
    expect(payload).not.toHaveProperty('brandId');
    expect(payload).not.toHaveProperty('defaultShelfLifeDays');
    // 불리언은 폼에 확정 값이 있으므로 명시 전달
    expect(payload['inventoryManaged']).toBe(true);
    expect(payload['sellable']).toBe(false);
  });

  it('★ Decimal 은 문자열 그대로 — 숫자 변환 없음', () => {
    const payload = buildCreatePayload({ ...filledForm(), unitConversionQty: '2.500000' });
    expect(payload['unitConversionQty']).toBe('2.500000');
    expect(typeof payload['unitConversionQty']).toBe('string');
    expect(createSkuSchema.safeParse(payload).success).toBe(true);
  });

  it('정수 필드는 JSON number 로 전달된다', () => {
    const payload = buildCreatePayload({ ...filledForm(), defaultShelfLifeDays: '365' });
    expect(payload['defaultShelfLifeDays']).toBe(365);
    expect(createSkuSchema.safeParse(payload).success).toBe(true);
  });

  it("★ 입력을 자동 trim 하지 않는다 — ' ABC ' 는 그대로 전송되어 서버가 400 판정", () => {
    const payload = buildCreatePayload({ ...filledForm(), skuCode: ' ABC ' });
    expect(payload['skuCode']).toBe(' ABC ');
    expect(createSkuSchema.safeParse(payload).success).toBe(false);
  });
});

describe('skuFormFromView', () => {
  it('null 은 빈 문자열로, Decimal·품번 문자열은 원문 그대로 옮긴다', () => {
    const form = skuFormFromView(VIEW);
    expect(form.skuNameEn).toBe('');
    expect(form.brandId).toBe('11111111-1111-4111-8111-111111111111');
    expect(form.serialNumber).toBe('00123'); // 앞자리 0 보존
    expect(form.unitConversionQty).toBe('2.5');
    expect(form.minimumRemainingDays).toBe('30');
    expect(form.defaultShelfLifeDays).toBe('');
  });
});

describe('buildUpdatePayload — 변경 필드만', () => {
  const original = skuFormFromView(VIEW);

  it('변경 없음이면 빈 객체 (PATCH {} 를 보내지 않기 위한 판정)', () => {
    expect(buildUpdatePayload(original, { ...original })).toEqual({});
    expect(hasSkuFormChanges(original, { ...original })).toBe(false);
  });

  it('★ 바뀐 필드만 담고, 건드리지 않은 CommonCode 참조는 전송하지 않는다', () => {
    const payload = buildUpdatePayload(original, { ...original, skuName: '수정된 이름' });
    expect(payload).toEqual({ skuName: '수정된 이름' });
    // ★ 기존 brandId 가 (비활성이더라도) 다시 전송되지 않는다
    expect(payload).not.toHaveProperty('brandId');
    expect(updateSkuSchema.safeParse(payload).success).toBe(true);
  });

  it('nullable 필드를 비우면 null 로 해제된다', () => {
    const payload = buildUpdatePayload(original, { ...original, brandId: '', serialNumber: '' });
    expect(payload).toEqual({ brandId: null, serialNumber: null });
    expect(updateSkuSchema.safeParse(payload).success).toBe(true);
  });

  it('NOT NULL 필드를 비우면 null 로 바꾸지 않고 원문을 보낸다 (서버가 400 판정)', () => {
    const payload = buildUpdatePayload(original, { ...original, skuName: '' });
    expect(payload).toEqual({ skuName: '' });
    expect(updateSkuSchema.safeParse(payload).success).toBe(false);
  });

  it('불리언·정수·Decimal 변경', () => {
    const payload = buildUpdatePayload(original, {
      ...original,
      lotManaged: true,
      minimumRemainingDays: '',
      unitConversionQty: '3.75',
    });
    expect(payload).toEqual({
      lotManaged: true,
      minimumRemainingDays: null,
      unitConversionQty: '3.75',
    });
    expect(updateSkuSchema.safeParse(payload).success).toBe(true);
  });

  it('★ 어떤 변경 조합에서도 서버 관리·폐기 필드가 섞이지 않는다', () => {
    const payload = buildUpdatePayload(original, {
      ...original,
      skuName: 'x',
      lotManaged: true,
      note: '메모',
    });
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(Object.keys(payload), forbidden).not.toContain(forbidden);
    }
  });
});
