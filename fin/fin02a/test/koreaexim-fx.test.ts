import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hasAllStages, isSchedulable, runCollection } from '../src/collector/pipeline';
import {
  KOREAEXIM_ENDPOINT,
  KoreaeximFxCollector,
  SPEC_EVIDENCE,
  type FxObservationPayload,
} from '../src/collectors/koreaexim-fx';
import { enqueueCollection } from '../src/queue/queue';
import { CollectorRegistry } from '../src/queue/registry';
import { ensureLegalEntity, ensureSourceSystem, createSourceAccount } from '../src/identity/repo';
import { FsRawStore } from '../src/raw/store';

import { secretsWith, testPool, truncateAll } from './helpers';

/**
 * 한국수출입은행 환율 수집기 — 가상 응답 기반 내부 시험. 공식 샘플이 아닌 "발췌 기준 가상 응답" 으로
 * 요청→파싱→정규화→대조→저장 경로가 파이프라인 규칙대로 동작하는지만 검증한다(검증 모드).
 * 실수집(공식 명세 원문·허용된 네트워크·실제 인증·실응답 파싱·대조)은 미검증이며 이 시험 통과는 실제 연동 성공을 뜻하지 않는다.
 */

const SAMPLE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'samples',
  'koreaexim-ap01-modeled.json',
);
let pool: pg.Pool;
let rawDir: string;
const period = { periodFrom: '2026-09-11', periodTo: '2026-09-11', mode: 'VERIFICATION' as const };

function fetchReturning(status: number, body: unknown, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    return {
      status,
      bytes: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
      contentType: 'application/json',
    };
  };
}

async function fxAccount(): Promise<string> {
  const le = await ensureLegalEntity(pool, 'TEST_ENTITY_A', '시험 법인');
  await ensureSourceSystem(pool, 'FX_KOREAEXIM', 'FX', '한국수출입은행 환율');
  const acc = await createSourceAccount(pool, {
    legalEntityId: le.id,
    sourceSystem: 'FX_KOREAEXIM',
    externalAccountId: 'shared',
    alias: 'FX-KOREAEXIM',
    activeFrom: '2026-01-01',
  });
  return acc.id;
}
const deps = (
  secrets: Record<string, string> = { FIN01_KOREAEXIM_AUTHKEY: 'FAKE-AUTHKEY-NOT-REAL-000001' },
) => ({ pool, rawStore: new FsRawStore(rawDir), secrets: secretsWith(secrets) });

