/**
 * SKU 권한 키 (T1-3 CRUD + T1-4A 워크플로).
 *
 * 배정 (05 API 문서: 조회 전체 / 작성 S,L,A / 승인·중지 L,A / FINANCE·EXECUTIVE read-only):
 *   - `sku.read`       — ADMIN, SCM_LEADER, SCM_STAFF, FINANCE, EXECUTIVE
 *   - `sku.create`     — ADMIN, SCM_LEADER, SCM_STAFF
 *   - `sku.update`     — ADMIN, SCM_LEADER, SCM_STAFF
 *   - `sku.submit`     — ADMIN, SCM_LEADER, SCM_STAFF
 *   - `sku.approve`    — ADMIN, SCM_LEADER  (reject 도 이 권한 — 승인/반려는 동일 authority,
 *                        별도 `sku.reject` 를 만들지 않는다)
 *   - `sku.deactivate` — ADMIN, SCM_LEADER
 *   - `sku.archive`    — (T1-4B 에서 ADMIN 에 추가 예정 — 아직 없음)
 *
 * T03-7 (docs/09): 코드 추천은 **독립 capability** 다 — 역할집합이 `sku.create`
 * 와 우연히 같더라도 그 권한에 묶지 않는다 (추천은 쓰기가 아니다).
 *   - `sku.suggest_code` — ADMIN, SCM_LEADER, SCM_STAFF
 *
 * ADMIN bypass 없음 — RolePermission 데이터로만 판정한다.
 */
export const SKU_READ_PERMISSION = 'sku.read';
export const SKU_CREATE_PERMISSION = 'sku.create';
export const SKU_UPDATE_PERMISSION = 'sku.update';
export const SKU_SUBMIT_PERMISSION = 'sku.submit';
export const SKU_APPROVE_PERMISSION = 'sku.approve';
export const SKU_DEACTIVATE_PERMISSION = 'sku.deactivate';
export const SKU_SUGGEST_CODE_PERMISSION = 'sku.suggest_code';
