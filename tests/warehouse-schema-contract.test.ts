import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Warehouse · WarehouseLocation **스키마 계약** 테스트 (T08-1 = v0.2 T2-1A).
 *
 * 근거: `docs/19_설계복구_Warehouse.md`
 *       (2026-08-25 Warehouse Design Recovery Decision — W-D1 ~ W-D42)
 *
 * ★ 이 파일은 DB 없이 **`schema.prisma` 원문**만 본다 (S1~S10). 카탈로그가
 *   실제로 그렇게 만들어졌는지는 `tests/db/warehouse-schema.test.ts` 가 본다.
 *   둘 다 필요하다 — drift gate 는 표현식 인덱스·CHECK·deferrability 를 보지
 *   못하고, 반대로 카탈로그 테스트는 "필드를 더 만들지 않았는가" 를 보기에
 *   불편하다.
 *
 * ⛔ T08-1 은 schema + migration + DB contract 까지다. application service ·
 *    API · DTO · permission · seed · UI 는 T08-2 이후이며 여기서 검사하지 않는다
 *    (없다는 사실만 §"범위 밖" 에서 고정한다).
 */

const SCHEMA_SOURCE = readFileSync(
  fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url)),
  'utf8',
);

/** `model X { ... }` 본문만 잘라 낸다 — 다른 모델의 필드가 섞이지 않게. */
function modelBody(name: string): string {
  const match = new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA_SOURCE);
  expect(match, `model ${name} 이 schema.prisma 에 없다`).not.toBeNull();
  return match![1] ?? '';
}

/**
 * 주석(`///` · `//`)을 제거한 **코드 라인만** 남긴다.
 *
 * ⛔ 금지어 검사를 주석 위에서 하면, 금지 사실을 설명하는 주석 자체가
 *    테스트를 실패시킨다 (선례: `src/app/master/boms/bom-ui.test.ts`).
 */
function codeOnly(body: string): string {
  return body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** 모델 본문에서 scalar/relation 필드 이름을 순서대로 뽑는다. */
function fieldNames(name: string): string[] {
  return codeOnly(modelBody(name))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('@@'))
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)\s/.exec(line)?.[1])
    .filter((token): token is string => token !== undefined);
}

// ═══════════════════════════════════════════════════════════════
// S1 — WarehouseType
// ═══════════════════════════════════════════════════════════════

