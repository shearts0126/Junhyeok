import pg from 'pg';

import type {
  Collector,
  CollectorContext,
  RawResponse,
  StageResult,
  ValidatedResponse,
} from '../src/collector/types';
import { failed, notImplemented, ok } from '../src/collector/types';
import {
  createSourceAccount,
  ensureLegalEntity,
  ensureSourceSystem,
  type SourceAccount,
} from '../src/identity/repo';
import type { ObservationInput } from '../src/records/observe';

export function testPool(): pg.Pool {
  const url = process.env['FIN02A_TEST_DATABASE_URL'];
  if (!url) throw new Error('global-setup 이 FIN02A_TEST_DATABASE_URL 을 설정하지 않았다');
  return new pg.Pool({ connectionString: url, max: 4 });
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    'TRUNCATE fin_source_record_versions, fin_source_records, fin_raw_objects, fin_source_runs, fin_external_mappings, fin_source_accounts, fin_source_systems, fin_legal_entities RESTART IDENTITY CASCADE',
  );
}

/** 시험 전용 식별 정보(실제 계좌·판매자 계정 아님). */
export async function seedAccount(
  pool: pg.Pool,
  opts: { entity?: string; system?: string; externalId?: string; alias?: string } = {},
): Promise<SourceAccount> {
  const entityCode = opts.entity ?? 'TEST_ENTITY_A';
  const system = opts.system ?? 'TEST_SYSTEM';
  const le = await ensureLegalEntity(pool, entityCode, `시험 법인 ${entityCode}`);
  await ensureSourceSystem(pool, system, 'BANK', '시험 원천');
  return createSourceAccount(pool, {
    legalEntityId: le.id,
    sourceSystem: system,
    externalAccountId: opts.externalId ?? 'EXT-0001',
    alias: opts.alias ?? `${entityCode}-${system}-${opts.externalId ?? 'EXT-0001'}`,
    activeFrom: '2026-01-01',
  });
}

export interface FixtureItem {
  key: string | null;
  data: Record<string, unknown>;
}

export interface FixtureOptions {
  items: FixtureItem[];
  sourceAsOf?: Date | null;
  bytes?: Uint8Array;
  requestFails?: boolean;
  authFails?: boolean;
  validateNotImplemented?: boolean;
  normalizeNotImplemented?: boolean;
  reconcileNotImplemented?: boolean;
  /** 시험용 가짜 비밀값을 요청 헤더·URL 에 넣어 저장 데이터·로그 누출 여부를 검사한다 */
  leakSecret?: string;
}

/** 시험용 수집기. 실제 공급자 응답을 흉내내지 않으며 내부 규칙 검증에만 쓴다. */
export class FixtureCollector implements Collector<{ token: string }, FixtureItem[]> {
  readonly sourceSystem: string;
  constructor(
    private readonly opt: FixtureOptions,
    sourceSystem = 'TEST_SYSTEM',
  ) {
    this.sourceSystem = sourceSystem;
  }

  async authenticate(): Promise<StageResult<{ token: string }>> {
    if (this.opt.authFails) return failed('NO_CREDENTIALS', 'FIN02A_TEST_TOKEN 미설정');
    return ok({ token: this.opt.leakSecret ?? 'test-token' });
  }

  async request(
    _ctx: CollectorContext,
    auth: { token: string },
  ): Promise<StageResult<RawResponse>> {
    if (this.opt.requestFails)
      return failed('NETWORK', `fetch failed: connect ECONNREFUSED (token=${auth.token})`);
    const bytes =
      this.opt.bytes ?? new TextEncoder().encode(JSON.stringify({ items: this.opt.items }));
    return ok({
      bytes,
      contentType: 'application/json',
      request: {
        method: 'GET',
        url: `https://example.invalid/api/list?from=2026-09-12&access_token=${auth.token}`,
        headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' },
      },
      sourceAsOf: this.opt.sourceAsOf ?? null,
    });
  }

  async validate(
    _ctx: CollectorContext,
    raw: RawResponse,
  ): Promise<StageResult<ValidatedResponse<FixtureItem[]>>> {
    if (this.opt.validateNotImplemented) return notImplemented('응답 검증 미구현(시험)');
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw.bytes)) as { items?: unknown };
      if (!Array.isArray(parsed.items)) return failed('PARSE_FAILED', '응답에 items 배열 없음');
      return ok({ parsed: parsed.items as FixtureItem[], receivedCount: parsed.items.length });
    } catch (e) {
      return failed('PARSE_FAILED', e instanceof Error ? e.message : String(e));
    }
  }

  async normalize(
    _ctx: CollectorContext,
    v: ValidatedResponse<FixtureItem[]>,
  ): Promise<StageResult<ObservationInput[]>> {
    if (this.opt.normalizeNotImplemented) return notImplemented('정규화 미구현(시험)');
    return ok(v.parsed.map((i) => ({ sourceKey: i.key, payload: i.data })));
  }

  async reconcile(
    _ctx: CollectorContext,
    v: ValidatedResponse<FixtureItem[]>,
    obs: ObservationInput[],
  ): Promise<StageResult<{ rawCount: number | null; normalizedCount: number; detail: string }>> {
    if (this.opt.reconcileNotImplemented) return notImplemented('대조 미구현(시험)');
    if (v.receivedCount !== obs.length)
      return failed('RECONCILE_MISMATCH', `원본 ${v.receivedCount} ≠ 정규화 ${obs.length}`);
    return ok({
      rawCount: v.receivedCount,
      normalizedCount: obs.length,
      detail: `건수 일치 ${obs.length}`,
    });
  }
}

/** 시험용 DB 의 모든 fin_ 테이블 내용을 문자열로 덤프(비밀값 누출 검사용). */
export async function dumpAll(pool: pg.Pool): Promise<string> {
  const tables = [
    'fin_legal_entities',
    'fin_source_systems',
    'fin_source_accounts',
    'fin_external_mappings',
    'fin_source_runs',
    'fin_raw_objects',
    'fin_source_records',
    'fin_source_record_versions',
  ];
  const parts: string[] = [];
  for (const t of tables) {
    const r = await pool.query(`SELECT row_to_json(x)::text AS j FROM ${t} x`);
    parts.push(...r.rows.map((row: { j: string }) => row.j));
  }
  return parts.join('\n');
}
