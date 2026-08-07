import { NextResponse } from 'next/server';

import { resolveActor } from '@/modules/auth/application';
import { claimsVerifierFrom } from '@/modules/auth/infrastructure/verify';
import {
  getSystemSettings,
  parseSettingPatch,
  updateSystemSettings,
} from '@/modules/settings/application';
import { ValidationError, withErrorHandling } from '@/shared/errors';
import { createSupabaseServerClient } from '@/shared/supabase';

/**
 * `GET /api/system-settings`   — `system_setting.read`
 * `PATCH /api/system-settings` — `system_setting.update`
 *
 * 2겹 가드: proxy 가 route policy 로 1차, Application Service 가 2차.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      const settings = await getSystemSettings(actor);

      return NextResponse.json(
        { ...settings, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/system-settings' },
  );
}

export async function PATCH(request: Request): Promise<NextResponse> {
  return withErrorHandling(
    request,
    async (requestId) => {
      const supabase = await createSupabaseServerClient();
      const actor = await resolveActor({ verifier: claimsVerifierFrom(supabase) }, { requestId });

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ValidationError([{ path: 'body', message: 'JSON 본문이 필요합니다.' }]);
      }

      const { patch, version } = parseSettingPatch(body);
      const settings = await updateSystemSettings(actor, patch, version);

      return NextResponse.json(
        { ...settings, requestId },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    { route: '/api/system-settings' },
  );
}
