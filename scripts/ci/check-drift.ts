import { spawnSync } from 'node:child_process';

import { startEphemeralDatabase } from '../../tests/db/harness';

/**
 * Migration drift 게이트 (T0-9).
 *
 * `schema.prisma` 와 `prisma/migrations` history 가 어긋나면 **비정상 종료**한다.
 * 스키마를 바꾸고 migration 을 만들지 않으면 CI 가 여기서 실패한다.
 *
 *   prisma migrate diff --from-migrations prisma/migrations
 *                       --to-schema prisma/schema.prisma --exit-code
 *
 *   exit 0 = 차이 없음(PASS) / 2 = 차이 있음(DRIFT) / 1 = 오류
 *
 * shadow DB 는 **일회용 빈 PostgreSQL**(Testcontainers, 또는 명시적
 * `DB_TEST_SERVER_URL` 서버의 임시 DB)이다. 운영·스테이징 DB 를 shadow 로
 * 쓰지 않는다. 검사 후 즉시 정리한다.
 *
 * 실행: `pnpm prisma:drift`
 */
async function main(): Promise<number> {
  // 빈 DB — diff 가 스스로 migration 을 적용해 비교한다.
  const shadow = await startEphemeralDatabase({ migrate: false });
  console.log(`[drift] shadow: ${shadow.source} / ${shadow.databaseName}`);

  try {
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-migrations',
        'prisma/migrations',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          // prisma.config.ts 의 env('DIRECT_URL') 해석용 — shadow 와 같은 일회용 DB.
          DIRECT_URL: shadow.url,
          SHADOW_DATABASE_URL: shadow.url,
        },
      },
    );

    if (result.status === 0) {
      console.log('[drift] PASS — schema.prisma 와 migration history 가 일치합니다.');
      return 0;
    }
    if (result.status === 2) {
      console.error(
        '[drift] FAIL — schema.prisma 가 migration history 와 다릅니다. ' +
          '`pnpm prisma:migrate` 로 migration 을 생성해 함께 커밋하세요.',
      );
      return 2;
    }
    console.error(`[drift] ERROR — prisma migrate diff 종료 코드 ${String(result.status)}`);
    return result.status ?? 1;
  } finally {
    await shadow.stop().catch(() => undefined);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('[drift] 실행 실패:', error);
    process.exitCode = 1;
  });
