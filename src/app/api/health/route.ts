import { NextResponse } from 'next/server';

import { checkDatabase } from '@/shared/db';
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
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const checks = [await checkDatabase()];
  const status = getHealthStatus(checks);

  return NextResponse.json(status, {
    status: status.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
