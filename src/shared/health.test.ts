import { describe, expect, it } from 'vitest';

import { aggregateStatus, getHealthStatus, SERVICE_NAME, type HealthCheck } from './health';

describe('aggregateStatus', () => {
  it('점검 항목이 없으면 ok', () => {
    expect(aggregateStatus([])).toBe('ok');
  });

  it('전부 ok 이면 ok', () => {
    const checks: HealthCheck[] = [
      { name: 'db', status: 'ok' },
      { name: 'storage', status: 'ok' },
    ];
    expect(aggregateStatus(checks)).toBe('ok');
  });

  it('degraded 가 하나라도 있으면 degraded', () => {
    const checks: HealthCheck[] = [
      { name: 'db', status: 'ok' },
      { name: 'queue', status: 'degraded' },
    ];
    expect(aggregateStatus(checks)).toBe('degraded');
  });

  it('down 이 있으면 degraded 보다 우선해 down', () => {
    const checks: HealthCheck[] = [
      { name: 'db', status: 'down' },
      { name: 'queue', status: 'degraded' },
    ];
    expect(aggregateStatus(checks)).toBe('down');
  });
});

describe('getHealthStatus', () => {
  it('서비스 식별 정보를 포함한다', () => {
    const status = getHealthStatus();
    expect(status.service).toBe(SERVICE_NAME);
    expect(status.status).toBe('ok');
    expect(status.checks).toHaveLength(0);
  });

  it('timestamp 를 ISO 8601 UTC 로 반환한다', () => {
    const status = getHealthStatus();
    expect(status.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(status.timestamp))).toBe(false);
  });

  it('uptimeSeconds 는 음수가 아닌 정수', () => {
    const { uptimeSeconds } = getHealthStatus();
    expect(Number.isInteger(uptimeSeconds)).toBe(true);
    expect(uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('전달한 점검 결과가 전체 상태에 반영된다', () => {
    const status = getHealthStatus([{ name: 'db', status: 'down', detail: 'connection refused' }]);
    expect(status.status).toBe('down');
    expect(status.checks).toHaveLength(1);
    expect(status.checks[0]?.detail).toBe('connection refused');
  });
});
