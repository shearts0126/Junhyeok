import { AuthorizationError, ERROR_CODES } from '@/shared/errors';

import type { ActorContext } from './actor';

/**
 * 권한 검사 (T0-6) — **2차 가드**.
 *
 * 순수 함수다. DB·요청·프레임워크에 의존하지 않는다.
 *
 * ⚠️ Application Service 는 **Proxy 가 이미 통과시켰다고 가정하지 않는다.**
 *    Proxy 는 경로 기반이라 새 라우트가 추가되면 누락될 수 있고, 서버 액션·
 *    내부 호출·배치는 Proxy 를 거치지 않는다. 서비스가 다시 검사하지 않으면
 *    그 경로들이 전부 무방비가 된다.
 *
 * ⚠️ **ADMIN 예외가 없다.** ADMIN 도 `role_permission` 데이터로 권한을
 *    취득한다. 코드에 역할 이름을 넣는 순간 권한 표가 실제 접근 권한을
 *    설명하지 못하게 되고, 감사에서 근거를 댈 수 없다.
 */

/** actor 가 권한을 가지고 있는가. */
export function hasPermission(actor: ActorContext, permissionKey: string): boolean {
  return actor.permissions.includes(permissionKey);
}

/** actor 가 역할을 가지고 있는가. 권한 판정에는 쓰지 않는다(권한으로 판정할 것). */
export function hasRole(actor: ActorContext, roleCode: string): boolean {
  return actor.roles.includes(roleCode);
}

/**
 * 권한이 없으면 403 을 던진다.
 *
 * ```ts
 * assertPermission(actor, 'role.read');
 * ```
 *
 * @throws {AuthorizationError} `FORBIDDEN` / HTTP 403
 */
export function assertPermission(actor: ActorContext, permissionKey: string): void {
  if (hasPermission(actor, permissionKey)) return;

  throw new AuthorizationError(ERROR_CODES.FORBIDDEN, {
    message: `권한 '${permissionKey}' 가 없습니다.`,
    publicHint: '접근 권한이 필요합니다. 관리자에게 문의하세요.',
    // ⚠️ 로그 전용 — 어떤 권한이 필요한지는 외부에 알리지 않는다.
    //    권한 키 목록이 새어 나가면 공격자가 내부 구조를 추론한다.
    context: {
      requiredPermission: permissionKey,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
    },
  });
}

/** 여러 권한을 모두 요구한다. */
export function assertAllPermissions(actor: ActorContext, permissionKeys: readonly string[]): void {
  for (const key of permissionKeys) {
    assertPermission(actor, key);
  }
}
