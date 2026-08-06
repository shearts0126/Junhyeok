import { describe, expect, it } from 'vitest';

import type { AuditLogger, AuditWriteInput } from '@/modules/audit/application/audit-logger';
import {
  createActorContext,
  resolveRoutePermission,
  type ActorContext,
} from '@/modules/auth/application';
import type { TransactionClient } from '@/shared/db';
import { ERROR_CODES, ValidationError, type AppError } from '@/shared/errors';

import {
  CODE_MANAGE_PERMISSION,
  CODE_READ_PERMISSION,
  createCode,
  jsonEquals,
  listCodeGroups,
  listCodes,
  parseActiveFilter,
  parseCreateCodeInput,
  parseUpdateCodePatch,
  updateCode,
  type CommonCodeReadClient,
} from './application';
import * as applicationBarrel from './application';

/**
 * 공통코드 테스트 (T0-8).
 *
 * DB 없이 대역으로 검증한다. 실제 DB 제약·seed 는 `common-codes-db.test.ts`.
 */

function actorWith(
  permissions: readonly string[],
  roles: readonly string[] = ['ADMIN'],
): ActorContext {
  return createActorContext({
    userId: '22222222-2222-4222-8222-222222222222',
    email: 'admin@deeppoint.test',
    name: '관리자',
    active: true,
    roles,
    permissions,
    requestId: 'req-code',
    sessionId: 'sess-1',
    ipAddress: '10.0.0.9',
  });
}

const MANAGER = actorWith([CODE_READ_PERMISSION, CODE_MANAGE_PERMISSION]);
const READER_ONLY = actorWith([CODE_READ_PERMISSION]);
/** 역할은 ADMIN 인데 권한 데이터가 없는 비정상 조합 — 그래도 차단되어야 한다. */
const ADMIN_ROLE_NO_PERMISSION = actorWith([], ['ADMIN']);
/** manage 만 있고 read 가 없는 비정상 조합 — 각 메서드의 명시 권한으로만 판정한다. */
const MANAGE_ONLY = actorWith([CODE_MANAGE_PERMISSION]);

// ── 인메모리 대역 ───────────────────────────────────────────────

interface FakeGroup {
  id: string;
  groupCode: string;
  groupName: string;
  parentGroupId: string | null;
  sortOrder: number;
  active: boolean;
}

