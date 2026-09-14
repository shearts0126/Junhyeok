/**
 * 실제 호출 시도(자격·네트워크가 있을 때만). 본 환경에서는 전 출처가 자격 없음 또는 네트워크 차단이다.
 * 요청 형식은 검색 발췌로 확인한 공식 명세를 따르되, 원문 미열람 항목은 주석으로 표시한다.
 */

import { createHmac } from 'node:crypto';

import {
  blockedNoCredentials,
  fetchSummary,
  requireEnv,
  type ImplementationLevel,
  type LiveResult,
} from './http';

export type LiveSource =
  'fx-exim' | 'fx-ecos' | 'bank-kftc' | 'ads-meta' | 'ads-tiktok' | 'ads-naver' | 'sales-cafe24';

/** 소스별 구현 수준(요청 구성 근거). 어떤 소스도 응답 파싱·대조(PARSE_AND_RECONCILE)는 구현하지 않았다. */
export const LIVE_IMPLEMENTATION: Record<LiveSource, ImplementationLevel> = {
  'fx-exim': 'REQUEST_BUILT_SPEC_SNIPPET', // 경로·파라미터·data=AP01 은 공식 페이지 발췌
  'fx-ecos': 'REQUEST_BUILT_SPEC_ASSUMED', // StatisticSearch 경로 구조는 추정
  'bank-kftc': 'REQUEST_BUILT_SPEC_ASSUMED', // 경로·파라미터명 일부 추정
  'ads-meta': 'REQUEST_BUILT_SPEC_SNIPPET', // fields/time_increment 발췌. 그래프 API 버전은 추정
  'ads-tiktok': 'REQUEST_BUILT_SPEC_ASSUMED', // 경로 발췌, 파라미터 값 추정
  'ads-naver': 'REQUEST_BUILT_SPEC_ASSUMED', // 서명 문자열 형식 추정
  'sales-cafe24': 'REQUEST_BUILT_SPEC_ASSUMED', // orders 경로·파라미터 추정, 헤더는 발췌
};

/** 결과·로그에 남기는 안전한 엔드포인트 템플릿. 실제 URL(인증키 포함)은 기록하지 않는다. */
export const LIVE_ENDPOINT_TEMPLATE: Record<LiveSource, string> = {
  'fx-exim':
    'GET oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey={authkey}&searchdate={date}&data=AP01',
  'fx-ecos':
    'GET ecos.bok.or.kr/api/StatisticSearch/{authkey}/json/kr/1/100/731Y001/D/{date}/{date}/0000001',
  'bank-kftc':
    'GET {kftc_base}/v2.0/account/transaction_list/fin_num?fintech_use_num={fintech_use_num}&from_date={date}&to_date={date}',
  'ads-meta':
    'GET graph.facebook.com/v21.0/{ad_account_id}/insights?time_increment=1&time_range={date}&access_token={access_token}',
  'ads-tiktok':
    'GET business-api.tiktok.com/open_api/v1.3/report/integrated/get/?advertiser_id={advertiser_id}&start_date={date}&end_date={date}',
  'ads-naver': 'GET api.searchad.naver.com/billing/bizmoney',
  'sales-cafe24':
    'GET {mall_id}.cafe24api.com/api/v2/admin/orders?start_date={date}&end_date={date}&limit=100',
};

export const LIVE_SOURCES: LiveSource[] = [
  'fx-exim',
  'fx-ecos',
  'bank-kftc',
  'ads-meta',
  'ads-tiktok',
  'ads-naver',
  'sales-cafe24',
];

