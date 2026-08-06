import { NextResponse, type NextRequest } from 'next/server';

import { isPublicPath, resolveActor, resolveRoutePermission } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import { blockWithError, createProxyRequestContext } from '@/modules/auth/presentation/proxy-guard';
import { AuthorizationError, ERROR_CODES } from '@/shared/errors';
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
 *   - route policy 에 권한이 명시된 **경로·메서드 조합**은 그 권한까지 확인 → 없으면 403
 *   - **차단한 요청은 서버 로그에 기록** (`blockWithError`)
 *
 * ## 1차 가드가 하지 않는 일
 *
 *   업무 판정. 그것은 Application Service 의 **2차 가드**가 한다.
 *   Proxy 는 경로 기반이라 새 라우트에서 누락될 수 있고, 서버 액션·내부 호출·
 *   배치는 여기를 거치지 않는다. **Proxy 통과를 서비스가 신뢰하면 안 된다.**
 *
 * ## 로깅 경계
 *
 *   Proxy 가 **차단한** 요청만 여기서 기록한다. 통과시킨 요청은 로그를 남기지
 *   않고 Route Handler 로 넘기며, 거기서 오류가 나면 `withErrorHandling` 이
 *   기록한다. 한 요청이 두 곳에서 기록되는 경로가 없다.
 *
 * ⚠️ 세션 판정에 `getSession()` 을 쓰지 않는다. 쿠키 값을 그대로 돌려주므로
 *    위조 가능하다. `resolveActor` 가 `getClaims()` 로 서명을 검증한다.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { supabase, response } = createSupabaseProxyClient(request);
  const pathname = request.nextUrl.pathname;

  // 공개 경로도 세션 갱신은 거친다. 토큰 만료로 로그인 상태가 끊기지 않도록.
  // ★ 오류 로그를 만들지 않는다 — 성공 경로다.
  if (isPublicPath(pathname)) return response;

  // ★ 서버가 생성한 requestId. 외부 x-request-id 는 correlationId 로 로그에만 간다.
  const { requestId } = createProxyRequestContext(request);

  try {
    const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

    // ★ 메서드까지 본다. 같은 경로라도 GET 과 PATCH 가 다른 권한을 요구한다.
    const required = resolveRoutePermission({ pathname, method: request.method });
    if (required !== undefined && !actor.permissions.includes(required)) {
      return blockWithError(
        new AuthorizationError(ERROR_CODES.FORBIDDEN, {
          message: `권한 '${required}' 가 없습니다.`,
          context: {
            requiredPermission: required,
            actorUserId: actor.userId,
            actorRoles: actor.roles,
            reason: 'MISSING_PERMISSION',
            method: request.method,
          },
        }),
        { request, requestId, route: pathname },
      ).response;
    }

    // ★ 통과 — 로그를 남기지 않는다.
    return response;
  } catch (error) {
    // resolveActor 가 던진 401(UNAUTHORIZED) / 403(FORBIDDEN) 을
    // 원인 그대로 기록하고 공통 형식으로 응답한다.
    return blockWithError(error, { request, requestId, route: pathname }).response;
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
