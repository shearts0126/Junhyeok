import type {
  CollectorContext,
  RawResponse,
  StageResult,
  ValidatedResponse,
} from '../collector/types';
import { failed, notImplemented, ok } from '../collector/types';
import type { ObservationInput } from '../records/observe';

/**
 * 한국수출입은행 환율 Open API 수집기 (FIN-01 첫 외부 연동 대상).
 *
 * 근거 수준(확인일 2026-09-14): 공식 페이지 https://www.koreaexim.go.kr/ir/HPHKIR020M01?apino=2&viewtype=C 와
 * 공공데이터포털 https://www.data.go.kr/data/3068846/openapi.do 의 **검색 발췌**로만 확인(원문 열람은 본 환경에서 차단).
 * 발췌로 확인한 것: 요청 URL oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=&searchdate=YYYYMMDD&data=AP01,
 * 응답 배열 원소 필드 result / cur_unit / cur_nm / ttb / tts / deal_bas_r / bkpr / yy_efee_r / ten_dd_efee_r / kftc_deal_bas_r / kftc_bkpr,
 * result 코드 1 성공·2 DATA 코드 오류·3 인증코드 오류·4 일일제한(1,000회) 초과, 영업일 11시경 갱신, 구 도메인 병행 종료 2026-04-30.
 * 확인하지 못한 것(추정 구현 금지 → 아래 처리): 비영업일·11시 이전 응답 형태(빈 배열로 알려졌으나 원문 미확인 → 빈 배열은 "0건" 으로만
 * 기록하고 전 영업일 값을 대체 저장하지 않음), 응답에 기준일 필드가 있는지(없다고 가정하지 않고 요청 searchdate 를 기준일로 보존하되
 * 필드 확인 전까지 asOfDateBasis='REQUESTED' 로 표시), 통화 단위(JPY(100) 등 100 단위 표기 규칙 원문 미확인 → cur_unit 원문 보존).
 *
 * 환율은 통화·기준일·환율 종류·값·출처로 구분해 저장한다. 대시보드에서 쓸 최종 환율 종류 선택과 은행 현금 환산 연결은 이 범위에 없다.
 * 이 수집기는 다섯 단계를 모두 구현하므로 정기 실행 등록이 가능하지만, 실제 호출은 인증키·허용된 네트워크가 있을 때만 성공한다.
 */

export const KOREAEXIM_SOURCE_SYSTEM = 'FX_KOREAEXIM';
export const KOREAEXIM_ENDPOINT = 'GET /site/program/financial/exchangeJSON/{searchdate}/AP01';
export const KOREAEXIM_BASE_URL =
  'https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON';

/** 발췌로 확인한 응답 원소 필드(전부 문자열). 확인되지 않은 필드는 정의하지 않는다. */
export interface KoreaeximRow {
  result: number | string;
  cur_unit: string;
  cur_nm?: string;
  ttb?: string;
  tts?: string;
  deal_bas_r?: string;
  bkpr?: string;
  yy_efee_r?: string;
  ten_dd_efee_r?: string;
  kftc_deal_bas_r?: string;
  kftc_bkpr?: string;
}

export type RateType = 'DEAL_BAS_R' | 'TTB' | 'TTS' | 'BKPR' | 'KFTC_DEAL_BAS_R' | 'KFTC_BKPR';
const RATE_FIELDS: { field: keyof KoreaeximRow; type: RateType }[] = [
  { field: 'deal_bas_r', type: 'DEAL_BAS_R' },
  { field: 'ttb', type: 'TTB' },
  { field: 'tts', type: 'TTS' },
  { field: 'bkpr', type: 'BKPR' },
  { field: 'kftc_deal_bas_r', type: 'KFTC_DEAL_BAS_R' },
  { field: 'kftc_bkpr', type: 'KFTC_BKPR' },
];

/** 정규화 결과 payload(공급자 원본 구조 보존 + 구분 키). 표준 fx_rates 로의 변환은 후속 범위. */
export interface FxObservationPayload {
  source: typeof KOREAEXIM_SOURCE_SYSTEM;
  currencyUnit: string; // cur_unit 원문(예: 'USD', 'JPY(100)')
  currencyName?: string;
  asOfDate: string; // YYYY-MM-DD
  asOfDateBasis: 'REQUESTED'; // 응답 기준일 필드 미확인 → 요청 searchdate
  rateType: RateType;
  value: string; // 콤마 제거 십진수 문자열. 부동소수점 변환 없음
  rawValue: string; // 원문 그대로
}

export interface KoreaeximFetch {
  (url: string): Promise<{ status: number; bytes: Uint8Array; contentType: string }>;
}

const defaultFetch: KoreaeximFetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  return {
    status: res.status,
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/json',
  };
};

export class KoreaeximFxCollector {
  readonly sourceSystem = KOREAEXIM_SOURCE_SYSTEM;
  readonly endpointTemplates = [KOREAEXIM_ENDPOINT] as const;
  readonly implementedStages = [
    'authenticate',
    'request',
    'validate',
    'normalize',
    'reconcile',
  ] as const;
  constructor(private readonly fetchImpl: KoreaeximFetch = defaultFetch) {}

  /** 인증키는 환경변수(FIN01_KOREAEXIM_AUTHKEY)에서만 읽는다. 값은 요청 URL 에만 쓰이고 저장·로그되지 않는다. */
  async authenticate(ctx: CollectorContext): Promise<StageResult<{ authkey: string }>> {
    const key = ctx.secrets.get('FIN01_KOREAEXIM_AUTHKEY');
    if (!key) return failed('NO_CREDENTIALS', 'CREDENTIALS');
    return ok({ authkey: key });
  }

