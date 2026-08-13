'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { supplyTypeLabel } from '@/modules/supplier/presentation/supply-type';

import { readApiError, type UiError } from '../../skus/sku-ui';
import { formatOptionalText } from '../list-params';

import {
  buildPriceApprovePayload,
  buildPriceCreatePayload,
  EMPTY_PRICE_CREATE_FORM,
  isPricePending,
  priceApprovalLabel,
  type PriceCreateForm,
} from './price-form';
import { Dialog, DialogActions, TextInput } from './terms-tab';
import type {
  PriceItem,
  PriceListResponse,
  SupplierSkuItem,
  SupplierSkuListResponse,
} from './types';

/**
 * 가격이력 탭 (T06-4, D-21 ~ D-25).
 *
 * 가격 API 는 **SupplierSku 기준**이라 먼저 공급조건을 선택해야 한다 (D-22).
 * 선택은 URL `supplierSkuId` 로 유지돼 새로고침·공유가 복원된다.
 *
 * - 승인 상태는 **`approvedBy` 로만 파생**한다 — DB 에 `approvalStatus` 가 없다 (D-25).
 * - 등록은 **미승인 제안행**을 만들 뿐이며, 유효단가 반영은 승인 시점이다 —
 *   dialog 에 그 사실을 명시한다 (T06-3 등록/발효 분리).
 * - 승인 버튼은 **미승인 + `supplier_price.approve`** 일 때만 보인다. 이미
 *   승인된 행에는 버튼이 없다 (D-24).
 * - 자가승인 금지는 backend 가 최종 판정한다 — 설정을 UI 가 미리 조회해
 *   버튼을 선제적으로 숨기지 않는다 (§42).
 *
 * ⛔ 없는 것: `asOf` 검색·현재 유효단가 카드·시뮬레이션(§43) · 첨부 필드(D-26) ·
 *    `effectiveTo` 입력(server-owned) · 가격 pagination(API 에 없음, D-32).
 */

