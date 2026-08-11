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