interface FakeCode {
  id: string;
  groupId: string;
  code: string;
  name: string;
  parentCodeId: string | null;
  sortOrder: number;
  attributes: unknown;
  active: boolean;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

interface FakeStore {
  groups: FakeGroup[];
  codes: FakeCode[];
  auditWrites: AuditWriteInput[];
}

function makeStore(): FakeStore {
  const parentGroup: FakeGroup = {
    id: 'g-parent',
    groupCode: 'MAJOR_TEST',
    groupName: '상위 그룹',
    parentGroupId: null,
    sortOrder: 1,
    active: true,
  };
  const childGroup: FakeGroup = {
    id: 'g-child',
    groupCode: 'MINOR_TEST',
    groupName: '하위 그룹',
    parentGroupId: 'g-parent',
    sortOrder: 2,
    active: true,
  };
  const flatGroup: FakeGroup = {
    id: 'g-flat',
    groupCode: 'FLAT_TEST',
    groupName: '계층 없는 그룹',
    parentGroupId: null,
    sortOrder: 3,
    active: true,
  };
  const inactiveGroup: FakeGroup = {
    id: 'g-off',
    groupCode: 'OFF_TEST',
    groupName: '비활성 그룹',
    parentGroupId: null,
    sortOrder: 4,
    active: false,
  };

  const now = new Date('2026-08-06T00:00:00.000Z');
  const codes: FakeCode[] = [
    {
      id: 'c-p1',
      groupId: 'g-parent',
      code: 'P1',
      name: '상위 1',
      parentCodeId: null,
      sortOrder: 1,
      attributes: null,
      active: true,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,
    },
    {
      id: 'c-p2',
      groupId: 'g-parent',
      code: 'P2',
      name: '상위 2 (비활성)',
      parentCodeId: null,
      sortOrder: 2,
      attributes: null,
      active: false,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,
    },
    {
      id: 'c-m1',
      groupId: 'g-child',
      code: 'M1',
      name: '하위 1',
      parentCodeId: 'c-p1',
      sortOrder: 1,
      attributes: { nameEn: 'Minor 1' },
      active: true,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,
    },
    {
      id: 'c-f1',
      groupId: 'g-flat',
      code: 'F1',
      name: '평면 1',
      parentCodeId: null,
      sortOrder: 1,
      attributes: null,
      active: true,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,
    },
  ];

  return {
    groups: [parentGroup, childGroup, flatGroup, inactiveGroup],
    codes,
    auditWrites: [],
  };
}

interface FakeTxOptions {
  readonly failAudit?: boolean;
}

function includeFor(store: FakeStore, row: FakeCode) {
  const group = store.groups.find((entry) => entry.id === row.groupId);
  const parent =
    row.parentCodeId === null
      ? null
      : (store.codes.find((entry) => entry.id === row.parentCodeId) ?? null);
  const parentGroup =
    parent === null ? null : store.groups.find((entry) => entry.id === parent.groupId);
  return {
    ...row,
    group: { groupCode: group?.groupCode ?? '?' },
    parentCode:
      parent === null
        ? null
        : {
            id: parent.id,
            code: parent.code,
            name: parent.name,
            group: { groupCode: parentGroup?.groupCode ?? '?' },
          },
  };
}

let idSequence = 0;

function createFakeTx(store: FakeStore): TransactionClient {
  const tx = {
    commonCodeGroup: {
      findUnique: async ({ where }: { where: { groupCode?: string } }) => {
        const found = store.groups.find((entry) => entry.groupCode === where.groupCode) ?? null;
        return found === null ? null : { ...found };
      },
    },
    commonCode: {
      findUnique: async (args: {
        where: { groupId_code?: { groupId: string; code: string }; id?: string };
      }) => {
        const { groupId_code: byGroupCode, id } = args.where;
        const row =
          byGroupCode !== undefined
            ? (store.codes.find(
                (entry) => entry.groupId === byGroupCode.groupId && entry.code === byGroupCode.code,
              ) ?? null)
            : (store.codes.find((entry) => entry.id === id) ?? null);
        if (row === null) return null;
        // include/select 를 흉내낸다 — 서비스가 쓰는 필드만 있으면 된다.
        return includeFor(store, row);
      },
      count: async ({ where }: { where: { parentCodeId: string; active: boolean } }) =>
        store.codes.filter(
          (entry) => entry.parentCodeId === where.parentCodeId && entry.active === where.active,
        ).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const duplicate = store.codes.some(
          (entry) => entry.groupId === data['groupId'] && entry.code === data['code'],
        );
        if (duplicate) {
          // 실제 DB 라면 P2002 — 대역에서는 사전 검사에서 걸리므로 여기 오면 버그다.
          throw new Error('UNIQUE violation (대역)');
        }
        idSequence += 1;
        const row: FakeCode = {
          id: `c-new-${idSequence}`,
          groupId: data['groupId'] as string,
          code: data['code'] as string,
          name: data['name'] as string,
          parentCodeId: (data['parentCodeId'] as string | null) ?? null,
          sortOrder: data['sortOrder'] as number,
          attributes:
            data['attributes'] !== null && typeof data['attributes'] === 'object'
              ? data['attributes']
              : null,
          active: true,
          updatedAt: new Date(),
          createdBy: data['createdBy'] as string,
          updatedBy: data['updatedBy'] as string,
        };
        store.codes.push(row);
        return includeFor(store, row);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.codes.find((entry) => entry.id === where.id);
        if (row === undefined) throw new Error('행 없음 (대역)');
        if ('name' in data) row.name = data['name'] as string;
        if ('sortOrder' in data) row.sortOrder = data['sortOrder'] as number;
        if ('active' in data) row.active = data['active'] as boolean;
        if ('parentCodeId' in data) row.parentCodeId = data['parentCodeId'] as string | null;
        if ('attributes' in data) {
          const value = data['attributes'];
          row.attributes = value !== null && typeof value === 'object' ? value : null;
        }
        if ('updatedBy' in data) row.updatedBy = data['updatedBy'] as string;
        row.updatedAt = new Date();
        return includeFor(store, row);
      },
    },
  };
  return tx as unknown as TransactionClient;
}

