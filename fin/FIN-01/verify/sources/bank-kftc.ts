/**
 * 은행 후보 1: 금융결제원 오픈뱅킹 거래내역조회·잔액조회 API.
 *
 * 확인일 2026-09-14. 공식 문서 호스트(developers.kftc.or.kr, openapi.kftc.or.kr)는 본 환경에서
 * 열람이 차단되어 검색 결과 발췌로만 필드명을 확인했다(SNIPPET). 실제 호출은 미검증.
 */

import { neg, sum } from '../decimal';
import { SourceRecordStore } from '../dedupe';
import { buildSourceKey, coverage, type SourceSpec } from '../mapping';
import { check, reconcile, type CheckResult } from '../reconcile';
import { loadSample } from '../samples';
import { localToUtc, yyyymmddHhmmssToLocal, yyyymmddToIso } from '../time';
import type { BankBalance, BankTransaction, LegalEntity } from '../types';

export const spec: SourceSpec = {
  sourceSystem: 'BANK_KFTC_OPENBANKING',
  displayName: '금융결제원 오픈뱅킹(거래내역조회·잔액조회)',
  docs: [
    {
      url: 'https://developers.kftc.or.kr/dev/openapi/open-banking/transaction',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://developers.kftc.or.kr/dev/openapi/open-banking/balance',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
    { url: 'https://openapi.kftc.or.kr/', checkedOn: '2026-09-14', access: 'BLOCKED' },
  ],
  sourceTz: 'Asia/Seoul',
  // 거래 단위 ID 를 제공하지 않으므로(bank_tran_id 는 API 호출 단위) 대체 식별을 사용한다.
  keyFields: ['tran_date', 'tran_time', 'inout_type', 'tran_amt', 'after_balance_amt', '_seq'],
  mappings: [
    {
      target: 'legalEntity / accountAlias / currency',
      source: 'fintech_use_num',
      transform: 'derived',
      status: 'SNIPPET',
      note: '핀테크이용번호 → external_mappings 로 법인·은행·계좌·통화 매핑. 통화는 응답에 없어 계좌 등록 정보로 확정해야 함',
    },
    {
      target: 'sourceKey',
      transform: 'derived',
      status: 'MISSING',
      note: '거래별 고유 ID 없음. (핀테크이용번호, tran_date, tran_time, inout_type, tran_amt, after_balance_amt, 페이지 내 순번) 대체키. 같은 날짜·금액의 정상 거래 2건은 after_balance_amt 와 순번으로 구분',
    },
    {
      target: 'occurredAtLocal',
      source: 'res_list[].tran_date + tran_time',
      transform: 'yyyymmdd_hhmmss_to_local_datetime',
      status: 'SNIPPET',
      note: 'YYYYMMDD + HHmmss, Asia/Seoul',
    },
    {
      target: 'direction',
      source: 'res_list[].inout_type',
      transform: 'inout_to_direction',
      status: 'SNIPPET',
      note: '"입금"→IN, "출금"→OUT. 값 목록은 원문 확인 필요',
    },
    {
      target: 'amount',
      source: 'res_list[].tran_amt',
      transform: 'decimal',
      status: 'SNIPPET',
      note: '문자열 정수(원). 소수 없음',
    },
    {
      target: 'balanceAfter',
      source: 'res_list[].after_balance_amt',
      transform: 'decimal',
      status: 'SNIPPET',
      note: '거래 후 잔액. 기준일 잔액은 당일 마지막 거래의 값 또는 잔액조회 API 로 확정',
    },
    {
      target: 'description',
      source: 'res_list[].print_content',
      transform: 'identity',
      status: 'SNIPPET',
      note: '통장인자내용. 검색 발췌에서 printed_content 로도 표기됨 → 원문에서 정확한 키 확인 필요',
    },
    {
      target: 'BankBalance.balance',
      source: 'balance_amt',
      transform: 'decimal',
      status: 'SNIPPET',
      note: '조회 시점 잔액(AT_INQUIRY). 전일 마감 잔액이 아니므로 06:00 수집 시점 잔액을 기준일 잔액으로 대체할지 설계 결정 필요',
    },
    {
      target: '페이지네이션',
      source: 'page_record_cnt / next_page_yn / befor_inquiry_trace_info',
      transform: 'derived',
      status: 'SNIPPET',
      note: '페이지당 최대 25건(검색 발췌). next_page_yn=Y 이면 befor_inquiry_trace_info 를 넘겨 재호출',
    },
    {
      target: 'USD 계좌',
      transform: 'derived',
      status: 'MISSING',
      note: '외화계좌 조회 지원 여부를 공식 문서에서 확인하지 못함. 미확인',
    },
  ],
};

interface KftcTxn {
  tran_date: string;
  tran_time: string;
  inout_type: string;
  tran_type: string;
  print_content: string;
  tran_amt: string;
  after_balance_amt: string;
  branch_name: string;
}

interface KftcPage {
  api_tran_id: string;
  rsp_code: string;
  bank_tran_id: string;
  fintech_use_num: string;
  balance_amt: string;
  page_record_cnt: string;
  next_page_yn: 'Y' | 'N';
  befor_inquiry_trace_info: string;
  res_list: KftcTxn[];
}

interface KftcSample {
  accountMapping: Record<
    string,
    { legalEntity: LegalEntity; accountAlias: string; currency: string; bank: string }
  >;
  pages: KftcPage[];
  /** 재수집 시뮬레이션: 같은 기간 두 번째 조회(원천 정정 1건 포함) */
  recollectPages: KftcPage[];
}

function normalizePages(pages: readonly KftcPage[], sample: KftcSample, collectedAtUtc: string) {
  const txns: BankTransaction[] = [];
  const items: { sourceKey: string; raw: unknown }[] = [];
  const balances: BankBalance[] = [];
  let seq = 0;
  for (const page of pages) {
    const acct = sample.accountMapping[page.fintech_use_num];
    if (!acct) throw new Error(`미매핑 핀테크이용번호: ${page.fintech_use_num}`);
    for (const t of page.res_list) {
      seq += 1;
      const rawWithSeq = { ...t, fintech_use_num: page.fintech_use_num, _seq: String(seq) };
      const sourceKey = buildSourceKey(spec.sourceSystem, acct.accountAlias, rawWithSeq, [
        'fintech_use_num',
        ...spec.keyFields,
      ]);
      const occurredAtLocal = yyyymmddHhmmssToLocal(t.tran_date, t.tran_time);
      txns.push({
        legalEntity: acct.legalEntity,
        accountAlias: acct.accountAlias,
        currency: acct.currency,
        sourceKey,
        occurredAtLocal,
        sourceTz: spec.sourceTz,
        occurredAtUtc: localToUtc(occurredAtLocal, spec.sourceTz),
        direction: t.inout_type === '입금' ? 'IN' : 'OUT',
        amount: t.tran_amt,
        balanceAfter: t.after_balance_amt,
        description: t.print_content,
      });
      items.push({ sourceKey, raw: t });
    }
    if (page.next_page_yn === 'N') {
      balances.push({
        legalEntity: acct.legalEntity,
        accountAlias: acct.accountAlias,
        currency: acct.currency,
        asOfDate: yyyymmddToIso(page.res_list.at(-1)?.tran_date ?? '19700101'),
        balance: page.balance_amt,
        balanceKind: 'AT_INQUIRY',
        observedAtUtc: collectedAtUtc,
      });
    }
  }
  return { txns, items, balances };
}

export function runFixtureChecks(): CheckResult[] {
  const { data } = loadSample<KftcSample>('bank-kftc-openbanking.json');
  const collectedAtUtc = new Date().toISOString();
  const results: CheckResult[] = [];

  // 1) 페이지네이션 완결성: next_page_yn=Y 인 페이지 뒤에 후속 페이지가 있어야 한다.
  const lastPage = data.pages.at(-1);
  const paginationComplete =
    lastPage !== undefined &&
    lastPage.next_page_yn === 'N' &&
    data.pages.every((p) => p.res_list.length <= 25) &&
    data.pages.every((p) => Number(p.page_record_cnt) === p.res_list.length);
  results.push(
    check(
      'BANK-KFTC-01',
      '페이지네이션: 마지막 페이지 next_page_yn=N, page_record_cnt 와 실제 건수 일치',
      paginationComplete,
      `페이지 ${data.pages.length}개, 건수 ${data.pages.reduce((n, p) => n + p.res_list.length, 0)}`,
    ),
  );

  // 2) 건수·금액 대조(입금 +, 출금 -)
  const { txns, items } = normalizePages(data.pages, data, collectedAtUtc);
  const rawSigned = data.pages.flatMap((p) =>
    p.res_list.map((t) => (t.inout_type === '입금' ? t.tran_amt : neg(t.tran_amt))),
  );
  const normSigned = txns.map((t) => (t.direction === 'IN' ? t.amount : neg(t.amount)));
  const rec = reconcile('bank-kftc', rawSigned, normSigned);
  results.push(
    check(
      'BANK-KFTC-02',
      '원본↔정규화 건수·순금액 일치',
      rec.countMatch && rec.amountMatch,
      `원본 ${rec.rawCount}건 ${rec.rawAmount} / 정규화 ${rec.normalizedCount}건 ${rec.normalizedAmount}`,
    ),
  );

  // 3) 같은 날짜·금액·적요의 정상 거래 2건이 합쳐지지 않는다.
  const keys = new Set(txns.map((t) => t.sourceKey));
  results.push(
    check(
      'BANK-KFTC-03',
      '같은 날짜·금액·적요 정상 거래 2건 보존(원천키 분리)',
      keys.size === txns.length,
      `고유키 ${keys.size} / 거래 ${txns.length}`,
    ),
  );

  // 4) 재수집 무중복 + 원천 정정 시 관측 버전 증가
  const store = new SourceRecordStore();
  const first = store.ingest('BANK_KFTC_OPENBANKING', 'DP-KB-001', 'run-1', items);
  const second = store.ingest('BANK_KFTC_OPENBANKING', 'DP-KB-001', 'run-2', items);
  const re = normalizePages(data.recollectPages, data, collectedAtUtc);
  const third = store.ingest('BANK_KFTC_OPENBANKING', 'DP-KB-001', 'run-3', re.items);
  results.push(
    check(
      'BANK-KFTC-04',
      '동일 응답 재수집 시 무중복, 정정 응답은 관측 버전 추가',
      first.inserted === items.length &&
        second.inserted === 0 &&
        second.unchanged === items.length &&
        third.versioned === 1 &&
        store.size() === items.length,
      `1차 insert ${first.inserted}, 2차 unchanged ${second.unchanged}, 3차 versioned ${third.versioned}, 저장 ${store.size()}`,
    ),
  );

  // 5) 계산 잔액 vs 원천 잔액: 기초잔액 + 입금 - 출금 = 마지막 after_balance_amt
  const opening = '1000000';
  const computed = sum([opening, ...normSigned]);
  const lastAfter = txns.at(-1)?.balanceAfter ?? '';
  results.push(
    check(
      'BANK-KFTC-05',
      '기초잔액 + 누적 입출금 = 마지막 거래 후 잔액(대조, 차이는 조정 거래로 메우지 않음)',
      computed === lastAfter,
      `계산 ${computed} / 원천 ${lastAfter}`,
    ),
  );

  // 6) 기준일 잔액과 조회 시점 잔액 구분
  const bal = re.balances[0];
  results.push(
    check(
      'BANK-KFTC-06',
      '잔액 종류를 AT_INQUIRY 로 표시(전일 마감 잔액과 구분)',
      bal !== undefined && bal.balanceKind === 'AT_INQUIRY',
      bal ? `${bal.accountAlias} ${bal.balance} (${bal.balanceKind})` : '잔액 없음',
    ),
  );

  // 7) UTC 변환 보존
  const t0 = txns[0];
  results.push(
    check(
      'BANK-KFTC-07',
      '원천 시간대(Asia/Seoul) 시각과 UTC 를 함께 보존',
      t0 !== undefined && t0.occurredAtUtc.endsWith('Z') && t0.sourceTz === 'Asia/Seoul',
      t0 ? `${t0.occurredAtLocal} ${t0.sourceTz} → ${t0.occurredAtUtc}` : '거래 없음',
    ),
  );

  const cov = coverage(spec);
  results.push(
    check(
      'BANK-KFTC-08',
      '필드매핑 근거 현황(CONFIRMED 0 이면 실제 수집 미검증)',
      cov.confirmed === 0,
      `confirmed ${cov.confirmed} / snippet ${cov.snippet} / assumed ${cov.assumed} / missing ${cov.missing}`,
    ),
  );
  return results;
}
