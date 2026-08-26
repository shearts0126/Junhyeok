/**
 * 창고·로케이션 권한 키 (T08-2 = v0.2 T2-1B).
 *
 * ⚠️ 근거: `docs/19_설계복구_Warehouse.md` §W-D22·§W-D23.
 *
 * **정확히 3종이다.**
 *
 *   - `warehouse.read`   — ADMIN, SCM_LEADER, SCM_STAFF
 *   - `warehouse.create` — ADMIN
 *   - `warehouse.update` — ADMIN
 *
 * ★ **FINANCE·EXECUTIVE 는 read 에서도 제외**된다. API 표(`05:143`)의 "전체"와
 *   화면별 권한표(`05 v0.2 §11.22` — `창고 관리 … S:R L:R A:RW F:— E:—`)가
 *   충돌했고, T05-2·T06-2 와 동일하게 **더 구체적인 화면별 권한표**를 채택했다
 *   (§W-D22).
 *
 * ⛔ `warehouse.delete` 를 만들지 않는다 — 물리삭제 금지 정책이다.
 * ⛔ location 전용 permission 을 만들지 않는다 — `POST .../locations` 는
 *    `warehouse.update` 를 재사용한다 (§W-D23). 로케이션은 창고의 하위 구조이지
 *    독립 capability 가 아니다.
 * ⛔ ADMIN bypass 없음 — RolePermission 데이터로만 판정한다.
 */
export const WAREHOUSE_READ_PERMISSION = 'warehouse.read';
export const WAREHOUSE_CREATE_PERMISSION = 'warehouse.create';
export const WAREHOUSE_UPDATE_PERMISSION = 'warehouse.update';

/**
 * `GET /api/warehouses` 의 서버 고정 페이지 크기 (§W-D30).
 *
 * ⛔ public query 로 노출하지 않는다 — 거래처·SKU 목록과 같은 관례다.
 */
export const WAREHOUSE_PAGE_SIZE = 50;

/**
 * 시스템 예약 창고 코드 (§W-D11).
 *
 * 이 코드의 창고는 **seed 만이 owner** 이며 public `POST` 로 만들 수 없다
 * (§W-D12). 창고이동의 system transit bucket 이 될 예정이다.
 */
export const IN_TRANSIT_WAREHOUSE_CODE = 'IN_TRANSIT';

/**
 * 예약 로케이션 코드 (§W-D9).
 *
 * 창고 생성 트랜잭션만이 이 코드의 owner 다. `POST .../locations` 로는 만들 수
 * 없고, 만들어진 뒤 rename·deactivate·delete 도 불가능하다 (§W-D10 — 애초에
 * location PATCH·DELETE endpoint 가 존재하지 않는다).
 */
export const DEFAULT_LOCATION_CODE = 'DEFAULT';