beforeAll(() => {
  pool = testPool();
  rawDir = mkdtempSync(join(tmpdir(), 'fin02a-fx-'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
});

describe('한국수출입은행 환율 수집기(발췌 기준 가상 응답)', () => {
  it('명세 미확인(SNIPPET_ONLY): 다섯 단계가 있어도 정기 실행은 외부 요청 전에 거부되고, 정기 enqueue 도 거부된다', async () => {
    const seen: string[] = [];
    const c = new KoreaeximFxCollector(fetchReturning(200, [], seen));
    expect(c.specStatus).toBe('SNIPPET_ONLY');
    expect(c.specEvidence).toBe(SPEC_EVIDENCE);
    expect(SPEC_EVIDENCE.officialTextReviewed).toBe(false);
    expect(SPEC_EVIDENCE.unverified.length).toBeGreaterThanOrEqual(5);
    expect(hasAllStages(c)).toBe(true); // 구현 완전성
    expect(isSchedulable(c)).toBe(false); // 실제 공급자 적합성 미확인 → 정기 등록 불가
    const acc = await fxAccount();
    const r = await runCollection(deps(), c, {
      sourceAccountId: acc,
      periodFrom: period.periodFrom,
      periodTo: period.periodTo,
      mode: 'SCHEDULED',
    });
    expect([r.run.status, r.run.errorCode, r.run.failureKind]).toEqual([
      'FAILED',
      'SCHEDULED_REQUIRES_CONFIRMED_SPEC',
      'PERMANENT',
    ]);
    expect(seen).toHaveLength(0); // 외부 요청 없음
    expect(Object.values(r.run.stages).every((st) => st?.outcome === 'SKIPPED')).toBe(true);
    // enqueue 게이트: 레지스트리를 주면 정기 모드 등록 자체를 거부한다(DB 작업 없음)
    const registry = new CollectorRegistry().register('koreaexim-fx', c);
    const stubQueue = { add: async () => undefined } as unknown as Parameters<
      typeof enqueueCollection
    >[1];
    expect(
      await enqueueCollection(
        pool,
        stubQueue,
        {
          requestId: 'fx-sched-1',
          sourceAccountId: acc,
          collectorKey: 'koreaexim-fx',
          periodFrom: period.periodFrom,
          periodTo: period.periodTo,
          mode: 'SCHEDULED',
        },
        registry,
      ),
    ).toEqual({ enqueued: false, reason: 'NOT_SCHEDULABLE' });
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_collection_jobs')).rows[0].n).toBe(
      0,
    );
    await pool.query('TRUNCATE fin_collection_jobs CASCADE');
  });

  it('가상 응답 3통화 × 6종류 = 18건 정규화·대조·저장(검증 모드), 인증키는 어디에도 남지 않음', async () => {
    const sample = JSON.parse(readFileSync(SAMPLE, 'utf8')) as {
      _meta: { synthetic: boolean };
      data: unknown;
    };
    expect(sample._meta.synthetic).toBe(true);
    const seen: string[] = [];
    const c = new KoreaeximFxCollector(fetchReturning(200, sample.data, seen));
    const acc = await fxAccount();
    const r = await runCollection(deps(), c, { sourceAccountId: acc, ...period });
    expect(r.run.status).toBe('SUCCEEDED');
    expect(r.run.receivedCount).toBe(18);
    expect(r.run.sourceAsOf).toBeNull(); // 응답에 기준 시각 없음(발췌) → null
    expect(r.observations).toMatchObject({ inserted: 18 });
    expect(seen[0]).toContain('searchdate=20260911&data=AP01');
    const raw = await pool.query<{ request_summary: { endpoint: string } }>(
      'SELECT request_summary FROM fin_raw_objects',
    );
    expect(raw.rows[0]!.request_summary.endpoint).toBe(KOREAEXIM_ENDPOINT.slice(4)); // 템플릿만, 인증키 없음
    const dump = (
      await pool.query("SELECT string_agg(row_to_json(x)::text, ' ') AS t FROM fin_source_runs x")
    ).rows[0].t as string;
    expect(dump).not.toContain('FAKE-AUTHKEY');
    const usd = await pool.query<{ payload: FxObservationPayload }>(
      "SELECT v.payload FROM fin_source_record_versions v JOIN fin_source_records r ON r.id = v.source_record_id WHERE r.source_key = '2026-09-11|USD|DEAL_BAS_R'",
    );
    expect(usd.rows[0]!.payload).toMatchObject({
      source: 'FX_KOREAEXIM',
      currencyUnit: 'USD',
      asOfDate: '2026-09-11',
      asOfDateBasis: 'REQUESTED',
      rateType: 'DEAL_BAS_R',
      value: '1335.1',
      rawValue: '1,335.1',
    });
    const jpy = await pool.query(
      "SELECT count(*)::int AS n FROM fin_source_records WHERE source_key LIKE '2026-09-11|JPY(100)|%'",
    );
    expect(jpy.rows[0].n).toBe(6); // 통화 단위 원문(100 단위 표기) 보존
    // 재수집: 동일 응답이면 버전 증가 없음
    const again = await runCollection(
      deps(),
      new KoreaeximFxCollector(fetchReturning(200, sample.data)),
      { sourceAccountId: acc, ...period },
    );
    expect(again.observations).toMatchObject({ inserted: 0, unchanged: 18, versioned: 0 });
  });

  it('빈 배열(비영업일·게시 전으로 알려짐)은 0건 성공으로 기록하고 전 영업일 값을 대체 저장하지 않는다', async () => {
    const acc = await fxAccount();
    const r = await runCollection(deps(), new KoreaeximFxCollector(fetchReturning(200, [])), {
      sourceAccountId: acc,
      periodFrom: '2026-09-13',
      periodTo: '2026-09-13',
      mode: 'VERIFICATION',
    });
    expect(r.run.status).toBe('SUCCEEDED');
    expect(r.run.receivedCount).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM fin_source_records')).rows[0].n).toBe(
      0,
    );
  });

  it('result 코드: 3 → BLOCKED/CREDENTIALS, 4 → FAILED/PERMANENT(일일 제한), 2 → FAILED/PERMANENT, 자격 없음 → BLOCKED(요청 없음)', async () => {
    const acc = await fxAccount();
    const r3 = await runCollection(
      deps(),
      new KoreaeximFxCollector(fetchReturning(200, [{ result: 3, cur_unit: '' }])),
      { sourceAccountId: acc, ...period },
    );
    expect([r3.run.status, r3.run.errorCode, r3.run.failureKind]).toEqual([
      'FAILED',
      'AUTHKEY_INVALID',
      'CREDENTIALS',
    ]); // 검증 단계 실패는 FAILED, 원인은 CREDENTIALS
    const r4 = await runCollection(
      deps(),
      new KoreaeximFxCollector(fetchReturning(200, [{ result: 4, cur_unit: '' }])),
      { sourceAccountId: acc, ...period },
    );
    expect([r4.run.errorCode, r4.run.failureKind]).toEqual(['DAILY_LIMIT_EXCEEDED', 'PERMANENT']);
    const r2 = await runCollection(
      deps(),
      new KoreaeximFxCollector(fetchReturning(200, [{ result: 2, cur_unit: '' }])),
      { sourceAccountId: acc, ...period },
    );
    expect([r2.run.errorCode, r2.run.failureKind]).toEqual(['DATA_CODE_ERROR', 'PERMANENT']);
    const seen: string[] = [];
    const nocred = await runCollection(
      deps({}),
      new KoreaeximFxCollector(fetchReturning(200, [], seen)),
      { sourceAccountId: acc, ...period },
    );
    expect(nocred.run.status).toBe('BLOCKED');
    expect(seen).toHaveLength(0);
  });

  it('HTTP 5xx/타임아웃 → TRANSIENT, 403 → PERMANENT(프록시 차단·거부), JSON 아님 → PARSE_FAILED 이지만 원본은 보관', async () => {
    const acc = await fxAccount();
    const r503 = await runCollection(
      deps(),
      new KoreaeximFxCollector(fetchReturning(503, 'unavailable')),
      { sourceAccountId: acc, ...period },
    );
    expect([r503.run.errorCode, r503.run.failureKind]).toEqual(['HTTP_503', 'TRANSIENT']);
    const r403 = await runCollection(
      deps(),
      new KoreaeximFxCollector(fetchReturning(403, 'Host not in allowlist')),
      { sourceAccountId: acc, ...period },
    );
    expect([r403.run.errorCode, r403.run.failureKind]).toEqual([
      'EGRESS_OR_FORBIDDEN',
      'PERMANENT',
    ]);
    const timeout = new KoreaeximFxCollector(async () => {
      const e = new Error('t');
      e.name = 'TimeoutError';
      throw e;
    });
    const rt = await runCollection(deps(), timeout, { sourceAccountId: acc, ...period });
    expect([rt.run.errorCode, rt.run.failureKind]).toEqual(['HTTP_TIMEOUT', 'TRANSIENT']);
    const bad = await runCollection(
      deps(),
      new KoreaeximFxCollector(fetchReturning(200, '<html>maintenance</html>')),
      { sourceAccountId: acc, ...period },
    );
    expect(bad.run.errorCode).toBe('PARSE_FAILED');
    expect(bad.rawObjectId).not.toBeNull();
    // 여러 날 범위는 미구현으로 명시(일 단위 API)
    const multi = await runCollection(deps(), new KoreaeximFxCollector(fetchReturning(200, [])), {
      sourceAccountId: acc,
      periodFrom: '2026-09-10',
      periodTo: '2026-09-11',
      mode: 'VERIFICATION',
    });
    expect(multi.run.status).toBe('PARTIAL');
    expect(multi.run.stages.request).toEqual({
      outcome: 'NOT_IMPLEMENTED',
      code: 'MULTI_DAY_RANGE_NOT_IMPLEMENTED',
    });
  });
});
