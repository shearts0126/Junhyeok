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

/**
 * 한 필드 선언을 **구조로** 파싱한다.
 *
 * ⛔ 문자열 한 조각을 `toContain` 하는 것만으로는 cardinality 를 못 본다 —
 *    `Warehouse?` 와 `Warehouse[]` 를 구분해야 하기 때문이다.
 */
interface ParsedField {
  readonly name: string;
  /** 목록·optional 표시를 뗀 타입 이름. */
  readonly type: string;
  readonly isList: boolean;
  readonly isOptional: boolean;
  readonly relationName: string | null;
  readonly fields: readonly string[] | null;
  readonly references: readonly string[] | null;
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
}

function parseField(model: string, fieldName: string): ParsedField | null {
  const line = codeOnly(modelBody(model))
    .split('\n')
    .map((row) => row.trim())
    .find((row) => new RegExp(`^${fieldName}\\s`).test(row));
  if (line === undefined) return null;

  const decl = new RegExp(`^${fieldName}\\s+([A-Za-z_][A-Za-z0-9_]*)(\\[\\])?(\\?)?`).exec(line);
  if (decl === null) return null;

  const list = (name: string): readonly string[] | null => {
    const found = new RegExp(`${name}:\\s*\\[([^\\]]*)\\]`).exec(line);
    if (found === null) return null;
    return (found[1] ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
  };

  return {
    name: fieldName,
    type: decl[1] ?? '',
    isList: decl[2] === '[]',
    isOptional: decl[3] === '?',
    relationName: /@relation\(\s*"([^"]+)"/.exec(line)?.[1] ?? null,
    fields: list('fields'),
    references: list('references'),
    onDelete: /onDelete:\s*([A-Za-z]+)/.exec(line)?.[1] ?? null,
    onUpdate: /onUpdate:\s*([A-Za-z]+)/.exec(line)?.[1] ?? null,
  };
}

