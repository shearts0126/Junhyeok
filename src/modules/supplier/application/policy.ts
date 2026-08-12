/**
 * 거래처·공급조건 권한 키 (T06-2).
 *
 * ⚠️ 근거: `docs/17_설계복구_거래처공급조건.md` §44·§45
 *    (2026-08-12 T06-2 Supply Terms API Design Recovery Decision — D-21·D-22).
 *
 * Supplier 와 SupplierSku 는 이번 Epic 의 **하나의 `거래처·공급조건` capability**
 * 로 묶는다 — `05 §10.6` 이 두 리소스에 같은 역할집합(조회 전체·작성 S,L,A)을
 * 부여하므로 `supplier_sku.*` 를 따로 만들지 않는다.
 *
 *   - `supplier.read`   — ADMIN, SCM_LEADER, SCM_STAFF, FINANCE
 *   - `supplier.create` — ADMIN, SCM_LEADER, SCM_STAFF
 *   - `supplier.update` — ADMIN, SCM_LEADER, SCM_STAFF
 *
 * ★ **EXECUTIVE 는 read 에서도 제외**된다. API 표(`05:96`)의 "전체"와 화면별
 *   권한표(`05:580` — `거래처·공급조건 … E = —`)가 충돌했고, T05-2 와 동일하게
 *   **더 구체적인 화면별 권한표**를 채택했다 (D-21).
 *
 * ⛔ ADMIN bypass 없음 — RolePermission 데이터로만 판정한다.
 */
export const SUPPLIER_READ_PERMISSION = 'supplier.read';
export const SUPPLIER_CREATE_PERMISSION = 'supplier.create';
export const SUPPLIER_UPDATE_PERMISSION = 'supplier.update';
