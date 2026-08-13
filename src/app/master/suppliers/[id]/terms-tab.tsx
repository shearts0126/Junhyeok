'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  SUPPLY_TYPE_LABELS,
  SUPPLY_TYPE_VALUES,
  supplyTypeLabel,
  type SupplyTypeValue,
} from '@/modules/supplier/presentation/supply-type';

import { readApiError, type UiError } from '../../skus/sku-ui';
import { formatLeadTimeDays, formatOptionalText } from '../list-params';

import {
  buildTermClosePayload,
  buildTermCreatePayload,
  buildTermVersionPayload,
  canSubmitVersion,
  EMPTY_TERM_CREATE_FORM,
  toVersionForm,
  type SupplierSkuCreateForm,
  type SupplierSkuVersionForm,
} from './terms-form';
import type { SkuOption, SupplierSkuItem, SupplierSkuListResponse } from './types';

/**
 * 공급조건 탭 (T06-4, D-11 ~ D-19).
 *
 * ## "수정" 버튼이 없다
 *
 * backend 는 제자리 수정을 400 으로 거부한다 — 공급조건은 effective-dated
 * history 이기 때문이다. 그래서 action 이 정확히 둘이다 (D-17·D-18):
 *
 *   - **기간 종료/단축** — body 정확히 `{effectiveTo}`
 *   - **새 버전 생성** — `effectiveFrom` + 변경 필드, 기존 row 는 그 날짜에 닫히고
 *     후속 version row 가 새로 생긴다
 *
 * 과거·현재·미래 어느 row 도 business field 를 제자리에서 덮어쓸 수 없다 (D-19).
 *
 * - 목록은 **과거+현재+미래 전부**를 backend 정렬(`effectiveFrom DESC, id DESC`)
 *   그대로 한 표에 보여준다. ⛔ speculative 현재/예정/종료 badge 를 만들지
 *   않는다 — backend 에 파생 상태 필드가 없다 (D-12).
 * - 리드타임은 **입력값과 적용값을 분리**한다 — `0` 을 `—` 로 표시하지 않는다 (D-13).
 * - `moq`·`orderMultiple` 은 Decimal 문자열 그대로다 (D-15).
 * - 우선공급업체는 checkbox 이며 다른 행을 자동 해제하지 않는다 — 충돌은
 *   backend 409 를 그대로 보여준다 (D-16).
 */

const PAGE_SIZE_HINT = '한 페이지에 50건씩 표시합니다.';

