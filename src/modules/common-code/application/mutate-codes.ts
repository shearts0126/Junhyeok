import { Prisma } from '@/generated/prisma/client';
import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { ConflictError, DomainError, ERROR_CODES, ValidationError } from '@/shared/errors';

import { groupNotFound } from './list-codes';
import type { CreateCodeInput, UpdateCodePatch } from './parse';
import { CODE_MANAGE_PERMISSION } from './policy';
import { toCodeView, type CodeView } from './views';

/**
 * 공통코드 생성·수정 (T0-8).
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `common_code.manage` 를 재검사한다.
 *
 * ⚠️ 변경과 감사로그 INSERT 는 **같은 트랜잭션**이다. 감사로그가 실패하면
 *    코드 변경도 롤백된다.
 *
 * ⛔ **물리삭제가 없다.** 이 모듈 어디에도 delete 가 없다 — "삭제"는 항상
 *    `active=false` (비활성화)다. 비활성 코드도 감사·이력 목적으로 DB 에 남는다.
 *
 * ⛔ 생성 후 `code` 와 `group` 은 바꿀 수 없다. 코드 값이 바뀌면 그 코드를
 *    참조하던 모든 기록의 의미가 바뀐다.
 */

export interface CommonCodeMutateDependencies {
  readonly auditLogger?: AuditLogger;
  readonly runInTransaction?: <T>(callback: (tx: TransactionClient) => Promise<T>) => Promise<T>;
}

const CODE_ENTITY_TYPE = 'CommonCode';

/** include 한 벌 — view 를 만들 때 필요한 부모·그룹 정보. */
const VIEW_INCLUDE = {
  group: { select: { groupCode: true } },
  parentCode: {
    select: { id: true, code: true, name: true, group: { select: { groupCode: true } } },
  },
} as const;

interface GroupRow {
  readonly id: string;
  readonly groupCode: string;
  readonly active: boolean;
  readonly parentGroupId: string | null;
}

async function findGroup(tx: TransactionClient, groupCode: string): Promise<GroupRow> {
  const group = await tx.commonCodeGroup.findUnique({
    where: { groupCode },
    select: { id: true, groupCode: true, active: true, parentGroupId: true },
  });
  if (group === null) throw groupNotFound(groupCode);
  return group;
}

interface ResolvedParent {
  readonly id: string;
  readonly active: boolean;
}

/**
 * 부모 코드 참조를 검증하고 해석한다.
 *
 * - 그룹에 `parentGroupId` 가 없으면 부모 지정 금지
 * - 부모 코드는 **그 부모 그룹 안에** 있어야 한다 (다른 그룹 코드 금지)
 * - 자기 자신 금지, 순환 금지
 * - 활성 코드를 비활성 부모에 연결 금지
 */
async function resolveParent(
  tx: TransactionClient,
  group: GroupRow,
  parentCode: string | null,
  options: { childActive: boolean; childId?: string },
): Promise<ResolvedParent | null> {
  if (parentCode === null) return null;

  if (group.parentGroupId === null) {
    throw new ValidationError(
      [{ path: 'parentCode', message: `그룹 '${group.groupCode}' 은(는) 상위 그룹이 없습니다.` }],
      { message: '상위 그룹이 없는 그룹의 코드에는 부모를 지정할 수 없습니다.' },
    );
  }

  const parent = await tx.commonCode.findUnique({
    where: { groupId_code: { groupId: group.parentGroupId, code: parentCode } },
    select: { id: true, active: true, parentCodeId: true },
  });
  if (parent === null) {
    throw new ValidationError(
      [{ path: 'parentCode', message: `상위 그룹에 코드 '${parentCode}' 이(가) 없습니다.` }],
      { message: '부모 코드가 상위 그룹에 없습니다.' },
    );
  }

  if (options.childId !== undefined && parent.id === options.childId) {
    throw new ValidationError([
      { path: 'parentCode', message: '자기 자신을 부모로 지정할 수 없습니다.' },
    ]);
  }

  // 순환 검사 — 새 부모의 조상 사슬에 자기 자신이 있으면 안 된다.
  // 부모는 다른 그룹에 있으므로 사슬은 그룹 계층을 따라 올라간다.
  if (options.childId !== undefined) {
    let ancestorId: string | null = parent.parentCodeId;
    let hops = 0;
    while (ancestorId !== null) {
      if (ancestorId === options.childId) {
        throw new ValidationError([
          { path: 'parentCode', message: '순환 참조가 됩니다. 상위 사슬을 확인하세요.' },
        ]);
      }
      hops += 1;
      if (hops > 100) {
        // 데이터가 이미 손상된 경우다. 순환 위에 더 쌓지 않는다.
        throw new ValidationError([
          { path: 'parentCode', message: '상위 사슬이 비정상적으로 깊습니다.' },
        ]);
      }
      const ancestor: { parentCodeId: string | null } | null = await tx.commonCode.findUnique({
        where: { id: ancestorId },
        select: { parentCodeId: true },
      });
      ancestorId = ancestor?.parentCodeId ?? null;
    }
  }

  if (options.childActive && !parent.active) {
    throw new ConflictError(ERROR_CODES.CONFLICT, {
      message: `비활성 상위 코드 '${parentCode}' 에는 활성 코드를 연결할 수 없습니다.`,
      publicDetails: { parentCode },
      publicHint: '상위 코드를 먼저 재활성화하거나 다른 상위 코드를 지정하세요.',
      retryable: false,
    });
  }

  return { id: parent.id, active: parent.active };
}

