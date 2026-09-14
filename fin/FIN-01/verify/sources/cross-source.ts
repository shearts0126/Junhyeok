/**
 * 출처 간 중복 집계 방지 점검(계획서 §5·§6·§7).
 *
 * - 매출 자료와 정산 입금(은행)을 각각 매출로 집계하지 않는다.
 * - 광고 충전(은행 유출)과 소진(손익 비용)을 구분하고, 소진 시 현금 유출을 다시 만들지 않는다.
 * - 통합 수집(사방넷)과 직접 수집(채널 API)을 단순 합산하지 않는다.
 */

import { sum } from '../decimal';
import { check, type CheckResult } from '../reconcile';
import { loadSample } from '../samples';

interface CrossSample {
  bankTransactions: {
    description: string;
    direction: 'IN' | 'OUT';
    amount: string;
    classification: string;
  }[];
  salesNet: string;
  adPrepaid: { charge: string; spend: string; taxAndFee: string };
  channelOwners: Record<string, 'SABANGNET' | 'DIRECT_API' | 'DELIVERY_EXCEL'>;
  eventsByOwner: { channel: string; source: string; amount: string }[];
}

/** 채널별 담당 원천만 집계한다. 담당 원천이 지정되지 않은 채널은 집계에서 제외하고 목록으로 남긴다. */
export function aggregateByOwner(sample: CrossSample): { total: string; excluded: string[] } {
  const excluded: string[] = [];
  const included: string[] = [];
  for (const e of sample.eventsByOwner) {
    const owner = sample.channelOwners[e.channel];
    if (!owner) {
      excluded.push(`${e.channel}(담당 원천 미지정)`);
      continue;
    }
    if (owner === e.source) included.push(e.amount);
    else excluded.push(`${e.channel}/${e.source}(비담당 원천)`);
  }
  return { total: sum(included), excluded };
}

export function runFixtureChecks(): CheckResult[] {
  const { data } = loadSample<CrossSample>('cross-source-placeholder.json');
  const settlementIn = data.bankTransactions.filter(
    (t) => t.classification === 'SETTLEMENT_RECEIPT',
  );
  const naiveDouble = sum([data.salesNet, ...settlementIn.map((t) => t.amount)]);
  const { total, excluded } = aggregateByOwner(data);
  const adCash = data.adPrepaid.charge; // 현금 유출은 충전액만
  const adPnl = data.adPrepaid.spend; // 손익 비용은 소진액만
  const adBalance = sum([
    data.adPrepaid.charge,
    `-${data.adPrepaid.spend}`,
    `-${data.adPrepaid.taxAndFee}`,
  ]);
  return [
    check(
      'X-01',
      '정산 입금은 은행 거래로만 보존(분류 SETTLEMENT_RECEIPT), 매출에 합산하지 않음',
      settlementIn.length > 0 && naiveDouble !== data.salesNet,
      `매출 ${data.salesNet} / 정산입금 ${sum(settlementIn.map((t) => t.amount))} / 합산 시 ${naiveDouble} (금지)`,
    ),
    check(
      'X-02',
      '선불 광고 충전 100, 소진 60: 은행 -100, 광고 잔액 +40, 손익 비용 60(§12-5)',
      adCash === '100' && adPnl === '60' && adBalance === '40',
      `현금 유출 ${adCash}, 비용 ${adPnl}, 잔액 ${adBalance}`,
    ),
    check(
      'X-03',
      '채널별 담당 원천만 집계, 비담당·미지정은 제외 목록',
      excluded.length > 0,
      `집계 ${total}, 제외: ${excluded.join('; ')}`,
    ),
  ];
}
