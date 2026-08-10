/**
 * 외부 상품 매핑 권한 키 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §11
 *    (2026-08-10 External Mapping CRUD Design Recovery Decision).
 *
 * 외부 상품 매핑은 `02_시스템_아키텍처와_모듈구조.md` §479 에서 **독립 모듈**로
 * 정의된 capability 다. ⛔ `sku.*` 권한을 재사용하지 않는다 — SKU 마스터를 고칠
 * 권한과 외부 별칭을 고칠 권한은 분리한다.
 *
 *   - `external_mapping.read`   — ADMIN, SCM_LEADER, SCM_STAFF, FINANCE
 *   - `external_mapping.create` — ADMIN, SCM_LEADER, SCM_STAFF
 *   - `external_mapping.update` — ADMIN, SCM_LEADER, SCM_STAFF
 *
 * ★ **EXECUTIVE 는 read 에서도 제외**된다. API 표(`05:80`)의 "전체"와 화면별
 *   권한표(`05:559` / `05_v0.2:656` — `외부 상품 매핑 … E = —`)가 충돌했고,
 *   Recovery Decision 이 **더 구체적인 화면별 권한표**를 채택했다.
 *   (`sku.read`·`barcode.read` 는 화면표에서도 `E = R` 이라 5역할이다 — 다른 사례다.)
 *
 * ⛔ ADMIN bypass 없음 — RolePermission 데이터로만 판정한다.
 */
export const EXTERNAL_MAPPING_READ_PERMISSION = 'external_mapping.read';
export const EXTERNAL_MAPPING_CREATE_PERMISSION = 'external_mapping.create';
export const EXTERNAL_MAPPING_UPDATE_PERMISSION = 'external_mapping.update';
