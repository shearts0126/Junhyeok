import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 재고 코어 **스키마 계약** 테스트 (T2-2 = legacy `T09-1`).
 *
 * 근거: `docs/03_ERD와_Prisma스키마_v0.2.md` §Layer 3 — 재고 코어 ★
 *       `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8·§9
 *       `docs/00_요구사항_이해와_충돌검토_v0.2.md` C-09 · C-10 · C-14
 *
 * ★ 이 파일은 DB 없이 **`schema.prisma`·migration 원문**만 본다.
 *   카탈로그가 실제로 그렇게 만들어졌는지는 `tests/db/inventory-schema.test.ts`
 *   가 본다. 둘 다 필요하다 — drift gate 는 CHECK·부분 인덱스·트리거를 보지
 *   못하고, 반대로 카탈로그 테스트는 "필드를 더 만들지 않았는가" 를 보기에
 *   불편하다 (T08-1 선례와 같은 2층 구조).
 *
 * ⛔ T2-2 는 schema foundation 까지다. posting service · balance 갱신 · 원장
 *    생성 · 현재고 조회 · UI 는 T2-5 이후이며 여기서는 **없다는 사실만** 고정한다.
 */

const ROOT = new URL('../', import.meta.url);

const SCHEMA_SOURCE = readFileSync(fileURLToPath(new URL('prisma/schema.prisma', ROOT)), 'utf8');

const MIGRATION_SOURCE = readFileSync(
  fileURLToPath(new URL('prisma/migrations/20260826075927_add_inventory_core/migration.sql', ROOT)),
  'utf8',
);

/**
 * `--` 주석을 뺀 **실행 SQL 만** 남긴다.
 *
 * ⛔ 금지어 검사를 주석 위에서 하면, "이것을 만들지 않는다" 고 설명하는 주석
 *    자체가 테스트를 실패시킨다 (T08-1 이 남긴 것과 같은 함정).
 */
const MIGRATION_CODE = MIGRATION_SOURCE.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

/** 실행 SQL 을 statement 단위로 쪼갠다 (`$$` 본문은 하나로 유지). */
function statements(): string[] {
  const withoutBodies = MIGRATION_CODE.replace(/\$\$[\s\S]*?\$\$/g, '$$BODY$$');
  return withoutBodies
    .split(';')
    .map((statement) => statement.trim().replace(/\s+/g, ' '))
    .filter((statement) => statement.length > 0);
}

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
 *    테스트를 실패시킨다 (T08-1 선례).
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

interface ParsedField {
  readonly name: string;
  readonly type: string;
  readonly isList: boolean;
  readonly isOptional: boolean;
  readonly relationName: string | null;
  readonly fields: readonly string[] | null;
  readonly references: readonly string[] | null;
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
  /** `@db.*` 네이티브 타입 (예: `Decimal(18, 6)`). */
  readonly dbType: string | null;
  /** `@default(...)` 안쪽 원문. */
  readonly defaultValue: string | null;
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
    dbType: /@db\.([A-Za-z]+(?:\([^)]*\))?)/.exec(line)?.[1] ?? null,
    defaultValue:
      /@default\(([\s\S]*?)\)\s*@map/.exec(line)?.[1] ??
      /@default\(([^)]*)\)/.exec(line)?.[1] ??
      null,
  };
}

/** enum 값을 선언 순서대로 뽑는다. */
function enumValues(name: string): string[] {
  const match = new RegExp(`^enum\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA_SOURCE);
  expect(match, `enum ${name} 이 schema.prisma 에 없다`).not.toBeNull();
  return codeOnly(match![1] ?? '')
    .split(/[\s\n]+/)
    .map((token) => token.trim())
    .filter((token) => /^[A-Z][A-Z0-9_]*$/.test(token));
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

