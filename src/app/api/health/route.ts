import { NextResponse } from 'next/server';

import { getHealthStatus } from '@/shared/health';

/**
 * 헬스체크 엔드포인트.
 *
 * T0-1 시점에는 애플리케이션 기동 여부만 확인한다.
 * DB·Storage·큐 연결 확인은 각 항목 도입 시점에 checks 에 추가한다.
 *  - DB          : T0-2 (Prisma)
 *  - Auth        : T0-6 (Supabase Auth)
 *  - Storage/Queue: T4-1 / T4-2 (R1a-4)
 */
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  const status = getHealthStatus();
  return NextResponse.json(status, {
    status: status.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
