import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { loadSupabaseEnv } from './env';

/**
 * 서버 Supabase 클라이언트 (서버 컴포넌트·Route Handler 용).
 *
 * Next.js 의 쿠키 저장소를 통해 세션을 읽고 갱신한다.
 *
 * ⚠️ **쿠키의 세션 객체를 그대로 신뢰하지 않는다.** 쿠키는 클라이언트가
 *    보내는 값이므로 위조될 수 있다. 인증 검증은 `auth.getClaims()` 로
 *    서명을 확인해야 한다 (`src/modules/auth/infrastructure/verify.ts`).
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { url, publishableKey } = loadSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // 서버 컴포넌트에서는 쿠키를 쓸 수 없다.
          // proxy 가 세션을 갱신하므로 여기서 실패해도 무방하다.
        }
      },
    },
  });
}
