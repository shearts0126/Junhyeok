/**
 * 원본 ↔ 정규화 결과 건수·금액 대조.
 */

import { eq, sum } from './decimal';

export interface ReconcileResult {
  label: string;
  rawCount: number;
  normalizedCount: number;
  rawAmount: string;
  normalizedAmount: string;
  countMatch: boolean;
  amountMatch: boolean;
}

export function reconcile(
  label: string,
  rawAmounts: readonly string[],
  normalizedAmounts: readonly string[],
): ReconcileResult {
  const rawAmount = sum(rawAmounts);
  const normalizedAmount = sum(normalizedAmounts);
  return {
    label,
    rawCount: rawAmounts.length,
    normalizedCount: normalizedAmounts.length,
    rawAmount,
    normalizedAmount,
    countMatch: rawAmounts.length === normalizedAmounts.length,
    amountMatch: eq(rawAmount, normalizedAmount),
  };
}

export interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  /** 가상 데이터 기반 검증인지 여부. true 면 실제 연동 성공으로 보고하지 않는다. */
  synthetic: boolean;
}

export function check(
  id: string,
  title: string,
  passed: boolean,
  detail: string,
  synthetic = true,
): CheckResult {
  return { id, title, passed, detail, synthetic };
}
