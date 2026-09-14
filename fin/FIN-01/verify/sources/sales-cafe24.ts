/**
 * 자사몰: 카페24 Admin API(사방넷이 자사몰 주문을 포괄하지 못할 때만 사용).
 *
 * 확인일 2026-09-14. developers.cafe24.com 은 본 환경에서 차단. 검색 발췌로 확인한 것:
 * OAuth 2.0, Access Token 유효 2시간, Refresh Token 2주(갱신 시 둘 다 재발급), Leaky Bucket 호출 제한
 * (x-ratelimit-remaining 헤더), X-Cafe24-Api-Version 헤더, 날짜는 ISO 8601, HTTPS 전용.
 * 주문 리소스 필드명(order_id, payment_date, paid, canceled, items[].order_item_code 등)은 원문 미열람 → ASSUMED.
 */

import { neg, sum } from '../decimal';
import { SourceRecordStore } from '../dedupe';
import { buildSourceKey, type SourceSpec } from '../mapping';
import { check, reconcile, type CheckResult } from '../reconcile';
import { loadSample } from '../samples';
import type { LegalEntity, SalesEvent } from '../types';

export const spec: SourceSpec = {
  sourceSystem: 'SALES_CAFE24',
  displayName: '카페24 Admin API(orders)',
  docs: [
    {
      url: 'https://developers.cafe24.com/docs/api/admin/',
      checkedOn: '2026-09-14',
      access: 'BLOCKED',
    },
    {
      url: 'https://developers.cafe24.com/en/app/front/app/develop/oauth/retoken',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
    {
      url: 'https://developers.cafe24.com/en/app/front/app/develop/api/adminapi',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
  ],
  sourceTz: 'Asia/Seoul',
  keyFields: ['order_id', 'order_item_code'],
  mappings: [
    {
      target: 'legalEntity',
      transform: 'derived',
      status: 'ASSUMED',
      note: '몰(mall_id) 단위 매핑',
    },
    {
      target: 'channel',
      transform: 'constant',
      constant: 'OWNMALL_CAFE24',
      status: 'CONFIRMED',
      note: '고정',
    },
    {
      target: 'orderId / lineId',
      source: 'order_id / items[].order_item_code',
      transform: 'identity',
      status: 'ASSUMED',
      note: '주문·품목 식별자 필드명 원문 확인 필요',
    },
    {
      target: 'eventDateLocal (결제 완료)',
      source: 'payment_date (paid=T 인 경우)',
      transform: 'identity',
      status: 'ASSUMED',
      note: '결제일 필드 존재·형식(ISO 8601) 원문 확인 필요. 입금전(미결제) 주문은 제외',
    },
    {
      target: 'eventType CANCELLED/REFUNDED',
      source: 'canceled / items[].order_status',
      transform: 'derived',
      status: 'ASSUMED',
      note: '취소·반품·환불 상태 코드 체계 원문 확인 필요. 환불 확정일 필드 존재 여부 미확인',
    },
    {
      target: 'netAmount / amountBasis',
      source: 'items[].product_price × quantity − 할인',
      transform: 'derived',
      status: 'ASSUMED',
      note: '공급가/세포함 구분 및 할인·배송비 필드 원문 확인 필요',
    },
    {
      target: 'productCode',
      source: 'items[].product_code',
      transform: 'identity',
      status: 'ASSUMED',
      note: '',
    },
    {
      target: '인증·갱신',
      transform: 'derived',
      status: 'SNIPPET',
      note: 'OAuth2, access 2h / refresh 2주. 2주 내 갱신 실패 시 재인가 필요 → 무인 수집 시 갱신 스케줄 필수',
    },
    {
      target: '호출 제한',
      transform: 'derived',
      status: 'SNIPPET',
      note: 'Leaky Bucket, x-ratelimit-remaining 헤더로 잔여 확인. 정확한 버킷 크기는 원문 확인 필요',
    },
    {
      target: '변경 조회',
      source: 'updated_start_date 류 파라미터',
      transform: 'derived',
      status: 'ASSUMED',
      note: '수정일 기준 조회 파라미터 존재 여부 미확인',
    },
  ],
};

interface Cafe24Item {
  order_item_code: string;
  product_code: string;
  quantity: string;
  product_price: string;
  order_status: string;
}

interface Cafe24Order {
  order_id: string;
  order_date: string;
  payment_date: string | null;
  paid: 'T' | 'F';
  canceled: 'T' | 'F';
  items: Cafe24Item[];
}

interface Cafe24Sample {
  mallAlias: string;
  legalEntity: LegalEntity;
  cancelStatuses: string[];
  orders: Cafe24Order[];
  /** 사방넷에서도 수집되는 자사몰 주문(중복 후보) */
  alsoInSabangnet: string[];
}

function normalize(sample: Cafe24Sample) {
  const events: SalesEvent[] = [];
  const items: { sourceKey: string; raw: unknown }[] = [];
  for (const o of sample.orders) {
    for (const it of o.items) {
      const raw = { ...it, order_id: o.order_id };
      const sourceKey = buildSourceKey(spec.sourceSystem, sample.mallAlias, raw, spec.keyFields);
      items.push({ sourceKey, raw: { ...raw, paid: o.paid, canceled: o.canceled } });
      if (o.paid !== 'T' || !o.payment_date) continue; // 입금전 주문 제외
      const gross = mul(it.product_price, it.quantity);
      events.push({
        legalEntity: sample.legalEntity,
        channel: 'OWNMALL_CAFE24',
        saleType: 'CONSUMER',
        sourceSystem: 'SALES_CAFE24',
        orderId: o.order_id,
        lineId: it.order_item_code,
        eventId: `${it.order_item_code}:PAID`,
        eventType: 'PAID',
        eventDateLocal: o.payment_date.slice(0, 10),
        eventAtLocal: o.payment_date.slice(0, 19),
        sourceTz: spec.sourceTz,
        currency: 'KRW',
        netAmount: gross,
        amountBasis: 'UNKNOWN',
        productCode: it.product_code,
        quantity: it.quantity,
      });
      if (sample.cancelStatuses.includes(it.order_status)) {
        events.push({
          legalEntity: sample.legalEntity,
          channel: 'OWNMALL_CAFE24',
          saleType: 'CONSUMER',
          sourceSystem: 'SALES_CAFE24',
          orderId: o.order_id,
          lineId: it.order_item_code,
          eventId: `${it.order_item_code}:CANCELLED`,
          eventType: 'CANCELLED',
          // 취소 확정일 필드가 확인되지 않아 결제일을 그대로 두지 않고 누락 표시용으로 빈 값 대신 결제일을 쓰지 않는다.
          eventDateLocal: 'UNKNOWN',
          sourceTz: spec.sourceTz,
          currency: 'KRW',
          netAmount: neg(gross),
          amountBasis: 'UNKNOWN',
          productCode: it.product_code,
          quantity: neg(it.quantity),
          linkedEventId: `${it.order_item_code}:PAID`,
        });
      }
    }
  }
  return { events, items };
}

/** 정수 수량 × 금액(소수 허용) — BigInt 스케일 곱. */
function mul(amount: string, qty: string): string {
  const q = BigInt(qty);
  let acc = '0';
  for (let i = 0n; i < q; i += 1n) acc = sum([acc, amount]);
  return acc;
}

export function runFixtureChecks(): CheckResult[] {
  const { data } = loadSample<Cafe24Sample>('sales-cafe24-placeholder.json');
  const { events, items } = normalize(data);
  const paid = events.filter((e) => e.eventType === 'PAID');
  const rawPaid = data.orders
    .filter((o) => o.paid === 'T' && o.payment_date)
    .flatMap((o) => o.items.map((it) => mul(it.product_price, it.quantity)));
  const rec = reconcile(
    'cafe24-paid',
    rawPaid,
    paid.map((e) => e.netAmount),
  );
  const unpaid = data.orders.filter((o) => o.paid !== 'T').length;
  const cancels = events.filter((e) => e.eventType === 'CANCELLED');
  const store = new SourceRecordStore();
  const a = store.ingest('SALES_CAFE24', data.mallAlias, 'run-1', items);
  const b = store.ingest('SALES_CAFE24', data.mallAlias, 'run-2', items);
  const overlap = paid.filter((e) => data.alsoInSabangnet.includes(e.orderId));
  return [
    check(
      'SALES-C24-01',
      '결제완료(paid=T, payment_date 존재) 품목만 PAID 이벤트, 입금전 주문 제외',
      rec.countMatch && rec.amountMatch && unpaid > 0,
      `PAID ${rec.normalizedCount}건 ${rec.normalizedAmount}, 입금전 제외 ${unpaid}건`,
    ),
    check(
      'SALES-C24-02',
      '취소 품목은 원거래에 연결된 음수 이벤트. 취소 확정일 필드 미확인 → 날짜 UNKNOWN 표시(임의 날짜 금지)',
      cancels.length > 0 && cancels.every((c) => c.linkedEventId && c.eventDateLocal === 'UNKNOWN'),
      `취소 ${cancels.length}건`,
    ),
    check(
      'SALES-C24-03',
      '같은 기간 재수집 무중복',
      a.inserted === items.length && b.inserted === 0,
      `1차 ${a.inserted} / 2차 unchanged ${b.unchanged}`,
    ),
    check(
      'SALES-C24-04',
      '사방넷과 중복되는 자사몰 주문 탐지(자사몰 담당 원천을 하나로 고정해야 함)',
      overlap.length > 0,
      `중복 후보 ${overlap.length}건: ${overlap.map((e) => e.orderId).join(', ')}`,
    ),
    check(
      'SALES-C24-05',
      '주문 필드명 ASSUMED, 인증·제한만 SNIPPET → 실제 수집 미검증',
      spec.mappings.some((m) => m.status === 'ASSUMED'),
      '',
    ),
  ];
}
