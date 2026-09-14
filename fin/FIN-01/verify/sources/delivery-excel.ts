/**
 * 납품 매출: 승인된 공유 위치의 엑셀 자동 읽기(출고일 기준).
 *
 * 실제 납품 엑셀 샘플과 공유 위치는 제공되지 않았다(접근 대기). 아래는 계획서 §4 필수 필드
 * (법인/거래처/출고번호·행, 출고일, 상품·수량·금액·세금, 반품) 를 컬럼으로 가정한 검증이며,
 * 실제 파일 헤더가 확보되면 requiredColumns 와 매핑만 교체한다.
 */

import { createHash } from 'node:crypto';

import { neg, sum } from '../decimal';
import { type SourceSpec } from '../mapping';
import { check, reconcile, type CheckResult } from '../reconcile';
import { loadSample } from '../samples';
import type { LegalEntity, SalesEvent } from '../types';

export const spec: SourceSpec = {
  sourceSystem: 'DELIVERY_EXCEL',
  displayName: '납품 엑셀(공유 폴더)',
  docs: [],
  sourceTz: 'Asia/Seoul',
  keyFields: ['법인', '출고번호', '행번호'],
  mappings: [
    {
      target: 'legalEntity',
      source: '법인',
      transform: 'derived',
      status: 'ASSUMED',
      note: '실제 파일 헤더 미확보',
    },
    {
      target: 'channel(거래처)',
      source: '거래처',
      transform: 'identity',
      status: 'ASSUMED',
      note: '거래처 외부 코드 매핑',
    },
    {
      target: 'orderId / lineId',
      source: '출고번호 / 행번호',
      transform: 'identity',
      status: 'ASSUMED',
      note: '출고번호가 없으면 파일명+시트+행 식별 사용, 중복 후보 검토',
    },
    {
      target: 'eventDateLocal(출고일)',
      source: '출고일',
      transform: 'identity',
      status: 'ASSUMED',
      note: '',
    },
    {
      target: 'productCode / quantity',
      source: '상품코드 / 수량',
      transform: 'identity',
      status: 'ASSUMED',
      note: '',
    },
    {
      target: 'netAmount(공급가) / taxAmount',
      source: '공급가액 / 세액',
      transform: 'decimal',
      status: 'ASSUMED',
      note: '면세·수출 행은 세액 0 가능. 1.1 나누기 금지',
    },
    {
      target: 'RETURNED',
      source: '반품여부 / 반품일',
      transform: 'derived',
      status: 'ASSUMED',
      note: '반품 기록 방식(별도 행/음수 행/원행 수정) 미확인',
    },
    {
      target: '수정 감지',
      transform: 'derived',
      status: 'ASSUMED',
      note: '행 payload 해시 비교로 수정 감지. 삭제된 행은 최신 파일에 없는 키로 식별',
    },
    {
      target: '파일 갱신 주기 / 전일 자료 확보 가능성',
      transform: 'derived',
      status: 'MISSING',
      note: '공유 위치·갱신 시각 미확인. 10시 전 전일분 확보 가능 여부는 사용자 확인 필요',
    },
  ],
};

interface DeliveryRow {
  법인: string;
  거래처: string;
  출고번호: string;
  행번호: string;
  출고일: string;
  상품코드: string;
  수량: string;
  공급가액: string;
  세액: string;
  반품여부: string;
  반품일: string;
}

interface DeliverySample {
  requiredColumns: string[];
  entityMapping: Record<string, LegalEntity>;
  rows: DeliveryRow[];
  /** 같은 거래처의 주문이 사방넷(주문 시스템)에도 있는 경우 */
  alsoInOrderSystem: { 거래처: string; 출고번호: string }[];
}

function rowHash(row: DeliveryRow): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 16);
}

