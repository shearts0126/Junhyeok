import { AuthorizationError, ERROR_CODES, AppError } from '@/shared/errors';

import { createActorContext, type ActorContext } from '../domain/actor';
import {
  prismaUserAuthorizationReader,
  type UserAuthorizationReader,
} from '../infrastructure/user-repository';
import { verifyIdentity, type ClaimsVerifier } from '../infrastructure/verify';

/**
 * 인증 주체 해석 (T0-6).
 *
 * 두 단계다.
 *
 *   1. **인증** — Supabase 가 서명을 검증한 클레임에서 사용자 ID 를 얻는다.
 *      실패하면 401.
 *   2. **인가 기준 확보** — 로컬 `user` 표에서 역할·권한을 읽는다.
 *      행이 없거나 비활성이면 403.
 *
 * 인증(누구인가)과 인가(무엇을 할 수 있는가)를 나누는 이유: 토큰이 유효해도
 * SCM 시스템 사용자로 승인되지 않았을 수 있다. 그 경우는 "로그인하세요"(401)가
 * 아니라 "권한이 없습니다"(403)가 맞다.
 */

/** 인증 실패. 세션 없음·토큰 무효. */
export class UnauthenticatedError extends AuthorizationError {
  constructor(detail: string) {
    super(ERROR_CODES.UNAUTHORIZED, {
      message: detail,
      publicHint: '로그인 후 다시 시도하세요.',
    });
  }
}

export interface ResolveActorDependencies {
  readonly verifier: ClaimsVerifier;
  readonly reader?: UserAuthorizationReader;
}

export interface ResolveActorRequest {
  /** 서버가 생성한 requestId. 외부 입력이 아니다. */
  readonly requestId: string;
  readonly ipAddress?: string;
}

/**
 * 검증된 인증 정보와 DB 조회 결과로 ActorContext 를 만든다.
 *
 * ⚠️ 요청 본문·헤더의 actor 정보를 **읽지 않는다.** 이 함수의 입력은
 *    `requestId` 와 `ipAddress` 뿐이며, 둘 다 권한 판정에 쓰이지 않는다.
 *
 * @throws {UnauthenticatedError} 401 — 세션 없음·토큰 무효
 * @throws {AuthorizationError} 403 — 로컬 사용자 없음·비활성
 */
export async function resolveActor(
  dependencies: ResolveActorDependencies,
  request: ResolveActorRequest,
): Promise<ActorContext> {
  const identity = await verifyIdentity(dependencies.verifier);
  if (identity === null) {
    throw new UnauthenticatedError('유효한 세션이 없습니다.');
  }

  const reader = dependencies.reader ?? prismaUserAuthorizationReader;
  const authorization = await reader.findByUserId(identity.userId);

  // 인증은 됐지만 SCM 시스템에 등록되지 않은 계정.
  // 여기서 자동 생성하면 승인 절차가 무의미해진다.
  if (authorization === null) {
    throw new AuthorizationError(ERROR_CODES.FORBIDDEN, {
      message: 'SCM 시스템에 등록되지 않은 사용자입니다.',
      publicHint: '시스템 관리자에게 사용자 등록을 요청하세요.',
      context: { supabaseUserId: identity.userId, reason: 'LOCAL_USER_NOT_FOUND' },
    });
  }

  if (!authorization.active) {
    throw new AuthorizationError(ERROR_CODES.FORBIDDEN, {
      message: '비활성화된 사용자입니다.',
      publicHint: '시스템 관리자에게 문의하세요.',
      context: { supabaseUserId: identity.userId, reason: 'USER_INACTIVE' },
    });
  }

  return createActorContext({
    userId: authorization.userId,
    email: authorization.email,
    name: authorization.name,
    active: authorization.active,
    roles: authorization.roles,
    permissions: authorization.permissions,
    requestId: request.requestId,
    ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
    ...(request.ipAddress !== undefined ? { ipAddress: request.ipAddress } : {}),
  });
}

/** `AppError` 인지 확인한다. 라우트에서 오류를 그대로 흘려보낼 때 쓴다. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
