import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase 인증 검증 (T0-6).
 *
 * ## `getSession()` 을 권한 판정에 쓰지 않는 이유
 *
 * `auth.getSession()` 은 **쿠키에 담긴 세션 객체를 그대로 돌려준다.** 쿠키는
 * 클라이언트가 보내는 값이므로 위조될 수 있고, 서버가 서명을 확인하지 않는다.
 * 그 안의 `user.id` 를 믿고 권한을 판정하면 누구든 아무 사용자로 행세할 수 있다.
 *
 * 대신
 *
 *   - `auth.getClaims()` — JWT 서명을 검증하고 클레임을 돌려준다. 인증 검증의 기본.
 *   - `auth.getUser()`   — Supabase 서버에 왕복해 최신 사용자 레코드를 가져온다.
 *                          네트워크 비용이 있으므로 **최신 레코드가 반드시 필요한
 *                          경우에만** 쓴다.
 *
 * T0-6 의 권한 판정은 로컬 `user` 표를 기준으로 하므로 `getClaims()` 로 충분하다.
 */

/** 검증된 인증 주체. Supabase 가 서명을 확인한 값만 담는다. */
export interface VerifiedIdentity {
  /** `auth.users.id` */
  readonly userId: string;
  readonly email: string;
  /** JWT 의 세션 식별자. 감사 추적용. */
  readonly sessionId?: string;
}

/**
 * 인증 검증에 필요한 최소 인터페이스.
 *
 * `SupabaseClient` 전체가 아니라 이 모양만 요구하므로, 테스트에서
 * 실제 Supabase 없이 대역을 넣을 수 있다.
 */
export interface ClaimsVerifier {
  getClaims(): Promise<{
    data: { claims: Record<string, unknown> } | null;
    error: { message: string } | null;
  }>;
}

function readString(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 검증된 인증 주체를 얻는다.
 *
 * @returns 검증 실패·세션 없음이면 `null`. 호출부가 401 로 변환한다.
 */
export async function verifyIdentity(client: ClaimsVerifier): Promise<VerifiedIdentity | null> {
  const { data, error } = await client.getClaims();
  if (error !== null || data === null) return null;

  const claims = data.claims;
  // `sub` 가 사용자 ID 다. 없으면 유효한 사용자 토큰이 아니다.
  const userId = readString(claims, 'sub');
  const email = readString(claims, 'email');
  if (userId === undefined || email === undefined) return null;

  const sessionId = readString(claims, 'session_id');

  return {
    userId,
    email,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/** `SupabaseClient` 를 `ClaimsVerifier` 로 좁힌다. */
export function claimsVerifierFrom(client: SupabaseClient): ClaimsVerifier {
  return {
    getClaims: async () => {
      const result = await client.auth.getClaims();
      return {
        data: result.data === null ? null : { claims: result.data.claims },
        error: result.error === null ? null : { message: result.error.message },
      };
    },
  };
}
