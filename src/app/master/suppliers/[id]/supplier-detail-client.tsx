'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

import { ErrorBanner, readApiError, usePermissions, type UiError } from '../../skus/sku-ui';
import { formatLeadTimeDays, formatOptionalText, SUPPLIER_TYPE_SUGGESTIONS } from '../list-params';
import {
  buildSupplierUpdatePayload,
  hasSupplierChanges,
  toSupplierEditForm,
  type SupplierEditForm,
} from '../supplier-form';

import {
  buildSupplierDetailParams,
  readSupplierDetailState,
  SUPPLIER_DETAIL_TAB_LABELS,
  SUPPLIER_DETAIL_TABS,
  type SupplierDetailPatch,
  type SupplierDetailTab,
} from './detail-params';
import { PricesTab } from './prices-tab';
import { TermsTab } from './terms-tab';
import type { SupplierDetail } from './types';

/**
 * 거래처 상세 화면 `SUP-DETAIL-001` (T06-4, D-7·D-8·D-10).
 *
 * ⚠️ 근거: `docs/17_설계복구_거래처공급조건.md` §80~.
 *
 * - **탭 3개 고정**: 기본정보 · 공급조건 · 가격이력. 탭·선택 상태는 URL query
 *   (`tab`·`termsPage`·`supplierSkuId`)로 유지한다 — 이 값을 API 로 보내지 않는다.
 * - 기본정보는 supporting API `GET /api/suppliers/{id}` 로 직접 읽는다 —
 *   새로고침·deep-link 가 목록 cache 없이 성립한다 (D-9).
 * - `supplierCode` 는 항상 표시하되 **immutable** 이고, `status` 는 **표시 전용**
 *   이다 — 상태 변경·비활성화·폐기 버튼을 만들지 않는다 (D-7·D-8).
 * - 가격이력 탭은 `supplier_price.read` 가 있을 때만 노출한다 — 진입 권한
 *   (`supplier.read`)과 **합치지 않는다** (D-28).
 *
 * ⛔ 창고 필드 없음(D-20) · 첨부 없음(D-26) · BOM 링크 없음(T07).
 */

