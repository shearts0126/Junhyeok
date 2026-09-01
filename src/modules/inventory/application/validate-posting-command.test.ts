import { describe, expect, it } from 'vitest';

import { TransactionType } from '@/generated/prisma/client';
import type { ActorContext } from '@/modules/auth/application';
import { toKstDate } from '@/shared/business-date';
import { AppError, AuthorizationError, DomainError, ERROR_CODES } from '@/shared/errors';

import type { PostingValidationDependencies } from './ports';
import type { PostingCommand, PostingEntry } from './posting-command';
import type { PostingDbClient } from './refs';
import { validatePostingCommand } from './validate-posting-command';

/**
 * Posting Phase-1 검증 (T2-5).
 *
 * ⚠️ 근거: `docs/04_재고_PostingService와_현재고전략_v0.2.md` §8.2 · §8.12,
 *    `docs/07_개발백로그와_테스트전략_v0.2.md:153` — 테스트 유형은 **단위**이며
 *    완료조건은 *"검증 실패 시 DB 무변경"* 이다.
 *
 * ★ real PostgreSQL 을 쓰지 않는다. 좁힌 read client 를 fake 로 주고, 쓰기
 *   메서드와 `$transaction` 은 **접근 자체가 실패**하도록 Proxy 로 막는다.
 *   "호출되면 실패" 가 아니라 "호출할 수 없음" 이어야 우회가 불가능하다.
 *
 * ⛔ 다음은 고정하지 않는다 — 정본이 정하지 않았다.
 *    · 복수 검증 동시 실패 시 first-error / aggregate 중 무엇인지
 *    · `sourceDocument.type` allowlist
 *    · `TransactionType` → permission 매핑 24종
 *    · 승인요청(approval request) semantics
 *    · `channelId` 의 참조 대상 (CommonCode 여부)
 *    · SKU lifecycle status (`ACTIVE` / `DISCONTINUED` 출고전용)
 *    · `lineNo` 파생 동작 (T2-6 이후)
 */

// ═══════════════════════════════════════════════════════════════
// fixture
// ═══════════════════════════════════════════════════════════════

const SKU_ID = '11111111-1111-4111-8111-111111111111';
const UNMANAGED_SKU_ID = '11111111-1111-4111-8111-111111111112';
const WAREHOUSE_ID = '22222222-2222-4222-8222-222222222221';
const INACTIVE_WAREHOUSE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_WAREHOUSE_ID = '22222222-2222-4222-8222-222222222223';
const DEFAULT_LOCATION_ID = '33333333-3333-4333-8333-333333333331';
const LOCATION_ID = '33333333-3333-4333-8333-333333333332';
const OTHER_LOCATION_ID = '33333333-3333-4333-8333-333333333333';
const CHANNEL_ID = '44444444-4444-4444-8444-444444444441';

const SKU_ROWS = [
  { id: SKU_ID, inventoryManaged: true },
  { id: UNMANAGED_SKU_ID, inventoryManaged: false },
];

const WAREHOUSE_ROWS = [
  { id: WAREHOUSE_ID, active: true, defaultLocationId: DEFAULT_LOCATION_ID },
  { id: INACTIVE_WAREHOUSE_ID, active: false, defaultLocationId: DEFAULT_LOCATION_ID },
  { id: OTHER_WAREHOUSE_ID, active: true, defaultLocationId: OTHER_LOCATION_ID },
];

const LOCATION_ROWS = [
  { id: DEFAULT_LOCATION_ID, warehouseId: WAREHOUSE_ID },
  { id: LOCATION_ID, warehouseId: WAREHOUSE_ID },
  { id: OTHER_LOCATION_ID, warehouseId: OTHER_WAREHOUSE_ID },
];

const ACTOR: ActorContext = {
  userId: '55555555-5555-4555-8555-555555555555',
  email: 'scm@example.com',
  name: 'SCM 담당자',
  roles: ['SCM_LEADER'],
  permissions: [],
  requestId: 'req-t2-5',
};

function entry(overrides: Partial<PostingEntry> = {}): PostingEntry {
  return {
    skuId: SKU_ID,
    warehouseId: WAREHOUSE_ID,
    inventoryStatus: 'AVAILABLE',
    quantityDelta: '10',
    ...overrides,
  };
}

