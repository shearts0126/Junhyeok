/**
 * BOM 권한 키 (T07-3).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-15 — 신규 permission **정확히 5종**.
 *    `docs/18` §5 implementation order 가 **`permission seed 5종` 을 T07-3 에**
 *    배정했으므로, workflow 전용 2종(`submit`·`approve`)도 이번에 함께 seed 한다.
 *    (⛔ endpoint 는 만들지 않는다 — T07-5 의 몫이다.)
 *
 * | key | 부여 role |
 * |---|---|
 * | `bom.read`    | ADMIN · SCM_LEADER · SCM_STAFF · FINANCE · **EXECUTIVE** |
 * | `bom.create`  | ADMIN · SCM_LEADER · SCM_STAFF |
 * | `bom.update`  | ADMIN · SCM_LEADER · SCM_STAFF |
 * | `bom.submit`  | ADMIN · SCM_LEADER · SCM_STAFF |
 * | `bom.approve` | ADMIN · SCM_LEADER |
 *
 * ★ **EXECUTIVE 가 BOM 을 읽는다** — `05v2:661` `BOM 목록·상세 | RW RW RW R R`.
 *   T1-6B4 의 ⑥ 공급조건 탭(E = —)과 **정반대**이므로 `supplier.*` 의 판단을
 *   그대로 복사하지 않는다.
 * ★ **FINANCE 는 BOM mutation 권한이 없다**(`05v2:661-662` R / —).
 *   가격(`supplier_price.*`)에서 FINANCE 가 create·approve 를 가진 것과 다르다.
 *
 * ⛔ `bom.cost` 를 만들지 않는다 — 원가는 `bom.read` 로 판정한다 (D-15).
 * ⛔ ADMIN bypass 없음 — RolePermission 데이터로만 판정한다.
 */
export const BOM_READ_PERMISSION = 'bom.read';
export const BOM_CREATE_PERMISSION = 'bom.create';
export const BOM_UPDATE_PERMISSION = 'bom.update';
/** ⚠️ T07-5 workflow 전용. T07-3 은 seed 만 하고 사용처를 만들지 않는다. */
export const BOM_SUBMIT_PERMISSION = 'bom.submit';
/** ⚠️ T07-5 workflow 전용(activate·deactivate·archive 포함, D-15). */
export const BOM_APPROVE_PERMISSION = 'bom.approve';