function yyyymmdd(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

export async function runLive(source: LiveSource, targetDate: string): Promise<LiveResult> {
  switch (source) {
    case 'fx-exim': {
      const r = requireEnv(['FIN01_KOREAEXIM_AUTHKEY']);
      if (!r.ok)
        return blockedNoCredentials(
          source,
          r.missing,
          LIVE_IMPLEMENTATION[source],
          LIVE_ENDPOINT_TEMPLATE[source],
        );
      // 신규 도메인(oapi.koreaexim.go.kr). data=AP01 환율. 검색 발췌 기준.
      const url = `https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=${encodeURIComponent(r.env['FIN01_KOREAEXIM_AUTHKEY'] ?? '')}&searchdate=${yyyymmdd(targetDate)}&data=AP01`;
      return fetchSummary(source, url, LIVE_IMPLEMENTATION[source], LIVE_ENDPOINT_TEMPLATE[source]);
    }
    case 'fx-ecos': {
      const r = requireEnv(['FIN01_ECOS_API_KEY']);
      if (!r.ok)
        return blockedNoCredentials(
          source,
          r.missing,
          LIVE_IMPLEMENTATION[source],
          LIVE_ENDPOINT_TEMPLATE[source],
        );
      // StatisticSearch/{key}/json/kr/1/100/731Y001/D/{from}/{to}/0000001 — 경로 구조는 원문 확인 필요(ASSUMED).
      // 인증키가 URL 경로에 들어가므로 실제 URL 은 절대 기록하지 않는다(LIVE_ENDPOINT_TEMPLATE 만 남김).
      const d = yyyymmdd(targetDate);
      const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(r.env['FIN01_ECOS_API_KEY'] ?? '')}/json/kr/1/100/731Y001/D/${d}/${d}/0000001`;
      return fetchSummary(source, url, LIVE_IMPLEMENTATION[source], LIVE_ENDPOINT_TEMPLATE[source]);
    }
    case 'bank-kftc': {
      const r = requireEnv([
        'FIN01_KFTC_ACCESS_TOKEN',
        'FIN01_KFTC_FINTECH_USE_NUM',
        'FIN01_KFTC_BASE_URL',
      ]);
      if (!r.ok)
        return blockedNoCredentials(
          source,
          r.missing,
          LIVE_IMPLEMENTATION[source],
          LIVE_ENDPOINT_TEMPLATE[source],
        );
      // GET /v2.0/account/transaction_list/fin_num — 파라미터 이름은 검색 발췌 기준, 원문 확인 필요
      const q = new URLSearchParams({
        bank_tran_id: `FIN01${Date.now().toString().slice(-9)}`,
        fintech_use_num: r.env['FIN01_KFTC_FINTECH_USE_NUM'] ?? '',
        inquiry_type: 'A',
        inquiry_base: 'D',
        from_date: yyyymmdd(targetDate),
        to_date: yyyymmdd(targetDate),
        sort_order: 'D',
        tran_dtime: new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, '')
          .slice(0, 14),
      });
      const url = `${r.env['FIN01_KFTC_BASE_URL']}/v2.0/account/transaction_list/fin_num?${q.toString()}`;
      return fetchSummary(
        source,
        url,
        LIVE_IMPLEMENTATION[source],
        LIVE_ENDPOINT_TEMPLATE[source],
        {
          headers: { Authorization: `Bearer ${r.env['FIN01_KFTC_ACCESS_TOKEN']}` },
        },
      );
    }
    case 'ads-meta': {
      const r = requireEnv(['FIN01_META_ACCESS_TOKEN', 'FIN01_META_AD_ACCOUNT_ID']);
      if (!r.ok)
        return blockedNoCredentials(
          source,
          r.missing,
          LIVE_IMPLEMENTATION[source],
          LIVE_ENDPOINT_TEMPLATE[source],
        );
      const q = new URLSearchParams({
        fields: 'account_id,account_currency,date_start,date_stop,spend',
        level: 'account',
        time_increment: '1',
        time_range: JSON.stringify({ since: targetDate, until: targetDate }),
        access_token: r.env['FIN01_META_ACCESS_TOKEN'] ?? '',
      });
      const url = `https://graph.facebook.com/v21.0/${r.env['FIN01_META_AD_ACCOUNT_ID']}/insights?${q.toString()}`;
      return fetchSummary(source, url, LIVE_IMPLEMENTATION[source], LIVE_ENDPOINT_TEMPLATE[source]);
    }
    case 'ads-tiktok': {
      const r = requireEnv(['FIN01_TIKTOK_ACCESS_TOKEN', 'FIN01_TIKTOK_ADVERTISER_ID']);
      if (!r.ok)
        return blockedNoCredentials(
          source,
          r.missing,
          LIVE_IMPLEMENTATION[source],
          LIVE_ENDPOINT_TEMPLATE[source],
        );
      const q = new URLSearchParams({
        advertiser_id: r.env['FIN01_TIKTOK_ADVERTISER_ID'] ?? '',
        report_type: 'BASIC',
        data_level: 'AUCTION_ADVERTISER',
        dimensions: JSON.stringify(['advertiser_id', 'stat_time_day']),
        metrics: JSON.stringify(['spend']),
        start_date: targetDate,
        end_date: targetDate,
      });
      const url = `https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?${q.toString()}`;
      return fetchSummary(
        source,
        url,
        LIVE_IMPLEMENTATION[source],
        LIVE_ENDPOINT_TEMPLATE[source],
        {
          headers: { 'Access-Token': r.env['FIN01_TIKTOK_ACCESS_TOKEN'] ?? '' },
        },
      );
    }
    case 'ads-naver': {
      const r = requireEnv([
        'FIN01_NAVER_API_KEY',
        'FIN01_NAVER_SECRET_KEY',
        'FIN01_NAVER_CUSTOMER_ID',
      ]);
      if (!r.ok)
        return blockedNoCredentials(
          source,
          r.missing,
          LIVE_IMPLEMENTATION[source],
          LIVE_ENDPOINT_TEMPLATE[source],
        );
      // 서명: HMAC-SHA256(timestamp + "." + method + "." + path), base64 — 검색 발췌 기준, 원문 확인 필요
      const path = '/billing/bizmoney';
      const ts = String(Date.now());
      const sig = createHmac('sha256', r.env['FIN01_NAVER_SECRET_KEY'] ?? '')
        .update(`${ts}.GET.${path}`)
        .digest('base64');
      return fetchSummary(
        source,
        `https://api.searchad.naver.com${path}`,
        LIVE_IMPLEMENTATION[source],
        LIVE_ENDPOINT_TEMPLATE[source],
        {
          headers: {
            'X-Timestamp': ts,
            'X-API-KEY': r.env['FIN01_NAVER_API_KEY'] ?? '',
            'X-Customer': r.env['FIN01_NAVER_CUSTOMER_ID'] ?? '',
            'X-Signature': sig,
          },
        },
      );
    }
    case 'sales-cafe24': {
      const r = requireEnv(['FIN01_CAFE24_MALL_ID', 'FIN01_CAFE24_ACCESS_TOKEN']);
      if (!r.ok)
        return blockedNoCredentials(
          source,
          r.missing,
          LIVE_IMPLEMENTATION[source],
          LIVE_ENDPOINT_TEMPLATE[source],
        );
      const q = new URLSearchParams({ start_date: targetDate, end_date: targetDate, limit: '100' });
      const url = `https://${r.env['FIN01_CAFE24_MALL_ID']}.cafe24api.com/api/v2/admin/orders?${q.toString()}`;
      return fetchSummary(
        source,
        url,
        LIVE_IMPLEMENTATION[source],
        LIVE_ENDPOINT_TEMPLATE[source],
        {
          headers: {
            Authorization: `Bearer ${r.env['FIN01_CAFE24_ACCESS_TOKEN']}`,
            'Content-Type': 'application/json',
            'X-Cafe24-Api-Version': '2025-06-01',
          },
        },
      );
    }
    default: {
      const never: never = source;
      throw new Error(`알 수 없는 소스: ${String(never)}`);
    }
  }
}
