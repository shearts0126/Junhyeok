import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

import { loadSupabaseEnv } from './env';

/**
 * Proxy(Next.js 16) 전용 Supabase 세션 유틸.
 *
 * Next.js 16 에서 요청 가로채기는 `middleware.ts` 가 아니라 **`proxy.ts`** 다.
 *
 * 요청 쿠키를 읽어 세션을 갱신하고, 갱신된 쿠키를 응답에 실어 보낸다.
 * 요청·응답 양쪽 쿠키를 모두 갱신해야 같은 요청 안의 후속 처리가
 * 새 토큰을 본다.
 */
export interface SupabaseProxySession {
  readonly supabase: SupabaseClient;
  /** 갱신된 쿠키가 실린 응답. proxy 는 이 응답을 돌려주어야 한다. */
  readonly response: NextResponse;
}

export function createSupabaseProxyClient(request: NextRequest): SupabaseProxySession {
  const { url, publishableKey } = loadSupabaseEnv();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  return {
    supabase,
    get response() {
      return response;
    },
  };
}
