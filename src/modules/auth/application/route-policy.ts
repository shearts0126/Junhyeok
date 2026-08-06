/**
 * 라우트 접근 정책 (T0-6) — **1차 가드**의 판정 표.
 *
 * Proxy 와 Route Handler 가 같은 표를 본다. 정책이 두 곳에 흩어지면
 * 한쪽만 고쳐지는 일이 생긴다.
 *
 * ⚠️ **기본값은 보호**다. 표에 없는 경로는 인증을 요구한다. 새 라우트를 추가할 때
 *    깜빡 잊으면 열리는 것이 아니라 닫히도록 하기 위함이다.
 */

/** 인증 없이 접근할 수 있는 경로. */
export const PUBLIC_PATHS: readonly string[] = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/login',
  '/',
];

/** 개발 전용 라우트. 자체 가드가 있으므로 여기서는 공개로 둔다. */
const DEV_ONLY_PREFIXES: readonly string[] = ['/api/dev/'];

/** 경로별로 추가로 요구하는 권한. */
export const ROUTE_PERMISSIONS: ReadonlyArray<{
  readonly prefix: string;
  readonly permission: string;
}> = [{ prefix: '/api/roles', permission: 'role.read' }];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return DEV_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** 경로가 요구하는 권한. 없으면 `undefined`(인증만 필요). */
export function requiredPermissionFor(pathname: string): string | undefined {
  const match = ROUTE_PERMISSIONS.find((policy) => pathname.startsWith(policy.prefix));
  return match?.permission;
}
