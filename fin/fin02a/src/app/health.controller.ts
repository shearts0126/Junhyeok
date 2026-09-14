import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';

import { DbHealthService } from './db.module';

const STARTED_AT = Date.now();

/**
 * liveness: 프로세스가 응답하면 200. readiness: DB 연결과 스키마(마이그레이션 기록)가 있으면 200, 아니면 503.
 * 응답에는 연결 문자열·호스트·예외 메시지가 포함되지 않는다(고정 코드만).
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(DbHealthService) private readonly db: DbHealthService) {}

  @Get('live')
  live(): { status: 'ok'; service: string; uptimeSeconds: number } {
    return {
      status: 'ok',
      service: 'fin-dashboard-core',
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    };
  }

  @Get('ready')
  async ready(): Promise<{
    status: 'ready';
    checks: { name: 'database'; status: 'ok'; migrations: number }[];
  }> {
    const c = await this.db.check();
    if (!c.ok) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        checks: [{ name: 'database', status: 'down', code: c.code }],
      });
    }
    return {
      status: 'ready',
      checks: [{ name: 'database', status: 'ok', migrations: c.migrations }],
    };
  }
}
