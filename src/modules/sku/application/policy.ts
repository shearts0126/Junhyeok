/**
 * SKU CRUD 권한 키 (T1-3).
 *
 * 배정 (05 API 문서: 조회 전체 / 작성 S,L,A / FINANCE 작성 금지):
 *   - `sku.read`   — ADMIN, SCM_LEADER, SCM_STAFF, FINANCE, EXECUTIVE
 *   - `sku.create` — ADMIN, SCM_LEADER, SCM_STAFF
 *   - `sku.update` — ADMIN, SCM_LEADER, SCM_STAFF
 *
 * ADMIN bypass 없음 — RolePermission 데이터로만 판정한다.
 */
export const SKU_READ_PERMISSION = 'sku.read';
export const SKU_CREATE_PERMISSION = 'sku.create';
export const SKU_UPDATE_PERMISSION = 'sku.update';
