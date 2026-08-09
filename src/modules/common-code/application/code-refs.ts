import type { TransactionClient } from '@/shared/db';

/**
 * 공통코드 참조 해석 (T1-3) — 다른 모듈이 쓰는 **공개 read 인터페이스.**
 *
 * SKU 등 업무 모델이 `brandId` 같은 공통코드 참조를 검증할 때, CommonCode
 * infrastructure 를 직접 import 하지 않고 이 쿼리를 통해 group 정체성과
 * 활성 여부를 확인한다.
 */

export interface CommonCodeRef {
  readonly id: string;
  readonly groupCode: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
}

/** 트랜잭션 안팎 어디서든 쓸 수 있는 최소 클라이언트 형태. */
export type CommonCodeRefClient = Pick<TransactionClient, 'commonCode'>;

/** id 목록으로 공통코드를 해석한다. 없는 id 는 결과에 포함되지 않는다. */
export async function findCommonCodeRefs(
  client: CommonCodeRefClient,
  ids: readonly string[],
): Promise<readonly CommonCodeRef[]> {
  if (ids.length === 0) return [];

  const rows = await client.commonCode.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      code: true,
      name: true,
      active: true,
      group: { select: { groupCode: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    groupCode: row.group.groupCode,
    code: row.code,
    name: row.name,
    active: row.active,
  }));
}
