/**
 * 라우트 접근 정책 (T0-6, T0-7 확장) — **1차 가드**의 판정 표.
 *
 * Proxy 와 Route Handler 가 같은 표를 본다. 정책이 두 곳에 흩어지면
 * 한쪽만 고쳐지는 일이 생긴다.
 *
 * ⚠️ **기본값은 보호**다. 표에 없는 경로는 인증을 요구한다. 새 라우트를 추가할 때
 *    깜빡 잊으면 열리는 것이 아니라 닫히도록 하기 위함이다.
 *
 * ⚠️ 권한 정책은 **HTTP 메서드까지** 본다. 같은 경로라도 조회와 변경이 요구하는
 *    권한이 다르다. 경로만으로 판정하면 조회 권한만 가진 사용자가 변경 요청을
 *    1차 가드에서 통과해버린다.
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

/** 정책이 다루는 HTTP 메서드. */
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface RoutePermissionPolicy {
  readonly prefix: string;
  /**
   * 이 정책이 적용되는 메서드. 생략하면 모든 메서드에 적용된다.
   *
   * 여러 정책이 같은 prefix 를 가질 수 있으므로, **더 구체적인(메서드 지정)
   * 정책을 앞에** 둔다.
   */
  readonly methods?: readonly HttpMethod[];
  readonly permission: string;
}

/**
 * 경로·메서드별로 요구하는 권한.
 *
 * 앞에서부터 첫 번째로 맞는 정책을 쓴다.
 */
export const ROUTE_PERMISSIONS: readonly RoutePermissionPolicy[] = [
  { prefix: '/api/roles', methods: ['GET'], permission: 'role.read' },

  // 같은 경로지만 조회와 변경이 다른 권한을 요구한다.
  { prefix: '/api/system-settings', methods: ['GET', 'HEAD'], permission: 'system_setting.read' },
  {
    prefix: '/api/system-settings',
    methods: ['PATCH', 'PUT', 'POST', 'DELETE'],
    permission: 'system_setting.update',
  },

  // 공통코드 (T0-8). 조회는 read, 변경은 manage.
  // ⚠️ DELETE 라우트는 존재하지 않지만(405), 1차 가드는 manage 로 묶어
  //    read 권한만 가진 사용자의 변경성 요청이 핸들러에 닿지 않게 한다.
  { prefix: '/api/code-groups', methods: ['GET', 'HEAD'], permission: 'common_code.read' },
  { prefix: '/api/codes', methods: ['GET', 'HEAD'], permission: 'common_code.read' },
  {
    prefix: '/api/codes',
    methods: ['POST', 'PATCH', 'PUT', 'DELETE'],
    permission: 'common_code.manage',
  },

  // SKU CRUD (T1-3). 조회는 read, 생성은 create, 수정은 update.
  // ⚠️ DELETE 라우트는 존재하지 않지만(405), 1차 가드는 update 로 묶어
  //    read 권한만 가진 사용자의 변경성 요청이 핸들러에 닿지 않게 한다.
  { prefix: '/api/skus', methods: ['GET', 'HEAD'], permission: 'sku.read' },
  { prefix: '/api/skus', methods: ['POST'], permission: 'sku.create' },
  { prefix: '/api/skus', methods: ['PATCH', 'PUT', 'DELETE'], permission: 'sku.update' },

  // 관리 화면도 1차에서 조회 권한을 요구한다 (2차는 화면이 부르는 API가 검사).
  { prefix: '/admin/codes', methods: ['GET', 'HEAD'], permission: 'common_code.read' },
];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return DEV_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export interface RoutePermissionQuery {
  readonly pathname: string;
  readonly method: string;
}

/**
 * 경로·메서드가 요구하는 권한. 없으면 `undefined`(인증만 필요).
 *
 * 메서드를 지정하지 않은 정책은 모든 메서드에 적용된다.
 */
export function resolveRoutePermission(query: RoutePermissionQuery): string | undefined {
  const method = query.method.toUpperCase();

  const match = ROUTE_PERMISSIONS.find((policy) => {
    if (!query.pathname.startsWith(policy.prefix)) return false;
    if (policy.methods === undefined) return true;
    return policy.methods.some((allowed) => allowed === method);
  });

  return match?.permission;
}
