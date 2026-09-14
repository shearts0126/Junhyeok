/**
 * FIN-01 검증 실행기.
 *
 *   pnpm tsx fin/FIN-01/verify/run.ts                 # 가상 샘플(fixture) 검증
 *   pnpm tsx fin/FIN-01/verify/run.ts --live all      # 실제 호출 시도(환경변수 필요)
 *   pnpm tsx fin/FIN-01/verify/run.ts --live fx-exim --date 2026-09-12
 *
 * 결과는 fin/FIN-01/results/ 에 JSON 으로 남긴다. 가상 데이터 검증은 synthetic=true 로 표시되며
 * 실제 연동 성공을 뜻하지 않는다.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LIVE_SOURCES, runLive, type LiveSource } from './live';
import { coverage, type SourceSpec } from './mapping';
import type { CheckResult } from './reconcile';
import * as wehago from './sources/accounting-wehago';
import * as ads from './sources/ads';
import * as bankAgg from './sources/bank-aggregator';
import * as bankKftc from './sources/bank-kftc';
import * as cross from './sources/cross-source';
import * as delivery from './sources/delivery-excel';
import * as fx from './sources/fx';
import * as cafe24 from './sources/sales-cafe24';
import * as sabangnet from './sources/sales-sabangnet';

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');

const FIXTURE_SUITES: { name: string; run: () => CheckResult[] }[] = [
  { name: 'bank-kftc-openbanking', run: bankKftc.runFixtureChecks },
  { name: 'bank-aggregator', run: bankAgg.runFixtureChecks },
  { name: 'sales-sabangnet', run: sabangnet.runFixtureChecks },
  { name: 'sales-cafe24', run: cafe24.runFixtureChecks },
  { name: 'delivery-excel', run: delivery.runFixtureChecks },
  { name: 'ads', run: ads.runFixtureChecks },
  { name: 'accounting-wehago', run: wehago.runFixtureChecks },
  { name: 'fx', run: fx.runFixtureChecks },
  { name: 'cross-source', run: cross.runFixtureChecks },
];

const SPECS: SourceSpec[] = [
  bankKftc.spec,
  bankAgg.spec,
  sabangnet.spec,
  cafe24.spec,
  delivery.spec,
  ...ads.specs,
  wehago.spec,
  fx.eximSpec,
  fx.ecosSpec,
];

function parseArgs(argv: string[]): { live: string | undefined; date: string } {
  let live: string | undefined;
  let date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--live') live = argv[i + 1] ?? 'all';
    if (argv[i] === '--date') date = argv[i + 1] ?? date;
  }
  return { live, date };
}

async function main(): Promise<number> {
  const { live, date } = parseArgs(process.argv.slice(2));
  mkdirSync(RESULTS_DIR, { recursive: true });
  const startedAtUtc = new Date().toISOString();

  if (live !== undefined) {
    const targets: LiveSource[] = live === 'all' ? LIVE_SOURCES : [live as LiveSource];
    const results = [];
    for (const t of targets) {
      if (!LIVE_SOURCES.includes(t))
        throw new Error(`지원하지 않는 live 소스: ${t}. 가능: ${LIVE_SOURCES.join(', ')}`);
      const r = await runLive(t, date);
      results.push(r);
      console.log(
        `[live] ${r.source.padEnd(14)} ${r.status.padEnd(24)} impl=${r.implementation} parse=${r.parsingImplemented ? 'yes' : 'NO(조회 구현 미완료)'} ${r.endpoint} → ${r.summary}`,
      );
    }
    const out = {
      mode: 'live',
      targetDate: date,
      startedAtUtc,
      finishedAtUtc: new Date().toISOString(),
      results,
    };
    writeFileSync(join(RESULTS_DIR, 'live-run.json'), `${JSON.stringify(out, null, 2)}\n`);
    const anyVerified = results.some((r) => r.verified);
    console.log(
      `\n실제 수집 검증 완료 소스: ${
        anyVerified
          ? results
              .filter((r) => r.verified)
              .map((r) => r.source)
              .join(', ')
          : '없음'
      }`,
    );
    console.log(
      '응답 파싱·정규화·대조 구현: 없음 → 모든 --live 소스는 자격정보가 있어도 "조회 구현 미완료" 상태',
    );
    return results.every((r) => r.status === 'OK') ? 0 : 2;
  }

  const suites: { name: string; checks: CheckResult[] }[] = [];
  let failed = 0;
  for (const s of FIXTURE_SUITES) {
    let checks: CheckResult[];
    try {
      checks = s.run();
    } catch (e) {
      checks = [
        {
          id: `${s.name}-EXC`,
          title: '실행 예외',
          passed: false,
          detail: e instanceof Error ? e.message : String(e),
          synthetic: true,
        },
      ];
    }
    suites.push({ name: s.name, checks });
    console.log(`\n## ${s.name}`);
    for (const c of checks) {
      if (!c.passed) failed += 1;
      console.log(
        `  ${c.passed ? 'PASS' : 'FAIL'} ${c.id} ${c.title}${c.detail ? ` — ${c.detail}` : ''}`,
      );
    }
  }
  const mappingSummary = SPECS.map((s) => ({
    sourceSystem: s.sourceSystem,
    displayName: s.displayName,
    coverage: coverage(s),
    docs: s.docs,
  }));
  const out = {
    mode: 'fixtures',
    synthetic: true,
    note: '가상 데이터 검증. 실제 연동 성공을 의미하지 않음(실제 수집 미검증).',
    startedAtUtc,
    finishedAtUtc: new Date().toISOString(),
    totalChecks: suites.reduce((n, s) => n + s.checks.length, 0),
    failed,
    suites,
    mappingSummary,
  };
  writeFileSync(join(RESULTS_DIR, 'fixture-run.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `\n총 ${out.totalChecks}건 중 실패 ${failed}건. 결과: results/fixture-run.json (synthetic=true)`,
  );
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);
