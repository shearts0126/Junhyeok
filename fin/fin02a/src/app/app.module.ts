import { Global, Module } from '@nestjs/common';

import { CollectionModule } from './collection.module';
import { type AppConfig, loadConfig } from './config';
import { DbModule } from './db.module';
import { HealthController } from './health.controller';
import { APP_CONFIG } from './tokens';

/** 설정 제공 모듈. 테스트에서는 forConfig 로 검증된 설정 객체를 직접 준다. */
@Global()
@Module({})
export class ConfigModule {
  static forConfig(config: AppConfig) {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
  static fromEnv() {
    return ConfigModule.forConfig(loadConfig());
  }
}

@Module({})
export class AppModule {
  static forConfig(config: AppConfig) {
    return {
      module: AppModule,
      imports: [ConfigModule.forConfig(config), DbModule, CollectionModule],
      controllers: [HealthController],
    };
  }
}
