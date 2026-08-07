import type { ActorContext } from '../domain/actor';
import { assertPermission } from '../domain/permission';
import {
  prismaRoleReader,
  type RoleReader,
  type RoleSummary,
} from '../infrastructure/user-repository';

/**
 * 역할 목록 조회 (T0-6).
 *
 * ⚠️ **2차 권한 가드.** Proxy 가 이미 통과시켰다고 가정하지 않고 여기서 다시
 *    검사한다. Proxy 는 경로 기반이라 새 라우트에서 누락될 수 있고, 서버 액션·
 *    내부 호출·배치는 Proxy 를 거치지 않는다.
 *
 * 이 함수를 Proxy 없이 직접 호출해도 권한이 없으면 403 이 난다.
 */

export const LIST_ROLES_PERMISSION = 'role.read';

export interface ListRolesDependencies {
  readonly reader?: RoleReader;
}

export async function listRoles(
  actor: ActorContext,
  dependencies: ListRolesDependencies = {},
): Promise<readonly RoleSummary[]> {
  // ★ 2차 가드 — 이 줄이 없으면 Proxy 를 우회한 호출이 전부 통과한다.
  assertPermission(actor, LIST_ROLES_PERMISSION);

  const reader = dependencies.reader ?? prismaRoleReader;
  return reader.listRoles();
}
