/**
 * 광고 5개 경로: 메타·구글·네이버·쿠팡·틱톡.
 *
 * 공통 검증 규칙(계획서 §5 ad_daily_spend): (계정, 일자) 단위 재수집은 대체(누적 합산 금지),
 * 원천 계정 시간대와 통화를 보존, 세금 기준을 UNKNOWN 으로 두되 확정 표시하지 않음.
 */

import { eq, fromMicros, sum } from '../decimal';
import { type SourceSpec } from '../mapping';
import { check, reconcile, type CheckResult } from '../reconcile';
import { loadSample } from '../samples';
import type { AdBalance, AdDailySpend, LegalEntity } from '../types';

const D = '2026-09-14';

export const metaSpec: SourceSpec = {
  sourceSystem: 'ADS_META',
  displayName: '메타 Marketing API Insights',
  docs: [
    {
      url: 'https://developers.facebook.com/docs/marketing-api/insights/',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://developers.facebook.com/docs/marketing-api/insights/best-practices/',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
  ],
  sourceTz: '광고 계정 시간대(계정 설정값)',
  keyFields: ['account_id', 'date_start'],
  mappings: [
    {
      target: 'adAccountAlias',
      source: 'account_id (act_{id})',
      transform: 'identity',
      status: 'SNIPPET',
      note: '',
    },
    {
      target: 'date',
      source: 'date_start (= date_stop, time_increment=1)',
      transform: 'identity',
      status: 'SNIPPET',
      note: '계정 시간대 일자. KST 로 이동하지 않음',
    },
    {
      target: 'spend',
      source: 'spend',
      transform: 'decimal',
      status: 'SNIPPET',
      note: '문자열 소수',
    },
    {
      target: 'currency',
      source: 'account_currency',
      transform: 'identity',
      status: 'SNIPPET',
      note: '',
    },
    {
      target: 'taxBasis',
      transform: 'derived',
      status: 'ASSUMED',
      note: '소진액에 VAT 포함 여부는 계정 국가·과세 설정에 따름. 미확인 → UNKNOWN',
    },
    {
      target: '과거 수정 반영',
      transform: 'derived',
      status: 'SNIPPET',
      note: '기여 창 마감으로 최대 28일 소급 갱신(제3자 요약). 최근 7일 재조회 + 주간 28일 재점검 필요',
    },
    {
      target: '조회 가능 기간',
      transform: 'derived',
      status: 'SNIPPET',
      note: '집계 지표 37개월, 일부 breakdown 13개월 등 제한(제3자 요약, 공식 원문 확인 필요)',
    },
    {
      target: '인증',
      transform: 'derived',
      status: 'SNIPPET',
      note: 'System User 토큰(Business Manager) 권장. 앱 접근 등급(Marketing API Access Tier)과 비즈니스 인증 필요',
    },
    {
      target: 'AdBalance',
      transform: 'derived',
      status: 'UNVERIFIED',
      note: '선불 잔액 조회 API 존재 여부를 확인하지 못함(광고 계정 balance 필드의 의미도 미확인)',
    },
  ],
};

export const googleSpec: SourceSpec = {
  sourceSystem: 'ADS_GOOGLE',
  displayName: '구글 Ads API(GAQL)',
  docs: [
    {
      url: 'https://developers.google.com/google-ads/api/docs/get-started/onboarding',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://ads-developers.googleblog.com/2026/02/an-update-on-google-ads-api-developer.html',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://ads-developers.googleblog.com/2026/07/passkey-authentication-requirement-for.html',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
  ],
  sourceTz: 'customer.time_zone',
  keyFields: ['customer.id', 'segments.date'],
  mappings: [
    {
      target: 'adAccountAlias',
      source: 'customer.id',
      transform: 'identity',
      status: 'SNIPPET',
      note: '',
    },
    {
      target: 'date',
      source: 'segments.date',
      transform: 'identity',
      status: 'SNIPPET',
      note: '계정 시간대 일자',
    },
    {
      target: 'spend',
      source: 'metrics.cost_micros',
      transform: 'micros_to_decimal',
      status: 'SNIPPET',
      note: '÷1,000,000. 십진수 변환',
    },
    {
      target: 'currency',
      source: 'customer.currency_code',
      transform: 'identity',
      status: 'SNIPPET',
      note: '',
    },
    {
      target: 'sourceTz',
      source: 'customer.time_zone',
      transform: 'identity',
      status: 'SNIPPET',
      note: '',
    },
    {
      target: 'taxBasis',
      transform: 'derived',
      status: 'ASSUMED',
      note: '한국 계정 VAT 별도 청구 여부 미확인 → UNKNOWN',
    },
    {
      target: '인증',
      transform: 'derived',
      status: 'SNIPPET',
      note: '2026-09-09 개발자 토큰 폐지, 접근 등급이 Google Cloud 프로젝트에 귀속(공식 블로그 발췌). 2026-08-05부터 신규 refresh token 발급에 패스키 필요',
    },
    {
      target: 'AdBalance',
      transform: 'derived',
      status: 'UNVERIFIED',
      note: '선불 잔액 조회 경로를 확인하지 못함',
    },
  ],
};

export const naverSpec: SourceSpec = {
  sourceSystem: 'ADS_NAVER',
  displayName: '네이버 검색광고 API(Stats / Bizmoney)',
  docs: [
    { url: 'https://naver.github.io/searchad-apidoc/', checkedOn: D, access: 'BLOCKED' },
    { url: 'https://github.com/naver/searchad-apidoc', checkedOn: D, access: 'SEARCH_SNIPPET' },
    {
      url: 'http://naver.github.io/searchad-apidoc/notice/2021/03/09/notice1/',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
  ],
  sourceTz: 'Asia/Seoul',
  keyFields: ['customerId', 'dateStart'],
  mappings: [
    {
      target: 'adAccountAlias',
      source: 'X-Customer(customerId)',
      transform: 'identity',
      status: 'SNIPPET',
      note: '',
    },
    {
      target: 'date',
      source: 'timeRange + timeIncrement=1 (Stats) / statDt (StatReport)',
      transform: 'identity',
      status: 'SNIPPET',
      note: '',
    },
    {
      target: 'spend',
      source: 'salesAmt',
      transform: 'decimal',
      status: 'SNIPPET',
      note: '광고비. VAT 포함 여부 미확인',
    },
    { target: 'currency', transform: 'constant', constant: 'KRW', status: 'CONFIRMED', note: '' },
    {
      target: 'taxBasis',
      transform: 'derived',
      status: 'ASSUMED',
      note: '비즈머니 차감액과 보고서 광고비의 VAT 관계 미확인',
    },
    {
      target: 'AdBalance',
      source: 'GET /billing/bizmoney (get, get(period))',
      transform: 'decimal',
      status: 'SNIPPET',
      note: '비즈머니 잔액 조회 존재(GitHub 이슈로 확인). 응답 필드명 원문 확인 필요',
    },
    {
      target: '조회 제한',
      transform: 'derived',
      status: 'SNIPPET',
      note: 'StatReport timeRange 최대 92일(제3자 요약)',
    },
    {
      target: '인증',
      transform: 'derived',
      status: 'SNIPPET',
      note: '액세스라이선스·비밀키·X-Customer, X-Timestamp, X-Signature(HMAC). 광고플랫폼 > 도구 > API 사용관리에서 발급',
    },
  ],
};

export const coupangSpec: SourceSpec = {
  sourceSystem: 'ADS_COUPANG',
  displayName: '쿠팡 광고(Coupang Ads) 소진액',
  docs: [
    { url: 'https://ads.coupang.com/AaaAna.html', checkedOn: D, access: 'SEARCH_SNIPPET' },
    { url: 'https://developers.coupang.com/ko/api', checkedOn: D, access: 'SEARCH_SNIPPET' },
  ],
  sourceTz: 'Asia/Seoul',
  keyFields: ['adAccountAlias', 'date'],
  mappings: [
    {
      target: 'spend (일별 광고비)',
      transform: 'derived',
      status: 'UNVERIFIED',
      note: '판매자용 공식 광고 소진액 API 존재 여부를 확인하지 못함("미지원" 아님). 광고센터 보고서(일별/월별 광고비 정산 리포트) 엑셀 다운로드는 발췌로 확인 → 쿠팡 광고 담당 문의 전까지 보조 경로(엑셀) 후보',
    },
    { target: 'AdBalance', transform: 'derived', status: 'MISSING', note: '잔액 조회 경로 미확인' },
    {
      target: '갱신 지연',
      transform: 'derived',
      status: 'SNIPPET',
      note: '전일 데이터 익일 12:30 이후(애드팝콘 CPS 일별 리포트 안내, 판매자 광고와 동일 여부 미확인) → 10시 전 전일 확정 불가 가능성',
    },
  ],
};

export const tiktokSpec: SourceSpec = {
  sourceSystem: 'ADS_TIKTOK',
  displayName: '틱톡 Marketing API(report/integrated/get, advertiser/balance/get)',
  docs: [
    { url: 'https://business-api.tiktok.com/portal/docs', checkedOn: D, access: 'BLOCKED' },
    {
      url: 'https://github.com/tiktok/tiktok-business-api-sdk',
      checkedOn: D,
      access: 'SEARCH_SNIPPET',
    },
  ],
  sourceTz: '광고 계정 시간대(advertiser/info)',
  keyFields: ['advertiser_id', 'stat_time_day'],
  mappings: [
    {
      target: 'adAccountAlias',
      source: 'advertiser_id',
      transform: 'identity',
      status: 'SNIPPET',
      note: '',
    },
    {
      target: 'date',
      source: 'dimensions.stat_time_day',
      transform: 'identity',
      status: 'SNIPPET',
      note: 'data_level=AUCTION_ADVERTISER, 일별 분해 시 1회 최대 30일(제3자 요약)',
    },
    { target: 'spend', source: 'metrics.spend', transform: 'decimal', status: 'SNIPPET', note: '' },
    {
      target: 'currency / sourceTz',
      source: 'advertiser/info currency, timezone',
      transform: 'identity',
      status: 'ASSUMED',
      note: '필드명 원문 확인 필요',
    },
    {
      target: 'AdBalance',
      source: 'advertiser/balance/get',
      transform: 'decimal',
      status: 'SNIPPET',
      note: '엔드포인트 존재 확인(SDK 문서). 응답 필드명·선불/후불 구분 미확인',
    },
    { target: 'taxBasis', transform: 'derived', status: 'ASSUMED', note: '미확인' },
    {
      target: '인증·갱신',
      transform: 'derived',
      status: 'ASSUMED',
      note: 'Marketing API 장기 access token 만료 정책 미확인(검색 결과의 24h/1년은 크리에이터 API 기준)',
    },
  ],
};

export const specs = [metaSpec, googleSpec, naverSpec, coupangSpec, tiktokSpec];

interface AdsSample {
  legalEntity: LegalEntity;
  meta: {
    account_id: string;
    account_currency: string;
    timezone: string;
    rows: { date_start: string; date_stop: string; spend: string }[];
    revisedRows: { date_start: string; date_stop: string; spend: string }[];
  };
  google: {
    customerId: string;
    currency_code: string;
    time_zone: string;
    rows: { date: string; cost_micros: string }[];
  };
  naver: {
    customerId: string;
    rows: { statDt: string; salesAmt: string }[];
    bizmoney: { balance: string; observedAtUtc: string };
  };
  tiktok: {
    advertiser_id: string;
    currency: string;
    timezone: string;
    rows: { stat_time_day: string; spend: string }[];
    requestedDays: number;
  };
}

class SpendStore {
  private readonly map = new Map<string, AdDailySpend>();
  upsert(rec: AdDailySpend): void {
    this.map.set(`${rec.platform}|${rec.adAccountAlias}|${rec.date}`, rec);
  }
  total(platform: AdDailySpend['platform']): string {
    return sum([...this.map.values()].filter((r) => r.platform === platform).map((r) => r.spend));
  }
  count(platform: AdDailySpend['platform']): number {
    return [...this.map.values()].filter((r) => r.platform === platform).length;
  }
}

export function runFixtureChecks(): CheckResult[] {
  const { data } = loadSample<AdsSample>('ads-placeholder.json');
  const store = new SpendStore();
  const results: CheckResult[] = [];

  // META: 일별 대체(재수집 시 누적 합산 금지), 계정 시간대 보존
  for (const r of data.meta.rows) {
    store.upsert({
      legalEntity: data.legalEntity,
      platform: 'META',
      adAccountAlias: data.meta.account_id,
      date: r.date_start,
      sourceTz: data.meta.timezone,
      currency: data.meta.account_currency,
      spend: r.spend,
      taxBasis: 'UNKNOWN',
      sourceVersion: 'run-1',
    });
  }
  const metaFirst = store.total('META');
  for (const r of data.meta.revisedRows) {
    store.upsert({
      legalEntity: data.legalEntity,
      platform: 'META',
      adAccountAlias: data.meta.account_id,
      date: r.date_start,
      sourceTz: data.meta.timezone,
      currency: data.meta.account_currency,
      spend: r.spend,
      taxBasis: 'UNKNOWN',
      sourceVersion: 'run-2',
    });
  }
  const metaRevisedExpected = sum(data.meta.revisedRows.map((r) => r.spend));
  results.push(
    check(
      'ADS-META-01',
      '(계정,일자) 재수집은 대체. 소급 수정 후 합계 = 최신 응답 합계(누적 합산 금지)',
      eq(store.total('META'), metaRevisedExpected) && !eq(metaFirst, store.total('META')),
      `1차 ${metaFirst} → 재수집 ${store.total('META')} (최신 응답 ${metaRevisedExpected})`,
    ),
  );
  results.push(
    check(
      'ADS-META-02',
      '계정 시간대(America/Los_Angeles) 일자를 KST 로 이동하지 않고 sourceTz 보존',
      data.meta.timezone !== 'Asia/Seoul' && store.count('META') === data.meta.rows.length,
      `tz=${data.meta.timezone}, rows=${store.count('META')}`,
    ),
  );

  // GOOGLE: micros → 십진수
  const gRaw = data.google.rows.map((r) => fromMicros(r.cost_micros));
  for (const r of data.google.rows) {
    store.upsert({
      legalEntity: data.legalEntity,
      platform: 'GOOGLE',
      adAccountAlias: data.google.customerId,
      date: r.date,
      sourceTz: data.google.time_zone,
      currency: data.google.currency_code,
      spend: fromMicros(r.cost_micros),
      taxBasis: 'UNKNOWN',
      sourceVersion: 'run-1',
    });
  }
  const gRec = reconcile('google', gRaw, gRaw);
  results.push(
    check(
      'ADS-GOOG-01',
      'cost_micros ÷ 1e6 십진수 변환(부동소수점 미사용) 및 합계 대조',
      gRec.amountMatch && eq(store.total('GOOGLE'), gRec.rawAmount),
      `합계 ${store.total('GOOGLE')} ${data.google.currency_code}`,
    ),
  );

  // NAVER: 소진액과 비즈머니 잔액 분리
  for (const r of data.naver.rows) {
    store.upsert({
      legalEntity: data.legalEntity,
      platform: 'NAVER',
      adAccountAlias: data.naver.customerId,
      date: r.statDt,
      sourceTz: 'Asia/Seoul',
      currency: 'KRW',
      spend: r.salesAmt,
      taxBasis: 'UNKNOWN',
      sourceVersion: 'run-1',
    });
  }
  const naverBalance: AdBalance = {
    legalEntity: data.legalEntity,
    platform: 'NAVER',
    adAccountAlias: data.naver.customerId,
    observedAtUtc: data.naver.bizmoney.observedAtUtc,
    currency: 'KRW',
    balance: data.naver.bizmoney.balance,
    balanceKind: 'PREPAID_REMAINING',
  };
  results.push(
    check(
      'ADS-NAVER-01',
      '소진액(salesAmt)과 비즈머니 잔액을 별도 레코드로 보존(잔액을 비용으로 쓰지 않음)',
      store.count('NAVER') === data.naver.rows.length &&
        naverBalance.balanceKind === 'PREPAID_REMAINING',
      `소진 ${store.total('NAVER')} / 잔액 ${naverBalance.balance}`,
    ),
  );

  // TIKTOK: 30일 창 초과 요청 감지
  results.push(
    check(
      'ADS-TT-01',
      '일별 분해 조회 30일 제한(제3자 요약) 초과 요청은 분할해야 함',
      data.tiktok.requestedDays > 30,
      `요청 ${data.tiktok.requestedDays}일 → ${Math.ceil(data.tiktok.requestedDays / 30)}회 분할 필요`,
    ),
  );
  for (const r of data.tiktok.rows) {
    store.upsert({
      legalEntity: data.legalEntity,
      platform: 'TIKTOK',
      adAccountAlias: data.tiktok.advertiser_id,
      date: r.stat_time_day.slice(0, 10),
      sourceTz: data.tiktok.timezone,
      currency: data.tiktok.currency,
      spend: r.spend,
      taxBasis: 'UNKNOWN',
      sourceVersion: 'run-1',
    });
  }
  results.push(
    check(
      'ADS-TT-02',
      'stat_time_day → date, 통화·시간대 보존',
      store.count('TIKTOK') === data.tiktok.rows.length,
      `rows=${store.count('TIKTOK')} ${data.tiktok.currency} ${data.tiktok.timezone}`,
    ),
  );

  // COUPANG: 자동 경로 미확인
  results.push(
    check(
      'ADS-CPNG-01',
      '쿠팡 광고 소진액 공식 API 존재 여부 확인하지 못함(미지원 단정 아님) → 미확인. 자동 수집 가능으로 표시하지 않음',
      coupangSpec.mappings.some((m) => m.status === 'UNVERIFIED'),
      '광고센터 리포트 엑셀 다운로드만 확인',
    ),
  );

  results.push(
    check(
      'ADS-ALL-01',
      '광고 5개 경로 모두 실제 호출 미실행(자격·네트워크 없음) → 실제 수집 미검증',
      true,
      specs.map((s) => s.sourceSystem).join(', '),
    ),
  );
  return results;
}
