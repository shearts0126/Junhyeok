/**
 * 수동 복구 CLI (미리보기·적용 분리).
 *
 *   pnpm recovery preview [--minutes 60]
 *   pnpm recovery close --run <id> --started-at <ISO> --actor <담당자> --reason <확인 내용>          # 드라이런(변경 없음, 종료 코드 3)
 *   pnpm recovery close --run <id> --started-at <ISO> --actor <담당자> --reason <확인 내용> --confirm  # 적용
 *   pnpm recovery release-lease --account <id> --generation <n> --actor <담당자> --reason <확인 내용> [--confirm]  # 죽은 worker 의 잠금 해제(담당자 확인 후)
 *
 * 자동 마감 없음. --confirm 없이는 아무것도 바꾸지 않는다. 적용 직전에 상태·시작 시각을 재확인한다.
 * 출력에는 실행 ID·상태·코드·시각만 담는다.
 */
import { createPool } from '../src/db/client';
import { FsRawStore } from '../src/raw/store';
import { releaseLeaseManually } from '../src/queue/lease';
import { closeStaleRunManually, previewRecovery } from '../src/recovery';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 종료 코드: 0 성공/적용, 2 사용법 오류, 3 드라이런(미적용), 4 적용 거부(상태 변경 등), 1 실행 오류 */
export async function runRecoveryCli(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const url = env['FIN02A_DATABASE_URL'];
  if (!url) {
    io.err('FIN02A_DATABASE_URL 이 필요합니다');
    return 2;
  }
  const pool = createPool(url);
  const store = new FsRawStore(env['FIN02A_RAW_STORE_DIR'] ?? '.raw-store');
  try {
    const cmd = argv[0];
    if (cmd === 'preview') {
      const minutes = Number(
        arg(argv, '--minutes') ?? env['FIN02A_RECOVERY_CANDIDATE_MINUTES'] ?? '60',
      );
      if (!Number.isInteger(minutes) || minutes < 1) {
        io.err('--minutes 는 1 이상의 정수');
        return 2;
      }
      const p = await previewRecovery(pool, store, minutes * 60_000);
      io.out(JSON.stringify(p, null, 2));
      io.out(
        `확인 후보 ${p.staleRunCandidates.length}건, 고아 원본 ${p.orphanRawKeys.length}건, 바이트 유실 ${p.rawRowsMissingBytes.length}건. 상태는 변경되지 않았습니다.`,
      );
      return 0;
    }
    if (cmd === 'close') {
      const runId = arg(argv, '--run');
      const startedAt = arg(argv, '--started-at');
      const actor = arg(argv, '--actor');
      const reason = arg(argv, '--reason');
      if (!runId || !startedAt || !actor || !reason) {
        io.err('close 에는 --run, --started-at, --actor, --reason 이 필요합니다');
        return 2;
      }
      const expectedStartedAt = new Date(startedAt);
      if (Number.isNaN(expectedStartedAt.getTime())) {
        io.err('--started-at 은 ISO-8601 시각(미리보기의 startedAt 값)');
        return 2;
      }
      if (!argv.includes('--confirm')) {
        io.out(
          `드라이런: 실행 ${runId} 를 담당자 ${actor} 확인으로 FAILED/RECOVERY_MANUAL_CLOSE 마감할 예정입니다. --confirm 을 붙여야 적용됩니다. 변경 없음.`,
        );
        return 3;
      }
      const r = await closeStaleRunManually(pool, { runId, expectedStartedAt, actor, reason });
      if (r.applied) {
        io.out(
          `적용: 실행 ${r.run.id} → ${r.run.status} (${r.run.errorCode}) closed_by=${r.run.closedBy} at ${r.run.finishedAt?.toISOString() ?? ''}`,
        );
        return 0;
      }
      io.out(`미적용: ${r.reason} (후보 조회 이후 상태가 바뀌었거나 입력이 유효하지 않음)`);
      return 4;
    }
    if (cmd === 'release-lease') {
      const account = arg(argv, '--account');
      const generation = Number(arg(argv, '--generation'));
      const actor = arg(argv, '--actor');
      const reason = arg(argv, '--reason');
      if (!account || !Number.isInteger(generation) || !actor || !reason) {
        io.err('release-lease 에는 --account, --generation, --actor, --reason 이 필요합니다');
        return 2;
      }
      if (!argv.includes('--confirm')) {
        io.out(
          `드라이런: 계정 ${account} 잠금(세대 ${generation})을 담당자 ${actor} 확인으로 해제할 예정입니다. --confirm 필요. 변경 없음.`,
        );
        return 3;
      }
      const ok = await releaseLeaseManually(pool, {
        sourceAccountId: account,
        expectedGeneration: generation,
        actor,
        reason,
      });
      io.out(
        ok
          ? `적용: 계정 ${account} 잠금 세대 ${generation} 해제`
          : '미적용: 세대가 바뀌었거나 이미 해제됨',
      );
      return ok ? 0 : 4;
    }
    io.err(
      '사용법: recovery preview [--minutes N] | close --run … [--confirm] | release-lease --account <id> --generation <n> --actor <name> --reason <text> [--confirm]',
    );
    return 2;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1] && /recovery\.(ts|js)$/.test(process.argv[1])) {
  runRecoveryCli(process.argv.slice(2), process.env, {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`recovery failed: ${e instanceof Error ? e.name : 'UNKNOWN'}`);
      process.exitCode = 1;
    },
  );
}
