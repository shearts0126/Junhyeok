import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { type AppConfig, loadConfig } from './config';

/** 테스트·CLI 에서 재사용하는 앱 생성. 로그인 구현 전이므로 설정 검증이 루프백 호스트만 통과시킨다. */
export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forConfig(config), {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.httpPort, config.httpHost);
  new Logger('bootstrap').log(
    `listening on ${config.httpHost}:${config.httpPort} (loopback only; no auth yet)`,
  );
}

if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    // 설정 오류는 코드만 출력한다(연결 문자열 미노출).
    const code =
      e instanceof Error && 'code' in e
        ? String((e as { code: unknown }).code)
        : e instanceof Error
          ? e.name
          : 'UNKNOWN';
    console.error(`bootstrap failed: ${code}`);
    process.exitCode = 1;
  });
}
