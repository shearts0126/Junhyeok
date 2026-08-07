/**
 * auth 모듈 공개 인터페이스 (T0-6).
 *
 * 다른 모듈은 이 경로로만 인증·권한 기능을 사용한다.
 * infrastructure 를 직접 참조하지 않는다.
 */

export { resolveActor, UnauthenticatedError, isAppError } from './resolve-actor';
export type { ResolveActorDependencies, ResolveActorRequest } from './resolve-actor';

export { listRoles, LIST_ROLES_PERMISSION } from './list-roles';
export type { ListRolesDependencies } from './list-roles';

export {
  PUBLIC_PATHS,
  ROUTE_PERMISSIONS,
  isPublicPath,
  resolveRoutePermission,
  type HttpMethod,
  type RoutePermissionPolicy,
  type RoutePermissionQuery,
} from './route-policy';

export {
  createActorContext,
  normalizeCodes,
  type ActorContext,
  type ActorContextInput,
} from '../domain/actor';

export {
  assertPermission,
  assertAllPermissions,
  hasPermission,
  hasRole,
} from '../domain/permission';

export type { RoleSummary, UserAuthorization } from '../infrastructure/user-repository';
