import type { PrismaClient } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { DomainError, ERROR_CODES } from '@/shared/errors';

import type { ActiveFilter } from './parse';
import { CODE_READ_PERMISSION } from './policy';
import { toCodeView, type CodeGroupView, type CodeView } from './views';

/**
 * 공통코드 조회 (T0-8).
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 `common_code.read` 를
 *    여기서 다시 검사한다.
 */

/** 조회에 필요한 최소 클라이언트. 테스트에서 대역을 주입한다. */
export type CommonCodeReadClient = Pick<PrismaClient, 'commonCodeGroup' | 'commonCode'>;

export interface CommonCodeListDependencies {
  readonly db?: CommonCodeReadClient;
}

async function defaultClient(): Promise<CommonCodeReadClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

/**
 * 그룹 목록. 그룹별 전체·활성 코드 수를 함께 낸다.
 *
 * 정렬: `sortOrder ASC, groupCode ASC`.
 */
export async function listCodeGroups(
  actor: ActorContext,
  dependencies: CommonCodeListDependencies = {},
): Promise<readonly CodeGroupView[]> {
  assertPermission(actor, CODE_READ_PERMISSION);
  const db = dependencies.db ?? (await defaultClient());

  const groups = await db.commonCodeGroup.findMany({
    orderBy: [{ sortOrder: 'asc' }, { groupCode: 'asc' }],
    select: {
      id: true,
      groupCode: true,
      groupName: true,
      sortOrder: true,
      active: true,
      parentGroup: { select: { groupCode: true } },
      _count: { select: { codes: true } },
    },
  });

  // 활성 코드 수는 그룹별 집계 한 번으로 얻는다 (그룹마다 count 쿼리 N번 금지).
  const activeCounts = await db.commonCode.groupBy({
    by: ['groupId'],
    where: { active: true },
    _count: { _all: true },
  });
  const activeByGroupId = new Map(activeCounts.map((row) => [row.groupId, row._count._all]));

  return groups.map((group) => ({
    groupCode: group.groupCode,
    groupName: group.groupName,
    parentGroupCode: group.parentGroup?.groupCode ?? null,
    sortOrder: group.sortOrder,
    active: group.active,
    codeCount: group._count.codes,
    activeCodeCount: activeByGroupId.get(group.id) ?? 0,
  }));
}

/** groupCode 로 그룹을 찾는다. 없으면 404. */
export function groupNotFound(groupCode: string): DomainError {
  return new DomainError(ERROR_CODES.NOT_FOUND, {
    message: `코드 그룹 '${groupCode}' 이(가) 없습니다.`,
    context: { groupCode },
  });
}

/**
 * 그룹의 코드 목록.
 *
 * - 존재하지 않는 그룹은 404
 * - 기본은 활성 코드만 (`active=true`), `false`/`all` 로 확장
 * - 정렬: `sort_order ASC, code ASC`
 */
export async function listCodes(
  actor: ActorContext,
  groupCode: string,
  activeFilter: ActiveFilter,
  dependencies: CommonCodeListDependencies = {},
): Promise<{
  readonly group: { groupCode: string; groupName: string };
  readonly codes: readonly CodeView[];
}> {
  assertPermission(actor, CODE_READ_PERMISSION);
  const db = dependencies.db ?? (await defaultClient());

  const group = await db.commonCodeGroup.findUnique({
    where: { groupCode },
    select: { id: true, groupCode: true, groupName: true },
  });
  if (group === null) throw groupNotFound(groupCode);

  const rows = await db.commonCode.findMany({
    where: {
      groupId: group.id,
      ...(activeFilter === 'all' ? {} : { active: activeFilter === 'true' }),
    },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    include: {
      group: { select: { groupCode: true } },
      parentCode: {
        select: {
          id: true,
          code: true,
          name: true,
          group: { select: { groupCode: true } },
        },
      },
    },
  });

  return {
    group: { groupCode: group.groupCode, groupName: group.groupName },
    codes: rows.map(toCodeView),
  };
}