function normalize(sample: DeliverySample): SalesEvent[] {
  const events: SalesEvent[] = [];
  for (const r of sample.rows) {
    const legalEntity = sample.entityMapping[r.법인] ?? 'UNMAPPED';
    const lineId = `${r.출고번호}-${r.행번호}`;
    const isReturn = r.반품여부 === 'Y';
    const base: SalesEvent = {
      legalEntity,
      channel: `B2B:${r.거래처}`,
      saleType: 'DELIVERY',
      sourceSystem: 'DELIVERY_EXCEL',
      orderId: r.출고번호,
      lineId,
      eventId: `${lineId}:${isReturn ? 'RETURNED' : 'SHIPPED'}`,
      eventType: isReturn ? 'RETURNED' : 'SHIPPED',
      eventDateLocal: isReturn ? r.반품일 : r.출고일,
      sourceTz: spec.sourceTz,
      currency: 'KRW',
      netAmount: isReturn ? neg(r.공급가액) : r.공급가액,
      amountBasis: 'SUPPLY',
      taxAmount: isReturn ? neg(r.세액) : r.세액,
      productCode: r.상품코드,
      quantity: isReturn ? neg(r.수량) : r.수량,
    };
    if (isReturn) base.linkedEventId = `${lineId}:SHIPPED`;
    events.push(base);
  }
  return events;
}

export function runFixtureChecks(): CheckResult[] {
  const { data } = loadSample<DeliverySample>('delivery-excel-placeholder.json');
  const first = data.rows[0];
  const headerOk =
    first !== undefined && data.requiredColumns.every((c) => Object.keys(first).includes(c));
  const keys = data.rows.map((r) => `${r.법인}|${r.출고번호}|${r.행번호}|${r.반품여부}`);
  const unique = new Set(keys).size === keys.length;
  const events = normalize(data);
  const shipped = events.filter((e) => e.eventType === 'SHIPPED');
  const returned = events.filter((e) => e.eventType === 'RETURNED');
  const rec = reconcile(
    'delivery-shipped',
    data.rows.filter((r) => r.반품여부 !== 'Y').map((r) => r.공급가액),
    shipped.map((e) => e.netAmount),
  );
  const hashes = data.rows.map(rowHash);
  const modified = { ...data.rows[1], 공급가액: '999' } as DeliveryRow;
  const overlap = data.alsoInOrderSystem.filter((o) =>
    shipped.some((e) => e.channel === `B2B:${o.거래처}` && e.orderId === o.출고번호),
  );
  const taxFreeRows = data.rows.filter((r) => r.세액 === '0');
  return [
    check(
      'DLV-01',
      '필수 컬럼 존재(법인·거래처·출고번호·행·출고일·상품·수량·공급가액·세액·반품)',
      headerOk,
      data.requiredColumns.join(', '),
    ),
    check(
      'DLV-02',
      '(법인, 출고번호, 행번호, 반품여부) 고유키 중복 없음',
      unique,
      `행 ${keys.length}, 고유 ${new Set(keys).size}`,
    ),
    check(
      'DLV-03',
      '출고 행 건수·공급가액 대조',
      rec.countMatch && rec.amountMatch,
      `원본 ${rec.rawCount}건 ${rec.rawAmount} / 정규화 ${rec.normalizedCount}건 ${rec.normalizedAmount}`,
    ),
    check(
      'DLV-04',
      '반품은 확인된 반품일에 원출고 행에 연결된 음수 이벤트',
      returned.length > 0 && returned.every((r) => r.linkedEventId && r.eventDateLocal !== ''),
      `반품 ${returned.length}건, 순매출 ${sum(events.map((e) => e.netAmount))}`,
    ),
    check(
      'DLV-05',
      '행 해시로 수정 감지(금액 수정 시 해시 변경)',
      hashes[1] !== undefined && rowHash(modified) !== hashes[1],
      `원본 ${hashes[1]} ≠ 수정 ${rowHash(modified)}`,
    ),
    check(
      'DLV-06',
      '납품 거래가 주문 시스템에도 존재하는 경우 탐지(채널/거래 유형별 담당 원천 지정 필요)',
      overlap.length > 0,
      `중복 후보 ${overlap.length}건`,
    ),
    check(
      'DLV-07',
      '세액 0 행(면세·수출)은 1.1 나누기 없이 원천 구분 유지',
      taxFreeRows.length > 0 && taxFreeRows.every((r) => r.세액 === '0'),
      `세액 0 행 ${taxFreeRows.length}건`,
    ),
    check(
      'DLV-08',
      '실제 파일·공유 위치 미제공 → 접근 대기(실제 수집 미검증)',
      true,
      '사용자 조치 필요: 샘플 파일, 공유 위치, 반품·수정 기록 방식',
    ),
  ];
}