/** 모델의 `@@index([...])` 블록. */
function indexes(model: string): string[][] {
  return [...codeOnly(modelBody(model)).matchAll(/@@index\(\s*\[([^\]]*)\]/g)].map((match) =>
    (match[1] ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

const INVENTORY_MODELS = ['InventoryTransaction', 'InventoryLedgerEntry', 'InventoryBalance'];

// ═══════════════════════════════════════════════════════════════
// I1 — 모델 경계
// ═══════════════════════════════════════════════════════════════

describe('I1. T2-2 가 소유하는 모델은 정확히 3개다', () => {
  it('3개 모두 존재한다', () => {
    for (const model of INVENTORY_MODELS) {
      expect(modelBody(model).length, model).toBeGreaterThan(0);
    }
  });

  it('★★ BalanceRebuildSnapshot 을 만들지 않았다 — T2-19 소유다', () => {
    expect(SCHEMA_SOURCE).not.toMatch(/^model\s+BalanceRebuildSnapshot\s*\{/m);
  });

  it('⛔ InventoryException(T2-14) · OpeningBalanceBatch(T11-1) 도 만들지 않았다', () => {
    expect(SCHEMA_SOURCE).not.toMatch(/^model\s+InventoryException\s*\{/m);
    expect(SCHEMA_SOURCE).not.toMatch(/^model\s+OpeningBalanceBatch\s*\{/m);
    expect(SCHEMA_SOURCE).not.toMatch(/^model\s+OpeningBalanceLine\s*\{/m);
  });

  it('⛔ 미래 참조 대상(Channel · Attachment)을 placeholder 로 만들지 않았다', () => {
    expect(SCHEMA_SOURCE).not.toMatch(/^model\s+Channel\s*\{/m);
    expect(SCHEMA_SOURCE).not.toMatch(/^model\s+Attachment\s*\{/m);
  });
});

// ═══════════════════════════════════════════════════════════════
// I2 — enum 4종 exact freeze
// ═══════════════════════════════════════════════════════════════

describe('I2. enum 4종 — 값·순서 exact', () => {
  it('InventoryStatus — 정확히 9종', () => {
    expect(enumValues('InventoryStatus')).toEqual([
      'AVAILABLE',
      'RESERVED',
      'OUTBOUND_PENDING',
      'HOLD',
      'INSPECTION',
      'DEFECTIVE',
      'RETURN_PENDING',
      'DISPOSAL_PENDING',
      'IN_TRANSIT',
    ]);
  });

  it('★★ TransactionType — 정확히 24종 (23 이 아니다)', () => {
    const values = enumValues('TransactionType');
    expect(values).toHaveLength(24);
    expect(values).toEqual([
      'OPENING_BALANCE',
      'PURCHASE_RECEIPT',
      'PRODUCTION_RECEIPT',
      'RETURN_RECEIPT',
      'WAREHOUSE_TRANSFER_IN',
      'ASSEMBLY_RECEIPT',
      'DISASSEMBLY_RECEIPT',
      'SALES_SHIPMENT',
      'B2B_SHIPMENT',
      'MARKETING_SHIPMENT',
      'CS_SHIPMENT',
      'SAMPLE_SHIPMENT',
      'EMPLOYEE_USE',
      'VENDOR_RETURN',
      'DISPOSAL',
      'WAREHOUSE_TRANSFER_OUT',
      'ASSEMBLY_CONSUMPTION',
      'DISASSEMBLY_CONSUMPTION',
      'STATUS_CHANGE',
      'STOCK_COUNT_ADJUSTMENT',
      'MANUAL_ADJUSTMENT',
      'REVERSAL',
      'RESERVATION',
      'RESERVATION_RELEASE',
    ]);
  });

  it('TransactionStatus — 정확히 2종', () => {
    expect(enumValues('TransactionStatus')).toEqual(['POSTED', 'REVERSED']);
  });

  it('OutboundPurpose — 정확히 8종', () => {
    expect(enumValues('OutboundPurpose')).toEqual([
      'SALES_B2C',
      'SALES_B2B',
      'WAREHOUSE_REPLENISHMENT',
      'MARKETING',
      'CS',
      'SAMPLE',
      'EMPLOYEE_USE',
      'OTHER',
    ]);
  });

  it('★ InventoryStatus.IN_TRANSIT 과 WarehouseType.IN_TRANSIT 은 별개 enum 이다', () => {
    // 이름만 같다. 어느 쪽도 상대 타입을 재사용하지 않는다.
    expect(enumValues('WarehouseType')).toContain('IN_TRANSIT');
    expect(enumValues('InventoryStatus')).toContain('IN_TRANSIT');
    expect(parseField('InventoryLedgerEntry', 'inventoryStatus')?.type).toBe('InventoryStatus');
    expect(parseField('InventoryBalance', 'inventoryStatus')?.type).toBe('InventoryStatus');
  });
});

// ═══════════════════════════════════════════════════════════════
// I3 — InventoryTransaction
// ═══════════════════════════════════════════════════════════════

describe('I3. InventoryTransaction', () => {
  it('scalar 필드가 문서 원문과 정확히 같다 (더도 덜도 없이)', () => {
    const relations = [
      'reversalOf',
      'reversedBy',
      'externalSystem',
      'creator',
      'approver',
      'entries',
      'lastForBalances',
    ];
    expect(fieldNames('InventoryTransaction').filter((name) => !relations.includes(name))).toEqual([
      'id',
      'transactionNo',
      'transactionType',
      'status',
      'occurredAt',
      'businessDate',
      'postedAt',
      'importedAt',
      'sourceDocumentType',
      'sourceDocumentId',
      'sourceDocumentNo',
      'externalSystemId',
      'externalTransactionId',
      'idempotencyKey',
      'reversalOfId',
      'reasonCode',
      'reasonDetail',
      'attachmentGroupId',
      'createdBy',
      'approvedBy',
      'createdAt',
    ]);
  });

  it('transactionNo — NOT NULL · UNIQUE · VarChar(50)', () => {
    const field = parseField('InventoryTransaction', 'transactionNo');
    expect(field?.type).toBe('String');
    expect(field?.isOptional).toBe(false);
    expect(field?.dbType).toBe('VarChar(50)');
    expect(codeOnly(modelBody('InventoryTransaction'))).toMatch(/transactionNo\s+String\s+@unique/);
  });

  it('★★ transactionNo 채번을 만들지 않았다 — default·sequence·generator 0 (LATER)', () => {
    expect(parseField('InventoryTransaction', 'transactionNo')?.defaultValue).toBeNull();
    // migration 에도 sequence·generated column 이 없다.
    expect(MIGRATION_SOURCE).not.toMatch(/CREATE\s+SEQUENCE/i);
    expect(MIGRATION_SOURCE).not.toMatch(/transaction_no[^\n]*DEFAULT/i);
    expect(MIGRATION_SOURCE).not.toMatch(/GENERATED\s+ALWAYS/i);
  });

  it('status — TransactionStatus, default POSTED (C-10: 집계 필터용이 아니다)', () => {
    const field = parseField('InventoryTransaction', 'status');
    expect(field?.type).toBe('TransactionStatus');
    expect(field?.isOptional).toBe(false);
    expect(field?.defaultValue).toBe('POSTED');
  });

  it('businessDate — Date NOT NULL. ⛔ 파생 로직·Warehouse.timezone 연결 없음 (T2-4)', () => {
    const field = parseField('InventoryTransaction', 'businessDate');
    expect(field?.dbType).toBe('Date');
    expect(field?.isOptional).toBe(false);
    expect(field?.defaultValue).toBeNull();
    expect(codeOnly(modelBody('InventoryTransaction'))).not.toContain('timezone');
  });

  it('createdBy 는 NOT NULL, approvedBy/externalSystemId/reversalOfId 는 nullable', () => {
    expect(parseField('InventoryTransaction', 'createdBy')?.isOptional).toBe(false);
    expect(parseField('InventoryTransaction', 'approvedBy')?.isOptional).toBe(true);
    expect(parseField('InventoryTransaction', 'externalSystemId')?.isOptional).toBe(true);
    expect(parseField('InventoryTransaction', 'reversalOfId')?.isOptional).toBe(true);
  });

  it('★ index 정확히 4개', () => {
    expect(indexes('InventoryTransaction')).toEqual([
      ['businessDate'],
      ['transactionType', 'businessDate'],
      ['sourceDocumentType', 'sourceDocumentId'],
      ['externalSystemId', 'externalTransactionId'],
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// I4 — InventoryLedgerEntry
// ═══════════════════════════════════════════════════════════════

describe('I4. InventoryLedgerEntry', () => {
  it('scalar 필드가 문서 원문과 정확히 같다', () => {
    const relations = ['transaction', 'sku', 'warehouse', 'location'];
    expect(fieldNames('InventoryLedgerEntry').filter((name) => !relations.includes(name))).toEqual([
      'id',
      'transactionId',
      'lineNo',
      'skuId',
      'warehouseId',
      'locationId',
      'inventoryStatus',
      'lotNo',
      'expiryKey',
      'serialNo',
      'ownerCode',
      'expiryDate',
      'manufacturedDate',
      'quantityDelta',
      'baseUom',
      'originalQuantity',
      'originalUom',
      'conversionFactor',
      'channelId',
      'outboundPurpose',
      'externalLineId',
      'note',
      'businessDate',
      'occurredAt',
      'createdAt',
    ]);
  });

  it('★★ 센티넬 4종 (C-09) — 재고키에 NULL 이 들어가지 않는다', () => {
    expect(parseField('InventoryLedgerEntry', 'lotNo')?.defaultValue).toBe('""');
    expect(parseField('InventoryLedgerEntry', 'serialNo')?.defaultValue).toBe('""');
    expect(parseField('InventoryLedgerEntry', 'ownerCode')?.defaultValue).toBe('"DEEPPOINT"');
    // ★ drift-safe 표현 — schema·migration·DB 세 층이 같은 식을 쓴다.
    expect(parseField('InventoryLedgerEntry', 'expiryKey')?.defaultValue).toBe(
      `dbgenerated("'9999-12-31'::date")`,
    );

    // 재고키 8열은 전부 NOT NULL 이어야 한다.
    for (const key of [
      'skuId',
      'warehouseId',
      'locationId',
      'inventoryStatus',
      'lotNo',
      'expiryKey',
      'serialNo',
      'ownerCode',
    ]) {
      expect(parseField('InventoryLedgerEntry', key)?.isOptional, key).toBe(false);
    }
  });

  it('★ expiryDate 는 표시용이라 nullable 을 유지한다 (expiryKey 와 다르다)', () => {
    expect(parseField('InventoryLedgerEntry', 'expiryDate')?.isOptional).toBe(true);
    expect(parseField('InventoryLedgerEntry', 'expiryDate')?.dbType).toBe('Date');
  });

  it('★★ signed quantity — Decimal(18,6). direction/movementType enum 없음', () => {
    const field = parseField('InventoryLedgerEntry', 'quantityDelta');
    expect(field?.type).toBe('Decimal');
    expect(field?.isOptional).toBe(false);
    expect(field?.dbType).toBe('Decimal(18, 6)');

    expect(SCHEMA_SOURCE).not.toMatch(/^enum\s+(MovementType|LedgerDirection|Direction)\s*\{/m);
    const body = codeOnly(modelBody('InventoryLedgerEntry'));
    expect(body).not.toMatch(/\bdirection\b/);
    expect(body).not.toMatch(/\bmovementType\b/);
  });

  it('originalQuantity · conversionFactor 도 Decimal(18,6) nullable', () => {
    for (const name of ['originalQuantity', 'conversionFactor']) {
      const field = parseField('InventoryLedgerEntry', name);
      expect(field?.type, name).toBe('Decimal');
      expect(field?.isOptional, name).toBe(true);
      expect(field?.dbType, name).toBe('Decimal(18, 6)');
    }
  });

  it('UNIQUE 는 (transactionId, lineNo) 하나뿐', () => {
    expect(compositeUniques('InventoryLedgerEntry')).toEqual([['transactionId', 'lineNo']]);
  });

  it('★ index 정확히 3개 — 재고키 집계 index 에 locationId 를 넣지 않았다', () => {
    expect(indexes('InventoryLedgerEntry')).toEqual([
      [
        'skuId',
        'warehouseId',
        'inventoryStatus',
        'lotNo',
        'expiryKey',
        'serialNo',
        'ownerCode',
        'businessDate',
      ],
      ['warehouseId', 'businessDate'],
      ['businessDate', 'transactionId'],
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// I5 — InventoryBalance
// ═══════════════════════════════════════════════════════════════

describe('I5. InventoryBalance', () => {
  it('scalar 필드가 문서 원문과 정확히 같다', () => {
    const relations = ['sku', 'warehouse', 'location', 'lastTransaction'];
    expect(fieldNames('InventoryBalance').filter((name) => !relations.includes(name))).toEqual([
      'id',
      'skuId',
      'warehouseId',
      'locationId',
      'inventoryStatus',
      'lotNo',
      'expiryKey',
      'serialNo',
      'ownerCode',
      'quantity',
      'lastTransactionId',
      'updatedAt',
      'lockVersion',
    ]);
  });

  it('★★ 수량 필드는 quantity 하나뿐 — 파생 수량 컬럼을 만들지 않았다', () => {
    const field = parseField('InventoryBalance', 'quantity');
    expect(field?.type).toBe('Decimal');
    expect(field?.dbType).toBe('Decimal(18, 6)');
    expect(field?.defaultValue).toBe('0');

    for (const forbidden of [
      'onHandQty',
      'availableQty',
      'reservedQty',
      'physicalQty',
      'totalQty',
    ]) {
      expect(fieldNames('InventoryBalance'), forbidden).not.toContain(forbidden);
    }
  });

  it('★★ quantity >= 0 CHECK 를 만들지 않았다 — 음수재고는 runtime 규칙이다', () => {
    expect(MIGRATION_SOURCE).not.toMatch(/quantity"?\s*>=\s*0/);
    expect(MIGRATION_SOURCE).not.toMatch(/ck_quantity_nonnegative|ck_balance_nonnegative/i);
  });

  it('★★ stock_key — 8열, 순서 고정, Prisma name·DB map 둘 다 stock_key', () => {
    expect(compositeUniques('InventoryBalance')).toEqual([
      [
        'skuId',
        'warehouseId',
        'locationId',
        'inventoryStatus',
        'lotNo',
        'expiryKey',
        'serialNo',
        'ownerCode',
      ],
    ]);
    const body = codeOnly(modelBody('InventoryBalance'));
    expect(body).toMatch(/name:\s*"stock_key"/);
    expect(body).toMatch(/map:\s*"stock_key"/);
    expect(MIGRATION_SOURCE).toMatch(/CREATE UNIQUE INDEX "stock_key" ON "inventory_balance"/);
  });

  it('★ index 정확히 2개 — (skuId, warehouseId) 중복 index 를 만들지 않았다', () => {
    expect(indexes('InventoryBalance')).toEqual([['skuId'], ['warehouseId', 'inventoryStatus']]);
    expect(MIGRATION_SOURCE).not.toMatch(
      /CREATE INDEX[^\n]*ON "inventory_balance"\("sku_id", "warehouse_id"\)/,
    );
  });

  it('lockVersion — Int default 0 (그룹 갱신 1회 기준)', () => {
    expect(parseField('InventoryBalance', 'lockVersion')?.type).toBe('Int');
    expect(parseField('InventoryBalance', 'lockVersion')?.defaultValue).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════════════
// I6 — 관계 · FK action
// ═══════════════════════════════════════════════════════════════

describe('I6. 관계 12종 — 전부 Restrict / Cascade', () => {
  const OWNING: ReadonlyArray<readonly [string, string, string]> = [
    ['InventoryTransaction', 'reversalOf', 'InventoryTransaction'],
    ['InventoryTransaction', 'externalSystem', 'ExternalSystem'],
    ['InventoryTransaction', 'creator', 'User'],
    ['InventoryTransaction', 'approver', 'User'],
    ['InventoryLedgerEntry', 'transaction', 'InventoryTransaction'],
    ['InventoryLedgerEntry', 'sku', 'Sku'],
    ['InventoryLedgerEntry', 'warehouse', 'Warehouse'],
    ['InventoryLedgerEntry', 'location', 'WarehouseLocation'],
    ['InventoryBalance', 'sku', 'Sku'],
    ['InventoryBalance', 'warehouse', 'Warehouse'],
    ['InventoryBalance', 'location', 'WarehouseLocation'],
    ['InventoryBalance', 'lastTransaction', 'InventoryTransaction'],
  ];

  it('owning relation 이 정확히 12개다', () => {
    expect(OWNING).toHaveLength(12);
    // migration 의 AddForeignKey 도 12개여야 한다.
    expect(MIGRATION_SOURCE.match(/-- AddForeignKey/g) ?? []).toHaveLength(12);
  });

  it('★★ 12개 전부 onDelete: Restrict · onUpdate: Cascade 를 명시한다', () => {
    for (const [model, field, target] of OWNING) {
      const parsed = parseField(model, field);
      expect(parsed, `${model}.${field}`).not.toBeNull();
      expect(parsed!.type, `${model}.${field}`).toBe(target);
      // ⛔ Prisma default 에 암묵적으로 맡기지 않는다.
      expect(parsed!.onDelete, `${model}.${field} onDelete`).toBe('Restrict');
      expect(parsed!.onUpdate, `${model}.${field} onUpdate`).toBe('Cascade');
    }
  });

  it('migration SQL 도 12개 전부 RESTRICT / CASCADE 다', () => {
    const fkLines = MIGRATION_SOURCE.split('\n').filter((line) => line.includes('FOREIGN KEY'));
    expect(fkLines).toHaveLength(12);
    for (const line of fkLines) {
      expect(line).toContain('ON DELETE RESTRICT');
      expect(line).toContain('ON UPDATE CASCADE');
    }
  });

  it('★★ location 은 composite FK — (warehouseId, locationId) → (warehouseId, id)', () => {
    for (const model of ['InventoryLedgerEntry', 'InventoryBalance']) {
      const parsed = parseField(model, 'location');
      expect(parsed?.fields, model).toEqual(['warehouseId', 'locationId']);
      expect(parsed?.references, model).toEqual(['warehouseId', 'id']);
      expect(parsed?.isOptional, model).toBe(false);
    }

    // ⛔ 단일 FK 로 바뀌지 않았다 — 그러면 다른 창고의 로케이션을 넣을 수 있다.
    expect(MIGRATION_SOURCE).not.toMatch(
      /FOREIGN KEY \("location_id"\) REFERENCES "warehouse_location"/,
    );
    expect(MIGRATION_SOURCE).toMatch(
      /ALTER TABLE "inventory_ledger_entry" ADD CONSTRAINT "inventory_ledger_entry_warehouse_id_location_id_fkey" FOREIGN KEY \("warehouse_id", "location_id"\) REFERENCES "warehouse_location"\("warehouse_id", "id"\)/,
    );
    expect(MIGRATION_SOURCE).toMatch(
      /ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_warehouse_id_location_id_fkey" FOREIGN KEY \("warehouse_id", "location_id"\) REFERENCES "warehouse_location"\("warehouse_id", "id"\)/,
    );
  });

  it('★★ scalar-only 3종에 relation 을 만들지 않았다', () => {
    // 대상 모델이 없거나(Channel·Attachment) generic reference(sourceDocument)다.
    expect(fieldNames('InventoryTransaction')).not.toContain('sourceDocument');
    expect(fieldNames('InventoryTransaction')).not.toContain('attachmentGroup');
    expect(fieldNames('InventoryLedgerEntry')).not.toContain('channel');

    expect(MIGRATION_SOURCE).not.toMatch(/FOREIGN KEY \("source_document_id"\)/);
    expect(MIGRATION_SOURCE).not.toMatch(/FOREIGN KEY \("attachment_group_id"\)/);
    expect(MIGRATION_SOURCE).not.toMatch(/FOREIGN KEY \("channel_id"\)/);
  });

  it('creator / approver 는 named relation 으로 구분된다', () => {
    expect(parseField('InventoryTransaction', 'creator')?.relationName).toBe(
      'InventoryTransactionCreatedBy',
    );
    expect(parseField('InventoryTransaction', 'approver')?.relationName).toBe(
      'InventoryTransactionApprovedBy',
    );
    expect(parseField('InventoryTransaction', 'creator')?.isOptional).toBe(false);
    expect(parseField('InventoryTransaction', 'approver')?.isOptional).toBe(true);
  });

  it('reversal self relation — optional, 목록 inverse', () => {
    expect(parseField('InventoryTransaction', 'reversalOf')?.isOptional).toBe(true);
    expect(parseField('InventoryTransaction', 'reversedBy')?.isList).toBe(true);
    expect(parseField('InventoryTransaction', 'reversedBy')?.relationName).toBe('Reversal');
  });
});

// ═══════════════════════════════════════════════════════════════
// I7 — 기존 모델의 reverse relation (컬럼 추가 0)
// ═══════════════════════════════════════════════════════════════

describe('I7. reverse relation 만 추가했다 — 기존 테이블 SQL 변경 0', () => {
  it('Sku · Warehouse · WarehouseLocation · ExternalSystem · User 에 목록 inverse 가 있다', () => {
    const expected: ReadonlyArray<readonly [string, string, string]> = [
      ['Sku', 'inventoryLedgerEntries', 'InventoryLedgerEntry'],
      ['Sku', 'inventoryBalances', 'InventoryBalance'],
      ['Warehouse', 'inventoryLedgerEntries', 'InventoryLedgerEntry'],
      ['Warehouse', 'inventoryBalances', 'InventoryBalance'],
      ['WarehouseLocation', 'inventoryLedgerEntries', 'InventoryLedgerEntry'],
      ['WarehouseLocation', 'inventoryBalances', 'InventoryBalance'],
      ['ExternalSystem', 'inventoryTransactions', 'InventoryTransaction'],
      ['User', 'createdInventoryTransactions', 'InventoryTransaction'],
      ['User', 'approvedInventoryTransactions', 'InventoryTransaction'],
    ];
    for (const [model, field, type] of expected) {
      const parsed = parseField(model, field);
      expect(parsed, `${model}.${field}`).not.toBeNull();
      expect(parsed!.isList, `${model}.${field}`).toBe(true);
      expect(parsed!.type, `${model}.${field}`).toBe(type);
      // inverse 쪽은 relation scalar 를 갖지 않는다 = 컬럼이 늘지 않는다.
      expect(parsed!.fields, `${model}.${field}`).toBeNull();
    }
  });

  it('★★ migration 에 기존 테이블 ALTER (컬럼·제약 변경) 가 없다', () => {
    const alters = MIGRATION_SOURCE.split('\n').filter((line) => line.startsWith('ALTER TABLE'));
    // ALTER 는 신규 3테이블의 FK·CHECK 추가뿐이어야 한다.
    for (const line of alters) {
      expect(line).toMatch(/ALTER TABLE "inventory_(transaction|ledger_entry|balance)"/);
    }
    for (const existing of ['warehouse', 'warehouse_location', 'sku', 'external_system', 'user']) {
      expect(MIGRATION_SOURCE, existing).not.toMatch(
        new RegExp(`ALTER TABLE "${existing}"\\s+(ADD|DROP|ALTER) COLUMN`),
      );
    }
    expect(MIGRATION_SOURCE).not.toMatch(/DROP TABLE|DROP CONSTRAINT|DROP INDEX/);
  });

  it('T08-1 의 (warehouseId, id) UNIQUE 가 그대로 있다 — composite FK 의 참조 대상', () => {
    expect(compositeUniques('WarehouseLocation')).toContainEqual(['warehouseId', 'id']);
  });
});

// ═══════════════════════════════════════════════════════════════
// I8 — migration raw SQL 계약
// ═══════════════════════════════════════════════════════════════

describe('I8. migration raw SQL', () => {
  it('신규 테이블 3개 · enum 4개', () => {
    expect(MIGRATION_SOURCE.match(/^CREATE TABLE /gm) ?? []).toHaveLength(3);
    expect(MIGRATION_SOURCE.match(/^CREATE TYPE /gm) ?? []).toHaveLength(4);
  });

  it('★★ 조건부 UNIQUE 는 정확히 2종이다 (backlog "3종" 은 문서 오기)', () => {
    // ★ statement 단위로 본다 — 파일 전체 정규식은 `stock_key` 처럼 WHERE 없는
    //   인덱스가 뒤 statement 의 WHERE 를 끌어와 조건부로 오인된다.
    const conditional = statements()
      .filter((statement) => /^CREATE UNIQUE INDEX/.test(statement) && / WHERE /.test(statement))
      .map((statement) => /^CREATE UNIQUE INDEX "([a-z_]+)"/.exec(statement)?.[1]);
    expect(conditional).toEqual(['ux_txn_idem', 'ux_txn_reversal']);
  });

  it('★ UNIQUE 는 총 5종 (그중 조건부 2)', () => {
    const uniques = statements()
      .filter((statement) => /^CREATE UNIQUE INDEX/.test(statement))
      .map((statement) => /^CREATE UNIQUE INDEX "([a-z_]+)"/.exec(statement)?.[1]);
    expect(uniques).toEqual([
      'inventory_transaction_transaction_no_key',
      'inventory_ledger_entry_transaction_id_line_no_key',
      'stock_key',
      'ux_txn_idem',
      'ux_txn_reversal',
    ]);
  });

  it('ux_txn_idem — predicate 원문', () => {
    expect(MIGRATION_SOURCE).toMatch(
      /CREATE UNIQUE INDEX "ux_txn_idem"\s+ON "inventory_transaction" \("idempotency_key"\)\s+WHERE "idempotency_key" IS NOT NULL;/,
    );
  });

  it('ux_txn_reversal — status = POSTED 조건 포함', () => {
    expect(MIGRATION_SOURCE).toMatch(
      /CREATE UNIQUE INDEX "ux_txn_reversal"\s+ON "inventory_transaction" \("reversal_of_id"\)\s+WHERE "reversal_of_id" IS NOT NULL AND "status" = 'POSTED';/,
    );
  });

  it('★ CHECK 는 정확히 2종 — ck_source_doc · ck_qty_nonzero', () => {
    const checks = [...MIGRATION_SOURCE.matchAll(/ADD CONSTRAINT "([a-z_]+)"\s+CHECK/g)].map(
      (match) => match[1],
    );
    expect(checks).toEqual(['ck_source_doc', 'ck_qty_nonzero']);
  });

  it('ix_ledger_channel — 부분 인덱스', () => {
    expect(MIGRATION_SOURCE).toMatch(
      /CREATE INDEX "ix_ledger_channel"\s+ON "inventory_ledger_entry" \("channel_id", "business_date"\)\s+WHERE "channel_id" IS NOT NULL;/,
    );
  });

  it('★★ 불변성 — 전용 함수 + BEFORE UPDATE OR DELETE 트리거', () => {
    expect(MIGRATION_SOURCE).toMatch(/CREATE OR REPLACE FUNCTION raise_immutable_violation\(\)/);
    expect(MIGRATION_SOURCE).toMatch(/RAISE EXCEPTION 'IMMUTABLE_VIOLATION'/);
    expect(MIGRATION_SOURCE).toMatch(
      /CREATE TRIGGER "trg_ledger_immutable"\s+BEFORE UPDATE OR DELETE ON "inventory_ledger_entry"\s+FOR EACH ROW/,
    );
  });

  it('⛔ audit 전용 함수를 재사용·수정하지 않았다', () => {
    // ★ 주석을 뺀 실행 SQL 기준이다 — 재사용하지 않는 **이유**는 주석에 남아 있다.
    expect(MIGRATION_CODE).not.toContain('audit_log_prevent_modification');
    expect(MIGRATION_CODE).not.toContain('AUDIT_LOG_IMMUTABLE');
    expect(MIGRATION_CODE).not.toMatch(/ALTER TABLE "?audit_log"?/);
  });

  it('⛔ TRUNCATE 트리거를 만들지 않았다 (문서는 UPDATE/DELETE 만 명시)', () => {
    expect(MIGRATION_CODE).not.toMatch(/BEFORE TRUNCATE/);
    expect(MIGRATION_CODE).not.toMatch(/FOR EACH STATEMENT/);
    expect(statements().filter((statement) => /^CREATE TRIGGER/.test(statement))).toHaveLength(1);
  });

  it('★★ T2-3 의 REVERSAL 재취소 트리거를 넣지 않았다', () => {
    expect(MIGRATION_CODE).not.toContain('reject_reversal_of_reversal');
    expect(MIGRATION_CODE).not.toContain('trg_no_reversal_of_reversal');
    // 이 migration 이 만드는 함수는 불변성 하나뿐이다.
    expect(
      statements().filter((statement) => /FUNCTION [a-z_]+\(\)$/.test(statement)),
    ).toHaveLength(1);
  });

  it('⛔ session_replication_role 을 쓰지 않았다', () => {
    expect(MIGRATION_CODE).not.toContain('session_replication_role');
  });
});

// ═══════════════════════════════════════════════════════════════
// I9 — 범위 밖 (runtime 0)
// ═══════════════════════════════════════════════════════════════

describe('I9. 범위 밖 — T2-2 는 schema foundation 까지다', () => {
  const missing = (path: string): boolean => {
    try {
      readFileSync(fileURLToPath(new URL(path, ROOT)));
      return false;
    } catch {
      return true;
    }
  };

  /**
   * ✏️ **T2-5 가 landing 시켰다** — 이 guard 는 원래 제목이 *"(T2-5 이후)"* 로
   * 전환 시점을 예고하고 있었다. 삭제·완화가 아니라 **방향을 뒤집는다**:
   * T2-5 가 실제로 만든 것은 `application` 계층 하나뿐이며, 나머지 3계층과
   * posting 관문은 여전히 없어야 한다. (T2-2 landing 때 T08 guard 를 같은
   * 방식으로 전환한 선례와 동일하다.)
   *
   * ★ canonical module root 는 `src/modules/inventory` 다 —
   *   `eslint-rules/inventory-boundary.ts` 의 allowlist 와 일치한다.
   */
  it('★★ T2-5 가 inventory application 계층을 landing 시켰다', () => {
    expect(missing('src/modules/inventory/application/index.ts')).toBe(false);
    expect(missing('src/modules/inventory/application/posting-command.ts')).toBe(false);
    expect(missing('src/modules/inventory/application/validate-posting-command.ts')).toBe(false);
  });

  /**
   * ✏️ **T2-6 이 domain 계층을 landing 시켰다** (Deviation #75).
   *
   * T2-5 시점의 이 guard 는 `domain` 부재를 assert 했다. 삭제·완화가 아니라
   * **방향 전환**이다 — `infrastructure`(T2-9·T2-10) 와 `presentation`(T2-16
   * 이후)은 **여전히 없어야** 한다.
   */
  it('★★ T2-6 이 inventory domain 계층을 landing 시켰다', () => {
    expect(missing('src/modules/inventory/domain/index.ts')).toBe(false);
    expect(missing('src/modules/inventory/domain/stock-key.ts')).toBe(false);
  });

  it('★★ infrastructure·presentation 은 아직 없다 (T2-9·T2-10·T2-16)', () => {
    expect(missing('src/modules/inventory/infrastructure')).toBe(true);
    expect(missing('src/modules/inventory/presentation')).toBe(true);
    expect(missing('src/modules/inventory/index.ts')).toBe(true);
  });

  /**
   * ★ **주석을 걷어낸 뒤** 본다. 이 파일들의 doc-comment 는 `post()` ·
   *   `normalizeStockKey` 같은 이름을 **금지 서술로** 여러 번 언급한다.
   *   원문 그대로 grep 하면 "금지한다고 적어 둔 것" 이 "구현했다" 로 잘못 잡힌다.
   *   (T2-2 의 `MIGRATION_CODE` 가 같은 이유로 주석을 제거했다.)
   */
  const codeOf = (path: string): string =>
    readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('★★ posting 관문 post() 가 아직 없다 (T2-10)', () => {
    // 공개 인터페이스에 실제 posting callable 이 없다 — T2-5 는 Phase-1 검증뿐이다.
    const application = codeOf('src/modules/inventory/application/index.ts');
    expect(application).not.toContain('postInventoryTransaction');
    expect(application).not.toContain('export function post');

    // ⛔ class 형태가 아니고, PostingResult 를 반환하지 않는다.
    const service = codeOf('src/modules/inventory/application/validate-posting-command.ts');
    expect(service).not.toContain('class InventoryPostingService');
    expect(service).not.toContain('Promise<PostingResult>');

    // ⛔ 어떤 T2-5 파일도 PostingResult 를 시그니처에 쓰지 않는다.
    for (const file of [
      'src/modules/inventory/application/posting-command.ts',
      'src/modules/inventory/application/refs.ts',
      'src/modules/inventory/application/ports.ts',
      'src/modules/inventory/application/validate-posting-command.ts',
    ]) {
      expect(codeOf(file), file).not.toContain('Promise<PostingResult>');
    }
  });

  /**
   * ✏️ **방향 전환 (T2-6, Deviation #75)** — T2-5 시점에는 8개 이름이 전부
   * 부재였다. T2-6 이 앞의 6개를 landing 시켰고, T2-8 의 2개는 **여전히 없다.**
   */
  it('★★ T2-6 산출물이 domain 에 landing 했다', () => {
    const domain = codeOf('src/modules/inventory/domain/index.ts');
    for (const landed of [
      'normalizeStockKey',
      'hashStockKey',
      'groupByStockKey',
      'netQuantityDelta',
      'NormalizedEntry',
      'StockKeyGroup',
    ]) {
      expect(domain, landed).toContain(landed);
    }
  });

  it('★★ T2-8 검증자를 선구현하지 않았다', () => {
    for (const file of [
      'src/modules/inventory/domain/index.ts',
      'src/modules/inventory/domain/stock-key.ts',
      'src/modules/inventory/application/index.ts',
    ]) {
      const source = codeOf(file);
      for (const future of ['assertLotExpirySerial', 'assertSerialNetQty']) {
        expect(source, `${file} :: ${future}`).not.toContain(future);
      }
    }
  });

  /**
   * ★ T2-6 은 **순수 domain** 이다 — `docs/07:377` 이 재고키 그룹화를
   *   "도메인 순수 함수" 로 분류했다.
   */
  it('★★ T2-6 domain 은 DB·application 에 의존하지 않는다', () => {
    const domain = codeOf('src/modules/inventory/domain/stock-key.ts');

    // Prisma 클라이언트·트랜잭션 접근 0 (enum type-only import 는 런타임 의존이 아니다).
    expect(domain).not.toContain('PrismaClient');
    expect(domain).not.toContain('$transaction');
    expect(domain).not.toContain('findMany');
    // application 계층 역참조 0.
    expect(domain).not.toContain('PostingReferences');
    expect(domain).not.toContain('PostingPhase1');
    expect(domain).not.toContain('PostingEntry');
    expect(domain).not.toContain('/application');
  });

  it('★★ T2-7·T2-9·T2-10 산출물이 아직 없다', () => {
    const domain = codeOf('src/modules/inventory/domain/stock-key.ts');
    for (const future of [
      // T2-7 — net 부호 해석부터가 T2-7 이다
      'assertStatusTransitionByNet',
      'assertBalancedIfStatusMove',
      'isTransitionAllowed',
      'isStatusMoveType',
      // T2-9
      'FOR UPDATE',
      'lockVersion',
      'INSUFFICIENT_STOCK',
      // T2-10
      'pickStockKeyAndAttrs',
      'transactionId',
    ]) {
      expect(domain, future).not.toContain(future);
    }
  });

  it('★★ T2-5 application 계약이 T2-6 에서 바뀌지 않았다', () => {
    const service = codeOf('src/modules/inventory/application/validate-posting-command.ts');

    // PostingPhase1 은 여전히 businessDate·refs 둘뿐이다.
    expect(service).not.toContain('normalizedEntries');
    expect(service).not.toContain('groups');
    // T2-6 을 application 에 아직 연결하지 않았다 — 연결은 T2-10 이다.
    expect(service).not.toContain('normalizeEntries');
    expect(service).not.toContain('groupByStockKey');
  });

  it('★★ PostingCommand 에 승인 관련 필드가 없다 (PENDING_v0.3 §2)', () => {
    const dto = readFileSync(
      fileURLToPath(new URL('src/modules/inventory/application/posting-command.ts', ROOT)),
      'utf8',
    );
    // 주석의 금지 서술과 실제 필드 선언을 구분하기 위해 스키마 본문만 본다.
    const schema = dto.slice(
      dto.indexOf('export const postingCommandPayloadSchema'),
      dto.indexOf('export type PostingCommandPayload'),
    );
    expect(schema).not.toContain('approvedBy');
    expect(schema).not.toContain('allowNegativeStock');
    expect(schema).not.toContain('allowClosedPeriod');
    expect(schema).not.toContain('approvalRequestId');
  });

  it('★★ inventory API route 가 없다 (T2-16 이후)', () => {
    expect(missing('src/app/api/inventory/route.ts')).toBe(true);
    expect(missing('src/app/api/inventory/balances/route.ts')).toBe(true);
  });

  it('★★ inventory 화면이 없다 (T2-20)', () => {
    expect(missing('src/app/inventory/balances/page.tsx')).toBe(true);
    expect(missing('src/app/master/warehouses/page.tsx')).toBe(true);
  });

  it('★ inventory seed 가 없다', () => {
    expect(missing('prisma/seed/inventory.ts')).toBe(true);
  });

  it('★ 재고 오류코드를 만들지 않았다 — 원장 예외는 DB 계약이다', () => {
    const codes = readFileSync(fileURLToPath(new URL('src/shared/errors/codes.ts', ROOT)), 'utf8');
    // `IMMUTABLE_VIOLATION` 은 DB 예외 문자열이지 public API error code 가 아니다.
    expect(codes).not.toContain('IMMUTABLE_VIOLATION');
    expect(codes).not.toContain('INVENTORY_LEDGER');
  });
});
