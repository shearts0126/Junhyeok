/**
 * 바코드 권한 키 (T04-3).
 *
 * ⚠️ 근거: `docs/10_설계복구_BarcodeCRUD.md` §3 (2026-08-10 Design Recovery Decision).
 *
 * 바코드는 `02_시스템_아키텍처와_모듈구조.md` §478 에서 **독립 모듈**로 정의된
 * capability 다. 역할집합이 SKU 계열과 일부 같더라도 **`sku.*` 권한을
 * 재사용하지 않는다** — SKU 마스터를 고칠 권한과 바코드를 고칠 권한은 분리한다.
 *
 *   - `barcode.read`       — ADMIN, SCM_LEADER, SCM_STAFF, FINANCE, EXECUTIVE
 *   - `barcode.create`     — ADMIN, SCM_LEADER, SCM_STAFF
 *   - `barcode.update`     — ADMIN, SCM_LEADER, SCM_STAFF
 *   - `barcode.deactivate` — ADMIN, SCM_LEADER, SCM_STAFF (DELETE = 비활성)
 *
 * 중복 예외 승인 (T04-4A, `docs/11_설계복구_Barcode중복예외승인.md` §3) — 요청과 승인은
 * **서로 다른 capability** 다. 역할집합도 다르므로 `barcode.create`·`barcode.update` 를
 * 재사용하지 않는다.
 *
 *   - `barcode.request_duplicate` — ADMIN, SCM_LEADER, SCM_STAFF (중복 예외 요청)
 *   - `barcode.approve_duplicate` — ADMIN, SCM_LEADER               (중복 예외 승인)
 *
 * ⛔ ADMIN bypass 없음 — RolePermission 데이터로만 판정한다.
 */
export const BARCODE_READ_PERMISSION = 'barcode.read';
export const BARCODE_CREATE_PERMISSION = 'barcode.create';
export const BARCODE_UPDATE_PERMISSION = 'barcode.update';
export const BARCODE_DEACTIVATE_PERMISSION = 'barcode.deactivate';
export const BARCODE_REQUEST_DUPLICATE_PERMISSION = 'barcode.request_duplicate';
export const BARCODE_APPROVE_DUPLICATE_PERMISSION = 'barcode.approve_duplicate';