function duplicateCode(groupCode: string, code: string): ConflictError {
  return new ConflictError(ERROR_CODES.CONFLICT, {
    message: `그룹 '${groupCode}' 에 코드 '${code}' 이(가) 이미 있습니다.`,
    publicDetails: { groupCode, code },
    publicHint: '다른 코드 값을 사용하거나 기존 코드를 수정하세요.',
    retryable: false,
  });
}

/**
 * 코드 생성. `common_code.manage` 권한이 필요하다.
 *
 * - 그룹이 없으면 404, 비활성 그룹이면 409
 * - 그룹 내 중복 코드 409 (동시 생성 경합은 DB UNIQUE 가 최종 판정)
 * - 생성자·수정자는 **ActorContext** 에서만 — 요청 본문의 actor 정보를 받지 않는다
 */
export async function createCode(
  actor: ActorContext,
  groupCode: string,
  input: CreateCodeInput,
  dependencies: CommonCodeMutateDependencies = {},
): Promise<CodeView> {
  assertPermission(actor, CODE_MANAGE_PERMISSION);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const group = await findGroup(tx, groupCode);

    if (!group.active) {
      throw new ConflictError(ERROR_CODES.CONFLICT, {
        message: `비활성 그룹 '${groupCode}' 에는 코드를 추가할 수 없습니다.`,
        publicDetails: { groupCode },
        retryable: false,
      });
    }

    const existing = await tx.commonCode.findUnique({
      where: { groupId_code: { groupId: group.id, code: input.code } },
      select: { id: true },
    });
    if (existing !== null) throw duplicateCode(groupCode, input.code);

    // 신규 코드는 active=true 로 태어난다 → 비활성 부모에 연결 금지가 적용된다.
    const parent = await resolveParent(tx, group, input.parentCode, { childActive: true });

    let created;
    try {
      created = await tx.commonCode.create({
        data: {
          groupId: group.id,
          code: input.code,
          name: input.name,
          parentCodeId: parent?.id ?? null,
          sortOrder: input.sortOrder,
          // JSON 컬럼의 SQL NULL 은 Prisma.DbNull 로 표기한다 (JSON null 과 구분).
          attributes:
            input.attributes === null ? Prisma.DbNull : (input.attributes as Prisma.InputJsonValue),
          active: true,
          // ★ ActorContext 에서만.
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
        include: VIEW_INCLUDE,
      });
    } catch (error) {
      // 위의 조회 이후 다른 요청이 먼저 만든 경우 — DB UNIQUE 가 잡는다.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw duplicateCode(groupCode, input.code);
      }
      throw error;
    }

    const view = toCodeView(created);

    // ★ 같은 트랜잭션. 로그 실패 시 생성도 롤백된다.
    await logger.write(tx, {
      actor,
      entityType: CODE_ENTITY_TYPE,
      // ⚠️ 실제 CommonCode UUID — 표시용 코드 문자열이 아니다.
      entityId: created.id,
      action: 'CREATE',
      beforeValue: null,
      afterValue: view,
    });

    return view;
  });
}

/** attributes(JSON) 동등성. 키 순서 차이를 무시한다. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const objectA = a as Record<string, unknown>;
  const objectB = b as Record<string, unknown>;
  const keysA = Object.keys(objectA);
  const keysB = Object.keys(objectB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => key in objectB && jsonEquals(objectA[key], objectB[key]));
}

/** 그룹은 있으나 코드가 없다 — 404. */
function codeNotFound(groupCode: string, code: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `그룹 '${groupCode}' 에 코드 '${code}' 이(가) 없습니다.`,
    context: { groupCode, code },
  });
}

