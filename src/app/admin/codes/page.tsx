import type { Metadata } from 'next';

import { CodesAdminClient } from './codes-client';

/**
 * `/admin/codes` — 공통코드 관리 (T0-8).
 *
 * 1차 가드: proxy 가 `common_code.read` 를 요구한다.
 * 2차 가드: 화면이 호출하는 모든 API 가 Application Service 에서 재검사한다.
 * 화면에서 수정 UI 를 숨기는 것은 UX 이고, 권한의 근거는 항상 서버다.
 */
export const metadata: Metadata = { title: '공통코드 관리 — DEEPPOINT SCM OS' };

export const dynamic = 'force-dynamic';

export default function CodesAdminPage() {
  return <CodesAdminClient />;
}
