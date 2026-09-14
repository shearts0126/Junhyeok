import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runCollection } from '../src/collector/pipeline';
import { addExternalMapping, resolveExternalCode } from '../src/identity/repo';
import { getRawObject } from '../src/raw/repo';
import { FsRawStore } from '../src/raw/store';
import { listVersions } from '../src/records/observe';
import { traceVersion } from '../src/records/trace';

import { dumpAll, FixtureCollector, seedAccount, testPool, truncateAll } from './helpers';

/**
 * FIN-02A 완료 기준 1~8. 시험용 일회용 PostgreSQL + 가상 데이터로 검증한다.
 * 외부 공급자 연동 성공을 뜻하지 않는다.
 */

let pool: pg.Pool;
let rawDir: string;
const logs: string[] = [];
const deps = () => ({
  pool,
  rawStore: new FsRawStore(rawDir),
  secrets: { get: (n: string) => process.env[n] },
  log: (l: string) => logs.push(l),
});
const period = { periodFrom: '2026-09-12', periodTo: '2026-09-12' };

beforeAll(() => {
  pool = testPool();
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-raw-'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  logs.length = 0;
});

const items = [
  { key: 'TX-1', data: { date: '2026-09-12', amount: '1000', memo: '입금A' } },
  { key: 'TX-2', data: { date: '2026-09-12', amount: '2000', memo: '출금B' } },
];

