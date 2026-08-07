import { auditLogger, type AuditLogger } from '@/modules/audit/application/audit-logger';
import { assertPermission, type ActorContext } from '@/modules/auth/application';
import { withTransaction, type TransactionClient } from '@/shared/db';
import { ConflictError, ERROR_CODES, ValidationError } from '@/shared/errors';

/**
 * 시스템 설정 조회·변경 (T0-7).
 *
 * ⚠️ **2차 권한 가드.** Proxy 통과를 신뢰하지 않고 여기서 다시 검사한다.
 *
 * ⚠️ 설정 변경과 감사로그 INSERT 는 **같은 트랜잭션**에서 처리한다.
 *    한쪽만 남으면 "기록 없는 변경" 또는 "일어나지 않은 일의 기록"이 된다.
 */

export const SYSTEM_SETTING_ID = 1;
export const SETTING_READ_PERMISSION = 'system_setting.read';
export const SETTING_UPDATE_PERMISSION = 'system_setting.update';

export interface SystemSettingView {
  readonly allowSelfApprovalSku: boolean;
  readonly allowSelfApprovalBom: boolean;
  /** `YYYY-MM-DD` 또는 null */
  readonly cutoverDate: string | null;
  readonly postingFrozen: boolean;
  readonly version: number;
}

/** 변경 가능한 필드. 이 목록에 없는 키는 거부한다. */
export const UPDATABLE_FIELDS = [
  'allowSelfApprovalSku',
  'allowSelfApprovalBom',
  'cutoverDate',
  'postingFrozen',
] as const;

export type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

export interface SystemSettingPatch {
  readonly allowSelfApprovalSku?: boolean;
  readonly allowSelfApprovalBom?: boolean;
  readonly cutoverDate?: string | null;
  readonly postingFrozen?: boolean;
}

/** DB 행 → 외부 표현. `Date` 를 `YYYY-MM-DD` 문자열로 낸다. */
function toView(row: {
  allowSelfApprovalSku: boolean;
  allowSelfApprovalBom: boolean;
  cutoverDate: Date | null;
  postingFrozen: boolean;
  version: number;
}): SystemSettingView {
  return {
    allowSelfApprovalSku: row.allowSelfApprovalSku,
    allowSelfApprovalBom: row.allowSelfApprovalBom,
    cutoverDate: row.cutoverDate === null ? null : row.cutoverDate.toISOString().slice(0, 10),
    postingFrozen: row.postingFrozen,
    version: row.version,
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 요청 본문을 검증한다.
 *
 * - 알 수 없는 필드 거부
 * - 최소 한 필드 필요
 * - `version` 필수
 * - boolean 필드는 boolean 만, `cutoverDate` 는 `YYYY-MM-DD` 또는 null
 */
export function parseSettingPatch(body: unknown): {
  patch: SystemSettingPatch;
  version: number;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError([{ path: 'body', message: 'JSON 객체가 필요합니다.' }]);
  }

  const raw = body as Record<string, unknown>;
  const fieldErrors: Array<{ path: string; message: string }> = [];

  // version 은 필수다. 없으면 낙관적 동시성 제어가 성립하지 않는다.
  if (typeof raw['version'] !== 'number' || !Number.isInteger(raw['version'])) {
    fieldErrors.push({ path: 'version', message: 'version 은 필수 정수입니다.' });
  }

  const allowed = new Set<string>([...UPDATABLE_FIELDS, 'version']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      fieldErrors.push({ path: key, message: '알 수 없는 필드입니다.' });
    }
  }

  const patch: Record<string, unknown> = {};

  for (const field of ['allowSelfApprovalSku', 'allowSelfApprovalBom', 'postingFrozen'] as const) {
    if (!(field in raw)) continue;
    if (typeof raw[field] !== 'boolean') {
      fieldErrors.push({ path: field, message: 'true 또는 false 여야 합니다.' });
      continue;
    }
    patch[field] = raw[field];
  }

  if ('cutoverDate' in raw) {
    const value = raw['cutoverDate'];
    if (value === null) {
      patch['cutoverDate'] = null;
    } else if (typeof value === 'string' && DATE_PATTERN.test(value)) {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) {
        fieldErrors.push({ path: 'cutoverDate', message: '존재하지 않는 날짜입니다.' });
      } else {
        patch['cutoverDate'] = value;
      }
    } else {
      fieldErrors.push({
        path: 'cutoverDate',
        message: 'YYYY-MM-DD 형식 문자열 또는 null 이어야 합니다.',
      });
    }
  }

  if (Object.keys(patch).length === 0 && fieldErrors.length === 0) {
    fieldErrors.push({ path: 'body', message: '변경할 필드를 최소 하나 지정하세요.' });
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError(fieldErrors, { message: '설정 변경 요청이 올바르지 않습니다.' });
  }

  return { patch: patch as SystemSettingPatch, version: raw['version'] as number };
}

/** 낙관적 동시성 충돌. `currentVersion` 은 충돌 시점의 최신 version 이다. */
function versionConflict(expected: number, current: number): ConflictError {
  return new ConflictError(ERROR_CODES.CONFLICT, {
    message: `설정이 이미 변경되었습니다. (기대 ${expected}, 현재 ${current})`,
    publicDetails: { currentVersion: current },
    publicHint: '최신 설정을 다시 조회한 뒤 변경하세요.',
    // 자동 재시도 금지 — 무엇이 바뀌었는지 확인하고 다시 보내야 한다.
    retryable: false,
  });
}

