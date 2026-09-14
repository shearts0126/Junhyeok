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
    'TRUNCATE fin_source_record_observations, fin_source_record_versions, fin_source_records, fin_raw_objects, fin_source_runs, fin_external_mappings, fin_source_accounts, fin_source_systems, fin_legal_entities RESTART IDENTITY CASCADE',
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
  /** 응답 바이트를 직접 지정(파싱 실패·반사 시험용) */
  bytes?: Uint8Array;
  contentType?: string;
  endpoint?: string;
  /** 수집기가 선언하는 템플릿 상수 목록(기본: 'GET /api/list/{date}') */
  declaredTemplates?: string[];
  requestFails?: boolean;
  requestNotImplemented?: boolean;
  validateNotImplemented?: boolean;
  normalizeNotImplemented?: boolean;
  reconcileNotImplemented?: boolean;
  /** 대조를 강제로 실패시킨다(변경 응답이 대조를 통과하지 못한 상황) */
  reconcileFails?: boolean;
  /** 자유 문자열 예외를 던진다(외부 예외 메시지가 영속화되지 않는지 시험) */
  throwInValidate?: string;
}

/** 시험용 비밀값 제공자. 값은 테스트 코드 안의 가짜 값이다. */
export const secretsWith = (map: Record<string, string>) => ({ get: (n: string) => map[n] });

/** 시험용 수집기. 실제 공급자 응답을 흉내내지 않으며 내부 규칙 검증에만 쓴다. 토큰은 ctx.secrets 에서만 읽는다. */
export class FixtureCollector implements Collector<{ token: string }, FixtureItem[]> {
  readonly sourceSystem: string;
  readonly endpointTemplates: readonly string[];
  constructor(
    private readonly opt: FixtureOptions,
    sourceSystem = 'TEST_SYSTEM',
  ) {
    this.sourceSystem = sourceSystem;
    this.endpointTemplates = opt.declaredTemplates ?? ['GET /api/list/{date}'];
  }

  async authenticate(ctx: CollectorContext): Promise<StageResult<{ token: string }>> {
    const token = ctx.secrets.get('FIN02A_TEST_TOKEN');
    if (!token) return failed('NO_CREDENTIALS', 'CREDENTIALS');
    return ok({ token });
  }

  async request(
    _ctx: CollectorContext,
    _auth: { token: string },
  ): Promise<StageResult<RawResponse>> {
    if (this.opt.requestNotImplemented) return notImplemented('REQUEST_NOT_IMPLEMENTED');
    if (this.opt.requestFails) return failed('NETWORK', 'TRANSIENT');
    const bytes =
      this.opt.bytes ?? new TextEncoder().encode(JSON.stringify({ items: this.opt.items }));
    return ok({
      bytes,
      contentType: this.opt.contentType ?? 'application/json',
      endpoint: this.opt.endpoint ?? 'GET /api/list/{date}',
      sourceAsOf: this.opt.sourceAsOf ?? null,
    });
  }

  async validate(
    _ctx: CollectorContext,
    raw: RawResponse,
  ): Promise<StageResult<ValidatedResponse<FixtureItem[]>>> {
    if (this.opt.throwInValidate) throw new Error(this.opt.throwInValidate);
    if (this.opt.validateNotImplemented) return notImplemented('VALIDATE_NOT_IMPLEMENTED');
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw.bytes)) as { items?: unknown };
      if (!Array.isArray(parsed.items)) return failed('PARSE_FAILED', 'PERMANENT');
      return ok({ parsed: parsed.items as FixtureItem[], receivedCount: parsed.items.length });
    } catch {
      return failed('PARSE_FAILED', 'PERMANENT');
    }
  }

  async normalize(
    _ctx: CollectorContext,
    v: ValidatedResponse<FixtureItem[]>,
  ): Promise<StageResult<ObservationInput[]>> {
    if (this.opt.normalizeNotImplemented) return notImplemented('NORMALIZE_NOT_IMPLEMENTED');
    return ok(v.parsed.map((i) => ({ sourceKey: i.key, payload: i.data })));
  }

  async reconcile(
    _ctx: CollectorContext,
    v: ValidatedResponse<FixtureItem[]>,
    obs: ObservationInput[],
  ): Promise<StageResult<{ rawCount: number | null; normalizedCount: number }>> {
    if (this.opt.reconcileNotImplemented) return notImplemented('RECONCILE_NOT_IMPLEMENTED');
    if (this.opt.reconcileFails || v.receivedCount !== obs.length)
      return failed('RECONCILE_MISMATCH', 'PERMANENT');
    return ok({ rawCount: v.receivedCount, normalizedCount: obs.length });
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
    'fin_source_record_observations',
  ];
  const parts: string[] = [];
  for (const t of tables) {
    const r = await pool.query(`SELECT row_to_json(x)::text AS j FROM ${t} x`);
    parts.push(...r.rows.map((row: { j: string }) => row.j));
  }
  return parts.join('\n');
}

/**
 * DB 장애 주입: SQL 이 패턴에 맞으면 예외를 던지는 풀 래퍼. pool.query 와 pool.connect() 로 얻은 클라이언트 둘 다 감싼다.
 * 실제 pg.Pool 을 대체하는 시험용 객체이며 필요한 메서드만 구현한다.
 */
export function faultyPool(pool: pg.Pool, failOn: RegExp): pg.Pool {
  const wrapQuery =
    (target: { query: (...a: unknown[]) => unknown }) =>
    (...args: unknown[]): unknown => {
      const text =
        typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
      if (failOn.test(text))
        return Promise.reject(new Error(`injected db failure: ${text.slice(0, 40)}`));
      return target.query(...args);
    };
  const proxy = {
    query: wrapQuery(pool as unknown as { query: (...a: unknown[]) => unknown }),
    connect: async () => {
      const client = await pool.connect();
      const q = wrapQuery(client as unknown as { query: (...a: unknown[]) => unknown });
      return new Proxy(client, { get: (t, p, r) => (p === 'query' ? q : Reflect.get(t, p, r)) });
    },
    end: () => pool.end(),
  };
  return proxy as unknown as pg.Pool;
}
