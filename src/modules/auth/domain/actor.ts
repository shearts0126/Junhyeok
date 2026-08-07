/**
 * ActorContext — 요청을 수행하는 주체 (T0-6).
 *
 * ⚠️ **요청 본문이나 헤더에서 actor 정보를 받지 않는다.** 검증된 Supabase
 *    사용자와 DB 조회 결과로만 만든다. 클라이언트가 `userId` 나 `roles` 를
 *    보낼 수 있다면 권한 체계 전체가 무의미해진다.
 *
 * ⚠️ 비활성 사용자로는 ActorContext 를 만들지 않는다. 만들 수 있게 두면
 *    "생성은 됐는데 어딘가에서 걸러지겠지"에 기대게 된다.
 */

export interface ActorContext {
  /** 로컬 `user.id`. Supabase `auth.users.id` 와 같은 UUID. */
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  /** 중복 제거·정렬된 역할 코드 */
  readonly roles: readonly string[];
  /** 중복 제거·정렬된 권한 키 */
  readonly permissions: readonly string[];
  /** 서버가 생성한 요청 식별자 */
  readonly requestId: string;
  readonly sessionId?: string;
  readonly ipAddress?: string;
}

/**
 * ActorContext 를 만들 때 필요한 값.
 *
 * 전부 **서버가 확보한 값**이다. 외부 입력을 그대로 받는 필드가 없다.
 */
export interface ActorContextInput {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly active: boolean;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly requestId: string;
  readonly sessionId?: string;
  readonly ipAddress?: string;
}

/** 중복을 제거하고 사전순으로 고정한다. 순서가 흔들리면 응답·로그 비교가 어려워진다. */
export function normalizeCodes(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
}

/**
 * ActorContext 를 만든다.
 *
 * @throws {Error} 비활성 사용자인 경우. 호출부가 그 전에 403 으로 막아야 하며,
 *   여기까지 왔다면 프로그래밍 오류다.
 */
export function createActorContext(input: ActorContextInput): ActorContext {
  if (!input.active) {
    throw new Error('비활성 사용자로는 ActorContext 를 만들 수 없습니다.');
  }

  return {
    userId: input.userId,
    email: input.email,
    name: input.name,
    roles: normalizeCodes(input.roles),
    permissions: normalizeCodes(input.permissions),
    requestId: input.requestId,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
  };
}