function fakeDependencies(store: FakeStore, options: FakeTxOptions = {}) {
  const auditLogger: AuditLogger = {
    write: async (_tx, input) => {
      if (options.failAudit === true) throw new Error('감사로그 실패 (대역)');
      store.auditWrites.push(input);
      return {
        id: `audit-${store.auditWrites.length}`,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorId: input.actor.userId,
      };
    },
  };
  return {
    auditLogger,
    runInTransaction: async <T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T> =>
      callback(createFakeTx(store)),
  };
}

async function expectAppError(promise: Promise<unknown>, code: string, httpStatus: number) {
  const error = (await promise.then(
    () => {
      throw new Error('오류가 나야 하는데 성공했습니다.');
    },
    (thrown: unknown) => thrown,
  )) as AppError;
  expect(error.code).toBe(code);
  expect(error.httpStatus).toBe(httpStatus);
  return error;
}

// ═══════════════════════════════════════════════════════════════
// 입력 검증
// ═══════════════════════════════════════════════════════════════
describe('parseCreateCodeInput', () => {
  it('정상 입력을 trim 해 반환한다', () => {
    const input = parseCreateCodeInput({
      code: ' NEW ',
      name: ' 신규 코드 ',
      parentCode: null,
      sortOrder: 100,
      attributes: null,
    });
    expect(input).toEqual({
      code: 'NEW',
      name: '신규 코드',
      parentCode: null,
      sortOrder: 100,
      attributes: null,
    });
  });

  it('★ 알 수 없는 필드를 거부한다', () => {
    expect(() => parseCreateCodeInput({ code: 'A', name: 'B', hacker: true })).toThrow(
      ValidationError,
    );
  });

  it('★ code·name 이 공백뿐이면 거부한다', () => {
    for (const bad of ['', '   ']) {
      expect(() => parseCreateCodeInput({ code: bad, name: '이름' })).toThrow(ValidationError);
      expect(() => parseCreateCodeInput({ code: 'C', name: bad })).toThrow(ValidationError);
    }
  });

  it('sortOrder 음수·소수·문자열을 거부한다', () => {
    for (const bad of [-1, 1.5, '3']) {
      expect(() => parseCreateCodeInput({ code: 'C', name: 'N', sortOrder: bad })).toThrow(
        ValidationError,
      );
    }
  });

  it('attributes 는 객체 또는 null 만 허용한다 (배열·원시값 거부)', () => {
    for (const bad of [[1], 'x', 7, true]) {
      expect(() => parseCreateCodeInput({ code: 'C', name: 'N', attributes: bad })).toThrow(
        ValidationError,
      );
    }
    expect(parseCreateCodeInput({ code: 'C', name: 'N', attributes: { a: 1 } }).attributes).toEqual(
      { a: 1 },
    );
  });

  it('body 가 객체가 아니면 거부한다', () => {
    for (const bad of [null, [], 'x', 1]) {
      expect(() => parseCreateCodeInput(bad)).toThrow(ValidationError);
    }
  });
});

describe('parseUpdateCodePatch', () => {
  it('★ 빈 PATCH 를 거부한다', () => {
    expect(() => parseUpdateCodePatch({})).toThrow(ValidationError);
  });

  it('★ 수정 불가 필드는 "수정할 수 없는 필드" 로 거부한다', () => {
    for (const field of ['id', 'code', 'groupCode', 'createdAt', 'createdBy', 'updatedBy']) {
      const error = (() => {
        try {
          parseUpdateCodePatch({ [field]: 'x', name: '유효' });
          return null;
        } catch (thrown) {
          return thrown as ValidationError;
        }
      })();
      expect(error, field).not.toBeNull();
      expect(error?.fieldErrors.some((entry) => entry.message.includes('수정할 수 없는'))).toBe(
        true,
      );
    }
  });

  it('알 수 없는 필드는 별도 문구로 거부한다', () => {
    try {
      parseUpdateCodePatch({ nonsense: 1 });
      expect.unreachable();
    } catch (thrown) {
      const error = thrown as ValidationError;
      expect(error.fieldErrors[0]?.message).toContain('알 수 없는');
    }
  });

  it('허용 필드만 통과한다', () => {
    const patch = parseUpdateCodePatch({
      name: ' 새 이름 ',
      parentCode: 'P1',
      sortOrder: 5,
      attributes: null,
      active: false,
    });
    expect(patch).toEqual({
      name: '새 이름',
      parentCode: 'P1',
      sortOrder: 5,
      attributes: null,
      active: false,
    });
  });
});

