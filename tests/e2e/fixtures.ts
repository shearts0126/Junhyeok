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
] as const;