describe('S1. WarehouseType — exact 6종 (W-D2)', () => {
  it('정확히 6개이며 순서·철자가 원 설계와 같다', () => {
    const match = /^enum\s+WarehouseType\s*\{([\s\S]*?)^\}/m.exec(SCHEMA_SOURCE);
    expect(match).not.toBeNull();

    const values = codeOnly(match![1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(values).toEqual([
      'INTERNAL',
      'THREE_PL',
      'SUPPLIER_SITE',
      'OVERSEAS',
      'VIRTUAL',
      'IN_TRANSIT',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// S2 · S8 — Warehouse 필드 목록
// ═══════════════════════════════════════════════════════════════

describe('S2. Warehouse — scalar 필드 inventory exact (W-D3)', () => {
  const SCALARS = [
    'id',
    'warehouseCode',
    'warehouseName',
    'warehouseType',
    'externalSystemId',
    'supplierId',
    'defaultLocationId',
    'timezone',
    'address',
    'active',
    'createdAt',
    'updatedAt',
  ] as const;

  const RELATIONS = [
    'supplier',
    'externalSystem',
    'defaultLocation',
    'locations',
    'externalMappings',
    'defaultForSuppliers',
    'destinationForSupplierSkus',
    'destinationForBomHeaders',
    'issueForBomLines',
  ] as const;

  it('scalar + relation 필드 집합이 정확히 일치한다', () => {
    expect(fieldNames('Warehouse')).toEqual([...SCALARS, ...RELATIONS]);
  });

  it('★ defaultLocationId 는 nullable 이 아니다 (W-D5)', () => {
    const line = codeOnly(modelBody('Warehouse'))
      .split('\n')
      .find((row) => row.trim().startsWith('defaultLocationId'));

    expect(line).toBeDefined();
    // `String` 이고 `String?` 이 아니다.
    expect(line).toMatch(/defaultLocationId\s+String\s/);
    expect(line).not.toMatch(/defaultLocationId\s+String\?/);
    expect(line).toContain('@db.Uuid');
  });

  it('★ warehouseCode 는 전역 UNIQUE 다', () => {
    expect(codeOnly(modelBody('Warehouse'))).toMatch(/warehouseCode\s+String\s+@unique/);
  });

  it('★ timezone 기본값은 Asia/Seoul 이다 (W-D29)', () => {
    expect(codeOnly(modelBody('Warehouse'))).toMatch(
      /timezone\s+String\s+@default\("Asia\/Seoul"\)/,
    );
  });

  it('★ externalSystemId · supplierId 는 nullable 이다 (W-D13 · W-D14)', () => {
    const body = codeOnly(modelBody('Warehouse'));
    expect(body).toMatch(/externalSystemId\s+String\?/);
    expect(body).toMatch(/supplierId\s+String\?/);
  });
});

describe('S8. Warehouse — 만들지 않은 컬럼 (W-D3)', () => {
  it('⛔ createdBy · updatedBy · deletedAt · version · metadata 가 없다', () => {
    const names = fieldNames('Warehouse');
    for (const forbidden of [
      'createdBy',
      'updatedBy',
      'deletedAt',
      'version',
      'metadata',
      'inventorySkuCount',
      'stockCount',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// S3 · S9 — WarehouseLocation 필드 목록
// ═══════════════════════════════════════════════════════════════

describe('S3. WarehouseLocation — scalar 필드 inventory exact (W-D4)', () => {
  it('scalar + relation 필드 집합이 정확히 일치한다', () => {
    expect(fieldNames('WarehouseLocation')).toEqual([
      'id',
      'warehouseId',
      'locationCode',
      'locationName',
      'locationType',
      'active',
      'warehouse',
      'defaultForWarehouses',
    ]);
  });

  it('★ locationType 만 nullable 이다', () => {
    const body = codeOnly(modelBody('WarehouseLocation'));
    expect(body).toMatch(/locationType\s+String\?/);
    expect(body).toMatch(/locationCode\s+String\s/);
    expect(body).toMatch(/locationName\s+String\s/);
  });
});

describe('S9. WarehouseLocation — 감사 컬럼이 없다 (W-D4)', () => {
  it('⛔ createdAt · updatedAt · deletedAt · sortOrder · isDefault 가 없다', () => {
    const names = fieldNames('WarehouseLocation');
    for (const forbidden of [
      'createdAt',
      'updatedAt',
      'deletedAt',
      'sortOrder',
      'isDefault',
      'createdBy',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// S5 · S6 — UNIQUE
// ═══════════════════════════════════════════════════════════════

describe('S5 · S6. WarehouseLocation UNIQUE 2종', () => {
  it('S5. business unique — (warehouseId, locationCode)', () => {
    expect(codeOnly(modelBody('WarehouseLocation'))).toMatch(
      /@@unique\(\[warehouseId,\s*locationCode\]\)/,
    );
  });

  it('S6. ★ composite FK target — (warehouseId, id) (W-D6)', () => {
    // ⛔ 이 UNIQUE 를 지우면 `warehouse (id, default_location_id)` FK 를
    //    걸 수 없다. business identity 가 아니라 **참조 대상**이다.
    expect(codeOnly(modelBody('WarehouseLocation'))).toMatch(/@@unique\(\[warehouseId,\s*id\]\)/);
  });
});

// ═══════════════════════════════════════════════════════════════
// S7 — same-warehouse composite relation
// ═══════════════════════════════════════════════════════════════

describe('S7. defaultLocation composite relation (W-D6)', () => {
  it('★ fields 는 [id, defaultLocationId] · references 는 [warehouseId, id] 다', () => {
    const line = codeOnly(modelBody('Warehouse'))
      .split('\n')
      .find((row) => row.trim().startsWith('defaultLocation '));

    expect(line, 'Warehouse.defaultLocation relation 이 없다').toBeDefined();
    expect(line).toContain('fields: [id, defaultLocationId]');
    expect(line).toContain('references: [warehouseId, id]');
    expect(line).toContain('onDelete: Restrict');
    expect(line).toContain('onUpdate: Cascade');
  });

  it('⛔ 단일 열 FK(`defaultLocationId → id`)로 축약하지 않았다', () => {
    // 단일 FK 면 **다른 창고의** 로케이션을 default 로 지정할 수 있다.
    expect(codeOnly(modelBody('Warehouse'))).not.toMatch(
      /fields:\s*\[defaultLocationId\]\s*,\s*references:\s*\[id\]/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// staged scalar 5종 — real FK landing (W-D15)
// ═══════════════════════════════════════════════════════════════

describe('★ staged warehouse scalar 5종이 real relation 으로 landing 했다 (W-D15)', () => {
  const LANDINGS = [
    ['SkuExternalMapping', 'warehouse', 'warehouseId'],
    ['Supplier', 'defaultWarehouse', 'defaultWarehouseId'],
    ['SupplierSku', 'destinationWarehouse', 'destinationWarehouseId'],
    ['BomHeader', 'destinationWarehouse', 'destinationWarehouseId'],
    ['BomLine', 'issueWarehouse', 'issueWarehouseId'],
  ] as const;

  it.each(LANDINGS)('%s.%s → Warehouse (scalar %s 유지)', (model, relation, scalar) => {
    const body = codeOnly(modelBody(model));

    // scalar 컬럼은 **삭제하지 않았다**.
    expect(body).toMatch(new RegExp(`${scalar}\\s+String\\?`));

    const line = body.split('\n').find((row) => row.trim().startsWith(`${relation} `));
    expect(line, `${model}.${relation} relation 이 없다`).toBeDefined();
    expect(line).toContain('Warehouse?');
    expect(line).toContain(`fields: [${scalar}]`);
    expect(line).toContain('references: [id]');
    expect(line).toContain('onDelete: Restrict');
    expect(line).toContain('onUpdate: Cascade');
  });

  it('★ Supplier 의 두 Warehouse 관계는 이름으로 구분된다', () => {
    const body = codeOnly(modelBody('Supplier'));
    // ① 이 거래처가 기본 입고처로 쓰는 창고
    expect(body).toContain('"SupplierDefaultWarehouse"');
    // ② 이 거래처가 사급자재를 보관하는 SUPPLIER_SITE 창고 (inverse)
    expect(body).toMatch(
      /supplierSiteWarehouses\s+Warehouse\[\]\s+@relation\("WarehouseSupplierSite"\)/,
    );
  });

  it('★ ExternalSystem 에 inverse 가 추가됐다 (W-D14)', () => {
    expect(codeOnly(modelBody('ExternalSystem'))).toMatch(/warehouses\s+Warehouse\[\]/);
  });
});

// ═══════════════════════════════════════════════════════════════
// S10 — 범위 밖: T09 관계는 하나도 없다
// ═══════════════════════════════════════════════════════════════

describe('S10. ⛔ T09 재고 모델·관계가 추가되지 않았다 (W-D18 · W-D40)', () => {
  it('⛔ Inventory 계열 model 이 없다', () => {
    for (const model of [
      'InventoryTransaction',
      'InventoryLedgerEntry',
      'InventoryBalance',
      'InventoryPosting',
    ]) {
      expect(SCHEMA_SOURCE, model).not.toMatch(new RegExp(`^\\s*model\\s+${model}\\b`, 'm'));
    }
  });

  it('⛔ Warehouse 에 ledgerEntries · balances 가 없다', () => {
    const names = fieldNames('Warehouse');
    expect(names).not.toContain('ledgerEntries');
    expect(names).not.toContain('balances');
  });

  it('⛔ WarehouseLocation 에 재고 inverse 가 없다', () => {
    const names = fieldNames('WarehouseLocation');
    expect(names).not.toContain('ledgerEntries');
    expect(names).not.toContain('balances');
  });
});

// ═══════════════════════════════════════════════════════════════
// 범위 밖 — T08-2 / T2-20 산출물이 하나도 없다 (W-D1)
// ═══════════════════════════════════════════════════════════════

describe('⛔ T08-1 범위 밖 산출물 0 (W-D1)', () => {
  const exists = (relative: string): boolean => {
    try {
      readFileSync(fileURLToPath(new URL(relative, import.meta.url)));
      return true;
    } catch {
      return false;
    }
  };

  it('⛔ Warehouse API route 가 없다 (T08-2)', () => {
    expect(exists('../src/app/api/warehouses/route.ts')).toBe(false);
  });

  it('⛔ Warehouse application module 이 없다 (T08-2)', () => {
    expect(exists('../src/modules/warehouse/application/dto.ts')).toBe(false);
  });

  it('⛔ Warehouse 화면이 없다 (T2-20)', () => {
    expect(exists('../src/app/master/warehouses/page.tsx')).toBe(false);
  });
});