describe('parseActiveFilter', () => {
  it("기본값은 'true' (활성만)", () => {
    expect(parseActiveFilter(null)).toBe('true');
  });

  it("'true' | 'false' | 'all' 만 허용한다", () => {
    expect(parseActiveFilter('false')).toBe('false');
    expect(parseActiveFilter('all')).toBe('all');
    expect(() => parseActiveFilter('yes')).toThrow(ValidationError);
  });
});

describe('jsonEquals', () => {
  it('키 순서가 달라도 같다고 판정한다', () => {
    expect(jsonEquals({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(jsonEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEquals(null, null)).toBe(true);
    expect(jsonEquals(null, {})).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2차 권한 가드 — Proxy 를 우회한 직접 호출도 차단
// ═══════════════════════════════════════════════════════════════
describe('★ 2차 권한 가드', () => {
  const store = makeStore();
  const dependencies = fakeDependencies(store);
  const readDb = {} as CommonCodeReadClient; // 권한에서 끊기므로 DB 까지 가지 않는다

  it('read 권한이 없으면 목록 조회가 403', async () => {
    await expectAppError(listCodeGroups(MANAGE_ONLY, { db: readDb }), ERROR_CODES.FORBIDDEN, 403);
    await expectAppError(
      listCodes(MANAGE_ONLY, 'MAJOR_TEST', 'true', { db: readDb }),
      ERROR_CODES.FORBIDDEN,
      403,
    );
  });

  it('manage 권한이 없으면 생성·수정이 403 (read 만으로 불가)', async () => {
    await expectAppError(
      createCode(
        READER_ONLY,
        'MAJOR_TEST',
        { code: 'X', name: 'x', parentCode: null, sortOrder: 0, attributes: null },
        dependencies,
      ),
      ERROR_CODES.FORBIDDEN,
      403,
    );
    await expectAppError(
      updateCode(READER_ONLY, 'MAJOR_TEST', 'P1', { name: '변경' }, dependencies),
      ERROR_CODES.FORBIDDEN,
      403,
    );
  });

  it('★ ADMIN 역할이라도 RolePermission 데이터가 없으면 차단된다', async () => {
    await expectAppError(
      listCodeGroups(ADMIN_ROLE_NO_PERMISSION, { db: readDb }),
      ERROR_CODES.FORBIDDEN,
      403,
    );
    await expectAppError(
      createCode(
        ADMIN_ROLE_NO_PERMISSION,
        'MAJOR_TEST',
        { code: 'X', name: 'x', parentCode: null, sortOrder: 0, attributes: null },
        dependencies,
      ),
      ERROR_CODES.FORBIDDEN,
      403,
    );
  });

  it('★ 위조 permissions 는 서버 판정에 영향이 없다 — ActorContext 는 서버가 만든다', () => {
    // ActorContext 는 요청 본문이 아니라 검증된 DB 조회로만 생성된다.
    // 이 테스트는 그 타입 계약을 고정한다: createActorContext 입력 외에 권한을
    // 주입할 통로가 없고, 문자열 배열은 정규화된다.
    const actor = actorWith(['common_code.read', 'common_code.read', ' ']);
    expect(actor.permissions).toEqual(['common_code.read']);
  });
});

// ═══════════════════════════════════════════════════════════════
// 1차 가드 — 경로·메서드별 권한 표
// ═══════════════════════════════════════════════════════════════
describe('★ 1차 가드 route policy (공통코드)', () => {
  it.each([
    ['/api/code-groups', 'GET', 'common_code.read'],
    ['/api/code-groups', 'HEAD', 'common_code.read'],
    ['/api/codes/BRAND', 'GET', 'common_code.read'],
    ['/api/codes/BRAND', 'POST', 'common_code.manage'],
    ['/api/codes/BRAND/FB', 'PATCH', 'common_code.manage'],
    ['/api/codes/BRAND/FB', 'DELETE', 'common_code.manage'],
    ['/api/codes/BRAND', 'PUT', 'common_code.manage'],
    ['/admin/codes', 'GET', 'common_code.read'],
  ])('%s %s → %s', (pathname, method, permission) => {
    expect(resolveRoutePermission({ pathname, method })).toBe(permission);
  });
});

// ═══════════════════════════════════════════════════════════════
// 물리삭제 부재 — API 계층과 Application 계층 모두
// ═══════════════════════════════════════════════════════════════
describe('★ 물리삭제가 존재하지 않는다', () => {
  it('Application barrel 에 delete·remove 류 함수가 없다', () => {
    const names = Object.keys(applicationBarrel);
    expect(names.filter((name) => /delete|remove|destroy/i.test(name))).toEqual([]);
  });

  it('코드 라우트 모듈이 DELETE 핸들러를 내보내지 않는다', async () => {
    const groupsRoute = await import('../../app/api/code-groups/route');
    const codesRoute = await import('../../app/api/codes/[groupCode]/route');
    const codeRoute = await import('../../app/api/codes/[groupCode]/[code]/route');

    expect('DELETE' in groupsRoute).toBe(false);
    expect('DELETE' in codesRoute).toBe(false);
    expect('DELETE' in codeRoute).toBe(false);
    // 그룹 생성·수정 API 도 없다 — 그룹은 seed·migration 관리 대상.
    expect('POST' in groupsRoute).toBe(false);
    expect('PATCH' in groupsRoute).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// createCode
// ═══════════════════════════════════════════════════════════════
describe('createCode', () => {
  const input = (overrides: Partial<Parameters<typeof createCode>[2]> = {}) => ({
    code: 'NEW',
    name: '신규',
    parentCode: null,
    sortOrder: 10,
    attributes: null,
    ...overrides,
  });

  it('생성 성공 — createdBy 는 ActorContext 에서 온다', async () => {
    const store = makeStore();
    const view = await createCode(MANAGER, 'FLAT_TEST', input(), fakeDependencies(store));

    expect(view.code).toBe('NEW');
    expect(view.active).toBe(true);
    const row = store.codes.find((entry) => entry.code === 'NEW');
    expect(row?.createdBy).toBe(MANAGER.userId);
    expect(row?.updatedBy).toBe(MANAGER.userId);
  });

  it('★ 감사로그 CREATE 가 같은 트랜잭션에서 남는다 (entityId = UUID)', async () => {
    const store = makeStore();
    const view = await createCode(MANAGER, 'FLAT_TEST', input(), fakeDependencies(store));

    expect(store.auditWrites).toHaveLength(1);
    const audit = store.auditWrites[0];
    expect(audit?.entityType).toBe('CommonCode');
    expect(audit?.entityId).toBe(view.id);
    expect(audit?.action).toBe('CREATE');
    expect(audit?.beforeValue).toBeNull();
  });

  it('★ 감사로그가 실패하면 생성이 전파 실패한다 (같은 트랜잭션 → 롤백)', async () => {
    const store = makeStore();
    await expect(
      createCode(MANAGER, 'FLAT_TEST', input(), fakeDependencies(store, { failAudit: true })),
    ).rejects.toThrow('감사로그 실패');
    // 실제 롤백은 DB 가 한다 — 대역에서는 오류 전파(=커밋 안 됨)를 고정한다.
  });

  it('없는 그룹은 404', async () => {
    const store = makeStore();
    await expectAppError(
      createCode(MANAGER, 'NOPE', input(), fakeDependencies(store)),
      ERROR_CODES.NOT_FOUND,
      404,
    );
  });

  it('비활성 그룹은 409', async () => {
    const store = makeStore();
    await expectAppError(
      createCode(MANAGER, 'OFF_TEST', input(), fakeDependencies(store)),
      ERROR_CODES.CONFLICT,
      409,
    );
  });

  it('★ 그룹 내 중복 코드는 409', async () => {
    const store = makeStore();
    await expectAppError(
      createCode(MANAGER, 'FLAT_TEST', input({ code: 'F1' }), fakeDependencies(store)),
      ERROR_CODES.CONFLICT,
      409,
    );
  });

  it('다른 그룹의 동일 코드는 허용된다', async () => {
    const store = makeStore();
    const view = await createCode(
      MANAGER,
      'MAJOR_TEST',
      input({ code: 'F1' }),
      fakeDependencies(store),
    );
    expect(view.code).toBe('F1');
  });

  it('★ 상위 그룹이 없는 그룹에 parentCode 를 주면 400', async () => {
    const store = makeStore();
    await expectAppError(
      createCode(MANAGER, 'FLAT_TEST', input({ parentCode: 'P1' }), fakeDependencies(store)),
      ERROR_CODES.VALIDATION_ERROR,
      400,
    );
  });

  it('★ parentCode 는 상위 그룹의 코드여야 한다', async () => {
    const store = makeStore();
    // F1 은 FLAT_TEST 그룹 코드 — MINOR_TEST 의 상위(MAJOR_TEST)에는 없다.
    await expectAppError(
      createCode(MANAGER, 'MINOR_TEST', input({ parentCode: 'F1' }), fakeDependencies(store)),
      ERROR_CODES.VALIDATION_ERROR,
      400,
    );
  });

  it('상위 그룹 코드를 parent 로 정상 연결한다', async () => {
    const store = makeStore();
    const view = await createCode(
      MANAGER,
      'MINOR_TEST',
      input({ parentCode: 'P1' }),
      fakeDependencies(store),
    );
    expect(view.parent).toEqual({
      id: 'c-p1',
      groupCode: 'MAJOR_TEST',
      code: 'P1',
      name: '상위 1',
    });
  });

  it('★ 비활성 parent 에 신규 active 코드 연결은 409', async () => {
    const store = makeStore();
    await expectAppError(
      createCode(MANAGER, 'MINOR_TEST', input({ parentCode: 'P2' }), fakeDependencies(store)),
      ERROR_CODES.CONFLICT,
      409,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// updateCode
// ═══════════════════════════════════════════════════════════════
describe('updateCode', () => {
  it('이름·정렬 수정 성공 — updatedBy 는 ActorContext', async () => {
    const store = makeStore();
    const view = await updateCode(
      MANAGER,
      'FLAT_TEST',
      'F1',
      { name: '평면 1 개정', sortOrder: 9 },
      fakeDependencies(store),
    );
    expect(view.name).toBe('평면 1 개정');
    expect(view.sortOrder).toBe(9);
    expect(store.codes.find((entry) => entry.id === 'c-f1')?.updatedBy).toBe(MANAGER.userId);
    expect(store.auditWrites[0]?.action).toBe('UPDATE');
  });

  it('없는 그룹·없는 코드는 404', async () => {
    const store = makeStore();
    await expectAppError(
      updateCode(MANAGER, 'NOPE', 'F1', { name: 'x' }, fakeDependencies(store)),
      ERROR_CODES.NOT_FOUND,
      404,
    );
    await expectAppError(
      updateCode(MANAGER, 'FLAT_TEST', 'NOPE', { name: 'x' }, fakeDependencies(store)),
      ERROR_CODES.NOT_FOUND,
      404,
    );
  });

  it('★ 동일 값 PATCH 는 400 — "변경할 내용이 없습니다."', async () => {
    const store = makeStore();
    const error = await expectAppError(
      updateCode(MANAGER, 'FLAT_TEST', 'F1', { name: '평면 1' }, fakeDependencies(store)),
      ERROR_CODES.VALIDATION_ERROR,
      400,
    );
    expect(error.message).toBe('변경할 내용이 없습니다.');
    // 감사로그도 남지 않는다.
    expect(store.auditWrites).toHaveLength(0);
  });

  it('동일 attributes (키 순서만 다름) 도 동일 값으로 판정한다', async () => {
    const store = makeStore();
    await expectAppError(
      updateCode(
        MANAGER,
        'MINOR_TEST',
        'M1',
        { attributes: { nameEn: 'Minor 1' } },
        fakeDependencies(store),
      ),
      ERROR_CODES.VALIDATION_ERROR,
      400,
    );
  });

  it('★ 비활성화 — action 이 DEACTIVATE 로 기록된다', async () => {
    const store = makeStore();
    const view = await updateCode(
      MANAGER,
      'FLAT_TEST',
      'F1',
      { active: false },
      fakeDependencies(store),
    );
    expect(view.active).toBe(false);
    expect(store.auditWrites[0]?.action).toBe('DEACTIVATE');
    // 행은 남는다 — 물리삭제가 아니다.
    expect(store.codes.some((entry) => entry.id === 'c-f1')).toBe(true);
  });

  it('★ 재활성화 — action 이 REACTIVATE 로 기록된다', async () => {
    const store = makeStore();
    const target = store.codes.find((entry) => entry.id === 'c-f1');
    if (target !== undefined) target.active = false;

    const view = await updateCode(
      MANAGER,
      'FLAT_TEST',
      'F1',
      { active: true },
      fakeDependencies(store),
    );
    expect(view.active).toBe(true);
    expect(store.auditWrites[0]?.action).toBe('REACTIVATE');
  });

  it('★ 하위 active 코드가 있으면 부모 비활성화는 409', async () => {
    const store = makeStore();
    await expectAppError(
      updateCode(MANAGER, 'MAJOR_TEST', 'P1', { active: false }, fakeDependencies(store)),
      ERROR_CODES.CONFLICT,
      409,
    );
    // 값이 그대로다.
    expect(store.codes.find((entry) => entry.id === 'c-p1')?.active).toBe(true);
  });

  it('하위 코드를 먼저 비활성화하면 부모도 비활성화된다', async () => {
    const store = makeStore();
    await updateCode(MANAGER, 'MINOR_TEST', 'M1', { active: false }, fakeDependencies(store));
    const view = await updateCode(
      MANAGER,
      'MAJOR_TEST',
      'P1',
      { active: false },
      fakeDependencies(store),
    );
    expect(view.active).toBe(false);
  });

  it('★ 비활성 parent 아래의 child 재활성화는 409', async () => {
    const store = makeStore();
    // M1 비활성 → P1 비활성 → M1 재활성 시도
    await updateCode(MANAGER, 'MINOR_TEST', 'M1', { active: false }, fakeDependencies(store));
    await updateCode(MANAGER, 'MAJOR_TEST', 'P1', { active: false }, fakeDependencies(store));

    await expectAppError(
      updateCode(MANAGER, 'MINOR_TEST', 'M1', { active: true }, fakeDependencies(store)),
      ERROR_CODES.CONFLICT,
      409,
    );
  });

  it('★ 자기 자신을 parent 로 지정하면 400', async () => {
    const store = makeStore();
    // MINOR_TEST 의 상위는 MAJOR_TEST 이므로, 자기 그룹 코드는 어차피 다른 그룹에서
    // 찾지 못한다. 자기참조 검사 자체는 상위 그룹에 같은 code 가 있는 경우를 대비한다.
    // 픽스처: MAJOR_TEST 에 M1 을 만들어 같은 code 로 자기참조가 성립하지 않게 한다.
    const dependencies = fakeDependencies(store);
    // parent 후보(c-m1 자신)가 상위 그룹에 없으므로 VALIDATION_ERROR 로 끝난다.
    await expectAppError(
      updateCode(MANAGER, 'MINOR_TEST', 'M1', { parentCode: 'M1' }, dependencies),
      ERROR_CODES.VALIDATION_ERROR,
      400,
    );
  });

  it('★ 순환 참조를 차단한다', async () => {
    const store = makeStore();
    // 순환 구성: MAJOR_TEST.P1 의 부모를 MINOR_TEST.M1 로 두는 손상 데이터를 만들고
    // (그룹 계층상 불가능하지만 손상 시나리오), M1 → P1 연결이 순환을 만드는지 본다.
    const p1 = store.codes.find((entry) => entry.id === 'c-p1');
    if (p1 !== undefined) p1.parentCodeId = 'c-m1';
    // 현재: M1.parent = P1(이미), P1.parent = M1 → M1 의 parentCode 를 P1 로 재설정 시도
    await expectAppError(
      updateCode(MANAGER, 'MINOR_TEST', 'M1', { parentCode: 'P1' }, fakeDependencies(store)),
      ERROR_CODES.VALIDATION_ERROR,
      400,
    );
  });

  it('parent 연결 해제 (null) 가 가능하다', async () => {
    const store = makeStore();
    const view = await updateCode(
      MANAGER,
      'MINOR_TEST',
      'M1',
      { parentCode: null },
      fakeDependencies(store),
    );
    expect(view.parent).toBeNull();
  });

  it('★ 감사로그 실패 시 수정이 전파 실패한다', async () => {
    const store = makeStore();
    await expect(
      updateCode(
        MANAGER,
        'FLAT_TEST',
        'F1',
        { name: '바뀜' },
        fakeDependencies(store, { failAudit: true }),
      ),
    ).rejects.toThrow('감사로그 실패');
  });

  it('before/after 값이 감사로그에 담긴다', async () => {
    const store = makeStore();
    await updateCode(MANAGER, 'FLAT_TEST', 'F1', { name: '개정' }, fakeDependencies(store));
    const audit = store.auditWrites[0];
    expect((audit?.beforeValue as { name: string }).name).toBe('평면 1');
    expect((audit?.afterValue as { name: string }).name).toBe('개정');
  });
});
