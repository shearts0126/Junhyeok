/**
 * 실제 호출 시도(자격·네트워크가 있을 때만). 본 환경에서는 전 출처가 자격 없음 또는 네트워크 차단이다.
 * 요청 형식은 검색 발췌로 확인한 공식 명세를 따르되, 원문 미열람 항목은 주석으로 표시한다.
 */

import { createHmac } from 'node:crypto';

import { blockedNoCredentials, fetchSummary, requireEnv, type LiveResult } from './http';

export type LiveSource =
  'fx-exim' | 'fx-ecos' | 'bank-kftc' | 'ads-meta' | 'ads-tiktok' | 'ads-naver' | 'sales-cafe24';

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
      if (!r.ok) return blockedNoCredentials(source, r.missing);
      // 신규 도메인(oapi.koreaexim.go.kr). data=AP01 환율. 검색 발췌 기준.
      const url = `https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=${encodeURIComponent(r.env['FIN01_KOREAEXIM_AUTHKEY'] ?? '')}&searchdate=${yyyymmdd(targetDate)}&data=AP01`;
      return fetchSummary(source, url, { redactQuery: true });
    }
    case 'fx-ecos': {
      const r = requireEnv(['FIN01_ECOS_API_KEY']);
      if (!r.ok) return blockedNoCredentials(source, r.missing);
      // StatisticSearch/{key}/json/kr/1/100/731Y001/D/{from}/{to}/0000001 — 경로 구조는 원문 확인 필요(ASSUMED)
      const d = yyyymmdd(targetDate);
      const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(r.env['FIN01_ECOS_API_KEY'] ?? '')}/json/kr/1/100/731Y001/D/${d}/${d}/0000001`;
      return fetchSummary(source, url, { redactQuery: true });
    }
    case 'bank-kftc': {
      const r = requireEnv([
        'FIN01_KFTC_ACCESS_TOKEN',
        'FIN01_KFTC_FINTECH_USE_NUM',
        'FIN01_KFTC_BASE_URL',
      ]);
      if (!r.ok) return blockedNoCredentials(source, r.missing);
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
      return fetchSummary(source, url, {
        headers: { Authorization: `Bearer ${r.env['FIN01_KFTC_ACCESS_TOKEN']}` },
        redactQuery: true,
      });
    }
    case 'ads-meta': {
      const r = requireEnv(['FIN01_META_ACCESS_TOKEN', 'FIN01_META_AD_ACCOUNT_ID']);
      if (!r.ok) return blockedNoCredentials(source, r.missing);
      const q = new URLSearchParams({
        fields: 'account_id,account_currency,date_start,date_stop,spend',
        level: 'account',
        time_increment: '1',
        time_range: JSON.stringify({ since: targetDate, until: targetDate }),
        access_token: r.env['FIN01_META_ACCESS_TOKEN'] ?? '',
      });
      const url = `https://graph.facebook.com/v21.0/${r.env['FIN01_META_AD_ACCOUNT_ID']}/insights?${q.toString()}`;
      return fetchSummary(source, url, { redactQuery: true });
    }
    case 'ads-tiktok': {
      const r = requireEnv(['FIN01_TIKTOK_ACCESS_TOKEN', 'FIN01_TIKTOK_ADVERTISER_ID']);
      if (!r.ok) return blockedNoCredentials(source, r.missing);
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
      return fetchSummary(source, url, {
        headers: { 'Access-Token': r.env['FIN01_TIKTOK_ACCESS_TOKEN'] ?? '' },
        redactQuery: true,
      });
    }
    case 'ads-naver': {
      const r = requireEnv([
        'FIN01_NAVER_API_KEY',
        'FIN01_NAVER_SECRET_KEY',
        'FIN01_NAVER_CUSTOMER_ID',
      ]);
      if (!r.ok) return blockedNoCredentials(source, r.missing);
      // 서명: HMAC-SHA256(timestamp + "." + method + "." + path), base64 — 검색 발췌 기준, 원문 확인 필요
      const path = '/billing/bizmoney';
      const ts = String(Date.now());
      const sig = createHmac('sha256', r.env['FIN01_NAVER_SECRET_KEY'] ?? '')
        .update(`${ts}.GET.${path}`)
        .digest('base64');
      return fetchSummary(source, `https://api.searchad.naver.com${path}`, {
        headers: {
          'X-Timestamp': ts,
          'X-API-KEY': r.env['FIN01_NAVER_API_KEY'] ?? '',
          'X-Customer': r.env['FIN01_NAVER_CUSTOMER_ID'] ?? '',
          'X-Signature': sig,
        },
      });
    }
    case 'sales-cafe24': {
      const r = requireEnv(['FIN01_CAFE24_MALL_ID', 'FIN01_CAFE24_ACCESS_TOKEN']);
      if (!r.ok) return blockedNoCredentials(source, r.missing);
      const q = new URLSearchParams({ start_date: targetDate, end_date: targetDate, limit: '100' });
      const url = `https://${r.env['FIN01_CAFE24_MALL_ID']}.cafe24api.com/api/v2/admin/orders?${q.toString()}`;
      return fetchSummary(source, url, {
        headers: {
          Authorization: `Bearer ${r.env['FIN01_CAFE24_ACCESS_TOKEN']}`,
          'Content-Type': 'application/json',
          'X-Cafe24-Api-Version': '2025-06-01',
        },
        redactQuery: true,
      });
    }
    default: {
      const never: never = source;
      throw new Error(`알 수 없는 소스: ${String(never)}`);
    }
  }
}
