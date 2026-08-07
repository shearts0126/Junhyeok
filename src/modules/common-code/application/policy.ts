/**
 * 공통코드 권한 키 (T0-8).
 *
 * - 조회: 전 역할 (seed 로 배정)
 * - 관리: ADMIN — 단, **코드상 ADMIN 특별 통과는 없다.**
 *   ADMIN 도 `role_permission` 데이터로만 권한을 얻는다.
 */
export const CODE_READ_PERMISSION = 'common_code.read';
export const CODE_MANAGE_PERMISSION = 'common_code.manage';
