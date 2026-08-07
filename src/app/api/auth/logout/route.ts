import { NextResponse } from 'next/server';

import { withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/auth/logout` — 세션 종료.
 *
 * 세션이 없어도 200 이다. 로그아웃은 멱등해야 하며, 세션 유무를 알려줄
 * 이유가 없다.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async () => {
      const supabase = await createSupabaseServerClient();
      await supabase.auth.signOut();

      return NextResponse.json({ signedOut: true }, { headers: { 'Cache-Control': 'no-store' } });
    },
    { route: '/api/auth/logout' },
  );
}