export function TermsTab({
  supplierId,
  page,
  permissions,
  onPageChange,
  onError,
}: {
  supplierId: string;
  page: number;
  permissions: readonly string[] | null;
  onPageChange: (page: number) => void;
  onError: (error: UiError | null) => void;
}) {
  const canCreate = permissions?.includes('supplier.create') ?? false;
  const canUpdate = permissions?.includes('supplier.update') ?? false;

  const [result, setResult] = useState<SupplierSkuListResponse | null>(null);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [createForm, setCreateForm] = useState<SupplierSkuCreateForm | null>(null);
  const [createKey, setCreateKey] = useState<string | null>(null);
  const [skuQuery, setSkuQuery] = useState('');
  const [skuOptions, setSkuOptions] = useState<readonly SkuOption[]>([]);

  const [closeTarget, setCloseTarget] = useState<SupplierSkuItem | null>(null);
  const [closeDate, setCloseDate] = useState('');

  const [versionTarget, setVersionTarget] = useState<SupplierSkuItem | null>(null);
  const [versionForm, setVersionForm] = useState<SupplierSkuVersionForm | null>(null);

  // ★ loading 전환은 render 중 상태 조정 (effect 안 setState 금지 규칙).
  const requestKey = `${supplierId}:${page}:${reloadToken}`;
  const [lastRequestKey, setLastRequestKey] = useState<string | null>(null);
  if (lastRequestKey !== requestKey) {
    setLastRequestKey(requestKey);
    setListState('loading');
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/suppliers/${supplierId}/skus?page=${page}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setListState('error');
          onError(await readApiError(response));
          return;
        }
        setResult((await response.json()) as SupplierSkuListResponse);
        setListState('ready');
      })
      .catch(() => {
        if (!cancelled) setListState('error');
      });
    return () => {
      cancelled = true;
    };
    // onError 는 setState 라 참조가 안정적이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId, page, reloadToken]);

  // SKU lookup — 기존 `/api/skus` 재사용. ⛔ 신규 supporting API 를 만들지 않는다.
  useEffect(() => {
    if (createForm === null) return;
    let cancelled = false;
    const query = skuQuery.trim() === '' ? '' : `&q=${encodeURIComponent(skuQuery.trim())}`;
    fetch(`/api/skus?pageSize=20${query}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { items: SkuOption[] };
        if (!cancelled) setSkuOptions(body.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [skuQuery, createForm]);

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  async function submitCreate(): Promise<void> {
    if (createForm === null) return;
    const key = createKey ?? crypto.randomUUID();
    if (createKey === null) setCreateKey(key);
    setBusy(true);
    try {
      const response = await fetch(`/api/suppliers/${supplierId}/skus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(buildTermCreatePayload(createForm)),
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

  /** ⛔ PATCH 에는 Idempotency-Key 를 붙이지 않는다 — 멱등 계약이 없다 (§32). */
  async function patchTerm(id: string, payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch(`/api/supplier-skus/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        onError(await readApiError(response));
        return false;
      }
      onError(null);
      refetch();
      return true;
    } finally {
      setBusy(false);
    }
  }

  const items = result?.items ?? [];
  const totalPages = result?.totalPages ?? 1;

  return (
    <section aria-label="공급조건" className="space-y-4" data-testid="panel-terms">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          과거·현재·미래 공급조건을 모두 표시합니다(적용 시작일 최신순). {PAGE_SIZE_HINT} 조건을
          바꾸려면 <strong>새 버전 생성</strong>, 기간을 끝내려면 <strong>기간 종료/단축</strong>을
          사용하세요 — 기존 이력은 덮어쓰지 않습니다.
        </p>
        {canCreate && (
          <Button
            size="sm"
            data-testid="new-term-button"
            onClick={() => {
              setCreateForm(EMPTY_TERM_CREATE_FORM);
              setCreateKey(null);
              setSkuQuery('');
            }}
          >
            공급조건 추가
          </Button>
        )}
      </div>

      {listState === 'loading' && (
        <p data-testid="terms-loading" className="text-muted-foreground text-sm">
          불러오는 중…
        </p>
      )}

      {listState === 'ready' && items.length === 0 && (
        <p data-testid="terms-empty" className="text-muted-foreground text-sm">
          등록된 공급조건이 없습니다.
        </p>
      )}

      {listState === 'ready' && items.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="terms-table">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">공급처 상품코드</th>
                <th className="px-3 py-2 font-medium">공급처 상품명</th>
                <th className="px-3 py-2 font-medium">공급유형</th>
                <th className="px-3 py-2 font-medium">MOQ</th>
                <th className="px-3 py-2 font-medium">발주배수</th>
                <th className="px-3 py-2 font-medium">입력 리드타임</th>
                <th className="px-3 py-2 font-medium">적용 리드타임</th>
                <th className="px-3 py-2 font-medium">구매단위</th>
                <th className="px-3 py-2 font-medium">통화</th>
                <th className="px-3 py-2 font-medium">우선공급업체</th>
                <th className="px-3 py-2 font-medium">적용 시작일</th>
                <th className="px-3 py-2 font-medium">적용 종료일(미포함)</th>
                <th className="px-3 py-2 font-medium">관리</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} className="border-t" data-testid="term-row">
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{row.sku.skuCode}</span>
                    <span className="text-muted-foreground block text-xs">{row.sku.skuName}</span>
                  </td>
                  <td className="px-3 py-2">{formatOptionalText(row.supplierSkuCode)}</td>
                  <td className="px-3 py-2">{formatOptionalText(row.supplierSkuName)}</td>
                  <td className="px-3 py-2" data-testid="term-supply-type">
                    {supplyTypeLabel(row.supplyType)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs" data-testid="term-moq">
                    {formatOptionalText(row.moq)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatOptionalText(row.orderMultiple)}
                  </td>
                  <td className="px-3 py-2" data-testid="term-lead-time">
                    {formatLeadTimeDays(row.leadTimeDays)}
                  </td>
                  <td className="px-3 py-2" data-testid="term-effective-lead-time">
                    {formatLeadTimeDays(row.effectiveLeadTimeDays)}
                  </td>
                  <td className="px-3 py-2">{formatOptionalText(row.purchaseUom)}</td>
                  <td className="px-3 py-2">{row.currency}</td>
                  <td className="px-3 py-2">{row.isPrimary ? '예' : '—'}</td>
                  <td className="px-3 py-2">{row.effectiveFrom}</td>
                  <td className="px-3 py-2">{row.effectiveTo ?? '—'}</td>
                  <td className="px-3 py-2">
                    {canUpdate && (
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          data-testid="term-close-button"
                          className="text-xs underline underline-offset-2"
                          onClick={() => {
                            setCloseTarget(row);
                            setCloseDate(row.effectiveTo ?? '');
                          }}
                        >
                          기간 종료/단축
                        </button>
                        <button
                          type="button"
                          data-testid="term-version-button"
                          className="text-xs underline underline-offset-2"
                          onClick={() => {
                            setVersionTarget(row);
                            setVersionForm(toVersionForm(row));
                          }}
                        >
                          새 버전 생성
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {listState === 'ready' && result !== null && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            전체 {result.total}건 · {result.page}/{Math.max(totalPages, 1)} 페이지
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              이전
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
            >
              다음
            </Button>
          </div>
        </div>
      )}

      {/* ── 공급조건 추가 ─────────────────────────────────────── */}
      {createForm !== null && (
        <Dialog label="공급조건 추가" testId="term-create-dialog">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs sm:col-span-2">
              <span className="text-muted-foreground">
                SKU <span className="text-destructive">*</span>
              </span>
              <input
                type="search"
                value={skuQuery}
                onChange={(event) => setSkuQuery(event.target.value)}
                placeholder="SKU 코드·상품명 검색"
                aria-label="SKU 검색"
                data-testid="term-sku-search"
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
              <select
                value={createForm.skuId}
                onChange={(event) => {
                  const option = skuOptions.find((sku) => sku.id === event.target.value);
                  setCreateForm({
                    ...createForm,
                    skuId: event.target.value,
                    skuLabel: option === undefined ? '' : `${option.skuCode} — ${option.skuName}`,
                  });
                }}
                aria-label="SKU 선택"
                data-testid="term-sku-select"
                className="bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="">SKU 를 선택하세요</option>
                {skuOptions.map((sku) => (
                  <option key={sku.id} value={sku.id}>
                    {sku.skuCode} — {sku.skuName}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">
                공급유형 <span className="text-destructive">*</span>
              </span>
              <select
                value={createForm.supplyType}
                onChange={(event) =>
                  setCreateForm({
                    ...createForm,
                    supplyType: event.target.value as SupplyTypeValue,
                  })
                }
                aria-label="공급유형"
                data-testid="term-supply-type-input"
                className="bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                {SUPPLY_TYPE_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {SUPPLY_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>

            <TextInput
              label="적용 시작일"
              required
              type="date"
              testId="term-effective-from"
              value={createForm.effectiveFrom}
              onChange={(value) => setCreateForm({ ...createForm, effectiveFrom: value })}
            />
            <TextInput
              label="공급처 상품코드"
              testId="term-supplier-sku-code"
              value={createForm.supplierSkuCode}
              onChange={(value) => setCreateForm({ ...createForm, supplierSkuCode: value })}
            />
            <TextInput
              label="공급처 상품명"
              testId="term-supplier-sku-name"
              value={createForm.supplierSkuName}
              onChange={(value) => setCreateForm({ ...createForm, supplierSkuName: value })}
            />
            <TextInput
              label="MOQ"
              testId="term-moq-input"
              hint="소수점 문자열 그대로 입력합니다. 0 은 사용할 수 없습니다."
              value={createForm.moq}
              onChange={(value) => setCreateForm({ ...createForm, moq: value })}
            />
            <TextInput
              label="발주배수"
              testId="term-order-multiple"
              value={createForm.orderMultiple}
              onChange={(value) => setCreateForm({ ...createForm, orderMultiple: value })}
            />
            <TextInput
              label="리드타임(일)"
              testId="term-lead-time-input"
              hint="비우면 거래처 기본값을 따르고, 0 은 즉시납입니다."
              value={createForm.leadTimeDays}
              onChange={(value) => setCreateForm({ ...createForm, leadTimeDays: value })}
            />
            <TextInput
              label="구매단위"
              testId="term-purchase-uom"
              value={createForm.purchaseUom}
              onChange={(value) => setCreateForm({ ...createForm, purchaseUom: value })}
            />
            <TextInput
              label="통화"
              testId="term-currency"
              hint="비우면 기본 통화가 적용됩니다."
              value={createForm.currency}
              onChange={(value) => setCreateForm({ ...createForm, currency: value })}
            />
            <TextInput
              label="적용 종료일(미포함)"
              type="date"
              testId="term-effective-to"
              hint="해당 일자부터 미적용입니다. 비우면 종료일 없음입니다."
              value={createForm.effectiveTo}
              onChange={(value) => setCreateForm({ ...createForm, effectiveTo: value })}
            />
            <label className="flex items-center gap-2 text-xs sm:col-span-2">
              <input
                type="checkbox"
                checked={createForm.isPrimary}
                onChange={(event) =>
                  setCreateForm({ ...createForm, isPrimary: event.target.checked })
                }
                aria-label="우선공급업체"
                data-testid="term-is-primary"
              />
              <span>우선공급업체로 지정</span>
            </label>
          </div>
          <p className="text-muted-foreground text-xs">
            이미 현행 우선공급업체가 있으면 자동으로 교체하지 않고 오류로 알려줍니다.
          </p>
          <DialogActions
            busy={busy}
            submitTestId="term-create-submit"
            onCancel={() => {
              setCreateForm(null);
              setCreateKey(null);
            }}
            onSubmit={() => void submitCreate()}
            disabled={createForm.skuId === '' || createForm.effectiveFrom === ''}
          />
        </Dialog>
      )}

      {/* ── mode A — 기간 종료/단축 ───────────────────────────── */}
      {closeTarget !== null && (
        <Dialog label="기간 종료/단축" testId="term-close-dialog">
          <p className="text-muted-foreground text-xs">
            {closeTarget.sku.skuCode} · 적용 시작일 {closeTarget.effectiveFrom}
          </p>
          <TextInput
            label="적용 종료일(미포함)"
            required
            type="date"
            testId="term-close-date"
            hint="종료일은 해당 일자부터 미적용됩니다. 기존 종료일을 앞당길 수만 있습니다."
            value={closeDate}
            onChange={setCloseDate}
          />
          <DialogActions
            busy={busy}
            submitTestId="term-close-submit"
            disabled={closeDate.trim() === ''}
            onCancel={() => setCloseTarget(null)}
            onSubmit={() => {
              void patchTerm(closeTarget.id, buildTermClosePayload(closeDate)).then((ok) => {
                if (ok) setCloseTarget(null);
              });
            }}
          />
        </Dialog>
      )}

      {/* ── mode B — 새 버전 생성 ─────────────────────────────── */}
      {versionTarget !== null && versionForm !== null && (
        <Dialog label="새 버전 생성" testId="term-version-dialog">
          <p className="text-muted-foreground text-xs">
            기존 조건은 새 시작일에 종료되고 후속 버전이 새로 만들어집니다. 기존 이력은 수정되지
            않습니다.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">SKU</span>
              <input
                type="text"
                value={`${versionTarget.sku.skuCode} — ${versionTarget.sku.skuName}`}
                readOnly
                aria-label="SKU"
                data-testid="version-sku-readonly"
                className="bg-muted/40 text-muted-foreground h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
            <TextInput
              label="새 적용 시작일"
              required
              type="date"
              testId="version-effective-from"
              value={versionForm.effectiveFrom}
              onChange={(value) => setVersionForm({ ...versionForm, effectiveFrom: value })}
            />
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">공급유형</span>
              <select
                value={versionForm.supplyType}
                onChange={(event) =>
                  setVersionForm({
                    ...versionForm,
                    supplyType: event.target.value as SupplyTypeValue,
                  })
                }
                aria-label="공급유형"
                className="bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                {SUPPLY_TYPE_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {SUPPLY_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <TextInput
              label="공급처 상품코드"
              testId="version-supplier-sku-code"
              value={versionForm.supplierSkuCode}
              onChange={(value) => setVersionForm({ ...versionForm, supplierSkuCode: value })}
            />
            <TextInput
              label="공급처 상품명"
              value={versionForm.supplierSkuName}
              testId="version-supplier-sku-name"
              onChange={(value) => setVersionForm({ ...versionForm, supplierSkuName: value })}
            />
            <TextInput
              label="MOQ"
              testId="version-moq"
              value={versionForm.moq}
              onChange={(value) => setVersionForm({ ...versionForm, moq: value })}
            />
            <TextInput
              label="발주배수"
              testId="version-order-multiple"
              value={versionForm.orderMultiple}
              onChange={(value) => setVersionForm({ ...versionForm, orderMultiple: value })}
            />
            <TextInput
              label="리드타임(일)"
              testId="version-lead-time"
              value={versionForm.leadTimeDays}
              onChange={(value) => setVersionForm({ ...versionForm, leadTimeDays: value })}
            />
            <TextInput
              label="구매단위"
              testId="version-purchase-uom"
              value={versionForm.purchaseUom}
              onChange={(value) => setVersionForm({ ...versionForm, purchaseUom: value })}
            />
            <TextInput
              label="통화"
              testId="version-currency"
              value={versionForm.currency}
              onChange={(value) => setVersionForm({ ...versionForm, currency: value })}
            />
            <TextInput
              label="적용 종료일(미포함)"
              type="date"
              testId="version-effective-to"
              hint="해당 일자부터 미적용입니다."
              value={versionForm.effectiveTo}
              onChange={(value) => setVersionForm({ ...versionForm, effectiveTo: value })}
            />
            <label className="flex items-center gap-2 text-xs sm:col-span-2">
              <input
                type="checkbox"
                checked={versionForm.isPrimary}
                onChange={(event) =>
                  setVersionForm({ ...versionForm, isPrimary: event.target.checked })
                }
                aria-label="우선공급업체"
                data-testid="version-is-primary"
              />
              <span>우선공급업체로 지정</span>
            </label>
          </div>
          <DialogActions
            busy={busy}
            submitTestId="term-version-submit"
            disabled={!canSubmitVersion(versionForm, versionTarget)}
            onCancel={() => {
              setVersionTarget(null);
              setVersionForm(null);
            }}
            onSubmit={() => {
              void patchTerm(
                versionTarget.id,
                buildTermVersionPayload(versionForm, versionTarget),
              ).then((ok) => {
                if (ok) {
                  setVersionTarget(null);
                  setVersionForm(null);
                }
              });
            }}
          />
        </Dialog>
      )}
    </section>
  );
}

export function Dialog({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid={testId}
      className="bg-background/80 fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6"
    >
      <div className="bg-card w-full max-w-2xl space-y-4 rounded-md border p-6 shadow-lg">
        <h2 className="text-lg font-semibold">{label}</h2>
        {children}
      </div>
    </div>
  );
}

export function DialogActions({
  busy,
  onCancel,
  onSubmit,
  submitTestId,
  disabled = false,
  submitLabel = '저장',
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  submitTestId: string;
  disabled?: boolean;
  submitLabel?: string;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="outline" onClick={onCancel}>
        취소
      </Button>
      <Button size="sm" data-testid={submitTestId} disabled={busy || disabled} onClick={onSubmit}>
        {busy ? '처리 중…' : submitLabel}
      </Button>
    </div>
  );
}

export function TextInput({
  label,
  value,
  onChange,
  testId,
  required = false,
  hint,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
  required?: boolean;
  hint?: string;
  type?: 'text' | 'date';
}) {
  return (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        data-testid={testId}
        className="bg-background h-9 w-full rounded-md border px-3 text-sm"
      />
      {hint !== undefined && <span className="text-muted-foreground block">{hint}</span>}
    </label>
  );
}