function command(overrides: Partial<PostingCommand> = {}): PostingCommand {
  return {
    transactionType: TransactionType.OPENING_BALANCE,
    occurredAt: new Date('2026-09-01T15:00:00.000Z'),
    entries: [entry()],
    actor: ACTOR,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// fake DB — 읽기만 가능하고 쓰기·트랜잭션은 접근 자체가 실패한다
// ═══════════════════════════════════════════════════════════════

/** 접근하면 즉시 실패해야 하는 이름들. */
const FORBIDDEN_CLIENT_KEYS = [
  '$transaction',
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
  'inventoryTransaction',
  'inventoryLedgerEntry',
  'inventoryBalance',
  'auditLog',
];

const FORBIDDEN_MODEL_METHODS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
];

interface FakeDb {
  readonly client: PostingDbClient;
  /** 읽기 호출 순서 추적 — orchestration 위치 확인용. */
  readonly reads: string[];
}

function guardedModel<T>(name: string, rows: readonly T[], reads: string[]): unknown {
  const model = {
    findMany: (args: { where?: Record<string, unknown> }) => {
      reads.push(name);
      return Promise.resolve(filterRows(rows, args?.where));
    },
  };

  return new Proxy(model, {
    get(target, key) {
      if (typeof key === 'string' && FORBIDDEN_MODEL_METHODS.includes(key)) {
        throw new Error(`T2-5 는 DB 에 쓰지 않는다 — ${name}.${key} 접근됨`);
      }
      return Reflect.get(target, key) as unknown;
    },
  });
}

/** fake 최소 where 해석 — `{ id: { in: [...] } }` 와 `{ OR: [{...}] }` 만. */
function filterRows<T>(rows: readonly T[], where?: Record<string, unknown>): T[] {
  if (where === undefined) return [...rows];

  if (Array.isArray(where['OR'])) {
    const clauses = where['OR'] as Record<string, unknown>[];
    return rows.filter((row) =>
      clauses.some((clause) =>
        Object.entries(clause).every(
          ([field, value]) => (row as Record<string, unknown>)[field] === value,
        ),
      ),
    );
  }

  const idFilter = where['id'] as { in?: string[] } | undefined;
  if (idFilter?.in !== undefined) {
    const wanted = new Set(idFilter.in);
    return rows.filter((row) => wanted.has((row as { id: string }).id));
  }

  return [...rows];
}

function fakeDb(): FakeDb {
  const reads: string[] = [];

  const client = {
    sku: guardedModel('sku', SKU_ROWS, reads),
    warehouse: guardedModel('warehouse', WAREHOUSE_ROWS, reads),
    warehouseLocation: guardedModel('warehouseLocation', LOCATION_ROWS, reads),
  };

  const guarded = new Proxy(client, {
    get(target, key) {
      if (typeof key === 'string' && FORBIDDEN_CLIENT_KEYS.includes(key)) {
        throw new Error(`T2-5 는 트랜잭션을 열거나 재고 테이블에 접근하지 않는다 — ${key}`);
      }
      return Reflect.get(target, key) as unknown;
    },
  });

  return { client: guarded as unknown as PostingDbClient, reads };
}

// ═══════════════════════════════════════════════════════════════
// port spy
// ═══════════════════════════════════════════════════════════════

interface PortTrace {
  readonly calls: string[];
  readonly channelIds: string[];
  readonly permissionArgs: { actor: ActorContext; transactionType: TransactionType }[];
  readonly sourceDocumentStates: unknown[];
  readonly periodArgs: { businessDate: Date; actor: ActorContext }[];
}

interface Harness {
  readonly deps: PostingValidationDependencies;
  readonly reads: string[];
  readonly trace: PortTrace;
}

function harness(overrides: Partial<Omit<PostingValidationDependencies, 'db'>> = {}): Harness {
  const db = fakeDb();
  const trace: PortTrace = {
    calls: [],
    channelIds: [],
    permissionArgs: [],
    sourceDocumentStates: [],
    periodArgs: [],
  };

  const deps: PostingValidationDependencies = {
    db: db.client,
    assertChannelUsable: (channelId) => {
      trace.calls.push('channel');
      trace.channelIds.push(channelId);
    },
    assertPostingPermission: (actor, transactionType) => {
      trace.calls.push('permission');
      trace.permissionArgs.push({ actor, transactionType });
    },
    assertSourceDocumentState: (sourceDocument) => {
      trace.calls.push('sourceDocumentState');
      trace.sourceDocumentStates.push(sourceDocument);
    },
    assertPeriodOpen: (businessDate, actor) => {
      trace.calls.push('periodOpen');
      trace.periodArgs.push({ businessDate, actor });
    },
    ...overrides,
  };

  return { deps, reads: db.reads, trace };
}

/** 던져진 오류의 `errorCode` 를 꺼낸다. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('오류가 발생하지 않았다.');
}

const SOURCE_DOCUMENT = { type: 'STOCK_ADJUSTMENT', id: 'ADJ-0001' };

// ═══════════════════════════════════════════════════════════════
// ① 구조
// ═══════════════════════════════════════════════════════════════

describe('T2-5 ① 구조 검증', () => {
  it('1. entries 가 비면 VALIDATION_ERROR', async () => {
    const { deps } = harness();
    expect(await codeOf(() => validatePostingCommand(deps, command({ entries: [] })))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('2. 유효한 entry 1건이면 ① 을 통과한다', async () => {
    const { deps } = harness();
    await expect(validatePostingCommand(deps, command())).resolves.toBeDefined();
  });

  it('3. ★ 개별 quantityDelta = 0 은 VALIDATION_ERROR', async () => {
    const { deps } = harness();
    for (const zero of ['0', '0.000000', '-0']) {
      expect(
        await codeOf(() =>
          validatePostingCommand(deps, command({ entries: [entry({ quantityDelta: zero })] })),
        ),
        zero,
      ).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });

  it('4. 음수 delta 는 허용된다 — 감소 거래다', async () => {
    const { deps } = harness();
    await expect(
      validatePostingCommand(deps, command({ entries: [entry({ quantityDelta: '-6' })] })),
    ).resolves.toBeDefined();
  });

  it('5. 미지원 키는 조용히 무시하지 않고 VALIDATION_ERROR', async () => {
    const { deps } = harness();
    const unsupported = { ...command(), businessDate: '2026-09-02' } as unknown as PostingCommand;
    expect(await codeOf(() => validatePostingCommand(deps, unsupported))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('6. entry 의 미지원 키도 VALIDATION_ERROR — lineNo·expiryKey 는 입력이 아니다', async () => {
    const { deps } = harness();
    for (const extra of [{ lineNo: 1 }, { expiryKey: '9999-12-31' }]) {
      const bad = command({ entries: [{ ...entry(), ...extra } as unknown as PostingEntry] });
      expect(await codeOf(() => validatePostingCommand(deps, bad))).toBe(
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
  });

  it('7. JSON number 수량은 타입 단계에서 거부된다 (Decimal 은 문자열)', async () => {
    const { deps } = harness();
    const bad = command({
      entries: [{ ...entry(), quantityDelta: 10 } as unknown as PostingEntry],
    });
    expect(await codeOf(() => validatePostingCommand(deps, bad))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// ② 참조 무결성
// ═══════════════════════════════════════════════════════════════

describe('T2-5 ② 참조 무결성', () => {
  it('8. SKU 미존재 → NOT_FOUND (⛔ SKU_NOT_FOUND 를 만들지 않는다)', async () => {
    const { deps } = harness();
    const missing = command({
      entries: [entry({ skuId: '99999999-9999-4999-8999-999999999999' })],
    });
    expect(await codeOf(() => validatePostingCommand(deps, missing))).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('9. 창고 미존재 → NOT_FOUND', async () => {
    const { deps } = harness();
    const missing = command({
      entries: [entry({ warehouseId: '99999999-9999-4999-8999-999999999998' })],
    });
    expect(await codeOf(() => validatePostingCommand(deps, missing))).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('10. ★ 창고 active=false → WAREHOUSE_INACTIVE (422)', async () => {
    const { deps } = harness();
    const inactive = command({ entries: [entry({ warehouseId: INACTIVE_WAREHOUSE_ID })] });
    expect(await codeOf(() => validatePostingCommand(deps, inactive))).toBe(
      ERROR_CODES.WAREHOUSE_INACTIVE,
    );
  });

  it('11. 제공된 로케이션 미존재 → NOT_FOUND', async () => {
    const { deps } = harness();
    const missing = command({
      entries: [entry({ locationId: '99999999-9999-4999-8999-999999999997' })],
    });
    expect(await codeOf(() => validatePostingCommand(deps, missing))).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('12. ★ 로케이션이 다른 창고 소속이면 NOT_FOUND — 재고키 정합성', async () => {
    const { deps } = harness();
    const crossed = command({
      entries: [entry({ warehouseId: WAREHOUSE_ID, locationId: OTHER_LOCATION_ID })],
    });
    expect(await codeOf(() => validatePostingCommand(deps, crossed))).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('13. ★★ locationId 를 생략하면 ② 는 검사하지 않고 통과한다', async () => {
    const { deps } = harness();
    // default 로케이션 치환은 T2-6 `normalizeStockKey` 소유다.
    await expect(validatePostingCommand(deps, command())).resolves.toBeDefined();
  });

  it('14. ★★ refs 에 warehouse.defaultLocationId 가 실려 나온다 (T2-6 재료)', async () => {
    const { deps } = harness();
    const phase1 = await validatePostingCommand(deps, command());

    expect(phase1.refs.warehouse(WAREHOUSE_ID)?.defaultLocationId).toBe(DEFAULT_LOCATION_ID);
  });

  it('15. refs 는 요청된 id 목록과 조회 결과를 함께 들고 있다', async () => {
    const { deps } = harness();
    const phase1 = await validatePostingCommand(
      deps,
      command({ entries: [entry({ locationId: LOCATION_ID })] }),
    );

    expect(phase1.refs.skuIds).toEqual([SKU_ID]);
    expect(phase1.refs.warehouseIds).toEqual([WAREHOUSE_ID]);
    expect(phase1.refs.locationKeys).toEqual([
      { warehouseId: WAREHOUSE_ID, locationId: LOCATION_ID },
    ]);
    expect(phase1.refs.sku(SKU_ID)?.inventoryManaged).toBe(true);
    expect(phase1.refs.location(WAREHOUSE_ID, LOCATION_ID)?.id).toBe(LOCATION_ID);
  });

  it('16. 동일 SKU·창고가 여러 entry 로 와도 조회는 중복 제거된다', async () => {
    const { deps } = harness();
    const phase1 = await validatePostingCommand(
      deps,
      command({
        entries: [entry({ quantityDelta: '-6' }), entry({ quantityDelta: '-6' })],
      }),
    );

    // ★ 동일 재고키 중복 자체는 허용된다 — 합산 검증은 T2-6 이후다.
    expect(phase1.refs.skuIds).toHaveLength(1);
    expect(phase1.refs.warehouseIds).toHaveLength(1);
  });

  it('17. channelId 가 있으면 채널 port 가 그 값으로 호출된다', async () => {
    const { deps, trace } = harness();
    await validatePostingCommand(deps, command({ entries: [entry({ channelId: CHANNEL_ID })] }));

    // ⛔ CommonCode 조회 semantics 는 테스트하지 않는다 — 참조 대상 미확정.
    expect(trace.channelIds).toEqual([CHANNEL_ID]);
  });

  it('18. channelId 가 없으면 채널 port 를 호출하지 않는다', async () => {
    const { deps, trace } = harness();
    await validatePostingCommand(deps, command());

    expect(trace.channelIds).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// ③ 권한
// ═══════════════════════════════════════════════════════════════

describe('T2-5 ③ 권한', () => {
  it('19. port 가 통과시키면 계속 진행한다', async () => {
    const { deps, trace } = harness();
    await validatePostingCommand(deps, command());

    expect(trace.permissionArgs).toHaveLength(1);
    expect(trace.permissionArgs[0]?.actor).toBe(ACTOR);
    expect(trace.permissionArgs[0]?.transactionType).toBe(TransactionType.OPENING_BALANCE);
  });

  it('20. ★ port 가 거부하면 FORBIDDEN 이 그대로 전파된다', async () => {
    const { deps } = harness({
      assertPostingPermission: () => {
        throw new AuthorizationError(ERROR_CODES.FORBIDDEN, { message: '권한이 없습니다.' });
      },
    });

    expect(await codeOf(() => validatePostingCommand(deps, command()))).toBe(ERROR_CODES.FORBIDDEN);
  });

  // ⛔ 24종 TransactionType → permission 매핑 · ADMIN bypass ·
  //    REVERSAL 의 원거래 권한 상속은 테스트하지 않는다 (정본 미완성 / T2-13).
});

// ═══════════════════════════════════════════════════════════════
// ④ 원인문서
// ═══════════════════════════════════════════════════════════════

describe('T2-5 ④ 원인문서', () => {
  it('21. ★ OPENING_BALANCE 는 원인문서 없이 통과한다', async () => {
    const { deps, trace } = harness();
    await expect(validatePostingCommand(deps, command())).resolves.toBeDefined();

    expect(trace.sourceDocumentStates).toEqual([]);
  });

  it('22. ★ 그 외 거래유형은 원인문서가 없으면 MISSING_SOURCE_DOCUMENT', async () => {
    const { deps } = harness();
    for (const type of [
      TransactionType.MANUAL_ADJUSTMENT,
      TransactionType.STATUS_CHANGE,
      TransactionType.SALES_SHIPMENT,
    ]) {
      expect(
        await codeOf(() => validatePostingCommand(deps, command({ transactionType: type }))),
        type,
      ).toBe(ERROR_CODES.MISSING_SOURCE_DOCUMENT);
    }
  });

  it('23. 공백뿐인 type 은 MISSING_SOURCE_DOCUMENT', async () => {
    const { deps } = harness();
    const blank = command({
      transactionType: TransactionType.MANUAL_ADJUSTMENT,
      sourceDocument: { type: '   ', id: 'ADJ-0001' },
    });
    expect(await codeOf(() => validatePostingCommand(deps, blank))).toBe(
      ERROR_CODES.MISSING_SOURCE_DOCUMENT,
    );
  });

  it('24. 공백뿐인 id 는 MISSING_SOURCE_DOCUMENT', async () => {
    const { deps } = harness();
    const blank = command({
      transactionType: TransactionType.MANUAL_ADJUSTMENT,
      sourceDocument: { type: 'STOCK_ADJUSTMENT', id: '  ' },
    });
    expect(await codeOf(() => validatePostingCommand(deps, blank))).toBe(
      ERROR_CODES.MISSING_SOURCE_DOCUMENT,
    );
  });

  it('25. 원인문서가 있으면 상태 port 가 그 문서로 호출된다', async () => {
    const { deps, trace } = harness();
    await validatePostingCommand(
      deps,
      command({
        transactionType: TransactionType.MANUAL_ADJUSTMENT,
        sourceDocument: SOURCE_DOCUMENT,
      }),
    );

    expect(trace.sourceDocumentStates).toEqual([SOURCE_DOCUMENT]);
  });

  it('26. ⛔ sourceDocument.type 은 allowlist 로 닫혀 있지 않다', async () => {
    const { deps } = harness();
    // 문서에 없는 임의 문자열도 presence 단계에서는 통과한다.
    // 존재·상태 판정은 port 의 몫이다.
    await expect(
      validatePostingCommand(
        deps,
        command({
          transactionType: TransactionType.MANUAL_ADJUSTMENT,
          sourceDocument: { type: 'ANY_FUTURE_DOCUMENT', id: 'X-1' },
        }),
      ),
    ).resolves.toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// businessDate · ⑤ 마감기간
// ═══════════════════════════════════════════════════════════════

describe('T2-5 businessDate · ⑤ 마감기간', () => {
  it('27. ★★ businessDate = toKstDate(occurredAt)', async () => {
    const { deps } = harness();
    const occurredAt = new Date('2026-09-01T15:00:00.000Z');
    const phase1 = await validatePostingCommand(deps, command({ occurredAt }));

    // T2-4 의 경계 matrix 를 여기서 다시 쓰지 않는다 — 합성만 확인한다.
    expect(phase1.businessDate.toISOString()).toBe(toKstDate(occurredAt).toISOString());
  });

  it('28. ★ ⑤ port 에 businessDate 와 actor 가 전달된다', async () => {
    const { deps, trace } = harness();
    const occurredAt = new Date('2026-09-01T15:00:00.000Z');
    await validatePostingCommand(deps, command({ occurredAt }));

    expect(trace.periodArgs).toHaveLength(1);
    expect(trace.periodArgs[0]?.businessDate.toISOString()).toBe(
      toKstDate(occurredAt).toISOString(),
    );
    expect(trace.periodArgs[0]?.actor).toBe(ACTOR);
  });

  it('29. ⑤ port 가 거부하면 CLOSED_PERIOD_TRANSACTION 이 전파된다', async () => {
    const { deps } = harness({
      assertPeriodOpen: () => {
        throw new DomainError(ERROR_CODES.CLOSED_PERIOD_TRANSACTION, {
          message: '마감된 달입니다.',
        });
      },
    });

    expect(await codeOf(() => validatePostingCommand(deps, command()))).toBe(
      ERROR_CODES.CLOSED_PERIOD_TRANSACTION,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑥ 재고관리 대상
// ═══════════════════════════════════════════════════════════════

describe('T2-5 ⑥ 재고관리 대상', () => {
  it('30. ★★ inventoryManaged=false → SKU_NOT_INVENTORY_MANAGED (422)', async () => {
    const { deps } = harness();
    const unmanaged = command({ entries: [entry({ skuId: UNMANAGED_SKU_ID })] });

    expect(await codeOf(() => validatePostingCommand(deps, unmanaged))).toBe(
      ERROR_CODES.SKU_NOT_INVENTORY_MANAGED,
    );
  });

  it('31. inventoryManaged=true 는 통과한다', async () => {
    const { deps } = harness();
    await expect(validatePostingCommand(deps, command())).resolves.toBeDefined();
  });

  // ⛔ SKU lifecycle status(ACTIVE / DISCONTINUED 출고전용)는 v0.2 §8.2 가
  //    정하지 않았다. 허용으로도 금지로도 테스트하지 않는다.
});

// ═══════════════════════════════════════════════════════════════
// orchestration 순서
// ═══════════════════════════════════════════════════════════════

describe('T2-5 orchestration 순서', () => {
  it('32. ★★ 정상 성공 경로의 호출 순서가 docs/04 §8.2 와 같다', async () => {
    // ⛔ 여러 검증을 동시에 실패시켜 "앞 번호가 이긴다" 를 확인하지 않는다 —
    //    first-error / aggregate 중 무엇인지는 정본 미정이며, 그 테스트는
    //    short-circuit semantics 를 과잉 고정한다.
    const { deps, reads, trace } = harness();

    await validatePostingCommand(
      deps,
      command({
        transactionType: TransactionType.MANUAL_ADJUSTMENT,
        sourceDocument: SOURCE_DOCUMENT,
        entries: [entry({ locationId: LOCATION_ID, channelId: CHANNEL_ID })],
      }),
    );

    // ② 는 세 모델을 한 번에 읽는다 (entry 수만큼 왕복하지 않는다).
    expect([...new Set(reads)].sort()).toEqual(['sku', 'warehouse', 'warehouseLocation']);

    // ② 채널 → ③ 권한 → ④ 문서상태 → ⑤ 마감
    expect(trace.calls).toEqual(['channel', 'permission', 'sourceDocumentState', 'periodOpen']);
  });

  it('33. ★ 각 단계가 단독으로 실패하면 그 단계의 오류가 나온다', async () => {
    const { deps: d1 } = harness();
    expect(await codeOf(() => validatePostingCommand(d1, command({ entries: [] })))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );

    const { deps: d2 } = harness();
    expect(
      await codeOf(() =>
        validatePostingCommand(
          d2,
          command({ entries: [entry({ warehouseId: INACTIVE_WAREHOUSE_ID })] }),
        ),
      ),
    ).toBe(ERROR_CODES.WAREHOUSE_INACTIVE);

    const { deps: d3 } = harness();
    expect(
      await codeOf(() =>
        validatePostingCommand(d3, command({ transactionType: TransactionType.MANUAL_ADJUSTMENT })),
      ),
    ).toBe(ERROR_CODES.MISSING_SOURCE_DOCUMENT);

    const { deps: d4 } = harness();
    expect(
      await codeOf(() =>
        validatePostingCommand(d4, command({ entries: [entry({ skuId: UNMANAGED_SKU_ID })] })),
      ),
    ).toBe(ERROR_CODES.SKU_NOT_INVENTORY_MANAGED);
  });

  it('34. ★ ② 가 ③ 보다 먼저다 — 참조가 깨지면 권한 port 에 닿지 않는다', async () => {
    const { deps, trace } = harness();
    const missing = command({
      entries: [entry({ skuId: '99999999-9999-4999-8999-999999999999' })],
    });

    await codeOf(() => validatePostingCommand(deps, missing));
    expect(trace.calls).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 경계 — write 0 / transaction 0 / PostingResult 0
// ═══════════════════════════════════════════════════════════════

describe('T2-5 경계', () => {
  it('35. ★★ 성공 경로에서도 DB write 와 $transaction 이 0 이다', async () => {
    // fake client 는 쓰기 메서드와 `$transaction` 접근 시 throw 한다.
    // 아래가 통과한다는 것은 어느 것도 건드리지 않았다는 뜻이다.
    const { deps } = harness();
    await expect(validatePostingCommand(deps, command())).resolves.toBeDefined();
  });

  it('36. ★★ 모든 실패 경로에서도 DB write 가 0 이다', async () => {
    for (const bad of [
      command({ entries: [] }),
      command({ entries: [entry({ quantityDelta: '0' })] }),
      command({ entries: [entry({ warehouseId: INACTIVE_WAREHOUSE_ID })] }),
      command({ transactionType: TransactionType.MANUAL_ADJUSTMENT }),
      command({ entries: [entry({ skuId: UNMANAGED_SKU_ID })] }),
    ]) {
      const { deps } = harness();
      // 쓰기 접근이 있었다면 Error('T2-5 는 DB 에 쓰지 않는다…') 가 나왔을 것이고,
      // 그것은 AppError 가 아니므로 codeOf 가 그대로 다시 던진다.
      await expect(codeOf(() => validatePostingCommand(deps, bad))).resolves.toBeTruthy();
    }
  });

  it('37. ★★ 반환은 { businessDate, refs } 뿐이다 — PostingResult 가 아니다', async () => {
    const { deps } = harness();
    const phase1 = await validatePostingCommand(deps, command());

    expect(Object.keys(phase1).sort()).toEqual(['businessDate', 'refs']);
    // 후속 task 소유 값이 새어 들어오지 않았는지 확인한다.
    for (const forbidden of [
      'transactionId',
      'transactionNo',
      'entryIds',
      'balancesAfter',
      'exceptionsCreated',
      'idempotent',
      'normalizedEntries',
      'groups',
      'entries',
    ]) {
      expect(phase1, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it('38. ★ PostingCommand 에 승인 관련 필드가 없다', async () => {
    const { deps } = harness();
    // PENDING_v0.3 §2 가 supersede 했고 승인요청 모델은 아직 없다.
    // 보내면 미지원 키이므로 400 이다 — 조용히 무시되지 않는다.
    for (const field of [
      { approvedBy: ACTOR.userId },
      { allowNegativeStock: { approvedBy: ACTOR.userId, reason: 'r' } },
      { allowClosedPeriod: { approvedBy: ACTOR.userId, reason: 'r' } },
      { approvalRequestId: '66666666-6666-4666-8666-666666666666' },
    ]) {
      const withApproval = { ...command(), ...field } as unknown as PostingCommand;
      expect(
        await codeOf(() => validatePostingCommand(deps, withApproval)),
        Object.keys(field)[0],
      ).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });
});