export function SupplierDetailClient({ supplierId }: { supplierId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => readSupplierDetailState(searchParams), [searchParams]);
  const permissions = usePermissions();

  const canRead = permissions?.includes('supplier.read') ?? false;
  const canUpdate = permissions?.includes('supplier.update') ?? false;
  const canReadPrice = permissions?.includes('supplier_price.read') ?? false;

  const [supplier, setSupplier] = useState<SupplierDetail | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<UiError | null>(null);
  const [editForm, setEditForm] = useState<SupplierEditForm | null>(null);
  const [busy, setBusy] = useState(false);

  // ★ loading 전환은 render 중 상태 조정 (effect 안 setState 금지 규칙).
  const [lastSupplierId, setLastSupplierId] = useState<string | null>(null);
  if (lastSupplierId !== supplierId) {
    setLastSupplierId(supplierId);
    setLoadState('loading');
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/suppliers/${supplierId}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const uiError = await readApiError(response);
          if (cancelled) return;
          setLoadState(response.status === 403 ? 'forbidden' : 'error');
          setError(uiError);
          setSupplier(null);
          return;
        }
        const body = (await response.json()) as { supplier: SupplierDetail };
        if (cancelled) return;
        setSupplier(body.supplier);
        setError(null);
        setLoadState('ready');
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  function apply(patch: SupplierDetailPatch): void {
    const next = buildSupplierDetailParams(searchParams, patch);
    const query = next.toString();
    router.push(query === '' ? pathname : `${pathname}?${query}`);
  }

  async function submitEdit(): Promise<void> {
    if (editForm === null || supplier === null) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/suppliers/${supplierId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSupplierUpdatePayload(editForm, supplier)),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as { supplier: SupplierDetail };
      setSupplier(body.supplier);
      setEditForm(null);
      setError(null);
    } finally {
      setBusy(false);
    }
  }

  // 가격 탭 권한이 없으면 탭 자체를 노출하지 않는다.
  const visibleTabs: readonly SupplierDetailTab[] = SUPPLIER_DETAIL_TABS.filter(
    (tab) => tab !== 'prices' || canReadPrice,
  );
  const activeTab: SupplierDetailTab = visibleTabs.includes(state.tab) ? state.tab : 'basic';

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-10">
      <nav className="text-muted-foreground text-sm">
        <Link href="/master/suppliers" className="underline underline-offset-2">
          거래처 관리
        </Link>
        <span> / 상세</span>
      </nav>

      {error !== null && loadState !== 'forbidden' && (
        <ErrorBanner error={error} onClose={() => setError(null)} />
      )}

      {permissions !== null && !canRead && (
        <div
          role="alert"
          data-testid="forbidden-state"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          거래처 조회 권한(<span className="font-mono">supplier.read</span>)이 없습니다.
        </div>
      )}

      {loadState === 'loading' && (
        <p data-testid="detail-loading" className="text-muted-foreground text-sm">
          불러오는 중…
        </p>
      )}

      {loadState === 'forbidden' && (
        <p data-testid="detail-forbidden" className="text-sm">
          조회 권한이 없어 거래처를 표시할 수 없습니다. (403)
        </p>
      )}

      {loadState === 'error' && supplier === null && (
        <p data-testid="detail-error" className="text-sm">
          거래처를 불러오지 못했습니다.
        </p>
      )}

      {loadState === 'ready' && supplier !== null && (
        <>
          <header className="space-y-1">
            <p className="text-muted-foreground font-mono text-sm">{supplier.supplierCode}</p>
            <h1 className="text-2xl font-semibold tracking-tight">{supplier.supplierName}</h1>
            <p className="text-muted-foreground text-sm">
              {supplier.supplierType} · 상태 {supplier.status}
            </p>
          </header>

          {/* 탭 3개 — placeholder 없음 (D-10) */}
          <div className="flex gap-1 border-b" role="tablist" aria-label="거래처 상세 탭">
            {visibleTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                data-testid={`tab-${tab}`}
                onClick={() => apply({ tab })}
                className={`px-4 py-2 text-sm ${
                  activeTab === tab
                    ? 'border-foreground -mb-px border-b-2 font-medium'
                    : 'text-muted-foreground'
                }`}
              >
                {SUPPLIER_DETAIL_TAB_LABELS[tab]}
              </button>
            ))}
          </div>

          {activeTab === 'basic' && (
            <section aria-label="기본정보" className="space-y-4" data-testid="panel-basic">
              {editForm === null ? (
                <>
                  <div className="flex justify-end">
                    {canUpdate && (
                      <Button
                        size="sm"
                        data-testid="edit-supplier-button"
                        onClick={() => setEditForm(toSupplierEditForm(supplier))}
                      >
                        수정
                      </Button>
                    )}
                  </div>
                  <dl className="bg-card grid gap-x-6 gap-y-3 rounded-md border p-4 text-sm sm:grid-cols-2">
                    <Field label="거래처코드" value={supplier.supplierCode} testId="view-code" />
                    <Field label="거래처명" value={supplier.supplierName} />
                    <Field label="거래처유형" value={supplier.supplierType} />
                    <Field
                      label="사업자등록번호"
                      value={formatOptionalText(supplier.businessRegistrationNo)}
                    />
                    <Field label="담당자" value={formatOptionalText(supplier.contactName)} />
                    <Field label="연락처" value={formatOptionalText(supplier.contactPhone)} />
                    <Field label="이메일" value={formatOptionalText(supplier.contactEmail)} />
                    <Field
                      label="기본 리드타임"
                      value={formatLeadTimeDays(supplier.defaultLeadTimeDays)}
                      testId="view-lead-time"
                    />
                    <Field label="상태" value={supplier.status} testId="view-status" />
                    <Field label="비고" value={formatOptionalText(supplier.note)} />
                    <Field label="등록일" value={supplier.createdAt} />
                    <Field label="최종수정" value={supplier.updatedAt} />
                  </dl>
                </>
              ) : (
                <div className="bg-card space-y-4 rounded-md border p-4">
                  <p className="text-muted-foreground text-xs">
                    거래처코드는 등록 후 변경할 수 없습니다. 상태는 이 화면에서 변경하지 않습니다.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs">
                      <span className="text-muted-foreground">거래처코드</span>
                      <input
                        type="text"
                        value={supplier.supplierCode}
                        readOnly
                        aria-label="거래처코드"
                        data-testid="edit-supplier-code"
                        className="bg-muted/40 text-muted-foreground h-9 w-full rounded-md border px-3 font-mono text-sm"
                      />
                    </label>
                    <EditField
                      label="거래처명"
                      testId="edit-supplier-name"
                      value={editForm.supplierName}
                      onChange={(value) => setEditForm({ ...editForm, supplierName: value })}
                    />
                    <EditField
                      label="거래처유형"
                      testId="edit-supplier-type"
                      list="supplier-type-suggestions"
                      value={editForm.supplierType}
                      onChange={(value) => setEditForm({ ...editForm, supplierType: value })}
                    />
                    <EditField
                      label="사업자등록번호"
                      testId="edit-business-no"
                      value={editForm.businessRegistrationNo}
                      onChange={(value) =>
                        setEditForm({ ...editForm, businessRegistrationNo: value })
                      }
                    />
                    <EditField
                      label="담당자"
                      testId="edit-contact-name"
                      value={editForm.contactName}
                      onChange={(value) => setEditForm({ ...editForm, contactName: value })}
                    />
                    <EditField
                      label="연락처"
                      testId="edit-contact-phone"
                      value={editForm.contactPhone}
                      onChange={(value) => setEditForm({ ...editForm, contactPhone: value })}
                    />
                    <EditField
                      label="이메일"
                      testId="edit-contact-email"
                      value={editForm.contactEmail}
                      onChange={(value) => setEditForm({ ...editForm, contactEmail: value })}
                    />
                    <EditField
                      label="기본 리드타임(일)"
                      testId="edit-lead-time"
                      hint="비우면 미입력, 0 은 즉시납입니다."
                      value={editForm.defaultLeadTimeDays}
                      onChange={(value) => setEditForm({ ...editForm, defaultLeadTimeDays: value })}
                    />
                    <div className="sm:col-span-2">
                      <EditField
                        label="비고"
                        testId="edit-note"
                        value={editForm.note}
                        onChange={(value) => setEditForm({ ...editForm, note: value })}
                      />
                    </div>
                  </div>
                  <datalist id="supplier-type-suggestions">
                    {SUPPLIER_TYPE_SUGGESTIONS.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditForm(null)}>
                      취소
                    </Button>
                    <Button
                      size="sm"
                      data-testid="edit-submit"
                      disabled={busy || !hasSupplierChanges(editForm, supplier)}
                      onClick={() => void submitEdit()}
                    >
                      {busy ? '저장 중…' : '저장'}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}

          {activeTab === 'terms' && (
            <TermsTab
              supplierId={supplierId}
              page={state.termsPage}
              permissions={permissions}
              onPageChange={(page) => apply({ termsPage: page })}
              onError={setError}
            />
          )}

          {activeTab === 'prices' && canReadPrice && (
            <PricesTab
              supplierId={supplierId}
              selectedSupplierSkuId={state.supplierSkuId}
              permissions={permissions}
              onSelect={(id) => apply({ supplierSkuId: id })}
              onError={setError}
            />
          )}
        </>
      )}
    </main>
  );
}

function Field({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm" {...(testId !== undefined ? { 'data-testid': testId } : {})}>
        {value}
      </dd>
    </div>
  );
}

function EditField({
  label,
  value,
  onChange,
  testId,
  hint,
  list,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
  hint?: string;
  list?: string;
}) {
  return (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        data-testid={testId}
        {...(list !== undefined ? { list } : {})}
        className="bg-background h-9 w-full rounded-md border px-3 text-sm"
      />
      {hint !== undefined && <span className="text-muted-foreground block">{hint}</span>}
    </label>
  );
}
