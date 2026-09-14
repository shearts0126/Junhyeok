/**
 * DI 토큰. esbuild(tsx·vitest)는 emitDecoratorMetadata 를 지원하지 않으므로 타입 기반 주입 대신
 * 명시적 토큰(@Inject)만 사용한다. 이미 검증한 핵심 로직(pipeline/recovery/repo)은 재작성하지 않고 그대로 주입한다.
 */
export const APP_CONFIG = Symbol('FIN02A_APP_CONFIG');
export const DB_POOL = Symbol('FIN02A_DB_POOL');
export const RAW_STORE = Symbol('FIN02A_RAW_STORE');
export const SECRETS = Symbol('FIN02A_SECRETS');
