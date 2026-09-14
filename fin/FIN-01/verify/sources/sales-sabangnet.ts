/**
 * 소비자 매출 1순위: 사방넷 API(주문 수집).
 *
 * 확인일 2026-09-14. 공식 사이트(sabangnet.co.kr)와 연동 가이드 호스트는 본 환경에서 차단되어
 * 검색 발췌로 다음만 확인했다: API 서비스는 유료 부가서비스, 연동키는 마이페이지 > 서비스 관리 >
 * 연동키(API 인증키) 관리에서 확인, 무신사·스마트스토어·카카오 등 연동 가능(올리브영은 올리브영 외부셀러
 * 서비스가 사방넷과 연동됨을 올리브영 기술블로그에서 확인). 주문 필드명·상태 코드·결제완료 일시 제공 여부는
 * 미확인이며 아래 필드명은 전부 자리표시자(ASSUMED)다.
 */

import { neg, sum } from '../decimal';
import { SourceRecordStore } from '../dedupe';
import { buildSourceKey, type SourceSpec } from '../mapping';
import { check, reconcile, type CheckResult } from '../reconcile';
import { loadSample } from '../samples';
import type { LegalEntity, SalesEvent } from '../types';

export const spec: SourceSpec = {
  sourceSystem: 'SALES_SABANGNET',
  displayName: '사방넷 주문 API',
  docs: [
    {
      url: 'https://www.sabangnet.co.kr/service-intro/api-service',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://www.sabangnet.co.kr/html/function_intro_mall_list.html',
      checkedOn: '2026-09-14',
      access: 'BLOCKED',
    },
    {
      url: 'https://oliveyoung.tech/2023-12-15/seller-service-1/',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
  ],
  sourceTz: 'Asia/Seoul',
  keyFields: ['order_line_id'],
  mappings: [
    {
      target: 'legalEntity',
      transform: 'derived',
      status: 'ASSUMED',
      note: '사방넷 계정(연동키) 단위로 법인 매핑. 한 계정에 두 법인 몰이 섞이면 몰 ID 별 매핑 필요',
    },
    {
      target: 'channel',
      source: 'mall_id (자리표시자)',
      transform: 'derived',
      status: 'ASSUMED',
      note: '사방넷 몰 코드 → channels 매핑. 실제 필드명 미확인',
    },
    {
      target: 'orderId / lineId',
      source: 'mall_order_id / order_line_id (자리표시자)',
      transform: 'identity',
      status: 'ASSUMED',
      note: '사방넷 주문 고유번호와 몰 주문번호 중 무엇이 행 단위 고유키인지 미확인',
    },
    {
      target: 'eventDateLocal (결제 완료일)',
      source: 'pay_date (자리표시자)',
      transform: 'identity',
      status: 'ASSUMED',
      note: '결제 완료 일시 필드 제공 여부 미확인. 주문일만 제공되면 계획서 기준(결제 완료)과 불일치 → 매핑표에 차이 명시',
    },
    {
      target: 'eventType',
      source: 'order_status (자리표시자)',
      transform: 'derived',
      status: 'ASSUMED',
      note: '상태 코드표 미확인. 결제완료/취소/부분취소/환불 값과 구매확정 값을 구분해야 함',
    },
    {
      target: 'netAmount / amountBasis',
      source: 'pay_amount (자리표시자)',
      transform: 'decimal',
      status: 'ASSUMED',
      note: '공급가/세포함, 할인·배송비 포함 여부 미확인 → amountBasis UNKNOWN',
    },
    {
      target: 'productCode',
      source: 'product_code (자리표시자)',
      transform: 'identity',
      status: 'ASSUMED',
      note: '사방넷 상품코드 vs 몰 상품코드 중 어떤 값이 오는지 미확인. 미매핑은 원본 코드 보존',
    },
    {
      target: 'quantity',
      source: 'qty (자리표시자)',
      transform: 'decimal',
      status: 'ASSUMED',
      note: '',
    },
    {
      target: '부분취소/분할환불 식별',
      transform: 'derived',
      status: 'ASSUMED',
      note: '취소 행이 별도 행으로 오는지, 원행의 상태만 바뀌는지 미확인. 후자면 관측 버전 비교로 이벤트를 생성해야 함',
    },
    {
      target: '변경 조회(수정일 기준)',
      transform: 'derived',
      status: 'ASSUMED',
      note: '수정일 기준 재조회 파라미터 제공 여부 미확인. 없으면 최근 7일 전체 재조회(계획서 §10)',
    },
  ],
};

interface SabangnetLine {
  sabangnet_order_no: string;
  mall_id: string;
  mall_order_id: string;
  order_line_id: string;
  order_date: string;
  pay_date: string;
  order_status: string;
  product_code: string;
  qty: string;
  pay_amount: string;
}

interface SabangnetSample {
  accountAlias: string;
  legalEntity: LegalEntity;
  channelMapping: Record<string, string>;
  /** 회사 전체 채널 목록(미확보 시 빈 배열) 과 사방넷 포괄 채널 */
  companyChannels: string[];
  sabangnetCoveredChannels: string[];
  statusMapping: Record<string, SalesEvent['eventType'] | 'IGNORE'>;
  lines: SabangnetLine[];
  /** 직접 채널 API 에도 존재하는 주문(중복 후보) */
  directApiOrders: { channel: string; orderId: string }[];
}

function normalize(sample: SabangnetSample): {
  events: SalesEvent[];
  items: { sourceKey: string; raw: unknown }[];
} {
  const events: SalesEvent[] = [];
  const items: { sourceKey: string; raw: unknown }[] = [];
  for (const line of sample.lines) {
    const channel = sample.channelMapping[line.mall_id] ?? `UNMAPPED:${line.mall_id}`;
    const mapped = sample.statusMapping[line.order_status];
    if (mapped === undefined) throw new Error(`미매핑 주문상태: ${line.order_status}`);
    const sourceKey = buildSourceKey(spec.sourceSystem, sample.accountAlias, line, [
      ...spec.keyFields,
      'order_status',
    ]);
    items.push({ sourceKey, raw: line });
    if (mapped === 'IGNORE') continue;
    const isReversal = mapped === 'CANCELLED' || mapped === 'REFUNDED';
    const event: SalesEvent = {
      legalEntity: sample.legalEntity,
      channel,
      saleType: 'CONSUMER',
      sourceSystem: 'SALES_SABANGNET',
      orderId: line.mall_order_id,
      lineId: line.order_line_id,
      eventId: `${line.order_line_id}:${mapped}`,
      eventType: mapped,
      eventDateLocal: line.pay_date.slice(0, 10),
      sourceTz: spec.sourceTz,
      currency: 'KRW',
      netAmount: isReversal ? neg(line.pay_amount) : line.pay_amount,
      amountBasis: 'UNKNOWN',
      productCode: line.product_code,
      quantity: isReversal ? neg(line.qty) : line.qty,
    };
    if (isReversal) event.linkedEventId = `${line.order_line_id}:PAID`;
    events.push(event);
  }
  return { events, items };
}

export function runFixtureChecks(): CheckResult[] {
  const { data } = loadSample<SabangnetSample>('sales-sabangnet-placeholder.json');
  const { events, items } = normalize(data);
  const results: CheckResult[] = [];

  const paid = events.filter((e) => e.eventType === 'PAID');
  const reversals = events.filter((e) => e.eventType !== 'PAID');
  const rawPaid = data.lines
    .filter((l) => data.statusMapping[l.order_status] === 'PAID')
    .map((l) => l.pay_amount);
  const rec = reconcile(
    'sabangnet-paid',
    rawPaid,
    paid.map((e) => e.netAmount),
  );
  results.push(
    check(
      'SALES-SBN-01',
      '결제완료 행 건수·금액 대조(구매확정 상태는 이벤트 생성 안 함)',
      rec.countMatch && rec.amountMatch,
      `원본 ${rec.rawCount}건 ${rec.rawAmount} / 정규화 ${rec.normalizedCount}건 ${rec.normalizedAmount}`,
    ),
  );

  const linked = reversals.every(
    (r) => r.linkedEventId !== undefined && paid.some((p) => p.eventId === r.linkedEventId),
  );
  results.push(
    check(
      'SALES-SBN-02',
      '부분취소·환불은 고유 이벤트로 원거래(PAID)에 연결되고 음수로 차감',
      reversals.length > 0 && linked && reversals.every((r) => r.netAmount.startsWith('-')),
      `취소/환불 ${reversals.length}건, 순매출 ${sum(events.map((e) => e.netAmount))}`,
    ),
  );

  const store = new SourceRecordStore();
  const a = store.ingest('SALES_SABANGNET', data.accountAlias, 'run-1', items);
  const b = store.ingest('SALES_SABANGNET', data.accountAlias, 'run-2', items);
  results.push(
    check(
      'SALES-SBN-03',
      '같은 기간 재수집 시 무중복',
      a.inserted === items.length && b.inserted === 0 && b.unchanged === items.length,
      `1차 ${a.inserted} / 2차 unchanged ${b.unchanged}`,
    ),
  );

  // 채널 포괄 범위: 회사 전체 목록이 없으면 "확인 불가" 로만 보고한다.
  const companyListKnown = data.companyChannels.length > 0;
  const missing = data.companyChannels.filter((c) => !data.sabangnetCoveredChannels.includes(c));
  results.push(
    check(
      'SALES-SBN-04',
      '사방넷 미포괄 채널 명단(전체 채널 목록 미확보 시 판정 보류)',
      true,
      companyListKnown
        ? `미포괄: ${missing.join(', ') || '없음'}`
        : '회사 전체 채널 목록 미확보 → 포괄 범위 판정 보류(주요 6개 채널만 가정 점검)',
    ),
  );

  // 사방넷과 직접 채널 API 에 같은 주문이 있으면 담당 원천을 하나로 지정해야 한다.
  const dup = data.directApiOrders.filter((d) =>
    events.some((e) => e.channel === d.channel && e.orderId === d.orderId),
  );
  results.push(
    check(
      'SALES-SBN-05',
      '사방넷·직접 API 중복 주문 탐지(채널별 담당 원천 지정 전에는 합산 금지)',
      dup.length > 0,
      `중복 후보 ${dup.length}건: ${dup.map((d) => `${d.channel}/${d.orderId}`).join(', ')}`,
    ),
  );

  results.push(
    check(
      'SALES-SBN-06',
      '필드명·상태코드 전부 ASSUMED → 실제 수집 미검증',
      spec.mappings.every((m) => m.status === 'ASSUMED'),
      `mappings ${spec.mappings.length}개 ASSUMED`,
    ),
  );
  return results;
}