describe('완료 기준', () => {
  it('1. 동일 원본을 두 번 수집하면 실행 이력은 두 번, 동일 고유키의 관측은 중복되지 않는다', async () => {
    const acc = await seedAccount(pool);
    const c = new FixtureCollector({ items });
    const r1 = await runCollection(deps(), c, { sourceAccountId: acc.id, ...period });
    const r2 = await runCollection(deps(), c, { sourceAccountId: acc.id, ...period });
    expect(r1.run.status).toBe('SUCCEEDED');
    expect(r2.run.status).toBe('SUCCEEDED');
    const runs = await pool.query(
      'SELECT count(*)::int AS n FROM fin_source_runs WHERE source_account_id = $1',
      [acc.id],
    );
    const raws = await pool.query(
      'SELECT count(*)::int AS n, count(DISTINCT sha256)::int AS d FROM fin_raw_objects',
    );
    const recs = await pool.query(
      'SELECT count(*)::int AS n FROM fin_source_records WHERE source_account_id = $1',
      [acc.id],
    );
    const vers = await pool.query('SELECT count(*)::int AS n FROM fin_source_record_versions');
    expect(runs.rows[0].n).toBe(2); // 실행 이력 2회
    expect(raws.rows[0]).toEqual({ n: 2, d: 1 }); // 원본 2건 보관(같은 해시), 이력 삭제 없음
    expect(recs.rows[0].n).toBe(2); // 업무 관측 중복 없음
    expect(vers.rows[0].n).toBe(2); // 버전도 늘지 않음
    expect(r2.observations).toMatchObject({ inserted: 0, unchanged: 2, versioned: 0 });
  });

  it('2. 동일 고유키의 내용이 변경되면 이전 내용과 새 버전을 모두 추적할 수 있다', async () => {
    const acc = await seedAccount(pool);
    await runCollection(deps(), new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    const changed = [
      items[0]!,
      { key: 'TX-2', data: { date: '2026-09-12', amount: '2000', memo: '출금B(적요 정정)' } },
    ];
    const r2 = await runCollection(deps(), new FixtureCollector({ items: changed }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(r2.observations).toMatchObject({ inserted: 0, unchanged: 1, versioned: 1 });
    const rec = await pool.query<{ id: string; current_version: number }>(
      'SELECT id, current_version FROM fin_source_records WHERE source_key = $1',
      ['TX-2'],
    );
    expect(rec.rows[0]!.current_version).toBe(2);
    const versions = await listVersions(pool, rec.rows[0]!.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect((versions[0]!.payload as { memo: string }).memo).toBe('출금B');
    expect((versions[1]!.payload as { memo: string }).memo).toBe('출금B(적요 정정)');
    expect(versions[0]!.rawObjectId).not.toBe(versions[1]!.rawObjectId); // 각 버전이 자기 원본을 가리킨다
  });

  it('3. 다른 법인·원천 계정의 같은 외부 ID 가 충돌하지 않는다', async () => {
    const a = await seedAccount(pool, {
      entity: 'TEST_ENTITY_A',
      externalId: 'SAME-EXT-ID',
      alias: 'A-acct',
    });
    const b = await seedAccount(pool, {
      entity: 'TEST_ENTITY_B',
      externalId: 'SAME-EXT-ID',
      alias: 'B-acct',
    });
    expect(a.id).not.toBe(b.id);
    const same = [{ key: 'TX-1', data: { amount: '1000' } }];
    await runCollection(deps(), new FixtureCollector({ items: same }), {
      sourceAccountId: a.id,
      ...period,
    });
    await runCollection(deps(), new FixtureCollector({ items: same }), {
      sourceAccountId: b.id,
      ...period,
    });
    const recs = await pool.query<{ source_account_id: string }>(
      'SELECT source_account_id FROM fin_source_records WHERE source_key = $1',
      ['TX-1'],
    );
    expect(recs.rows.map((r) => r.source_account_id).sort()).toEqual([a.id, b.id].sort()); // 계정 범위로 분리
    // 같은 법인·같은 원천의 같은 외부 계정 ID 는 중복 생성 불가
    await expect(
      seedAccount(pool, {
        entity: 'TEST_ENTITY_A',
        externalId: 'SAME-EXT-ID',
        alias: 'A-acct-dup',
      }),
    ).rejects.toThrow(/fin_source_accounts_scope_uq/);
    // 외부 코드 매핑도 계정 범위가 시스템 범위보다 우선
    await addExternalMapping(pool, {
      sourceSystem: 'TEST_SYSTEM',
      entityType: 'COUNTERPARTY',
      externalCode: 'CP-1',
      internalId: 'INT-SYS',
      validFrom: '2026-01-01',
    });
    await addExternalMapping(pool, {
      sourceSystem: 'TEST_SYSTEM',
      sourceAccountId: b.id,
      entityType: 'COUNTERPARTY',
      externalCode: 'CP-1',
      internalId: 'INT-B',
      validFrom: '2026-01-01',
    });
    expect(
      await resolveExternalCode(pool, {
        sourceSystem: 'TEST_SYSTEM',
        sourceAccountId: a.id,
        entityType: 'COUNTERPARTY',
        externalCode: 'CP-1',
        onDate: '2026-09-12',
      }),
    ).toBe('INT-SYS');
    expect(
      await resolveExternalCode(pool, {
        sourceSystem: 'TEST_SYSTEM',
        sourceAccountId: b.id,
        entityType: 'COUNTERPARTY',
        externalCode: 'CP-1',
        onDate: '2026-09-12',
      }),
    ).toBe('INT-B');
    expect(
      await resolveExternalCode(pool, {
        sourceSystem: 'TEST_SYSTEM',
        sourceAccountId: a.id,
        entityType: 'COUNTERPARTY',
        externalCode: 'CP-UNKNOWN',
        onDate: '2026-09-12',
      }),
    ).toBeNull(); // 미매핑은 null(임의 생성 없음)
  });

  it('4. 고유키 없는 동일 금액 거래 두 건이 임의로 합쳐지지 않는다', async () => {
    const acc = await seedAccount(pool);
    const twins = [
      { key: null, data: { date: '2026-09-12', amount: '50000', memo: '택배비' } },
      { key: null, data: { date: '2026-09-12', amount: '50000', memo: '택배비' } },
    ];
    const r = await runCollection(deps(), new FixtureCollector({ items: twins }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(r.observations).toMatchObject({ unidentified: 2, inserted: 0, unchanged: 0 });
    const recs = await pool.query(
      'SELECT count(*)::int AS n FROM fin_source_records WHERE source_key IS NULL',
    );
    expect(recs.rows[0].n).toBe(2);
    // 재수집해도 자동 확정 중복 제거를 하지 않고 미식별로 다시 보존한다(중복 후보 검토는 사람/후속 규칙 몫)
    await runCollection(deps(), new FixtureCollector({ items: twins }), {
      sourceAccountId: acc.id,
      ...period,
    });
    const again = await pool.query(
      'SELECT count(*)::int AS n FROM fin_source_records WHERE source_key IS NULL',
    );
    expect(again.rows[0].n).toBe(4);
  });

  it('5. 원천 기준 시각 미제공과 실제 0건 응답을 구분한다', async () => {
    const acc = await seedAccount(pool);
    const zero = await runCollection(
      deps(),
      new FixtureCollector({ items: [], sourceAsOf: null }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(zero.run.status).toBe('SUCCEEDED');
    expect(zero.run.receivedCount).toBe(0); // 실제 0건
    expect(zero.run.sourceAsOf).toBeNull(); // 기준 시각 미제공
    const withAsOf = await runCollection(
      deps(),
      new FixtureCollector({ items, sourceAsOf: new Date('2026-09-12T15:00:00Z') }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(withAsOf.run.sourceAsOf?.toISOString()).toBe('2026-09-12T15:00:00.000Z');
    expect(withAsOf.run.receivedCount).toBe(2);
    // 파싱 전에 끝난 실행은 건수를 모른다 → null(0 아님)
    const unparsed = await runCollection(
      deps(),
      new FixtureCollector({ items, validateNotImplemented: true }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(unparsed.run.status).toBe('PARTIAL');
    expect(unparsed.run.receivedCount).toBeNull();
  });

  it('6. 네트워크·파싱 실패와 미구현 단계는 수집 완료로 표시되지 않는다', async () => {
    const acc = await seedAccount(pool);
    const net = await runCollection(deps(), new FixtureCollector({ items, requestFails: true }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(net.run.status).toBe('FAILED');
    expect(net.run.errorCode).toBe('NETWORK');
    expect(net.run.receivedCount).toBeNull();
    expect(net.rawObjectId).toBeNull();
    expect(net.run.stages).toEqual({
      authenticate: 'OK',
      request: 'FAILED',
      validate: 'SKIPPED',
      normalize: 'SKIPPED',
      reconcile: 'SKIPPED',
    });

    const bad = await runCollection(
      deps(),
      new FixtureCollector({ items, bytes: new TextEncoder().encode('<html>not json</html>') }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(bad.run.status).toBe('FAILED');
    expect(bad.run.errorCode).toBe('PARSE_FAILED');
    expect(bad.rawObjectId).not.toBeNull(); // 실패해도 원문은 보관
    expect(bad.run.receivedCount).toBeNull();

    const auth = await runCollection(deps(), new FixtureCollector({ items, authFails: true }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(auth.run.status).toBe('BLOCKED');
    expect(auth.run.errorCode).toBe('NO_CREDENTIALS');

    // 요청 성공 + 정규화 미구현 → PARTIAL (네트워크 성공 ≠ 수집 완료)
    const partial = await runCollection(
      deps(),
      new FixtureCollector({ items, normalizeNotImplemented: true }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(partial.run.status).toBe('PARTIAL');
    expect(partial.run.stages.normalize).toBe('NOT_IMPLEMENTED');
    expect(partial.observations).toBeNull();
    // 대조 미구현도 SUCCEEDED 가 아니다
    const noRecon = await runCollection(
      deps(),
      new FixtureCollector({ items, reconcileNotImplemented: true }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(noRecon.run.status).toBe('PARTIAL');
    expect(noRecon.observations).not.toBeNull();
    const succeeded = await pool.query(
      "SELECT count(*)::int AS n FROM fin_source_runs WHERE status = 'SUCCEEDED'",
    );
    expect(succeeded.rows[0].n).toBe(0);
  });

  it('7. 처리 결과에서 수집 실행과 원본까지 추적할 수 있다', async () => {
    const acc = await seedAccount(pool);
    const r = await runCollection(deps(), new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    const v = await pool.query<{ id: string }>(
      'SELECT v.id FROM fin_source_record_versions v JOIN fin_source_records s ON s.id = v.source_record_id WHERE s.source_key = $1',
      ['TX-1'],
    );
    const trace = await traceVersion(pool, v.rows[0]!.id);
    expect(trace).toMatchObject({
      sourceKey: 'TX-1',
      runId: r.run.id,
      rawObjectId: r.rawObjectId,
      sourceAccountAlias: acc.alias,
      legalEntityCode: 'TEST_ENTITY_A',
      runStatus: 'SUCCEEDED',
    });
    const raw = await getRawObject(pool, r.rawObjectId!);
    const bytes = readFileSync(join(rawDir, raw!.storageKey));
    expect(bytes.byteLength).toBe(raw!.byteSize); // 원본 바이트 그대로
    expect(JSON.parse(bytes.toString('utf8')).items).toHaveLength(2);
  });

  it('8. 토큰·인증 헤더가 저장 데이터·원본 저장소·로그에 남지 않는다', async () => {
    const acc = await seedAccount(pool);
    const secret = 'SECRET-TOKEN-XYZ-123';
    await runCollection(deps(), new FixtureCollector({ items, leakSecret: secret }), {
      sourceAccountId: acc.id,
      ...period,
    });
    await runCollection(
      deps(),
      new FixtureCollector({ items, leakSecret: secret, requestFails: true }),
      { sourceAccountId: acc.id, ...period },
    ); // 오류 메시지 경로
    const dump = await dumpAll(pool);
    expect(dump).not.toContain(secret);
    expect(dump).toContain('[REDACTED]'); // URL 쿼리·오류 메시지가 마스킹됨
    const raw = await pool.query<{ request_summary: { headerNames: string[]; url: string } }>(
      'SELECT request_summary FROM fin_raw_objects LIMIT 1',
    );
    expect(raw.rows[0]!.request_summary.headerNames).toEqual(['accept', 'authorization']); // 이름만, 값 없음
    expect(raw.rows[0]!.request_summary.url).toContain('access_token=%5BREDACTED%5D');
    for (const line of logs) expect(line).not.toContain(secret);
    // 원본 저장소 파일(응답 본문)에도 없어야 한다(이 시험의 응답 본문은 토큰을 포함하지 않는다)
    for (const f of walk(rawDir)) expect(readFileSync(f, 'utf8')).not.toContain(secret);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
