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
   * 경로가 이 suffix 로 끝날 때만 적용된다 (`/api/skus/{id}/submit` 같은
   * action 하위 경로용). 생략하면 prefix 만 본다.
   *
   * suffix 지정 정책은 같은 prefix 의 일반 정책보다 **앞에** 둔다.
   */
  readonly suffix?: string;
  /**
   * 경로가 이 조각을 **포함**할 때만 적용된다 (`/api/skus/{id}/barcodes` 와
   * `/api/skus/{id}/barcodes/{bid}` 처럼 하위 컬렉션이 두 깊이에 걸칠 때용).
   * 생략하면 보지 않는다.
   *
   * suffix 와 마찬가지로 **더 구체적이므로 일반 정책보다 앞에** 둔다.
   */
  readonly contains?: string;
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

  // SKU 코드 추천 (T03-7) — 저장이 없는 독립 capability 다. 일반 POST(생성)
  // 정책보다 앞에 두어 `sku.create` 로 잘못 매칭되지 않게 한다.
  {
    prefix: '/api/skus/suggest-code',
    methods: ['POST'],
    permission: 'sku.suggest_code',
  },

  // 바코드 중복 예외 (T04-4A, docs/11_설계복구_Barcode중복예외승인.md §3) —
  // 요청과 승인은 서로 다른 capability 이며 역할집합도 다르다.
  // ⚠️ 아래 일반 바코드 정책보다 **앞에** 둔다. 뒤에 두면 두 경로가 POST →
  //    `barcode.create` 로 잡혀 승인 통제가 무너진다.
  {
    prefix: '/api/skus',
    suffix: '/barcodes/duplicate-candidates',
    methods: ['POST'],
    permission: 'barcode.request_duplicate',
  },
  {
    prefix: '/api/skus',
    suffix: '/approve-duplicate',
    methods: ['POST'],
    permission: 'barcode.approve_duplicate',
  },

  // 바코드 CRUD (T04-3, docs/10_설계복구_BarcodeCRUD.md §4) — **독립 capability** 다.
  // ⚠️ 반드시 일반 `/api/skus` 정책보다 **앞에** 둔다. 뒤에 두면
  //    `/api/skus/{id}/barcodes` 가 prefix 매칭으로 `sku.read`/`sku.create`/
  //    `sku.update` 에 잡혀 SKU 권한만으로 바코드를 바꿀 수 있게 된다.
  // ⚠️ suffix 로는 구분할 수 없다 — 컬렉션(`…/barcodes`)과 단건(`…/barcodes/{bid}`)
  //    경로가 다르므로 `contains` 로 매칭한다.
  {
    prefix: '/api/skus',
    contains: '/barcodes',
    methods: ['GET', 'HEAD'],
    permission: 'barcode.read',
  },
  { prefix: '/api/skus', contains: '/barcodes', methods: ['POST'], permission: 'barcode.create' },
  {
    prefix: '/api/skus',
    contains: '/barcodes',
    methods: ['PATCH', 'PUT'],
    permission: 'barcode.update',
  },
  {
    prefix: '/api/skus',
    contains: '/barcodes',
    methods: ['DELETE'],
    permission: 'barcode.deactivate',
  },

  // SKU 상세 ⑥ 공급조건 요약 supporting API (T1-6B4, docs/16 §41~) —
  // **독립 capability** 다. ⚠️ 반드시 일반 `/api/skus` GET 정책보다 **앞에**
  // 둔다 — 뒤에 두면 `sku.read` 만으로 공급조건·가격 요약을 볼 수 있게 된다.
  // ★ 이 endpoint 는 가격까지 반환하므로 실제로는 `supplier.read` **AND**
  //   `supplier_price.read` 를 요구한다. proxy 는 경로당 permission 1개라
  //   여기서 `supplier.read` 를 잡고, 두 번째 capability 는 application
  //   2차 가드가 본다 (D-3·D-19).
  {
    prefix: '/api/skus',
    contains: '/supplier-skus',
    methods: ['GET', 'HEAD'],
    permission: 'supplier.read',
  },

  // SKU 역전개 supporting API (T07-3, docs/18 §D-15·§D-30) — 경로는 `/api/skus`
  // 아래지만 응답이 전부 BOM 사실이므로 **`bom.read`** 다 (⛔ `sku.read` 아님).
  // ⚠️ 반드시 일반 `/api/skus` GET 정책보다 **앞에** 둔다 — 뒤에 두면
  //    `sku.read` 로 shadow 되어 BOM 권한이 없는 사용자에게 구성 정보가 열린다
  //    (T1-6B4 `supplier-skus` 와 같은 상황).
  {
    prefix: '/api/skus',
    contains: '/where-used',
    methods: ['GET', 'HEAD'],
    permission: 'bom.read',
  },

  // SKU 승인 워크플로 (T1-4A) — 일반 POST(생성) 정책보다 앞에 둔다.
  // reject 는 sku.approve — 승인/반려는 동일 authority (별도 sku.reject 없음).
  // ⛔ archive 는 T1-4B — 정책도 라우트도 아직 없다.
  { prefix: '/api/skus', suffix: '/submit', methods: ['POST'], permission: 'sku.submit' },
  { prefix: '/api/skus', suffix: '/approve', methods: ['POST'], permission: 'sku.approve' },
  { prefix: '/api/skus', suffix: '/reject', methods: ['POST'], permission: 'sku.approve' },
  { prefix: '/api/skus', suffix: '/deactivate', methods: ['POST'], permission: 'sku.deactivate' },

  // SKU CRUD (T1-3). 조회는 read, 생성은 create, 수정은 update.
  // ⚠️ DELETE 라우트는 존재하지 않지만(405), 1차 가드는 update 로 묶어
  //    read 권한만 가진 사용자의 변경성 요청이 핸들러에 닿지 않게 한다.
  { prefix: '/api/skus', methods: ['GET', 'HEAD'], permission: 'sku.read' },
  { prefix: '/api/skus', methods: ['POST'], permission: 'sku.create' },
  { prefix: '/api/skus', methods: ['PATCH', 'PUT', 'DELETE'], permission: 'sku.update' },

  // 외부 상품 매핑 CRUD (T05-2, docs/13_설계복구_외부상품매핑CRUD.md §11).
  // ⛔ `sku.*` 재사용 없음 — 독립 capability 다.
  // ⚠️ 향후 `/api/external-mappings/import`·`/unmatched` 가 생기면 **이 세 줄보다
  //    앞에** 특수 정책을 둬야 한다 (첫 일치 우선). 이번 Task 에서는 만들지 않는다.
  // ⚠️ DELETE 라우트는 존재하지 않지만(405), 1차 가드는 update 로 묶어
  //    read 권한만 가진 사용자의 변경성 요청이 핸들러에 닿지 않게 한다.
  {
    prefix: '/api/external-mappings',
    methods: ['GET', 'HEAD'],
    permission: 'external_mapping.read',
  },
  { prefix: '/api/external-mappings', methods: ['POST'], permission: 'external_mapping.create' },
  {
    prefix: '/api/external-mappings',
    methods: ['PATCH', 'PUT', 'DELETE'],
    permission: 'external_mapping.update',
  },

  // 가격이력 (T06-3, docs/17_설계복구_거래처공급조건.md §58~) — **독립 capability** 다
  // (D-28) — `supplier.*` 를 재사용하지 않는다. FINANCE 는 supplier.create 없이도
  // 가격 등록·승인이 가능해야 하고, SCM_STAFF 는 approve 가 없다.
  // ⚠️ 반드시 아래 일반 `/api/suppliers`·`/api/supplier-skus` 정책보다 **앞에**
  //    둔다 — 뒤에 두면 `/api/supplier-skus/{id}/prices` 변경성 요청이
  //    `supplier.update` 로 잘못 잡히고, GET/POST 는 아예 정책 없이
  //    인증-only 로 떨어진다 (T06-3 PRE-FLIGHT 실측 gap).
  // ⚠️ `/api/supplier-sku-prices` 는 `/api/supplier-skus` prefix 에 걸리지 않는
  //    독립 경로다 (`-p` vs `s` — 끝 문자가 다르다).
  {
    prefix: '/api/supplier-skus',
    contains: '/prices',
    methods: ['GET', 'HEAD'],
    permission: 'supplier_price.read',
  },
  {
    prefix: '/api/supplier-skus',
    contains: '/prices',
    methods: ['POST'],
    permission: 'supplier_price.create',
  },
  {
    prefix: '/api/supplier-sku-prices',
    suffix: '/approve',
    methods: ['POST'],
    permission: 'supplier_price.approve',
  },

  // 거래처·공급조건 (T06-2, docs/17_설계복구_거래처공급조건.md §39~) —
  // Supplier 와 SupplierSku 는 **하나의 capability** 다(D-22) — `supplier.*` 3종만
  // 쓰고 `supplier_sku.*` 를 만들지 않는다. 따라서 nested
  // `/api/suppliers/{id}/skus` 도 아래 GET/POST 정책이 그대로 잡는다(별도
  // contains 분기 불필요). `/api/supplier-skus` 는 `/api/suppliers` 의 prefix
  // 매칭에 걸리지 않는 독립 경로다(끝 문자가 다르다).
  // ⚠️ DELETE 라우트는 존재하지 않지만(405), 1차 가드는 update 로 묶어
  //    read 권한만 가진 사용자의 변경성 요청이 핸들러에 닿지 않게 한다.
  { prefix: '/api/suppliers', methods: ['GET', 'HEAD'], permission: 'supplier.read' },
  { prefix: '/api/suppliers', methods: ['POST'], permission: 'supplier.create' },
  { prefix: '/api/suppliers', methods: ['PATCH', 'PUT', 'DELETE'], permission: 'supplier.update' },
  {
    prefix: '/api/supplier-skus',
    methods: ['PATCH', 'PUT', 'DELETE'],
    permission: 'supplier.update',
  },

  // BOM (T07-3, docs/18_설계복구_BOM.md §D-15) — **독립 capability** 다.
  // ⛔ `sku.*` 를 재사용하지 않는다. ★ `bom.read` 는 EXECUTIVE 를 포함한다 —
  //   `supplier.*`(E = —)와 정반대이며 FINANCE 는 read 만 가진다.
  //
  // ⚠️ 아래 workflow suffix 정책들은 **T07-5 가 만들 endpoint** 를 위한 것이다.
  //    route 자체는 아직 없지만(404) 정책을 지금 넣는 이유는, 일반
  //    `{prefix:'/api/boms', methods:['POST']}` 규칙이 뒤에 있어서 나중에
  //    `…/submit`·`…/approve` 가 생기면 **`bom.create` 로 잘못 잡히기** 때문이다.
  //    첫 일치 우선이므로 더 구체적인 정책이 반드시 앞에 있어야 한다.
  //    ⛔ 정책 추가는 route 를 만드는 것이 아니다 — 없는 경로는 여전히 404 다.
  { prefix: '/api/boms', suffix: '/submit', methods: ['POST'], permission: 'bom.submit' },
  { prefix: '/api/boms', suffix: '/approve', methods: ['POST'], permission: 'bom.approve' },
  { prefix: '/api/boms', suffix: '/reject', methods: ['POST'], permission: 'bom.approve' },
  { prefix: '/api/boms', suffix: '/activate', methods: ['POST'], permission: 'bom.approve' },
  { prefix: '/api/boms', suffix: '/deactivate', methods: ['POST'], permission: 'bom.approve' },
  { prefix: '/api/boms', suffix: '/archive', methods: ['POST'], permission: 'bom.approve' },
  { prefix: '/api/boms', suffix: '/clone', methods: ['POST'], permission: 'bom.create' },
  // 라인은 컬렉션(`…/lines`)과 단건(`…/lines/{lineId}`)이 두 깊이라 `contains` 다.
  // ★ 라인 추가도 **BOM 수정**이므로 `bom.update` 다 — `bom.create` 가 아니다.
  //   (T07-4 의 `…/lines/bulk-confirm-qty` 도 이 정책에 잡힌다 — 의도된 결과다.)
  { prefix: '/api/boms', contains: '/lines', methods: ['POST'], permission: 'bom.update' },
  {
    prefix: '/api/boms',
    contains: '/lines',
    methods: ['PATCH', 'PUT', 'DELETE'],
    permission: 'bom.update',
  },
  { prefix: '/api/boms', methods: ['GET', 'HEAD'], permission: 'bom.read' },
  { prefix: '/api/boms', methods: ['POST'], permission: 'bom.create' },
  { prefix: '/api/boms', methods: ['PATCH', 'PUT', 'DELETE'], permission: 'bom.update' },

  // 외부시스템 lookup (T05-4A) — 관리 UI 의 선택 수단 전용, read-only.
  // ⛔ 신규 permission 을 만들지 않는다 — 매핑 조회 권한을 그대로 쓴다.
  {
    prefix: '/api/external-systems',
    methods: ['GET', 'HEAD'],
    permission: 'external_mapping.read',
  },

  // 관리 화면도 1차에서 조회 권한을 요구한다 (2차는 화면이 부르는 API가 검사).
  { prefix: '/admin/codes', methods: ['GET', 'HEAD'], permission: 'common_code.read' },
  // ⚠️ 신규 등록 화면은 조회 권한만으로 열리면 안 된다 — 더 구체적인 경로
  //    정책을 일반 `/master/skus` read 정책보다 **앞에** 둔다 (첫 일치 우선).
  //    SKU id 는 UUID 라 `/master/skus/{id}` 가 이 prefix 에 걸리지 않는다.
  { prefix: '/master/skus/new', methods: ['GET', 'HEAD'], permission: 'sku.create' },
  { prefix: '/master/skus', methods: ['GET', 'HEAD'], permission: 'sku.read' },
  // 외부 상품 매핑 관리 화면 `EXT-MAP-001` (T05-4A). 신규/수정은 같은 화면의
  // dialog 라 별도 `/new`·`/{id}` 경로가 없다 — 진입은 read 권한이면 충분하고
  // mutation 은 각 API 의 create/update 권한이 막는다.
  {
    prefix: '/master/external-mappings',
    methods: ['GET', 'HEAD'],
    permission: 'external_mapping.read',
  },
  // 거래처·공급조건·가격 관리 화면 `/master/suppliers`(목록)·`/master/suppliers/{id}`
  // (상세 3탭) (T06-4, docs/17 §80~). 같은 prefix 라 두 route 를 한 정책이 잡는다 —
  // supplier id 는 UUID 라 `/new` 같은 하위 경로와 충돌하지 않는다(⛔ `/new` route
  // 자체를 만들지 않는다 — 신규 등록은 목록 화면의 dialog 다, D-1·D-6).
  // ★ 진입은 `supplier.read` 다 — 가격 탭은 화면 안에서 `supplier_price.read` 로
  //   따로 가린다(권한을 role 로 합치지 않는다, D-28).
  { prefix: '/master/suppliers', methods: ['GET', 'HEAD'], permission: 'supplier.read' },
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
    if (policy.suffix !== undefined && !query.pathname.endsWith(policy.suffix)) return false;
    if (policy.contains !== undefined && !query.pathname.includes(policy.contains)) return false;
    if (policy.methods === undefined) return true;
    return policy.methods.some((allowed) => allowed === method);
  });

  return match?.permission;
}
