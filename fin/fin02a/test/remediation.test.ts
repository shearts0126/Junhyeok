import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runCollection } from '../src/collector/pipeline';
import { addExternalMapping, resolveExternalCode } from '../src/identity/repo';
import { FsRawStore, MemoryRawStore, type RawStore } from '../src/raw/store';
import { listVersions } from '../src/records/observe';
import { runsForRecord, traceRun } from '../src/records/trace';
import {
  findOrphanRawKeys,
  findRawRowsMissingBytes,
  listUnfinishedRuns,
  markUnfinishedRunFailed,
} from '../src/recovery';
import { startRun } from '../src/runs/repo';

import {
  dumpAll,
  faultyPool,
  FixtureCollector,
  secretsWith,
  seedAccount,
  testPool,
  truncateAll,
} from './helpers';

/**
 * 2차 검토 지적 항목의 회귀 시험. 시험용 일회용 PostgreSQL + 가상 데이터. 외부 연동 성공을 뜻하지 않는다.
 * 모든 비밀값은 테스트 코드 안의 가짜 값이다.
 */

let pool: pg.Pool;
let rawDir: string;
const logs: string[] = [];
const TOKEN = 'FAKE-TOKEN-ABCDEFGHIJ-0001';
const period = { periodFrom: '2026-09-12', periodTo: '2026-09-12' };
const deps = (
  over: { pool?: pg.Pool; rawStore?: RawStore; secrets?: Record<string, string> } = {},
) => ({
  pool: over.pool ?? pool,
  rawStore: over.rawStore ?? new FsRawStore(rawDir),
  secrets: secretsWith(over.secrets ?? { FIN02A_TEST_TOKEN: TOKEN }),
  log: (l: string) => logs.push(l),
});
const items = [
  { key: 'TX-1', data: { date: '2026-09-12', amount: '1000', memo: '입금A' } },
  { key: 'TX-2', data: { date: '2026-09-12', amount: '2000', memo: '출금B' } },
];

beforeAll(() => {
  pool = testPool();
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-rem-'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  logs.length = 0;
});

