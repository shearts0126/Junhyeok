import { NextResponse } from 'next/server';

import {
  ERROR_CODES,
  AuthorizationError,
  ValidationError,
  withErrorHandling,
} from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `POST /api/auth/login` — 이메일·비밀번호 로그인.
 *
 * Supabase 가 세션 쿠키를 설정한다. 이 라우트는 로컬 `user` 행을
 * **생성하지 않는다.** 인증 성공과 SCM 시스템 사용 승인은 별개다.
 * 등록되지 않은 계정은 로그인은 되지만 이후 API 에서 403 을 받는다.
 *
 * ⚠️ 실패 사유(이메일 없음 / 비밀번호 틀림)를 구분해 알려주지 않는다.
 *    계정 존재 여부가 새어 나간다.
 */
export const dynamic = 'force-dynamic';

interface LoginBody {
  readonly email?: unknown;
  readonly password?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async () => {
      let body: LoginBody;
      try {
        body = (await request.json()) as LoginBody;
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const fieldErrors = [];
      if (typeof body.email !== 'string' || body.email.trim() === '') {
        fieldErrors.push({ path: 'email', message: '이메일은 필수입니다.' });
      }
      if (typeof body.password !== 'string' || body.password === '') {
        fieldErrors.push({ path: 'password', message: '비밀번호는 필수입니다.' });
      }
      if (fieldErrors.length > 0) {
        throw new ValidationError(fieldErrors, { message: '로그인 요청 값이 올바르지 않습니다.' });
      }

      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: (body.email as string).trim(),
        password: body.password as string,
      });

      if (error !== null || data.user === null) {
        throw new AuthorizationError(ERROR_CODES.UNAUTHORIZED, {
          message: '이메일 또는 비밀번호가 올바르지 않습니다.',
          publicHint: '이메일과 비밀번호를 확인하세요.',
          // 실패 사유는 로그에만 남긴다
          context: { supabaseError: error?.message ?? 'user is null' },
        });
      }

      return NextResponse.json(
        { user: { id: data.user.id, email: data.user.email ?? '' } },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/auth/login' },
  );
}