export function PricesTab({
  supplierId,
  selectedSupplierSkuId,
  permissions,
  onSelect,
  onError,
}: {
  supplierId: string;
  selectedSupplierSkuId: string;
  permissions: readonly string[] | null;
  onSelect: (supplierSkuId: string) => void;
  onError: (error: UiError | null) => void;
}) {
  const canCreate = permissions?.includes('supplier_price.create') ?? false;
  const canApprove = permissions?.includes('supplier_price.approve') ?? false;

  const [terms, setTerms] = useState<SupplierSkuListResponse | null>(null);
  const [prices, setPrices] = useState<readonly PriceItem[] | null>(null);
  const [priceState, setPriceState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [createForm, setCreateForm] = useState<PriceCreateForm | null>(null);
  const [createKey, setCreateKey] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<PriceItem | null>(null);
  const [approveNote, setApproveNote] = useState('');

  // 공급조건 selector — 전체 table 을 복제하지 않고 최소 열만 쓴다 (§35).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/suppliers/${supplierId}/skus`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        setTerms((await response.json()) as SupplierSkuListResponse);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  // ★ 선택 변경 시 상태 전환은 render 중 조정 (effect 안 setState 금지 규칙).
  const priceRequestKey = `${selectedSupplierSkuId}:${reloadToken}`;
  const [lastPriceKey, setLastPriceKey] = useState<string | null>(null);
  if (lastPriceKey !== priceRequestKey) {
    setLastPriceKey(priceRequestKey);
    if (selectedSupplierSkuId === '') {
      setPrices(null);
      setPriceState('idle');
    } else {
      setPriceState('loading');
    }
  }

  useEffect(() => {
    if (selectedSupplierSkuId === '') return;
    let cancelled = false;
    fetch(`/api/supplier-skus/${selectedSupplierSkuId}/prices`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setPriceState('error');
          onError(await readApiError(response));
          return;
        }
        setPrices(((await response.json()) as PriceListResponse).prices);
        setPriceState('ready');
      })
      .catch(() => {
        if (!cancelled) setPriceState('error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSupplierSkuId, reloadToken]);

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  async function submitCreate(): Promise<void> {
    if (createForm === null || selectedSupplierSkuId === '') return;
    const key = createKey ?? crypto.randomUUID();
    if (createKey === null) setCreateKey(key);
    setBusy(true);
    try {
      const response = await fetch(`/api/supplier-skus/${selectedSupplierSkuId}/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(buildPriceCreatePayload(createForm)),
      });
      if (!response.ok) {
        onError(await readApiError(response));
        return;
      }
      setCreateForm(null);
      setCreateKey(null);
      onError(null);
      refetch();
    } finally {
      setBusy(false);
    }
  }

  /** ⛔ approve 에는 Idempotency-Key 를 붙이지 않는다 — repeat approve 가 자연 멱등이다. */
  async function submitApprove(): Promise<void> {
    if (approveTarget === null) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/supplier-sku-prices/${approveTarget.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPriceApprovePayload(approveNote)),
      });
      if (!response.ok) {
        // SELF_APPROVAL_FORBIDDEN 도 이 배너로 보인다 (§42).
        onError(await readApiError(response));
        return;
      }
      setApproveTarget(null);
      setApproveNote('');
      onError(null);
      refetch();
    } finally {
      setBusy(false);
    }
  }

  const termItems: readonly SupplierSkuItem[] = terms?.items ?? [];
  const selected = termItems.find((item) => item.id === selectedSupplierSkuId) ?? null;

  return (
    <section aria-label="가격이력" className="space-y-4" data-testid="panel-prices">
      {/* 공급조건 선택 */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium">공급조건 선택</h2>
        {termItems.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="price-terms-empty">
            등록된 공급조건이 없습니다.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="price-terms-table">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">공급유형</th>
                  <th className="px-3 py-2 font-medium">적용 시작일</th>
                  <th className="px-3 py-2 font-medium">적용 종료일(미포함)</th>
                  <th className="px-3 py-2 font-medium">가격이력</th>
                </tr>
              </thead>
              <tbody>
                {termItems.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-t ${row.id === selectedSupplierSkuId ? 'bg-muted/30' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs">{row.sku.skuCode}</span>
                      <span className="text-muted-foreground block text-xs">{row.sku.skuName}</span>
                    </td>
                    <td className="px-3 py-2">{supplyTypeLabel(row.supplyType)}</td>
                    <td className="px-3 py-2">{row.effectiveFrom}</td>
                    <td className="px-3 py-2">{row.effectiveTo ?? '—'}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        data-testid="price-view-button"
                        className="text-xs underline underline-offset-2"
                        onClick={() => onSelect(row.id)}
                      >
                        가격이력 보기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 가격이력 */}
      {selectedSupplierSkuId === '' ? (
        <p className="text-muted-foreground text-sm" data-testid="price-no-selection">
          가격이력을 확인할 공급조건을 선택하세요.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium">
              가격이력
              {selected !== null && (
                <span className="text-muted-foreground ml-2 font-normal">
                  {selected.sku.skuCode} · {selected.effectiveFrom} 시작 공급조건
                </span>
              )}
            </h2>
            {canCreate && (
              <Button
                size="sm"
                data-testid="new-price-button"
                onClick={() => {
                  setCreateForm(EMPTY_PRICE_CREATE_FORM);
                  setCreateKey(null);
                }}
              >
                가격 등록
              </Button>
            )}
          </div>

          {priceState === 'loading' && (
            <p data-testid="price-loading" className="text-muted-foreground text-sm">
              불러오는 중…
            </p>
          )}

          {priceState === 'ready' && (prices?.length ?? 0) === 0 && (
            <p data-testid="price-empty" className="text-muted-foreground text-sm">
              등록된 가격이력이 없습니다.
            </p>
          )}

          {priceState === 'ready' && (prices?.length ?? 0) > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm" data-testid="price-table">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">적용 시작일</th>
                    <th className="px-3 py-2 font-medium">적용 종료일(미포함)</th>
                    <th className="px-3 py-2 font-medium">단가</th>
                    <th className="px-3 py-2 font-medium">통화</th>
                    <th className="px-3 py-2 font-medium">VAT 포함</th>
                    <th className="px-3 py-2 font-medium">승인상태</th>
                    <th className="px-3 py-2 font-medium">출처문서</th>
                    <th className="px-3 py-2 font-medium">생성일</th>
                    <th className="px-3 py-2 font-medium">관리</th>
                  </tr>
                </thead>
                <tbody>
                  {(prices ?? []).map((row) => (
                    <tr
                      key={row.id}
                      className="border-t"
                      data-testid="price-row"
                      data-effective-from={row.effectiveFrom}
                    >
                      <td className="px-3 py-2">{row.effectiveFrom}</td>
                      <td className="px-3 py-2">{row.effectiveTo ?? '—'}</td>
                      {/* ★ Decimal 문자열 그대로 — "0" 도 실재하는 0원 가격이다. */}
                      <td className="px-3 py-2 font-mono text-xs" data-testid="price-unit-price">
                        {row.unitPrice}
                      </td>
                      <td className="px-3 py-2">{row.currency}</td>
                      <td className="px-3 py-2">{row.vatIncluded ? '포함' : '미포함'}</td>
                      <td className="px-3 py-2" data-testid="price-approval-state">
                        {priceApprovalLabel(row.approvedBy)}
                      </td>
                      <td className="px-3 py-2">{formatOptionalText(row.sourceDocument)}</td>
                      <td className="px-3 py-2 text-xs">{row.createdAt}</td>
                      <td className="px-3 py-2">
                        {isPricePending(row.approvedBy) && canApprove && (
                          <button
                            type="button"
                            data-testid="price-approve-button"
                            className="text-xs underline underline-offset-2"
                            onClick={() => {
                              setApproveTarget(row);
                              setApproveNote('');
                            }}
                          >
                            승인
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 가격 등록 */}
      {createForm !== null && (
        <Dialog label="가격 등록" testId="price-create-dialog">
          <p className="text-muted-foreground text-xs" data-testid="price-pending-notice">
            등록된 가격은 승인 전까지 현재 유효단가에 반영되지 않습니다.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput
              label="단가"
              required
              testId="price-unit-price-input"
              hint="소수점 문자열 그대로 입력합니다. 0 도 유효한 단가입니다."
              value={createForm.unitPrice}
              onChange={(value) => setCreateForm({ ...createForm, unitPrice: value })}
            />
            <TextInput
              label="통화"
              required
              testId="price-currency-input"
              value={createForm.currency}
              onChange={(value) => setCreateForm({ ...createForm, currency: value })}
            />
            <TextInput
              label="적용 시작일"
              required
              type="date"
              testId="price-effective-from"
              hint="과거 소급·미래 예약 모두 등록할 수 있습니다."
              value={createForm.effectiveFrom}
              onChange={(value) => setCreateForm({ ...createForm, effectiveFrom: value })}
            />
            <TextInput
              label="출처문서"
              testId="price-source-document"
              value={createForm.sourceDocument}
              onChange={(value) => setCreateForm({ ...createForm, sourceDocument: value })}
            />
            <label className="flex items-center gap-2 text-xs sm:col-span-2">
              <input
                type="checkbox"
                checked={createForm.vatIncluded}
                onChange={(event) =>
                  setCreateForm({ ...createForm, vatIncluded: event.target.checked })
                }
                aria-label="VAT 포함"
                data-testid="price-vat-included"
              />
              <span>VAT 포함 단가</span>
            </label>
          </div>
          <DialogActions
            busy={busy}
            submitTestId="price-create-submit"
            disabled={createForm.unitPrice.trim() === '' || createForm.effectiveFrom === ''}
            onCancel={() => {
              setCreateForm(null);
              setCreateKey(null);
            }}
            onSubmit={() => void submitCreate()}
          />
        </Dialog>
      )}

      {/* 가격 승인 */}
      {approveTarget !== null && (
        <Dialog label="가격 승인" testId="price-approve-dialog">
          <p className="text-muted-foreground text-xs">
            {approveTarget.effectiveFrom} 시작 · 단가 {approveTarget.unitPrice}{' '}
            {approveTarget.currency}
          </p>
          <p className="text-muted-foreground text-xs" data-testid="price-approve-notice">
            승인 시 적용일 기준으로 가격이력이 재구성됩니다.
          </p>
          <TextInput
            label="메모"
            testId="price-approve-note"
            hint="감사로그 사유로 기록됩니다. 비워 둘 수 있습니다."
            value={approveNote}
            onChange={setApproveNote}
          />
          <DialogActions
            busy={busy}
            submitTestId="price-approve-submit"
            submitLabel="승인"
            onCancel={() => setApproveTarget(null)}
            onSubmit={() => void submitApprove()}
          />
        </Dialog>
      )}
    </section>
  );
}
