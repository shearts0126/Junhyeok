import { EnvironmentError } from '@/shared/errors';

/**
 * Supabase 환경변수 (T0-6).
 *
 * ⚠️ **service-role / secret 키를 쓰지 않는다.** T0-6 에는 관리자 사용자 생성
 *    API 가 없으므로 Admin API 가 필요 없다. 서버 전용 secret 키는 실제로
 *    Admin API 가 필요해지는 작업에서만 별도로 추가한다.
 *
 * ⚠️ `NEXT_PUBLIC_` 접두사가 붙은 값은 **클라이언트 번들에 포함된다.**
 *    publishable key 는 그렇게 쓰도록 설계된 공개 키이지만,
 *    secret key 에 이 접두사를 붙이면 브라우저로 유출된다.
 */

export interface SupabaseEnv {
  readonly url: string;
  /** 공개용 publishable key. 브라우저에 노출되어도 되는 값이다. */
  readonly publishableKey: string;
}

export const SUPABASE_URL_VAR = 'NEXT_PUBLIC_SUPABASE_URL';
export const SUPABASE_PUBLISHABLE_KEY_VAR = 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY';

function readRequired(source: NodeJS.ProcessEnv, variable: string): string {
  const value = source[variable];
  if (value === undefined || value.trim() === '') {
    throw new EnvironmentError(
      variable,
      '환경변수가 설정되지 않았습니다. `.env.example` 을 참고해 `.env.local` 에 값을 채우세요.',
    );
  }
  return value.trim();
}

/**
 * Supabase 연결 정보를 읽는다.
 *
 * @throws {EnvironmentError} 변수 누락 또는 URL 형식 오류.
 *   변수명은 서버 로그에만 남고 운영 응답에는 나가지 않는다.
 */
export function loadSupabaseEnv(source: NodeJS.ProcessEnv = process.env): SupabaseEnv {
  const url = readRequired(source, SUPABASE_URL_VAR);
  const publishableKey = readRequired(source, SUPABASE_PUBLISHABLE_KEY_VAR);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EnvironmentError(
      SUPABASE_URL_VAR,
      'URL 형식이 올바르지 않습니다. `https://<PROJECT_REF>.supabase.co` 형태여야 합니다.',
    );
  }

  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new EnvironmentError(
      SUPABASE_URL_VAR,
      `https 여야 합니다. 현재 프로토콜: '${parsed.protocol}'`,
    );
  }

  return { url, publishableKey };
}
