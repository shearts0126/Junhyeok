/**
 * 환율: 한국수출입은행 Open API / 한국은행 ECOS / 서울외국환중개(웹 공표).
 *
 * 확인일 2026-09-14. 세 출처 호스트 모두 본 환경에서 차단. 검색 발췌로 확인한 것:
 * - 수출입은행: oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=&searchdate=YYYYMMDD&data=AP01,
 *   응답 cur_unit/ttb/tts/deal_bas_r 등, 영업일 11시경 갱신, 일 1,000회 제한, 인증키 2년 미사용 파기,
 *   구 도메인 병행 종료 2026-04-30.
 * - ECOS: 통계표 731Y001 항목 0000001(원/미국달러 매매기준율), 인증키 무료, 약 1,000회/일.
 * - 서울외국환중개: 매매기준율(시장평균환율) 영업일 08:30경 공표, API 여부 미확인.
 */

import { type SourceSpec } from '../mapping';
import { check, type CheckResult } from '../reconcile';
import { loadSample } from '../samples';
import { addDays, isWeekend } from '../time';
import type { FxRate } from '../types';

const D = '2026-09-14';

export const eximSpec: SourceSpec = {
  sourceSystem: 'FX_KOREAEXIM',
  displayName: '한국수출입은행 환율 Open API',
  docs: [
    {
      url: 'https://www.koreaexim.go.kr/ir/HPHKIR020M01?apino=2&viewtype=C',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://www.data.go.kr/data/3068846/openapi.do',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
  ],
  sourceTz: 'Asia/Seoul',
  keyFields: ['searchdate', 'cur_unit'],
  mappings: [
    {
      target: 'currency',
      source: 'cur_unit',
      transform: 'identity',
      status: 'SNIPPET',
      note: '"USD". 일부 통화는 100 단위(JPY(100) 등) 표기 → 정규화 필요',
    },
    {
      target: 'asOfDate',
      source: 'searchdate(요청)',
      transform: 'yyyymmdd_to_iso_date',
      status: 'SNIPPET',
      note: '응답에 기준일이 없을 수 있어 요청일을 보존',
    },
    {
      target: 'rate',
      source: 'deal_bas_r',
      transform: 'decimal',
      status: 'SNIPPET',
      note: '매매기준율. 천 단위 콤마 포함 문자열 → 제거 후 십진수',
    },
    {
      target: 'rateType',
      transform: 'constant',
      constant: 'KOREAEXIM_DEAL_BAS_R',
      status: 'CONFIRMED',
      note: 'ttb/tts 는 별도 종류',
    },
    {
      target: '휴일 처리',
      transform: 'derived',
      status: 'SNIPPET',
      note: '비영업일 조회 시 빈 결과(제3자 사례). 이전 영업일 환율 대체 + 적용일 표시',
    },
    {
      target: '호출 제한 / 인증',
      transform: 'derived',
      status: 'SNIPPET',
      note: '일 1,000회, authkey 발급 즉시, 2년 미사용 파기',
    },
  ],
};

export const ecosSpec: SourceSpec = {
  sourceSystem: 'FX_ECOS',
  displayName: '한국은행 ECOS Open API(731Y001)',
  docs: [{ url: 'https://ecos.bok.or.kr/api/', checkedOn: D, access: 'SEARCH_SNIPPET' }],
  sourceTz: 'Asia/Seoul',
  keyFields: ['STAT_CODE', 'ITEM_CODE1', 'TIME'],
  mappings: [
    {
      target: 'currency',
      source: 'ITEM_CODE1=0000001',
      transform: 'constant',
      constant: 'USD',
      status: 'SNIPPET',
      note: '원/미국달러(매매기준율). 항목 코드 원문 확인 필요',
    },
    {
      target: 'asOfDate',
      source: 'TIME(YYYYMMDD)',
      transform: 'yyyymmdd_to_iso_date',
      status: 'SNIPPET',
      note: '',
    },
    {
      target: 'rate',
      source: 'DATA_VALUE',
      transform: 'decimal',
      status: 'ASSUMED',
      note: '필드명 원문 확인 필요',
    },
    {
      target: 'rateType',
      transform: 'constant',
      constant: 'ECOS_731Y001_0000001',
      status: 'CONFIRMED',
      note: '',
    },
    {
      target: '호출 제한 / 인증',
      transform: 'derived',
      status: 'SNIPPET',
      note: '무료 인증키, 약 1,000회/일',
    },
  ],
};

interface FxSample {
  exim: {
    searchdate: string;
    rows: { cur_unit: string; deal_bas_r: string; ttb: string; tts: string }[];
  }[];
}

/** 보고일 환율: 보고일 자료가 없으면 최근 이용 가능한 이전 영업일 환율을 쓰고 적용일을 표시. 없으면 오류(0 대체 금지). */
export function pickRateForDate(
  rates: readonly FxRate[],
  reportDate: string,
  maxLookbackDays = 7,
): FxRate {
  let d = reportDate;
  for (let i = 0; i <= maxLookbackDays; i += 1) {
    const hit = rates.find((r) => r.asOfDate === d);
    if (hit) return { ...hit, appliedForDate: reportDate };
    d = addDays(d, -1);
  }
  throw new Error(`환율 없음: ${reportDate} 기준 ${maxLookbackDays}일 내 자료 없음(0 대체 금지)`);
}

export function runFixtureChecks(): CheckResult[] {
  const { data } = loadSample<FxSample>('fx-placeholder.json');
  const now = new Date().toISOString();
  const rates: FxRate[] = [];
  for (const day of data.exim) {
    for (const r of day.rows) {
      if (r.cur_unit !== 'USD') continue;
      rates.push({
        currency: 'USD',
        asOfDate: `${day.searchdate.slice(0, 4)}-${day.searchdate.slice(4, 6)}-${day.searchdate.slice(6, 8)}`,
        rateType: 'KOREAEXIM_DEAL_BAS_R',
        rate: r.deal_bas_r.replace(/,/g, ''),
        source: 'FX_KOREAEXIM',
        collectedAtUtc: now,
      });
    }
  }
  const sat = '2026-09-12';
  const picked = pickRateForDate(rates, sat);
  let missingErr = '';
  try {
    pickRateForDate(rates, '2026-08-01', 3);
  } catch (e) {
    missingErr = e instanceof Error ? e.message : String(e);
  }
  const emptyDay = data.exim.find((d) => d.rows.length === 0);
  return [
    check(
      'FX-01',
      '콤마 포함 문자열 → 십진수 문자열(부동소수점 미사용)',
      rates.every((r) => /^\d+(\.\d+)?$/.test(r.rate)),
      rates.map((r) => `${r.asOfDate}:${r.rate}`).join(', '),
    ),
    check(
      'FX-02',
      '비영업일(토요일) 응답이 비어 있으면 이전 영업일 환율 적용 + 적용일 표시',
      isWeekend(sat) &&
        emptyDay !== undefined &&
        picked.asOfDate === '2026-09-11' &&
        picked.appliedForDate === sat,
      `${sat} → ${picked.asOfDate} ${picked.rate}`,
    ),
    check(
      'FX-03',
      '환율이 없으면 0 으로 대체하지 않고 오류',
      missingErr.includes('0 대체 금지'),
      missingErr,
    ),
    check(
      'FX-04',
      '실제 호출 미실행(인증키·네트워크 없음) → 실제 수집 미검증',
      true,
      `${eximSpec.sourceSystem}, ${ecosSpec.sourceSystem}`,
    ),
  ];
}
