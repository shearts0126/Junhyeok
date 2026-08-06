import { NextResponse, type NextRequest } from 'next/server';

import { isPublicPath, requiredPermissionFor, resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { ERROR_CODES, publicMessageForCode, REQUEST_ID_HEADER } from '@/shared/errors';
import { generateRequestId } from '@/shared/errors';
import { createSupabaseProxyClient } from '@/shared/supabase';

/**
 * Proxy — 세션 갱신과 **1차 접근 검사** (T0-6).
 *
 * ⚠️ Next.js 16 에서 요청 가로채기는 `middleware.ts` 가 아니라 **`proxy.ts`** 다.
 *    함수명도 `proxy` 다. `middleware.ts` 를 새로 만들지 않는다.
 *
 * ## 1차 가드가 하는 일
 *
 *   - 공개 경로는 그대로 통과 (로그인·헬스체크)
 *   - 보호 경로는 검증된 인증을 요구 → 없으면 401
 *   - route policy 에 권한이 명시된 경로는 그 권한까지 확인 → 없으면 403
 *
 * ## 1차 가드가 하지 않는 일
 *
 *   업무 판정. 그것은 Application Service 의 **2차 가드**가 한다.
 *   Proxy 는 경로 기반이라 새 라우트에서 누락될 수 있고, 서버 액션·내부 호출·
 *   배치는 여기를 거치지 않는다. **Proxy 통과를 서비스가 신뢰하면 안 된다.**
 *
 * ⚠️ 세션 판정에 `getSession()` 을 쓰지 않는다. 쿠키 값을 그대로 돌려주므로
 *    위조 가능하다. `resolveActor` 가 `getClaims()` 로 서명을 검증한다.
 */

function jsonError(code: string, status: number, requestId: string): NextResponse {
  return NextResponse.json(
    { errorCode: code, message: publicMessageForCode(code), requestId },
    {
      status,
      headers: { [REQUEST_ID_HEADER]: requestId, 'Cache-Control': 'no-store' },
    },
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { supabase, response } = createSupabaseProxyClient(request);
  const pathname = request.nextUrl.pathname;

  // 공개 경로도 세션 갱신은 거친다. 토큰 만료로 로그인 상태가 끊기지 않도록.
  if (isPublicPath(pathname)) return response;

  // ★ Proxy 는 서버가 생성한 requestId 를 쓴다. 외부 x-request-id 는 쓰지 않는다.
  const requestId = generateRequestId();

  try {
    const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

    const required = requiredPermissionFor(pathname);
    if (required !== undefined && !actor.permissions.includes(required)) {
      return jsonError(ERROR_CODES.FORBIDDEN, 403, requestId);
    }

    return response;
  } catch (error) {
    // 상세는 라우트 핸들러가 다시 판정하며 기록한다.
    // 여기서는 공통 형식의 최소 응답만 낸다.
    const code =
      error instanceof Error && 'code' in error && error.code === ERROR_CODES.UNAUTHORIZED
        ? ERROR_CODES.UNAUTHORIZED
        : ERROR_CODES.FORBIDDEN;

    return jsonError(code, code === ERROR_CODES.UNAUTHORIZED ? 401 : 403, requestId);
  }
}

export const config = {
  /**
   * 정적 자산과 이미지 최적화 요청은 제외한다.
   *
   * 나머지는 전부 통과시켜 `isPublicPath` 가 판정하게 한다 —
   * matcher 로 보호 경로를 열거하면 새 라우트를 빠뜨렸을 때 열린다.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