export interface SystemSettingReader {
  read(): Promise<SystemSettingView>;
}

export interface SystemSettingDependencies {
  readonly reader?: SystemSettingReader;
  readonly auditLogger?: AuditLogger;
  readonly runInTransaction?: <T>(callback: (tx: TransactionClient) => Promise<T>) => Promise<T>;
}

/** Prisma 기본 구현. */
export const prismaSystemSettingReader: SystemSettingReader = {
  async read(): Promise<SystemSettingView> {
    const { getPrismaClient } = await import('@/shared/db');
    const row = await getPrismaClient().systemSetting.findUniqueOrThrow({
      where: { id: SYSTEM_SETTING_ID },
    });
    return toView(row);
  },
};

/** 설정 조회. `system_setting.read` 권한이 필요하다. */
export async function getSystemSettings(
  actor: ActorContext,
  dependencies: SystemSettingDependencies = {},
): Promise<SystemSettingView> {
  assertPermission(actor, SETTING_READ_PERMISSION);
  return (dependencies.reader ?? prismaSystemSettingReader).read();
}

/**
 * 설정 변경. `system_setting.update` 권한이 필요하다.
 *
 * - `version` 이 현재 값과 다르면 409 `CONFLICT`
 * - 변경마다 `version` 을 1 증가시킨다
 * - `updatedBy` 는 요청 본문이 아니라 `ActorContext` 에서 가져온다
 * - **변경 없는 동일 값 요청도 정상 처리**한다. 값은 그대로지만 `version` 은
 *   증가하고 감사로그도 남는다. "누가 언제 이 값을 확정했는가"가 기록으로
 *   필요하고, 동일 값을 조용히 무시하면 version 이 어긋난 클라이언트가
 *   성공했다고 오해한다.
 */
export async function updateSystemSettings(
  actor: ActorContext,
  patch: SystemSettingPatch,
  expectedVersion: number,
  dependencies: SystemSettingDependencies = {},
): Promise<SystemSettingView> {
  // ★ 2차 가드
  assertPermission(actor, SETTING_UPDATE_PERMISSION);

  const run = dependencies.runInTransaction ?? withTransaction;
  const logger = dependencies.auditLogger ?? auditLogger;

  return run(async (tx) => {
    const before = await tx.systemSetting.findUniqueOrThrow({
      where: { id: SYSTEM_SETTING_ID },
    });

    // 빠른 실패 — 명백히 어긋난 요청은 UPDATE 를 시도하지 않는다.
    if (before.version !== expectedVersion) {
      throw versionConflict(expectedVersion, before.version);
    }

    // ★ 여기가 실제 동시성 토큰이다.
    //
    //   위의 read-then-compare 만으로는 READ COMMITTED 에서 두 요청이 같은
    //   version 을 읽고 **둘 다** 통과한다. WHERE 절에 version 을 넣어
    //   **DB 가 원자적으로** 판정하게 해야 한 건만 이긴다.
    //   version 증가도 UPDATE 안에서 이뤄지므로 읽고-더하고-쓰는 틈이 없다.
    const updated = await tx.systemSetting.updateMany({
      where: { id: SYSTEM_SETTING_ID, version: expectedVersion },
      data: {
        ...(patch.allowSelfApprovalSku !== undefined
          ? { allowSelfApprovalSku: patch.allowSelfApprovalSku }
          : {}),
        ...(patch.allowSelfApprovalBom !== undefined
          ? { allowSelfApprovalBom: patch.allowSelfApprovalBom }
          : {}),
        ...(patch.cutoverDate !== undefined
          ? {
              cutoverDate:
                patch.cutoverDate === null ? null : new Date(`${patch.cutoverDate}T00:00:00.000Z`),
            }
          : {}),
        ...(patch.postingFrozen !== undefined ? { postingFrozen: patch.postingFrozen } : {}),
        // ★ ActorContext 에서만 — 요청 본문이 아니다.
        updatedBy: actor.userId,
        version: { increment: 1 },
      },
    });

    // 0건이면 그 사이에 다른 요청이 이겼다는 뜻이다.
    // ⚠️ 자동 재시도하지 않는다 — 무엇이 바뀌었는지 모르는 채로 덮어쓰면 안 된다.
    if (updated.count !== 1) {
      const current = await tx.systemSetting.findUniqueOrThrow({
        where: { id: SYSTEM_SETTING_ID },
      });
      throw versionConflict(expectedVersion, current.version);
    }

    const after = await tx.systemSetting.findUniqueOrThrow({
      where: { id: SYSTEM_SETTING_ID },
    });

    // ★ 같은 트랜잭션. 이긴 요청만 감사로그 1건을 남긴다.
    await logger.write(tx, {
      actor,
      entityType: 'SystemSetting',
      // ⚠️ 정수 PK 를 문자열로 정규화한다. audit_log.entity_id 는 TEXT 다.
      entityId: String(SYSTEM_SETTING_ID),
      action: 'UPDATE',
      beforeValue: toView(before),
      afterValue: toView(after),
    });

    return toView(after);
  });
}
