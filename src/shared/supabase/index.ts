/**
 * Supabase 클라이언트 (T0-6).
 *
 * 세 가지를 분리한다. 쿠키 접근 방식이 다르기 때문이다.
 *
 *   - `browser.ts` — 클라이언트 컴포넌트
 *   - `server.ts`  — 서버 컴포넌트·Route Handler
 *   - `proxy.ts`   — Next.js 16 proxy 의 세션 갱신
 *
 * ⚠️ 브라우저 클라이언트는 `'use client'` 모듈이므로 여기서 re-export 하지 않는다.
 *    필요한 곳에서 `@/shared/supabase/browser` 를 직접 import 한다.
 */

export { loadSupabaseEnv, SUPABASE_URL_VAR, SUPABASE_PUBLISHABLE_KEY_VAR } from './env';
export type { SupabaseEnv } from './env';
export { createSupabaseServerClient } from './server';
export { createSupabaseProxyClient } from './proxy';
export type { SupabaseProxySession } from './proxy';
