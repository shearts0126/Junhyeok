/**
 * 수동 복구 CLI (미리보기·적용 분리).
 *
 *   pnpm recovery preview [--minutes 60]
 *   pnpm recovery close --run <id> --started-at <ISO> [--generation <n>] --actor <담당자> --reason <확인 내용>
 *                       --verified OWNER_TERMINATED|NO_ACTIVE_WORK            # 드라이런(변경 없음, 종료 코드 3)
 *   … 같은 인자 + --confirm                                                  # 적용
 *   pnpm recovery release-lease --account <id> --generation <n> --actor <담당자> --reason <확인 내용>
 *                       --verified OWNER_TERMINATED|NO_ACTIVE_WORK [--confirm] # 죽은 worker 의 잠금 해제(담당자 확인 후)
 *
 * 자동 마감·탈취 없음. --confirm 없이는 아무것도 바꾸지 않는다. --verified 는 담당자가 소유자 종료 또는 활성 작업 부재를
 * 확인했다는 명시적 입력이며 heartbeat 노후가 이를 대체하지 않는다. 적용은 잠금 행·실행 행을 잠근 채 상태·시작 시각·세대값을 재확인한다.
 * 출력에는 실행 ID·상태·코드·시각·세대값만 담는다.
 */
import { createPool } from '../src/db/client';
import { FsRawStore } from '../src/raw/store';
import {
  MANUAL_VERIFICATIONS,
  releaseLeaseManually,
  type ManualVerification,
} from '../src/queue/lease';
import { closeStaleRunManually, previewRecovery } from '../src/recovery';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function parseVerified(v: string | undefined): ManualVerification | undefined {
  return v !== undefined && (MANUAL_VERIFICATIONS as readonly string[]).includes(v)
    ? (v as ManualVerification)
    : undefined;
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
      const verified = parseVerified(arg(argv, '--verified'));
      const genArg = arg(argv, '--generation');
      const expectedGeneration = genArg === undefined ? null : Number(genArg);
      if (!runId || !startedAt || !actor || !reason || !verified) {
        io.err(
          'close 에는 --run, --started-at, --actor, --reason, --verified OWNER_TERMINATED|NO_ACTIVE_WORK 가 필요합니다',
        );
        return 2;
      }
      if (expectedGeneration !== null && !Number.isInteger(expectedGeneration)) {
        io.err('--generation 은 정수(미리보기의 closeArgs.generation 값)');
        return 2;
      }
      const expectedStartedAt = new Date(startedAt);
      if (Number.isNaN(expectedStartedAt.getTime())) {
        io.err('--started-at 은 ISO-8601 시각(미리보기의 startedAt 값)');
        return 2;
      }
      if (!argv.includes('--confirm')) {
        io.out(
          `드라이런: 실행 ${runId} 를 담당자 ${actor} 확인(${verified})으로 FAILED/RECOVERY_MANUAL_CLOSE 마감할 예정입니다. --confirm 을 붙여야 적용됩니다. 변경 없음.`,
        );
        return 3;
      }
      const r = await closeStaleRunManually(pool, {
        runId,
        expectedStartedAt,
        expectedGeneration,
        actor,
        reason,
        verified,
      });
      if (r.applied) {
        io.out(
          `적용: 실행 ${r.run.id} → ${r.run.status} (${r.run.errorCode}) closed_by=${r.run.closedBy} verified=${verified} lease_released=${r.leaseReleased} job_status=${r.jobStatus ?? '-'} at ${r.run.finishedAt?.toISOString() ?? ''}`,
        );
        return 0;
      }
      io.out(`미적용: ${r.reason} (후보 조회 이후 상태·소유권이 바뀌었거나 입력이 유효하지 않음)`);
      return 4;
    }
    if (cmd === 'release-lease') {
      const account = arg(argv, '--account');
      const generation = Number(arg(argv, '--generation'));
      const actor = arg(argv, '--actor');
      const reason = arg(argv, '--reason');
      const verified = parseVerified(arg(argv, '--verified'));
      if (!account || !Number.isInteger(generation) || !actor || !reason || !verified) {
        io.err(
          'release-lease 에는 --account, --generation, --actor, --reason, --verified OWNER_TERMINATED|NO_ACTIVE_WORK 가 필요합니다',
        );
        return 2;
      }
      if (!argv.includes('--confirm')) {
        io.out(
          `드라이런: 계정 ${account} 잠금(세대 ${generation})을 담당자 ${actor} 확인으로 해제할 예정입니다. --confirm 필요. 변경 없음.`,
        );
        return 3;
      }
      const rel = await releaseLeaseManually(pool, {
        sourceAccountId: account,
        expectedGeneration: generation,
        actor,
        reason,
        verified,
      });
      io.out(
        rel.applied
          ? `적용: 계정 ${account} 잠금 세대 ${generation} 해제 (verified=${verified})`
          : `미적용: ${rel.reason}`,
      );
      return rel.applied ? 0 : 4;
    }
    io.err(
      '사용법: recovery preview [--minutes N] | close --run … --verified <kind> [--confirm] | release-lease --account <id> --generation <n> --actor <name> --reason <text> --verified <kind> [--confirm]',
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
