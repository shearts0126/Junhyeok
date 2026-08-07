'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadSupabaseEnv } from './env';

/**
 * 브라우저 Supabase 클라이언트.
 *
 * 로그인 폼처럼 클라이언트 컴포넌트에서만 쓴다.
 * 서버에서는 `server.ts` 의 클라이언트를 쓴다 — 쿠키 접근 방식이 다르다.
 */
export function createSupabaseBrowserClient(): SupabaseClient {
  const { url, publishableKey } = loadSupabaseEnv();
  return createBrowserClient(url, publishableKey);
}