describe('2. 비밀값 경계', () => {
  it('URL 경로·쿼리·오류·note·응답 본문에 넣은 가짜 키가 DB·파일·로그·결과에 남지 않는다', async () => {
    const acc = await seedAccount(pool);
    const key = 'FAKE-PATH-KEY-1234567890';
    const d = deps({ secrets: { FIN02A_TEST_TOKEN: key } });
    // (a) 요청 시점에 조립한 경로(키 삽입)는 선언된 템플릿 상수와 일치하지 않아 거부 → 원본 미저장, FAILED
    const badPath = await runCollection(
      d,
      new FixtureCollector({ items, endpoint: `GET /api/StatisticSearch/${key}/json` }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(badPath.run.status).toBe('FAILED');
    expect(badPath.run.errorCode).toBe('REQUEST_SUMMARY_INVALID');
    expect(badPath.rawObjectId).toBeNull();
    // (a') 키가 든 문자열을 템플릿 "상수" 로 선언했더라도, 이번 실행에서 읽은 비밀값이 포함되면 거부
    const declaredWithKey = `GET /api/StatisticSearch/${key}/json`;
    const badDeclared = await runCollection(
      d,
      new FixtureCollector({
        items,
        endpoint: declaredWithKey,
        declaredTemplates: [declaredWithKey],
      }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(badDeclared.run.errorCode).toBe('REQUEST_SUMMARY_INVALID');
    // (a'') 쿼리 문자열 형태는 형태 규칙으로 거부(선언했더라도)
    const badQuery = await runCollection(
      d,
      new FixtureCollector({
        items,
        endpoint: 'GET /api/list?authkey={authkey}',
        declaredTemplates: ['GET /api/list?authkey={authkey}'],
      }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(badQuery.run.errorCode).toBe('REQUEST_SUMMARY_INVALID');
    // (b) 외부 예외 메시지에 든 키 → 코드·클래스만 영속화
    const thrown = await runCollection(
      d,
      new FixtureCollector({ items, throwInValidate: `provider said key=${key}` }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(thrown.run.errorCode).toBe('UNHANDLED_VALIDATE');
    expect(thrown.run.errorMessage).toBe('오류 코드 UNHANDLED_VALIDATE');
    // (c) 응답 본문이 사용한 인증값을 반사 → 원본 저장 중단
    const reflected = await runCollection(
      d,
      new FixtureCollector({
        items,
        bytes: new TextEncoder().encode(JSON.stringify({ items, echo: key })),
      }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(reflected.run.status).toBe('FAILED');
    expect(reflected.run.errorCode).toBe('RAW_CONTAINS_CREDENTIAL');
    expect(reflected.rawObjectId).toBeNull();
    // (d) 인증 응답처럼 토큰 필드를 가진 본문 → 원본 저장 중단
    const tokenField = await runCollection(
      d,
      new FixtureCollector({
        items,
        bytes: new TextEncoder().encode(
          JSON.stringify({ data: { access_token: 'x'.repeat(8), items } }),
        ),
      }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(tokenField.run.errorCode).toBe('RAW_TOKEN_FIELD');
    expect(tokenField.rawObjectId).toBeNull();
    // (e) 정상 업무 응답은 바이트 그대로 저장
    const good = await runCollection(d, new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(good.run.status).toBe('SUCCEEDED');
    const dump = await dumpAll(pool);
    expect(dump).not.toContain(key);
    for (const l of logs) expect(l).not.toContain(key);
    for (const out of [badPath, badDeclared, badQuery, thrown, reflected, tokenField, good])
      expect(JSON.stringify(out)).not.toContain(key);
    const store = new FsRawStore(rawDir);
    for (const k of await store.list())
      expect(new TextDecoder().decode(await store.get(k))).not.toContain(key);
  });
});

describe('3. 저장 실패와 미종료 실행', () => {
  it('원본 바이트 저장 실패 → FAILED/RAW_STORE_FAILED, 원본 행 없음, 실행은 종료됨', async () => {
    const acc = await seedAccount(pool);
    const failing: RawStore = {
      put: async () => {
        throw new Error('disk full');
      },
      get: async () => new Uint8Array(),
      list: async () => [],
    };
    const r = await runCollection(deps({ rawStore: failing }), new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(r.finalized).toBe(true);
    expect(r.run.status).toBe('FAILED');
    expect(r.run.errorCode).toBe('RAW_STORE_FAILED');
    expect(r.run.failureKind).toBe('STORAGE');
    expect(r.run.errorClass).toBe('Error');
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_raw_objects')).rows[0].n).toBe(0);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM fin_source_runs WHERE status = 'RUNNING'"))
        .rows[0].n,
    ).toBe(0);
  });

  it('원본 메타데이터 저장 실패 → FAILED/RAW_META_FAILED, 고아 원본이 복구 절차에서 식별된다', async () => {
    const acc = await seedAccount(pool);
    const store = new MemoryRawStore();
    const r = await runCollection(
      deps({ pool: faultyPool(pool, /INSERT INTO fin_raw_objects/), rawStore: store }),
      new FixtureCollector({ items }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(r.run.status).toBe('FAILED');
    expect(r.run.errorCode).toBe('RAW_META_FAILED');
    expect(r.run.failureKind).toBe('STORAGE');
    const orphans = await findOrphanRawKeys(pool, store);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.startsWith(`${r.runId}/`)).toBe(true);
    expect(await findRawRowsMissingBytes(pool, store)).toEqual([]);
  });

  it('관측 트랜잭션 실패 → 롤백, FAILED/OBSERVE_STORE_FAILED, 관측·SUCCEEDED 없음', async () => {
    const acc = await seedAccount(pool);
    const r = await runCollection(
      deps({ pool: faultyPool(pool, /INSERT INTO fin_source_record_versions/) }),
      new FixtureCollector({ items }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(r.run.status).toBe('FAILED');
    expect(r.run.errorCode).toBe('OBSERVE_STORE_FAILED');
    expect(r.rawObjectId).not.toBeNull(); // 원본은 보관
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

  it('종료 기록 실패 → finalized=false 로 반환, RUNNING 잔존이 복구 절차로 마감된다', async () => {
    const acc = await seedAccount(pool);
    const r = await runCollection(
      deps({ pool: faultyPool(pool, /UPDATE fin_source_runs/) }),
      new FixtureCollector({ items, requestFails: true }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(r.finalized).toBe(false);
    expect(r.unrecordedFailure).toEqual({
      originalErrorCode: 'NETWORK',
      finishErrorClass: 'Error',
    });
    expect(
      (await pool.query('SELECT status FROM fin_source_runs WHERE id = $1', [r.runId])).rows[0]
        .status,
    ).toBe('RUNNING');
    // 강제 종료를 흉내낸 실행(시작만 하고 종료 기록 없음)도 같은 절차로 식별
    const killed = await startRun(pool, { sourceAccountId: acc.id, ...period });
    await pool.query(
      "UPDATE fin_source_runs SET started_at = now() - interval '2 hours' WHERE id = ANY($1::uuid[])",
      [[r.runId, killed.id]],
    );
    const stale = await listUnfinishedRuns(pool, 60 * 60 * 1000);
    expect(stale.map((s) => s.id).sort()).toEqual([r.runId, killed.id].sort());
    const fixed = await markUnfinishedRunFailed(pool, killed.id);
    expect(fixed.status).toBe('FAILED');
    expect(fixed.errorCode).toBe('RECOVERY_STALE_RUNNING');
    expect(fixed.failureKind).toBe('STORAGE');
  });
});

describe('4. 대조를 통과한 데이터만 최신 관측', () => {
  it('정상 v1 이 있는 상태에서 변경 응답의 대조가 실패하면 기존 최신 버전이 유지된다', async () => {
    const acc = await seedAccount(pool);
    const first = await runCollection(deps(), new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(first.run.status).toBe('SUCCEEDED');
    const changed = [
      items[0]!,
      { key: 'TX-2', data: { date: '2026-09-12', amount: '2000', memo: '변경됨(대조 실패)' } },
    ];
    const bad = await runCollection(
      deps(),
      new FixtureCollector({ items: changed, reconcileFails: true }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(bad.run.status).toBe('FAILED');
    expect(bad.run.errorCode).toBe('RECONCILE_MISMATCH');
    expect(bad.run.stages.reconcile).toEqual({ outcome: 'FAILED', code: 'RECONCILE_MISMATCH' });
    expect(bad.rawObjectId).not.toBeNull(); // 원본·실행 이력은 보존
    const rec = await pool.query<{ id: string; current_version: number; last_run_id: string }>(
      'SELECT id, current_version, last_run_id FROM fin_source_records WHERE source_key = $1',
      ['TX-2'],
    );
    expect(rec.rows[0]!.current_version).toBe(1);
    expect(rec.rows[0]!.last_run_id).toBe(first.runId);
    const versions = await listVersions(pool, rec.rows[0]!.id);
    expect(versions).toHaveLength(1);
    expect((versions[0]!.payload as { memo: string }).memo).toBe('출금B');
    // 대조 미구현도 관측을 갱신하지 않는다
    const ni = await runCollection(
      deps(),
      new FixtureCollector({ items: changed, reconcileNotImplemented: true }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(ni.run.status).toBe('PARTIAL');
    expect((await listVersions(pool, rec.rows[0]!.id)).length).toBe(1);
    // 성공 실행은 관측 저장과 SUCCEEDED 가 같은 트랜잭션: 실행 SUCCEEDED 이면 관측 연결이 반드시 있다
    const succeededRuns = await pool.query<{ id: string }>(
      "SELECT id FROM fin_source_runs WHERE status = 'SUCCEEDED'",
    );
    for (const s of succeededRuns.rows)
      expect((await traceRun(pool, s.id)).length).toBeGreaterThan(0);
  });
});

describe('5. 실행별 관측 연결', () => {
  it('동일 자료 세 차례 수집 후 업무 버전은 유지되고 세 실행의 연결이 모두 남는다', async () => {
    const acc = await seedAccount(pool);
    const runs = [];
    for (let i = 0; i < 3; i += 1)
      runs.push(
        await runCollection(deps(), new FixtureCollector({ items }), {
          sourceAccountId: acc.id,
          ...period,
        }),
      );
    const rec = await pool.query<{ id: string; current_version: number }>(
      'SELECT id, current_version FROM fin_source_records WHERE source_key = $1',
      ['TX-1'],
    );
    expect(rec.rows[0]!.current_version).toBe(1);
    expect((await listVersions(pool, rec.rows[0]!.id)).length).toBe(1);
    const links = await runsForRecord(pool, rec.rows[0]!.id);
    expect(links.map((l) => l.runId)).toEqual(runs.map((r) => r.runId)); // 첫·중간·마지막 모두
    expect(links.map((l) => l.outcome)).toEqual(['INSERTED', 'UNCHANGED', 'UNCHANGED']);
    expect(new Set(links.map((l) => l.rawObjectId)).size).toBe(3); // 각 실행의 원본
    for (const r of runs) {
      const obs = await traceRun(pool, r.runId);
      expect(obs.map((o) => o.sourceKey).sort()).toEqual(['TX-1', 'TX-2']);
      expect(obs.every((o) => o.rawObjectId === r.rawObjectId)).toBe(true);
    }
  });
});

describe('6. 매핑·연결 무결성', () => {
  it('같은 범위의 유효기간 중복은 거부되고 다른 범위(계정/시스템)는 공존한다', async () => {
    const a = await seedAccount(pool, { alias: 'A' });
    await addExternalMapping(pool, {
      sourceSystem: 'TEST_SYSTEM',
      entityType: 'COUNTERPARTY',
      externalCode: 'CP-1',
      internalId: 'INT-1',
      validFrom: '2026-01-01',
      validTo: '2026-06-30',
    });
    await expect(
      addExternalMapping(pool, {
        sourceSystem: 'TEST_SYSTEM',
        entityType: 'COUNTERPARTY',
        externalCode: 'CP-1',
        internalId: 'INT-2',
        validFrom: '2026-06-30',
      }),
    ).rejects.toThrow(/fin_external_mappings_no_overlap/);
    await expect(
      addExternalMapping(pool, {
        sourceSystem: 'TEST_SYSTEM',
        entityType: 'COUNTERPARTY',
        externalCode: 'CP-1',
        internalId: 'INT-2',
        validFrom: '2026-03-01',
        validTo: '2026-04-01',
      }),
    ).rejects.toThrow(/fin_external_mappings_no_overlap/);
    await addExternalMapping(pool, {
      sourceSystem: 'TEST_SYSTEM',
      entityType: 'COUNTERPARTY',
      externalCode: 'CP-1',
      internalId: 'INT-2',
      validFrom: '2026-07-01',
    }); // 인접 기간은 허용
    await addExternalMapping(pool, {
      sourceSystem: 'TEST_SYSTEM',
      sourceAccountId: a.id,
      entityType: 'COUNTERPARTY',
      externalCode: 'CP-1',
      internalId: 'INT-A',
      validFrom: '2026-01-01',
    }); // 계정 범위 공존
    expect(
      await resolveExternalCode(pool, {
        sourceSystem: 'TEST_SYSTEM',
        sourceAccountId: a.id,
        entityType: 'COUNTERPARTY',
        externalCode: 'CP-1',
        onDate: '2026-03-15',
      }),
    ).toBe('INT-A');
    expect(
      await resolveExternalCode(pool, {
        sourceSystem: 'TEST_SYSTEM',
        sourceAccountId: null,
        entityType: 'COUNTERPARTY',
        externalCode: 'CP-1',
        onDate: '2026-03-15',
      }),
    ).toBe('INT-1');
    expect(
      await resolveExternalCode(pool, {
        sourceSystem: 'TEST_SYSTEM',
        sourceAccountId: null,
        entityType: 'COUNTERPARTY',
        externalCode: 'CP-1',
        onDate: '2026-08-01',
      }),
    ).toBe('INT-2');
  });

  it('매핑의 시스템과 계정의 시스템이 다르면 거부된다', async () => {
    const a = await seedAccount(pool, { system: 'SYS_ONE', alias: 'one' });
    await seedAccount(pool, { system: 'SYS_TWO', alias: 'two', externalId: 'EXT-0002' });
    await expect(
      addExternalMapping(pool, {
        sourceSystem: 'SYS_TWO',
        sourceAccountId: a.id,
        entityType: 'CHANNEL',
        externalCode: 'C-1',
        internalId: 'X',
        validFrom: '2026-01-01',
      }),
    ).rejects.toThrow(/fin_external_mappings_account_system_fk/);
  });

  it('레코드·실행·원본·버전이 서로 다른 계정·실행을 조합하면 거부된다', async () => {
    const a = await seedAccount(pool, { entity: 'TEST_ENTITY_A', alias: 'A' });
    const b = await seedAccount(pool, { entity: 'TEST_ENTITY_B', alias: 'B' });
    const ra = await runCollection(deps(), new FixtureCollector({ items }), {
      sourceAccountId: a.id,
      ...period,
    });
    const rb = await runCollection(deps(), new FixtureCollector({ items }), {
      sourceAccountId: b.id,
      ...period,
    });
    const recA = (
      await pool.query<{ id: string }>(
        'SELECT id FROM fin_source_records WHERE source_account_id = $1 LIMIT 1',
        [a.id],
      )
    ).rows[0]!.id;
    const verA = (
      await pool.query<{ id: string }>(
        'SELECT id FROM fin_source_record_versions WHERE source_record_id = $1',
        [recA],
      )
    ).rows[0]!.id;
    const hash = 'a'.repeat(64);
    // 계정 A 의 레코드를 계정 B 의 실행으로 만들 수 없다
    await expect(
      pool.query(
        'INSERT INTO fin_source_records (source_account_id, source_key, current_payload_hash, first_run_id, last_run_id) VALUES ($1, $2, $3, $4, $4)',
        [a.id, 'X-1', hash, rb.runId],
      ),
    ).rejects.toThrow(/fin_source_records_first_run_account_fk/);
    // 계정 A 의 레코드 버전을 계정 B 의 실행·원본으로 만들 수 없다
    await expect(
      pool.query(
        'INSERT INTO fin_source_record_versions (source_record_id, source_account_id, version, payload_hash, payload, raw_object_id, source_run_id) VALUES ($1, $2, 9, $3, $4, $5, $6)',
        [recA, a.id, hash, '{}', rb.rawObjectId, rb.runId],
      ),
    ).rejects.toThrow(/fin_srv_run_account_fk/);
    // 원본은 자기 실행 소속이어야 한다(실행 A 의 원본을 실행 B 와 조합 불가)
    await expect(
      pool.query(
        'INSERT INTO fin_source_record_versions (source_record_id, source_account_id, version, payload_hash, payload, raw_object_id, source_run_id) VALUES ($1, $2, 9, $3, $4, $5, $6)',
        [recA, a.id, hash, '{}', rb.rawObjectId, ra.runId],
      ),
    ).rejects.toThrow(/fin_srv_raw_run_fk/);
    // 관측 연결도 동일
    await expect(
      pool.query(
        'INSERT INTO fin_source_record_observations (source_run_id, source_account_id, source_record_id, version_id, raw_object_id, outcome) VALUES ($1, $2, $3, $4, $5, $6)',
        [rb.runId, b.id, recA, verA, rb.rawObjectId, 'UNCHANGED'],
      ),
    ).rejects.toThrow(/fin_sro_record_account_fk/);
  });
});

describe('7. 상태 정의', () => {
  it('BLOCKED=자격, PARTIAL=미구현(단계 명시), FAILED=실패, SUCCEEDED=관측 저장 완료. 미식별은 별도 보존', async () => {
    const acc = await seedAccount(pool);
    const cases = [
      { c: new FixtureCollector({ items }), secrets: {}, status: 'BLOCKED', kind: 'CREDENTIALS' },
      {
        c: new FixtureCollector({ items, requestNotImplemented: true }),
        status: 'PARTIAL',
        kind: 'NOT_IMPLEMENTED',
      },
      {
        c: new FixtureCollector({ items, validateNotImplemented: true }),
        status: 'PARTIAL',
        kind: 'NOT_IMPLEMENTED',
      },
      {
        c: new FixtureCollector({ items, requestFails: true }),
        status: 'FAILED',
        kind: 'TRANSIENT',
      },
      { c: new FixtureCollector({ items }), status: 'SUCCEEDED', kind: null },
    ] as const;
    for (const k of cases) {
      const r = await runCollection(deps('secrets' in k ? { secrets: k.secrets } : {}), k.c, {
        sourceAccountId: acc.id,
        ...period,
      });
      expect(r.run.status).toBe(k.status);
      expect(r.run.failureKind).toBe(k.kind);
    }
    const unid = await runCollection(
      deps(),
      new FixtureCollector({ items: [{ key: null, data: { amount: '1' } }] }),
      { sourceAccountId: acc.id, ...period },
    );
    expect(unid.observations?.unidentified).toBe(1);
    const q = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM fin_source_records WHERE source_key IS NULL',
    );
    expect(q.rows[0]!.n).toBe(1); // 미식별 자료는 별도 보존되며 후속 집계에 바로 쓰지 않는다
  });
});

// 저장소 유실 식별(복구 절차 보조)
describe('복구 보조', () => {
  it('메타데이터 행은 있으나 바이트가 없는 원본을 식별한다', async () => {
    const acc = await seedAccount(pool);
    const dir = mkdtempSync(join(tmpdir(), 'fin02a-lost-'));
    const store = new FsRawStore(dir);
    const r = await runCollection(deps({ rawStore: store }), new FixtureCollector({ items }), {
      sourceAccountId: acc.id,
      ...period,
    });
    expect(r.run.status).toBe('SUCCEEDED');
    mkdirSync(join(dir, 'stray'), { recursive: true });
    writeFileSync(join(dir, 'stray', 'orphan.bin'), 'x');
    expect(await findOrphanRawKeys(pool, store)).toEqual(['stray/orphan.bin']);
    const other = new MemoryRawStore();
    expect((await findRawRowsMissingBytes(pool, other)).length).toBe(1);
  });
});
