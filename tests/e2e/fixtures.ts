/**
 * E2E 픽스처 사용자 (T0-8).
 *
 * 스텁 인증 서버(supabase-stub)와 DB 준비(setup-db), 테스트(spec)가
 * **같은 UUID·이메일** 을 공유해야 하므로 한 곳에 둔다.
 */
export const E2E_USERS = [
  {
    id: 'e2e00000-0000-4000-8000-000000000ad1',
    email: 'e2e-admin@deeppoint.test',
    password: 'e2e-password-admin',
  },
  {
    id: 'e2e00000-0000-4000-8000-000000005caf',
    email: 'e2e-staff@deeppoint.test',
    password: 'e2e-password-staff',
  },
  {
    id: 'e2e00000-0000-4000-8000-00000000f14a',
    email: 'e2e-finance@deeppoint.test',
    password: 'e2e-password-finance',
  },
  {
    id: 'e2e00000-0000-4000-8000-000000001ead',
    email: 'e2e-leader@deeppoint.test',
    password: 'e2e-password-leader',
  },
  {
    id: 'e2e00000-0000-4000-8000-0000000e0ec0',
    email: 'e2e-exec@deeppoint.test',
    password: 'e2e-password-exec',
  },
] as const;

/**
 * 중복 예외 시나리오용 바코드 (T1-6B1).
 *
 * `ZZS-E2E-012` 가 이 값을 **활성**으로 쓰고 있다. `ZZS-E2E-013` 에서 같은 값을
 * 일반 등록하면 409 `BARCODE_DUPLICATE` 가 나고, 거기서 중복 예외 요청 흐름이
 * 시작된다. ⚠️ 숫자만이어야 한다 — T04-2 정규화가 숫자 외 문자를 거부한다.
 */
export const E2E_DUPLICATE_BARCODE = '8809999900012';

/**
 * SKU 상세 외부시스템 매핑 탭 픽스처 (T1-6B2).
 *
 * `ZZS-E2E-015` 가 외부시스템 `ZZX-ERP` 와 세 건의 매핑을 갖는다 —
 * MATCHED(대표) · REVIEW_REQUIRED(상품명만) · 종료된 매핑.
 */
export const E2E_MAPPING_CODE = 'ZZX-MAP-015';
export const E2E_MAPPING_REVIEW_NAME = 'E2E 상품명만 매핑';
/** ⚠️ `E2E_MAPPING_CODE` 의 접두사가 되면 안 된다 — 행 필터가 두 행에 걸린다. */
export const E2E_MAPPING_ENDED_CODE = 'ZZX-OLD-015';

/**
 * SKU 상세 변경이력 탭 픽스처 (T1-6B3).
 *
 * `ZZS-E2E-016` 이 SKU CREATE/UPDATE + 바코드 CREATE 감사로그를 갖고,
 * 같은 SKU 의 `SkuExternalMapping` CREATE 감사로그는 **탭에 나오지 않아야** 한다.
 */
export const E2E_HISTORY_BARCODE = '8809999900016';