/**
 * 코드 수정. `common_code.manage` 권한이 필요하다.
 *
 * 수정 가능: `name`·`parentCode`·`sortOrder`·`attributes`·`active`.
 * `code`·`group` 은 생성 후 불변 — parse 단계에서 이미 거부된다.
 *
 * - **동일 값 요청은 400** — "변경할 내용이 없습니다." 조용히 성공 처리하면
 *   클라이언트는 반영됐다고 오해하고, 감사로그에는 변경 없는 UPDATE 가 쌓인다.
 * - 비활성화(true→false): 하위 **활성** 코드가 있으면 409 로 차단
 * - 재활성화(false→true): 부모가 비활성이면 409 로 차단
 */
export async function updateCode(
  actor: ActorContext,
  groupCode: string,
  code: string,
  patch: UpdateCodePatch,
  dependencies: CommonCodeMutateDependencies = {},
): Promise<CodeView> {
  assertPermission(actor, CODE_MANAGE_PERMISSION);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const group = await findGroup(tx, groupCode);

    const row = await tx.commonCode.findUnique({
      where: { groupId_code: { groupId: group.id, code } },
      include: VIEW_INCLUDE,
    });
    if (row === null) throw codeNotFound(groupCode, code);

    const beforeView = toCodeView(row);
    const effectiveActive = patch.active ?? row.active;

    // 부모 변경이 있으면 해석·검증한다. (childActive 는 패치 적용 후 상태 기준)
    let nextParentId = row.parentCodeId;
    let nextParentActive: boolean | null = null;
    if (patch.parentCode !== undefined) {
      const parent = await resolveParent(tx, group, patch.parentCode, {
        childActive: effectiveActive,
        childId: row.id,
      });
      nextParentId = parent?.id ?? null;
      nextParentActive = parent?.active ?? null;
    } else if (row.parentCodeId !== null) {
      const currentParent = await tx.commonCode.findUnique({
        where: { id: row.parentCodeId },
        select: { active: true },
      });
      nextParentActive = currentParent?.active ?? null;
    }

    // ── 동일 값 검사 ──────────────────────────────────────────
    const changed =
      (patch.name !== undefined && patch.name !== row.name) ||
      (patch.sortOrder !== undefined && patch.sortOrder !== row.sortOrder) ||
      (patch.active !== undefined && patch.active !== row.active) ||
      (patch.parentCode !== undefined && nextParentId !== row.parentCodeId) ||
      (patch.attributes !== undefined && !jsonEquals(patch.attributes, row.attributes ?? null));

    if (!changed) {
      throw new ValidationError([{ path: 'body', message: '변경할 내용이 없습니다.' }], {
        message: '변경할 내용이 없습니다.',
      });
    }

    // ── 활성 전환 규칙 ────────────────────────────────────────
    const deactivating = row.active && patch.active === false;
    const reactivating = !row.active && patch.active === true;

    if (deactivating) {
      const activeChildren = await tx.commonCode.count({
        where: { parentCodeId: row.id, active: true },
      });
      if (activeChildren > 0) {
        throw new ConflictError(ERROR_CODES.CONFLICT, {
          message: `하위 활성 코드 ${activeChildren}건이 있어 비활성화할 수 없습니다.`,
          publicDetails: { activeChildren },
          publicHint: '하위 코드를 먼저 비활성화하세요.',
          retryable: false,
        });
      }
    }

    if (reactivating && nextParentId !== null && nextParentActive === false) {
      throw new ConflictError(ERROR_CODES.CONFLICT, {
        message: '상위 코드가 비활성 상태라 재활성화할 수 없습니다.',
        publicHint: '상위 코드를 먼저 재활성화하세요.',
        retryable: false,
      });
    }

    const updated = await tx.commonCode.update({
      where: { id: row.id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(patch.parentCode !== undefined ? { parentCodeId: nextParentId } : {}),
        ...(patch.attributes !== undefined
          ? {
              attributes:
                patch.attributes === null
                  ? Prisma.DbNull
                  : (patch.attributes as Prisma.InputJsonValue),
            }
          : {}),
        // ★ ActorContext 에서만.
        updatedBy: actor.userId,
      },
      include: VIEW_INCLUDE,
    });

    const afterView = toCodeView(updated);

    const action = deactivating ? 'DEACTIVATE' : reactivating ? 'REACTIVATE' : 'UPDATE';

    // ★ 같은 트랜잭션. 로그 실패 시 수정도 롤백된다.
    await logger.write(tx, {
      actor,
      entityType: CODE_ENTITY_TYPE,
      entityId: row.id,
      action,
      beforeValue: beforeView,
      afterValue: afterView,
    });

    return afterView;
  });
}
