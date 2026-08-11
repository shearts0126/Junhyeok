import type { PrismaClient } from '@/generated/prisma/client';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { ValidationError } from '@/shared/errors';

import { EXTERNAL_MAPPING_READ_PERMISSION } from './policy';

/**
 * `GET /api/external-systems` — 외부시스템 lookup (T05-4A).
 *
 * ⚠️ 근거: `docs/15_설계복구_ExternalMapping관리UI.md` §5·§6·§7.
 *
 * ## 왜 이 endpoint 가 생겼나
 *
 * `docs/13` §12 는 "ExternalSystem 별도 read API 를 발명하지 않는다"로 확정했다.
 * 그러나 T05-4A 의 **신규 매핑 화면**은 `externalSystemId` 가 필수인데 고를 수단이
 * 전혀 없다. 그 공백만 좁게 supersede 한 것이 이 endpoint 다.
 *
 * ⛔ **lookup 전용**이다. ExternalSystem CRUD(생성·수정·비활성)를 만들지 않는다.
 *
 * ## 계약
 *
 *   - pagination 없음 · query parameter 없음 (알 수 없는 키는 400).
 *   - 정렬은 `systemCode ASC, id ASC` 로 **결정적**이다.
 *   - `active = false` 도 **숨기지 않는다** — T05-2 backend 가 active 제한을
 *     두지 않으므로(`docs/13` §5) UI 가 backend 보다 새로운 business restriction 을
 *     만들지 않는다. 화면은 상태 표시만 한다.
 *
 * ⚠️ **2차 권한 가드.** `external_mapping.read` 를 재검사한다. ADMIN bypass 없음.
 * ⛔ 신규 permission 을 만들지 않는다. ⛔ read-only — AuditLog·멱등 없음.
 */

export interface ExternalSystemView {
  readonly id: string;
  readonly systemCode: string;
  readonly systemName: string;
  readonly systemType: string;
  readonly active: boolean;
}

export interface ExternalSystemListResult {
  readonly items: readonly ExternalSystemView[];
}

export type ExternalSystemListClient = Pick<PrismaClient, 'externalSystem'>;

export interface ExternalSystemListDependencies {
  readonly db?: ExternalSystemListClient;
}

/**
 * 이 endpoint 는 query parameter 를 **하나도** 받지 않는다.
 *
 * 기존 목록 convention(화이트리스트 밖 키는 400)과 동일하게, 알 수 없는 키를
 * 조용히 무시하지 않는다.
 */
export function parseListExternalSystemsQuery(searchParams: URLSearchParams): void {
  const keys = [...new Set([...searchParams.keys()])];
  if (keys.length > 0) {
    throw new ValidationError(
      keys.map((key) => ({
        path: key,
        message: '지원하지 않는 파라미터입니다. (외부시스템 조회는 파라미터를 받지 않습니다)',
      })),
      { message: '지원하지 않는 목록 파라미터가 있습니다.' },
    );
  }
}

async function defaultClient(): Promise<ExternalSystemListClient> {
  const { getPrismaClient } = await import('@/shared/db');
  return getPrismaClient();
}

export async function listExternalSystems(
  actor: ActorContext,
  dependencies: ExternalSystemListDependencies = {},
): Promise<ExternalSystemListResult> {
  assertPermission(actor, EXTERNAL_MAPPING_READ_PERMISSION);

  const db = dependencies.db ?? (await defaultClient());

  const rows = await db.externalSystem.findMany({
    // ⛔ `where` 없음 — inactive 를 숨기지 않는다.
    orderBy: [{ systemCode: 'asc' }, { id: 'asc' }],
    select: { id: true, systemCode: true, systemName: true, systemType: true, active: true },
  });

  return { items: rows };
}
