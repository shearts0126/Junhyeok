/**
 * 헬스체크 도메인 로직.
 *
 * Route Handler 에 로직을 두지 않는다는 프로젝트 규칙(SKU·BOM PRD §2.6)을
 * 최소 단위에서부터 지킨다. Route 는 이 함수를 호출해 직렬화만 담당한다.
 */

export type HealthCheckStatus = 'ok' | 'degraded' | 'down';

export interface HealthCheck {
  /** 점검 대상 이름 (db, storage, queue ...) */
  readonly name: string;
  readonly status: HealthCheckStatus;
  readonly detail?: string;
}

export interface HealthStatus {
  readonly status: HealthCheckStatus;
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  /** ISO 8601 (UTC) */
  readonly timestamp: string;
  readonly uptimeSeconds: number;
  readonly checks: readonly HealthCheck[];
}

export const SERVICE_NAME = 'deeppoint-scm-os';

/**
 * 개별 점검 결과를 종합해 전체 상태를 결정한다.
 * down 이 하나라도 있으면 down, degraded 가 있으면 degraded, 그 외 ok.
 */
export function aggregateStatus(checks: readonly HealthCheck[]): HealthCheckStatus {
  if (checks.some((c) => c.status === 'down')) return 'down';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return 'ok';
}

/**
 * 현재 헬스 상태를 생성한다.
 *
 * @param checks 외부 의존성 점검 결과. T0-1 에서는 비어 있다.
 */
export function getHealthStatus(checks: readonly HealthCheck[] = []): HealthStatus {
  return {
    status: aggregateStatus(checks),
    service: SERVICE_NAME,
    version: process.env['npm_package_version'] ?? '0.0.0',
    environment: process.env['NODE_ENV'] ?? 'development',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    checks,
  };
}