/** 모델의 `@@unique([...])` 블록을 필드 배열의 배열로 돌려준다. */
function compositeUniques(model: string): string[][] {
  return [...codeOnly(modelBody(model)).matchAll(/@@unique\(\s*\[([^\]]*)\]/g)].map((match) =>
    (match[1] ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
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
    // ✏️ **T2-2 landing** — W-D18 이 "T09 authoritative schema landing 시
    //    추가한다" 고 유예해 둔 두 inverse 다. ⛔ scalar 컬럼은 늘지 않았다.
    'inventoryLedgerEntries',
    'inventoryBalances',
  ] as const;

  it('scalar + relation 필드 집합이 정확히 일치한다', () => {
    expect(fieldNames('Warehouse')).toEqual([...SCALARS, ...RELATIONS]);
  });

  it('★ scalar 컬럼은 T08-1 확정분 12개 그대로다 (T2-2 가 늘리지 않았다)', () => {
    expect(SCALARS).toHaveLength(12);
    const relationSet = new Set<string>(RELATIONS);
    expect(fieldNames('Warehouse').filter((name) => !relationSet.has(name))).toEqual([...SCALARS]);
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
      'defaultForWarehouse',
      // ✏️ **T2-2 landing** — 재고 두 모델이 `(warehouseId, locationId)`
      //    composite FK 로 이 모델을 참조한다. relation field 일 뿐 컬럼은 그대로다.
      'inventoryLedgerEntries',
      'inventoryBalances',
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

describe('S5 · S6 · D · E. composite UNIQUE — source · target', () => {
  it('S5. business unique — WarehouseLocation (warehouseId, locationCode)', () => {
    expect(compositeUniques('WarehouseLocation')).toContainEqual(['warehouseId', 'locationCode']);
  });

  it('S6 · E. ★ target composite unique — WarehouseLocation (warehouseId, id) (W-D6)', () => {
    // ⛔ 이 UNIQUE 를 지우면 `warehouse (id, default_location_id)` FK 를
    //    걸 수 없다. business identity 가 아니라 **참조 대상**이다.
    expect(compositeUniques('WarehouseLocation')).toContainEqual(['warehouseId', 'id']);
  });

  it('D. ★ source composite unique — Warehouse (id, defaultLocationId)', () => {
    // ★ 성능용 인덱스가 아니라 **1:1 cardinality 선언**이다.
    //   `id` 가 PK 라 DB 논리상 중복이지만, Prisma 가 multi-field 1:1 을
    //   인정하려면 source relation scalar 집합에 `@@unique` 가 있어야 한다.
    //   없으면 inverse 를 `Warehouse[]` 로밖에 선언할 수 없어 ORM cardinality
    //   가 DB 불변식보다 느슨해진다.
    expect(compositeUniques('Warehouse')).toContainEqual(['id', 'defaultLocationId']);
  });

  it('★ 두 UNIQUE 의 필드 순서가 relation 의 fields/references 와 정확히 대응한다', () => {
    const relation = parseField('Warehouse', 'defaultLocation');
    expect(relation).not.toBeNull();

    // source UNIQUE == relation fields
    expect(compositeUniques('Warehouse')).toContainEqual([...(relation?.fields ?? [])]);
    // target UNIQUE == relation references
    expect(compositeUniques('WarehouseLocation')).toContainEqual([...(relation?.references ?? [])]);
  });
});

// ═══════════════════════════════════════════════════════════════
// S7 · A · B · C · F — same-warehouse composite relation, 1:1
// ═══════════════════════════════════════════════════════════════

describe('S7 · A · F. Warehouse.defaultLocation (W-D6)', () => {
  it('A · F. ★ singular required 이고 fields/references 가 정확하다', () => {
    const field = parseField('Warehouse', 'defaultLocation');

    expect(field, 'Warehouse.defaultLocation relation 이 없다').not.toBeNull();
    expect(field?.type).toBe('WarehouseLocation');
    // A — singular. ⛔ 목록이 아니다.
    expect(field?.isList).toBe(false);
    // relation scalar(`defaultLocationId`) 가 NOT NULL 이므로 required 다.
    expect(field?.isOptional).toBe(false);

    // F — composite relation 의 열 대응이 W-D6 그대로다.
    expect(field?.fields).toEqual(['id', 'defaultLocationId']);
    expect(field?.references).toEqual(['warehouseId', 'id']);
    expect(field?.onDelete).toBe('Restrict');
    expect(field?.onUpdate).toBe('Cascade');
  });

  it('⛔ 단일 열 FK(`defaultLocationId → id`)로 축약하지 않았다', () => {
    // 단일 FK 면 **다른 창고의** 로케이션을 default 로 지정할 수 있다.
    const field = parseField('Warehouse', 'defaultLocation');
    expect(field?.fields).not.toEqual(['defaultLocationId']);
    expect(field?.references).not.toEqual(['id']);
  });
});

describe('B · C. WarehouseLocation inverse 는 optional singular 다', () => {
  it('B. ★ defaultForWarehouse 는 `Warehouse?` 다 — 배열이 아니다', () => {
    const field = parseField('WarehouseLocation', 'defaultForWarehouse');

    expect(field, 'WarehouseLocation.defaultForWarehouse relation 이 없다').not.toBeNull();
    expect(field?.type).toBe('Warehouse');
    // ★ 핵심 — 목록이면 ORM cardinality 가 DB 불변식보다 느슨해진다.
    expect(field?.isList).toBe(false);
    // relation scalar 가 없는 inverse 이므로 Prisma 1:1 규칙상 optional 이다.
    expect(field?.isOptional).toBe(true);
    expect(field?.relationName).toBe('WarehouseDefaultLocation');
  });

  it('C. ⛔ `defaultForWarehouses Warehouse[]` 가 남아 있지 않다', () => {
    expect(fieldNames('WarehouseLocation')).not.toContain('defaultForWarehouses');
    // 모델 전체에서 이 relation 이 목록으로 선언된 곳이 없다.
    expect(codeOnly(modelBody('WarehouseLocation'))).not.toMatch(/Warehouse\[\]/);
  });

  it('★ 두 방향의 relation name 이 같다 — Prisma 가 짝으로 인식한다', () => {
    expect(parseField('Warehouse', 'defaultLocation')?.relationName).toBe(
      parseField('WarehouseLocation', 'defaultForWarehouse')?.relationName,
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

/**
 * ✏️ **2026-08-26 (T2-2)**: 이 블록은 원래 "T09 재고 모델이 **아직** 없다" 를
 *    고정하던 scope guard 였다. `T2-2`(= legacy `T09-1`)가 바로 그 모델을
 *    landing 시키는 task 이므로 — W-D18 이 "T09 authoritative schema landing 시
 *    추가한다" 고 명시한 그 시점이다 — guard 를 **방향만 뒤집어** 유지한다.
 *    ⛔ 삭제하지 않는다: 지금 지키는 것은 "재고 모델은 **T2-2 소유**이고
 *       Warehouse 쪽에는 relation 말고 **컬럼이 늘지 않았다**" 는 계약이다.
 */
describe('S10. ✏️ T09 재고 모델은 T2-2 가 landing 시킨다 (W-D18 · W-D40)', () => {
  it('✏️ Inventory 3모델이 이제 존재한다 — T2-2 소유', () => {
    for (const model of ['InventoryTransaction', 'InventoryLedgerEntry', 'InventoryBalance']) {
      expect(SCHEMA_SOURCE, model).toMatch(new RegExp(`^\\s*model\\s+${model}\\b`, 'm'));
    }
  });

  it('⛔ posting service 계열 model 은 여전히 없다 (T2-5 이후)', () => {
    for (const model of ['InventoryPosting', 'BalanceRebuildSnapshot', 'InventoryException']) {
      expect(SCHEMA_SOURCE, model).not.toMatch(new RegExp(`^\\s*model\\s+${model}\\b`, 'm'));
    }
  });

  it('★ Warehouse inverse 이름은 T2-2 가 정한 것뿐이다 — 초안 이름을 쓰지 않았다', () => {
    const names = fieldNames('Warehouse');
    // `docs/03` 초안의 `ledgerEntries`·`balances` 가 아니라 모듈 접두를 붙였다.
    expect(names).not.toContain('ledgerEntries');
    expect(names).not.toContain('balances');
    expect(names).toContain('inventoryLedgerEntries');
    expect(names).toContain('inventoryBalances');
  });

  it('★★ Warehouse · WarehouseLocation 에 재고 scalar 컬럼이 늘지 않았다', () => {
    // relation field 는 DB 컬럼이 아니다. 재고 캐시 컬럼을 마스터에 두지 않는다.
    for (const model of ['Warehouse', 'WarehouseLocation']) {
      const body = codeOnly(modelBody(model));
      for (const forbidden of ['quantity', 'stock', 'onHand', 'inventoryQty', 'skuCount']) {
        expect(body.toLowerCase(), `${model}.${forbidden}`).not.toContain(forbidden.toLowerCase());
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 범위 밖 — T08-2 / T2-20 산출물이 하나도 없다 (W-D1)
// ═══════════════════════════════════════════════════════════════

describe('범위 경계 — T08-2 는 landing, UI 는 여전히 T2-20 (W-D1 · W-D28)', () => {
  const exists = (relative: string): boolean => {
    try {
      readFileSync(fileURLToPath(new URL(relative, import.meta.url)));
      return true;
    } catch {
      return false;
    }
  };

  // ⚠️ 아래 둘은 T08-1 당시 "아직 없다" 를 고정했던 단언이다. **T08-2 가
  //    구현하면서 방향이 반대로 바뀌었다** — staged-state supersession 이며
  //    T08-1 의 schema/constraint 검증 의미와는 무관하다.
  it('★ Warehouse API route 가 landing 했다 (T08-2)', () => {
    expect(exists('../src/app/api/warehouses/route.ts')).toBe(true);
  });

  it('★ Warehouse application module 이 landing 했다 (T08-2)', () => {
    expect(exists('../src/modules/warehouse/application/dto.ts')).toBe(true);
  });

  // ★ 이 단언은 **그대로 유지된다** — UI 는 `T2-20` 이고 T08-2 범위가 아니다.
  it('⛔ Warehouse 화면은 여전히 없다 (T2-20, W-D28)', () => {
    expect(exists('../src/app/master/warehouses/page.tsx')).toBe(false);
  });
});
