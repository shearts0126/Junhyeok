/**
 * 회계: 위하고(더존) 공식 읽기 경로.
 *
 * 확인일 2026-09-14. wehago.com / developers.wehago.com 은 본 환경에서 차단. 검색 결과에서
 * 공식 개발자 포털·Open API 문서·전표 조회 API 존재를 확인하지 못했다(리플릿에 "Report 파일 또는 API 형태"
 * 언급만 발췌). 현재 계약·권한에서 이용 가능한 읽기 경로는 더존 담당자 확인이 필요하다(미확인).
 * 아래는 월 단위 자료(월간/누적 구분)를 받았을 때의 변환 규칙 검증만 수행한다.
 */

import { sub } from '../decimal';
import { type SourceSpec } from '../mapping';
import { check, type CheckResult } from '../reconcile';
import { loadSample } from '../samples';
import type { AccountingLine, LegalEntity } from '../types';

export const spec: SourceSpec = {
  sourceSystem: 'ACCOUNTING_WEHAGO',
  displayName: '위하고 회계 읽기 경로',
  docs: [
    { url: 'https://www.wehago.com/', checkedOn: '2026-09-14', access: 'BLOCKED' },
    {
      url: 'https://www.douzoneon.com/s1/down/wehago_leaflet.pdf',
      checkedOn: '2026-09-14',
      access: 'SEARCH_SNIPPET',
    },
  ],
  sourceTz: 'Asia/Seoul',
  keyFields: ['legalEntity', 'fiscalPeriod', 'accountCode', 'voucherId', 'lineId'],
  mappings: [
    {
      target: '공식 읽기 API 존재·자격',
      transform: 'derived',
      status: 'MISSING',
      note: '개발자 포털·API 문서 미확인. 계약 상품별 제공 범위는 더존 확인 필요',
    },
    {
      target: 'legalEntity / fiscalPeriod',
      transform: 'derived',
      status: 'ASSUMED',
      note: '회사코드·회계기간 컬럼 가정',
    },
    {
      target: 'accountCode / amount',
      transform: 'derived',
      status: 'ASSUMED',
      note: '계정코드·금액(차/대) 컬럼 가정',
    },
    {
      target: 'voucherId / lineId',
      transform: 'derived',
      status: 'ASSUMED',
      note: '전표번호·행번호 제공 시 함께 수집. 원장/손익 요약만 제공되면 없음',
    },
    {
      target: 'dataShape(MONTHLY/CUMULATIVE)',
      transform: 'derived',
      status: 'ASSUMED',
      note: '자료 형태를 사용자가 지정. 누적은 동일 기준 전월 누적이 있을 때만 차감',
    },
    {
      target: '원천 최신성',
      transform: 'derived',
      status: 'CONFIRMED',
      note: '사용자 확인 사항: 전표는 월 단위 정리 → 자동 조회 가능해도 자료 기준일은 전월 이하',
    },
  ],
};

interface WehagoSample {
  legalEntity: LegalEntity;
  lines: {
    fiscalPeriod: string;
    accountCode: string;
    amount: string;
    dataShape: 'MONTHLY' | 'CUMULATIVE';
  }[];
}

/**
 * 누적 → 월간 전환: 동일 기준 전월 누적이 있을 때만 차감한다.
 * 전월 누적이 없는 행은 임의 산출하지 않고 unconvertible 목록에 남긴다(사용자에게 자료 요청).
 */
export function toMonthly(lines: readonly AccountingLine[]): {
  monthly: AccountingLine[];
  unconvertible: string[];
} {
  const monthly: AccountingLine[] = [];
  const unconvertible: string[] = [];
  for (const l of lines) {
    if (l.dataShape === 'MONTHLY') {
      monthly.push(l);
      continue;
    }
    const [y, m] = l.fiscalPeriod.split('-').map(Number) as [number, number];
    if (m === 1) {
      monthly.push({ ...l, dataShape: 'MONTHLY' });
      continue;
    }
    const prevPeriod = `${y}-${String(m - 1).padStart(2, '0')}`;
    const prev = lines.find(
      (p) =>
        p.fiscalPeriod === prevPeriod &&
        p.accountCode === l.accountCode &&
        p.dataShape === 'CUMULATIVE' &&
        p.legalEntity === l.legalEntity,
    );
    if (!prev) {
      unconvertible.push(
        `전월 누적 없음: ${l.legalEntity} ${l.accountCode} ${l.fiscalPeriod} (필요: ${prevPeriod})`,
      );
      continue;
    }
    monthly.push({ ...l, amount: sub(l.amount, prev.amount), dataShape: 'MONTHLY' });
  }
  return { monthly, unconvertible };
}

export function runFixtureChecks(): CheckResult[] {
  const { data } = loadSample<WehagoSample>('accounting-wehago-placeholder.json');
  const lines: AccountingLine[] = data.lines.map((l) => ({
    legalEntity: data.legalEntity,
    fiscalPeriod: l.fiscalPeriod,
    accountCode: l.accountCode,
    amount: l.amount,
    dataShape: l.dataShape,
    version: 'run-1',
  }));
  const { monthly, unconvertible } = toMonthly(lines);
  const aug = monthly.find((l) => l.fiscalPeriod === '2026-08' && l.accountCode === '401');
  const monthlyLine = monthly.find((l) => l.accountCode === '501');
  return [
    check(
      'ACC-WHG-01',
      '누적 자료는 동일 기준 전월 누적과 차감해 월간 전환(§12-12)',
      aug !== undefined && aug.amount === '3000000',
      aug ? `8월 401 = ${aug.amount}` : '없음',
    ),
    check(
      'ACC-WHG-02',
      '전월 누적이 없는 행(7월 401)은 임의 산출하지 않고 전환 불가 목록으로 남김',
      unconvertible.length === 1 && (unconvertible[0] ?? '').includes('2026-07'),
      unconvertible.join('; '),
    ),
    check(
      'ACC-WHG-03',
      '월간 자료는 차감하지 않음',
      monthlyLine !== undefined && monthlyLine.amount === '450000',
      monthlyLine ? monthlyLine.amount : '없음',
    ),
    check(
      'ACC-WHG-04',
      '공식 읽기 경로·자격 미확인 → 접근 대기(실제 수집 미검증)',
      spec.mappings.some((m) => m.status === 'MISSING'),
      '더존 담당자 확인 필요',
    ),
  ];
}
