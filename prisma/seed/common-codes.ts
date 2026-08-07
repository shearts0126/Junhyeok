import { Prisma, type PrismaClient } from '@/generated/prisma/client';

import { COMMON_CODE_GROUP_SEED, COMMON_CODE_SEED, type CommonCodeSeed } from './common-code-data';

/**
 * 코드사전 시드 (T0-8) — **idempotent**.
 *
 * ## 원칙
 *
 *   - natural key(`groupCode`, `(groupId, code)`) 로 upsert 한다.
 *     재실행해도 중복이 없고 **UUID 가 바뀌지 않는다**.
 *   - seed 가 관리하는 코드의 이름·정렬·부모·attributes·active 는 기준 데이터와
 *     일치하도록 맞춘다(upsert 의 update).
 *   - ⛔ **사용자가 API 로 추가한 커스텀 코드는 건드리지 않는다** — deleteMany 가 없다.
 *   - 부모 코드는 먼저 생성된 것을 조회해 연결한다. **누락된 부모를 자동 생성하지
 *     않는다** — 부모가 없으면 던져서 전체 트랜잭션이 롤백된다.
 *
 * ⚠️ 반드시 트랜잭션 클라이언트 안에서 호출해야 부분 시드가 남지 않는다.
 *    (`prisma/seed/index.ts` 가 `$transaction` 으로 감싼다)
 */

export type CommonCodeSeedClient =
  Pick<PrismaClient, 'commonCodeGroup' | 'commonCode'> | Prisma.TransactionClient;

export interface CommonCodeSeedResult {
  readonly groups: number;
  readonly codes: number;
  /** 그룹별 시드 코드 수. 출력 순서는 시드 정의 순서다. */
  readonly byGroup: ReadonlyArray<{ groupCode: string; count: number }>;
}

/** 부모 코드 누락·불일치. 시드 전체를 롤백시키기 위해 던진다. */
export class CommonCodeSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommonCodeSeedError';
  }
}

/** 테스트에서 손상된 데이터로 롤백을 검증할 때만 주입한다. 운영 시드는 기본값. */
export interface CommonCodeSeedData {
  readonly groups: readonly (typeof COMMON_CODE_GROUP_SEED)[number][];
  readonly codes: Readonly<Record<string, readonly CommonCodeSeed[]>>;
}

export async function seedCommonCodes(
  client: CommonCodeSeedClient,
  data: CommonCodeSeedData = { groups: COMMON_CODE_GROUP_SEED, codes: COMMON_CODE_SEED },
): Promise<CommonCodeSeedResult> {
  const seedGroups = data.groups;
  const seedCodes = data.codes;

  // 1) 그룹 — parent 그룹을 먼저 만들 수 있도록 parent 없는 그룹부터 처리한다.
  //    (T0-8 시드는 전부 parent 없음이지만, 규칙은 데이터가 아니라 코드가 보장한다)
  const ordered = [...seedGroups].sort(
    (a, b) => Number(a.parentGroupCode !== null) - Number(b.parentGroupCode !== null),
  );

  const groupIdByCode = new Map<string, string>();

  for (const group of ordered) {
    let parentGroupId: string | null = null;
    if (group.parentGroupCode !== null) {
      const parentId = groupIdByCode.get(group.parentGroupCode);
      if (parentId === undefined) {
        throw new CommonCodeSeedError(
          `그룹 '${group.groupCode}' 의 부모 그룹 '${group.parentGroupCode}' 가 시드에 없습니다.`,
        );
      }
      parentGroupId = parentId;
    }

    const row = await client.commonCodeGroup.upsert({
      where: { groupCode: group.groupCode },
      update: {
        groupName: group.groupName,
        description: group.description,
        parentGroupId,
        sortOrder: group.sortOrder,
        active: true,
      },
      create: {
        groupCode: group.groupCode,
        groupName: group.groupName,
        description: group.description,
        parentGroupId,
        sortOrder: group.sortOrder,
        active: true,
      },
      select: { id: true, groupCode: true },
    });
    groupIdByCode.set(row.groupCode, row.id);
  }

  // 2) 코드 — 부모 없는 코드를 1차로 전부 넣고, 부모 있는 코드를 2차로 연결한다.
  const withParent: Array<{ groupCode: string; seed: CommonCodeSeed }> = [];
  const byGroup: Array<{ groupCode: string; count: number }> = [];
  let total = 0;

  for (const group of seedGroups) {
    const seeds = seedCodes[group.groupCode] ?? [];
    const groupId = groupIdByCode.get(group.groupCode);
    if (groupId === undefined) {
      throw new CommonCodeSeedError(`그룹 '${group.groupCode}' 가 생성되지 않았습니다.`);
    }

    for (const seed of seeds) {
      if (seed.parent !== null) {
        withParent.push({ groupCode: group.groupCode, seed });
        continue;
      }
      await upsertCode(client, groupId, seed, null);
    }

    byGroup.push({ groupCode: group.groupCode, count: seeds.length });
    total += seeds.length;
  }

  for (const { groupCode, seed } of withParent) {
    const groupId = groupIdByCode.get(groupCode);
    if (groupId === undefined) {
      throw new CommonCodeSeedError(`그룹 '${groupCode}' 가 생성되지 않았습니다.`);
    }
    if (seed.parent === null) continue;

    const parentGroupId = groupIdByCode.get(seed.parent.groupCode);
    if (parentGroupId === undefined) {
      throw new CommonCodeSeedError(
        `코드 '${groupCode}.${seed.code}' 의 부모 그룹 '${seed.parent.groupCode}' 가 시드에 없습니다.`,
      );
    }

    // ⛔ 누락된 부모를 자동 생성하지 않는다. 없으면 시드 실패 → 전체 롤백.
    const parent = await client.commonCode.findUnique({
      where: { groupId_code: { groupId: parentGroupId, code: seed.parent.code } },
      select: { id: true },
    });
    if (parent === null) {
      throw new CommonCodeSeedError(
        `코드 '${groupCode}.${seed.code}' 의 부모 '${seed.parent.groupCode}.${seed.parent.code}' 가 없습니다.`,
      );
    }

    await upsertCode(client, groupId, seed, parent.id);
  }

  return { groups: seedGroups.length, codes: total, byGroup };
}

async function upsertCode(
  client: CommonCodeSeedClient,
  groupId: string,
  seed: CommonCodeSeed,
  parentCodeId: string | null,
): Promise<void> {
  // attributes 는 원본 그대로. null 은 JSON null 이 아니라 SQL NULL 로 저장한다.
  const attributes =
    seed.attributes === null
      ? { attributes: Prisma.DbNull }
      : { attributes: seed.attributes as Prisma.InputJsonValue };

  await client.commonCode.upsert({
    where: { groupId_code: { groupId, code: seed.code } },
    update: {
      name: seed.name,
      parentCodeId,
      sortOrder: seed.sortOrder,
      active: true,
      ...attributes,
    },
    create: {
      groupId,
      code: seed.code,
      name: seed.name,
      parentCodeId,
      sortOrder: seed.sortOrder,
      active: true,
      ...attributes,
    },
  });
}

/** `pnpm db:seed` 종료 시 출력하는 요약. */
export function formatCommonCodeSeedSummary(result: CommonCodeSeedResult): string {
  const lines = [`groups=${result.groups}`, `codes=${result.codes}`];
  for (const entry of result.byGroup) {
    lines.push(`${entry.groupCode}=${entry.count}`);
  }
  return lines.join('\n');
}
