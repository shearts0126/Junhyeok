/**
 * 은행 후보 2/3: 웹케시 브랜치(ERP연계 API) · CODEF 기업 계좌 API.
 *
 * 두 경로 모두 공식 문서 원문을 본 환경에서 열람하지 못했고 응답 필드명을 확인하지 못했다.
 * 따라서 필드명을 가정하지 않고, 실제 샘플이 오면 컬럼 이름만 바꾸는 "설정 기반 매핑" 으로 둔다.
 * 아래 fixture 의 컬럼명은 검증 코드 동작 확인용 자리표시자이며 원천 명세가 아니다.
 */

import { neg } from '../decimal';
import { buildSourceKey, readPath, type SourceSpec } from '../mapping';
import { check, reconcile, type CheckResult } from '../reconcile';
import { loadSample } from '../samples';
import { localToUtc } from '../time';
import type { BankTransaction, LegalEntity } from '../types';

export const spec: SourceSpec = {
  sourceSystem: 'BANK_AGGREGATOR',
  displayName: '법인 다은행 조회 중계(웹케시 브랜치 / CODEF / 하이픈)',
  docs: [
    {
      url: 'https://www.xbranch.co.kr/branch/html/branch4_2000.html',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://developer.codef.io/products/bank/common/b/transaction',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://developer.codef.io/products/bank/common/b/fastAccount',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://hyphen.im/product/view?seq=54',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
  ],
  sourceTz: 'Asia/Seoul',
  keyFields: ['_configured'],
  mappings: [
    {
      target: 'legalEntity / accountAlias / currency',
      transform: 'derived',
      status: 'ASSUMED',
      note: '계좌번호·은행코드·통화 컬럼이 응답에 있을 것으로 예상(브랜치는 외화계좌 17개 은행 지원 표기, CODEF 는 기업 외화 거래내역 API 별도 존재). 컬럼명 미확인',
    },
    {
      target: 'sourceKey',
      transform: 'derived',
      status: 'ASSUMED',
      note: '거래 고유번호 제공 여부 미확인. 없으면 (계좌, 거래일시, 입출금, 거래후잔액, 순번) 대체키',
    },
    {
      target: 'occurredAtLocal',
      transform: 'derived',
      status: 'ASSUMED',
      note: '거래일·거래시각 컬럼명 미확인',
    },
    {
      target: 'direction / amount',
      transform: 'derived',
      status: 'ASSUMED',
      note: '입금액·출금액 분리 컬럼 또는 부호 컬럼 여부 미확인',
    },
    {
      target: 'balanceAfter',
      transform: 'derived',
      status: 'ASSUMED',
      note: '거래후잔액 컬럼명 미확인',
    },
    {
      target: '기준일 잔액(전일 마감)',
      transform: 'derived',
      status: 'ASSUMED',
      note: '잔액 조회가 조회 시점 기준인지 일자 기준인지 미확인',
    },
    {
      target: '과거 조회 가능 기간 / 갱신 지연 / 호출 제한 / 요금',
      transform: 'derived',
      status: 'ASSUMED',
      note: '검색 결과에 요금·제한이 없었음. 영업 문의 필요',
    },
  ],
};

/** 설정 기반 컬럼 매핑: 실제 응답이 확보되면 이 값만 교체한다. */
export interface AggregatorColumnConfig {
  accountId: string;
  currency: string;
  txnId?: string;
  date: string;
  time: string;
  inAmount: string;
  outAmount: string;
  balanceAfter: string;
  description: string;
}

interface AggregatorSample {
  columns: AggregatorColumnConfig;
  accountMapping: Record<string, { legalEntity: LegalEntity; accountAlias: string }>;
  rows: Record<string, string>[];
}

function normalize(sample: AggregatorSample): BankTransaction[] {
  const c = sample.columns;
  return sample.rows.map((row, i) => {
    const accountId = String(readPath(row, c.accountId));
    const acct = sample.accountMapping[accountId];
    if (!acct) throw new Error(`미매핑 계좌: ${accountId}`);
    const inAmt = String(readPath(row, c.inAmount) ?? '0');
    const outAmt = String(readPath(row, c.outAmount) ?? '0');
    const direction: BankTransaction['direction'] = inAmt !== '0' ? 'IN' : 'OUT';
    const occurredAtLocal = `${String(readPath(row, c.date))}T${String(readPath(row, c.time))}`;
    const keyFields = c.txnId
      ? [c.txnId]
      : [c.accountId, c.date, c.time, c.inAmount, c.outAmount, c.balanceAfter, '_seq'];
    const sourceKey = buildSourceKey(
      spec.sourceSystem,
      acct.accountAlias,
      { ...row, _seq: String(i + 1) },
      keyFields,
    );
    return {
      legalEntity: acct.legalEntity,
      accountAlias: acct.accountAlias,
      currency: String(readPath(row, c.currency)),
      sourceKey,
      occurredAtLocal,
      sourceTz: spec.sourceTz,
      occurredAtUtc: localToUtc(occurredAtLocal, spec.sourceTz),
      direction,
      amount: direction === 'IN' ? inAmt : outAmt,
      balanceAfter: String(readPath(row, c.balanceAfter)),
      description: String(readPath(row, c.description)),
    };
  });
}

export function runFixtureChecks(): CheckResult[] {
  const { data } = loadSample<AggregatorSample>('bank-aggregator-placeholder.json');
  const txns = normalize(data);
  const rawSigned = data.rows.map((r) => {
    const inAmt = String(readPath(r, data.columns.inAmount) ?? '0');
    const outAmt = String(readPath(r, data.columns.outAmount) ?? '0');
    return inAmt !== '0' ? inAmt : neg(outAmt);
  });
  const normSigned = txns.map((t) => (t.direction === 'IN' ? t.amount : neg(t.amount)));
  const rec = reconcile('bank-aggregator', rawSigned, normSigned);
  const usd = txns.filter((t) => t.currency === 'USD');
  return [
    check(
      'BANK-AGG-01',
      '설정 기반 컬럼 매핑으로 건수·순금액 대조(자리표시자 컬럼명)',
      rec.countMatch && rec.amountMatch,
      `원본 ${rec.rawCount}건 ${rec.rawAmount} / 정규화 ${rec.normalizedCount}건 ${rec.normalizedAmount}`,
    ),
    check(
      'BANK-AGG-02',
      'USD 계좌 거래는 원통화 금액을 보존하고 환산하지 않음',
      usd.length > 0 && usd.every((t) => /^\d+(\.\d{1,2})?$/.test(t.amount)),
      `USD 거래 ${usd.length}건: ${usd.map((t) => t.amount).join(', ')}`,
    ),
    check(
      'BANK-AGG-03',
      '실제 응답 필드명 미확인 → 실제 수집 미검증(ASSUMED 만 존재)',
      spec.mappings.every((m) => m.status === 'ASSUMED'),
      `mappings ${spec.mappings.length}개 전부 ASSUMED`,
    ),
  ];
}
