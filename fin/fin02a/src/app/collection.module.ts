import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import type pg from 'pg';

import { runCollection, type CollectionOutcome } from '../collector/pipeline';
import type { Collector, SecretProvider } from '../collector/types';
import { FsRawStore, type RawStore } from '../raw/store';
import {
  closeStaleRunManually,
  previewRecovery,
  type ManualCloseInput,
  type ManualCloseResult,
  type RecoveryPreview,
} from '../recovery';
import type { RunMode } from '../runs/repo';

import type { AppConfig } from './config';
import { DbModule } from './db.module';
import { APP_CONFIG, DB_POOL, RAW_STORE, SECRETS } from './tokens';

/** 환경변수 기반 비밀값 제공자. 값은 호출 시점에만 읽고 저장·로그하지 않는다. */
export class EnvSecretProvider implements SecretProvider {
  get(name: string): string | undefined {
    return process.env[name];
  }
}

/** 이미 검증한 파이프라인을 그대로 호출하는 얇은 서비스. 스케줄러·큐·실제 공급자 수집기는 이 범위에 없다. */
@Injectable()
export class CollectionService {
  private readonly logger = new Logger(CollectionService.name);
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(RAW_STORE) private readonly rawStore: RawStore,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
  ) {}

  run<A, P>(
    collector: Collector<A, P>,
    input: { sourceAccountId: string; periodFrom: string; periodTo: string; mode?: RunMode },
  ): Promise<CollectionOutcome> {
    // 파이프라인 로그 한 줄은 실행 ID·상태·코드만 담는다. 원본·payload·개인정보는 출력하지 않는다.
    return runCollection(
      {
        pool: this.pool,
        rawStore: this.rawStore,
        secrets: this.secrets,
        log: (l) => this.logger.log(l),
      },
      collector,
      input,
    );
  }
}

@Injectable()
export class RecoveryService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(RAW_STORE) private readonly rawStore: RawStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  preview(): Promise<RecoveryPreview> {
    return previewRecovery(this.pool, this.rawStore, this.config.recoveryCandidateMinutes * 60_000);
  }

  close(input: ManualCloseInput): Promise<ManualCloseResult> {
    return closeStaleRunManually(this.pool, input);
  }
}

@Module({
  imports: [DbModule],
  providers: [
    {
      provide: RAW_STORE,
      useFactory: (cfg: AppConfig) => new FsRawStore(cfg.rawStoreDir),
      inject: [APP_CONFIG],
    },
    { provide: SECRETS, useClass: EnvSecretProvider },
    CollectionService,
    RecoveryService,
  ],
  exports: [CollectionService, RecoveryService, RAW_STORE],
})
export class CollectionModule {}
