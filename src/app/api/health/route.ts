import { NextResponse } from 'next/server';

import { checkDatabase } from '@/shared/db';
import { withErrorHandling } from '@/shared/errors';
import { getHealthStatus } from '@/shared/health';

/**
 * 헬스체크 엔드포인트.
 *
 * 점검 항목
 *  - database : SELECT 1 (T0-2) ✅
 *  - auth     : T0-6
 *  - storage  : T4-2 (R1a-4)
 *  - queue    : T4-1 (R1a-4)
 *
 * 응답에는 연결 문자열·비밀정보를 절대 포함하지 않는다.
 * 실패 사유는 분류된 요약 문장만 노출한다 (shared/db/check.ts).
 *
 * 헬스체크는 의존성 실패를 **정상 응답 본문(503)** 으로 표현하므로
 * 오류를 던지지 않는다. `withErrorHandling` 은 예기치 못한 오류와
 * `x-request-id` 헤더 부여를 위해 사용한다.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async () => {
      const checks = [await checkDatabase()];
      const status = getHealthStatus(checks);

      return NextResponse.json(status, {
        status: status.status === 'ok' ? 200 : 503,
        headers: { 'Cache-Control': 'no-store' },
      });
    },
    { route: '/api/health' },
  );
}