  async request(
    ctx: CollectorContext,
    auth: { authkey: string },
  ): Promise<StageResult<RawResponse>> {
    if (ctx.run.periodFrom !== ctx.run.periodTo)
      return notImplemented('MULTI_DAY_RANGE_NOT_IMPLEMENTED'); // 일 단위 API. 여러 날은 작업을 나눈다
    const searchdate = ctx.run.periodFrom.replace(/-/g, '');
    const url = `${KOREAEXIM_BASE_URL}?authkey=${encodeURIComponent(auth.authkey)}&searchdate=${searchdate}&data=AP01`;
    let res: { status: number; bytes: Uint8Array; contentType: string };
    try {
      res = await this.fetchImpl(url);
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      return failed(name === 'TimeoutError' ? 'HTTP_TIMEOUT' : 'NETWORK', 'TRANSIENT');
    }
    if (res.status === 403) return failed('EGRESS_OR_FORBIDDEN', 'PERMANENT'); // 프록시 차단 또는 거부. 자동 재시도 대상 아님
    if (res.status === 429 || res.status >= 500) return failed(`HTTP_${res.status}`, 'TRANSIENT');
    if (res.status !== 200) return failed(`HTTP_${res.status}`, 'PERMANENT');
    // 응답에는 기준일이 없다고 발췌됨. 원천 기준 시각은 미제공 → null (요청일은 정규화 단계에서 asOfDate 로 보존).
    return ok({
      bytes: res.bytes,
      contentType: res.contentType,
      endpoint: KOREAEXIM_ENDPOINT,
      sourceAsOf: null,
    });
  }

  async validate(
    _ctx: CollectorContext,
    raw: RawResponse,
  ): Promise<StageResult<ValidatedResponse<KoreaeximRow[]>>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw.bytes));
    } catch {
      return failed('PARSE_FAILED', 'PERMANENT');
    }
    if (!Array.isArray(parsed)) return failed('PARSE_FAILED', 'PERMANENT');
    if (parsed.length === 0) return ok({ parsed: [], receivedCount: 0 }); // 비영업일·게시 전으로 알려진 빈 배열. 실제 0건으로 기록
    const rows = parsed as KoreaeximRow[];
    const first = rows[0];
    const code = first ? Number(first.result) : NaN;
    if (code === 3) return failed('AUTHKEY_INVALID', 'CREDENTIALS'); // 발췌: 인증코드 오류. 자격 문제로만 분류
    if (code === 4) return failed('DAILY_LIMIT_EXCEEDED', 'PERMANENT'); // 발췌: 일일 1,000회 초과. 오늘은 재시도 무의미
    if (code === 2) return failed('DATA_CODE_ERROR', 'PERMANENT');
    if (code !== 1) return failed('UNKNOWN_RESULT_CODE', 'UNKNOWN');
    for (const r of rows) {
      if (typeof r.cur_unit !== 'string' || r.cur_unit.length === 0)
        return failed('PARSE_FAILED', 'PERMANENT');
    }
    return ok({ parsed: rows, receivedCount: rows.length });
  }

  async normalize(
    ctx: CollectorContext,
    v: ValidatedResponse<KoreaeximRow[]>,
  ): Promise<StageResult<ObservationInput[]>> {
    const asOfDate = ctx.run.periodFrom;
    const out: ObservationInput[] = [];
    for (const row of v.parsed) {
      for (const { field, type } of RATE_FIELDS) {
        const rawValue = row[field];
        if (typeof rawValue !== 'string' || rawValue.trim() === '') continue; // 제공되지 않은 종류는 만들지 않는다(0 대체 금지)
        const value = rawValue.replace(/,/g, '').trim();
        if (!/^-?\d+(\.\d+)?$/.test(value)) return failed('VALUE_FORMAT', 'PERMANENT');
        const payload: FxObservationPayload = {
          source: KOREAEXIM_SOURCE_SYSTEM,
          currencyUnit: row.cur_unit,
          asOfDate,
          asOfDateBasis: 'REQUESTED',
          rateType: type,
          value,
          rawValue,
          ...(row.cur_nm ? { currencyName: row.cur_nm } : {}),
        };
        out.push({ sourceKey: `${asOfDate}|${row.cur_unit}|${type}`, payload });
      }
    }
    return ok(out);
  }

  /** 원본 대조: 통화 행 수 × 제공된 환율 종류 수 = 정규화 건수. 통화 행 수는 원본 건수와 같아야 한다. */
  async reconcile(
    _ctx: CollectorContext,
    v: ValidatedResponse<KoreaeximRow[]>,
    obs: ObservationInput[],
  ): Promise<StageResult<{ rawCount: number | null; normalizedCount: number }>> {
    let expected = 0;
    const units = new Set<string>();
    for (const row of v.parsed) {
      units.add(row.cur_unit);
      for (const { field } of RATE_FIELDS)
        if (typeof row[field] === 'string' && (row[field] as string).trim() !== '') expected += 1;
    }
    if (units.size !== v.parsed.length) return failed('RECONCILE_MISMATCH', 'PERMANENT'); // 통화 중복 행
    if (expected !== obs.length) return failed('RECONCILE_MISMATCH', 'PERMANENT');
    return ok({ rawCount: v.receivedCount, normalizedCount: obs.length });
  }
}
