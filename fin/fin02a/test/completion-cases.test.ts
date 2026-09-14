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

import {
  dumpAll,
  FixtureCollector,
  secretsWith,
  seedAccount,
  testPool,
  truncateAll,
} from './helpers';

/**
 * FIN-02A 완료 기준 1~8. 시험용 일회용 PostgreSQL + 가상 데이터로 검증한다.
 * 외부 공급자 연동 성공을 뜻하지 않는다. 2차 검토(대조 후 관측 저장, 상태 정의, 비밀값 경계)에 맞춰 6·8 을 수정했다.
 */

let pool: pg.Pool;
let rawDir: string;
const logs: string[] = [];
const TOKEN = 'test-token-not-real-0001';
const deps = (secrets: Record<string, string> = { FIN02A_TEST_TOKEN: TOKEN }) => ({
  pool,
  rawStore: new FsRawStore(rawDir),
  secrets: secretsWith(secrets),
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
    const links = await pool.query('SELECT count(*)::int AS n FROM fin_source_record_observations');
    expect(runs.rows[0].n).toBe(2); // 실행 이력 2회
    expect(raws.rows[0]).toEqual({ n: 2, d: 1 }); // 원본 2건 보관(같은 해시), 이력 삭제 없음
    expect(recs.rows[0].n).toBe(2); // 원거래 2건 → 업무 관측 2건(중복 없음)
    expect(vers.rows[0].n).toBe(2); // 버전도 늘지 않음
    expect(links.rows[0].n).toBe(4); // 실행별 연결은 2회 × 2건
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
    await expect(
      seedAccount(pool, {
        entity: 'TEST_ENTITY_A',
        externalId: 'SAME-EXT-ID',
        alias: 'A-acct-dup',
      }),
    ).rejects.toThrow(/fin_source_accounts_scope_uq/);
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
    ).toBeNull();
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
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM fin_source_records WHERE source_key IS NULL',
        )
      ).rows[0].n,
    ).toBe(2);
    await runCollection(deps(), new FixtureCollector({ items: twins }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM fin_source_records WHERE source_key IS NULL',
        )
      ).rows[0].n,
    ).toBe(4); // 미식별 자료로 재보존
  });

  it('5. 원천 기준 시각 미제공과 실제 0건 응답을 구분한다', async () => {
    const acc = await seedAccount(pool);
    const zero = await runCollection(
      deps(),
      new FixtureCollector({ items: [], sourceAsOf: null }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(zero.run.status).toBe('SUCCEEDED');
    expect(zero.run.receivedCount).toBe(0);
    expect(zero.run.sourceAsOf).toBeNull();
    const withAsOf = await runCollection(
      deps(),
      new FixtureCollector({ items, sourceAsOf: new Date('2026-09-12T15:00:00Z') }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(withAsOf.run.sourceAsOf?.toISOString()).toBe('2026-09-12T15:00:00.000Z');
    expect(withAsOf.run.receivedCount).toBe(2);
    const unparsed = await runCollection(
      deps(),
      new FixtureCollector({ items, validateNotImplemented: true }),
      { sourceAccountId: acc.id, ...period, mode: 'VERIFICATION' },
    );
    expect(unparsed.run.status).toBe('PARTIAL');
    expect(unparsed.run.receivedCount).toBeNull(); // 파싱 전 종료는 건수를 모른다(0 아님)
  });

  it('6. 네트워크·파싱 실패와 미구현 단계는 수집 완료로 표시되지 않는다', async () => {
    const acc = await seedAccount(pool);
    const net = await runCollection(deps(), new FixtureCollector({ items, requestFails: true }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(net.run.status).toBe('FAILED');
    expect(net.run.errorCode).toBe('NETWORK');
    expect(net.run.failureKind).toBe('TRANSIENT');
    expect(net.run.receivedCount).toBeNull();
    expect(net.rawObjectId).toBeNull();
    expect(net.run.stages).toEqual({
      authenticate: { outcome: 'OK' },
      request: { outcome: 'FAILED', code: 'NETWORK' },
      validate: { outcome: 'SKIPPED' },
      normalize: { outcome: 'SKIPPED' },
      reconcile: { outcome: 'SKIPPED' },
    });

    const bad = await runCollection(
      deps(),
      new FixtureCollector({
        items,
        bytes: new TextEncoder().encode('<html>not json</html>'),
        contentType: 'text/html',
      }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(bad.run.status).toBe('FAILED');
    expect(bad.run.errorCode).toBe('PARSE_FAILED');
    expect(bad.run.failureKind).toBe('PERMANENT');
    expect(bad.rawObjectId).not.toBeNull(); // 실패해도 원문은 보관
    expect(bad.run.receivedCount).toBeNull();

    const auth = await runCollection(deps({}), new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(auth.run.status).toBe('BLOCKED');
    expect(auth.run.errorCode).toBe('NO_CREDENTIALS');
    expect(auth.run.failureKind).toBe('CREDENTIALS');

    const reqNi = await runCollection(
      deps(),
      new FixtureCollector({ items, requestNotImplemented: true }),
      { sourceAccountId: acc.id, ...period, mode: 'VERIFICATION' },
    );
    expect(reqNi.run.status).toBe('PARTIAL'); // 미구현은 BLOCKED 가 아니다
    expect(reqNi.run.failureKind).toBe('NOT_IMPLEMENTED');
    expect(reqNi.run.stages.request).toEqual({
      outcome: 'NOT_IMPLEMENTED',
      code: 'REQUEST_NOT_IMPLEMENTED',
    });
    const partial = await runCollection(
      deps(),
      new FixtureCollector({ items, normalizeNotImplemented: true }),
      { sourceAccountId: acc.id, ...period, mode: 'VERIFICATION' },
    );
    expect(partial.run.status).toBe('PARTIAL');
    expect(partial.run.stages.normalize).toEqual({
      outcome: 'NOT_IMPLEMENTED',
      code: 'NORMALIZE_NOT_IMPLEMENTED',
    });
    expect(partial.observations).toBeNull();
    const noRecon = await runCollection(
      deps(),
      new FixtureCollector({ items, reconcileNotImplemented: true }),
      { sourceAccountId: acc.id, ...period, mode: 'VERIFICATION' },
    );
    expect(noRecon.run.status).toBe('PARTIAL'); // 대조 미구현: 원본·실행 보존, 최신 관측 미갱신
    expect(noRecon.observations).toBeNull();
    expect(noRecon.rawObjectId).not.toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_source_records')).rows[0].n).toBe(
      0,
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM fin_source_runs WHERE status = 'SUCCEEDED'",
        )
      ).rows[0].n,
    ).toBe(0);
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
      runId: r.runId,
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

  it('8. 토큰·인증 헤더가 저장 데이터·원본 저장소·로그·결과에 남지 않는다', async () => {
    const acc = await seedAccount(pool);
    const secret = 'SECRET-TOKEN-XYZ-123';
    const d = deps({ FIN02A_TEST_TOKEN: secret });
    const r1 = await runCollection(d, new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    const r2 = await runCollection(d, new FixtureCollector({ items, requestFails: true }), {
      sourceAccountId: acc.id,
      ...period,
    });
    const r3 = await runCollection(
      d,
      new FixtureCollector({
        items,
        throwInValidate: `boom access_token=${secret} path/${secret}`,
      }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(r3.run.status).toBe('FAILED');
    expect(r3.run.errorCode).toBe('UNHANDLED_VALIDATE');
    expect(r3.run.errorClass).toBe('Error');
    const dump = await dumpAll(pool);
    expect(dump).not.toContain(secret);
    const raw = await pool.query<{
      request_summary: { sourceSystem: string; method: string; endpoint: string };
    }>('SELECT request_summary FROM fin_raw_objects LIMIT 1');
    expect(raw.rows[0]!.request_summary).toEqual({
      sourceSystem: 'TEST_SYSTEM',
      method: 'GET',
      endpoint: '/api/list/{date}',
    }); // 템플릿만, URL·헤더 없음
    for (const line of logs) expect(line).not.toContain(secret);
    for (const out of [r1, r2, r3]) expect(JSON.stringify(out)).not.toContain(secret); // 반환값(CLI 결과)에도 없음
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
