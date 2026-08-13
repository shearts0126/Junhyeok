'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

import { ErrorBanner, readApiError, usePermissions, type UiError } from '../skus/sku-ui';

import {
  buildSupplierListParams,
  formatLeadTimeDays,
  formatOptionalText,
  readSupplierListState,
  SUPPLIER_STATUS_SUGGESTIONS,
  SUPPLIER_TYPE_SUGGESTIONS,
  supplierListApiQuery,
  type SupplierListPatch,
} from './list-params';
import {
  buildSupplierCreatePayload,
  EMPTY_SUPPLIER_CREATE_FORM,
  type SupplierCreateForm,
} from './supplier-form';

/**
 * 거래처 목록 화면 `SUP-LIST-001` (T06-4).
 *
 * ⚠️ 근거: `docs/17_설계복구_거래처공급조건.md` §80~ (D-1 ~ D-38).
 *
 * - 목록·검색은 **URL searchParams 가 단일 진실**이다. 미지원 파라미터가 URL 에
 *   있으면 조용히 지우지 않고 API 400 을 그대로 보여준다.
 * - 신규 등록은 **같은 화면의 dialog** 다 — `/new` 라우트가 없다 (D-1·D-6).
 *   성공하면 상세(`/master/suppliers/{id}`)로 이동한다 (D-6).
 * - 권한 UI 는 `/api/me` permissions 로만 판단한다 (역할 이름 하드코딩 없음).
 * - 403 을 빈 목록으로 위장하지 않는다.
 *
 * ⛔ 없는 것: 정렬 UI(API 에 `sort` 없음) · 페이지 크기 선택(서버 고정 50) ·
 *    상태 변경·비활성화 버튼(D-8 — status 는 표시·필터 전용) ·
 *    창고 입력(D-20 — T08 staged) · 전화/이메일/비고/생성일 열.
 */

interface SupplierListItem {
  id: string;
  supplierCode: string;
  supplierName: string;
  supplierType: string;
  businessRegistrationNo: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  defaultLeadTimeDays: number | null;
  status: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SupplierListResponse {
  items: SupplierListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function SuppliersClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => readSupplierListState(searchParams), [searchParams]);
  const permissions = usePermissions();

  const canRead = permissions?.includes('supplier.read') ?? false;
  const canCreate = permissions?.includes('supplier.create') ?? false;

  const [result, setResult] = useState<SupplierListResponse | null>(null);
  const [listState, setListState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<UiError | null>(null);
  const [qInput, setQInput] = useState(state.q);

  const [createForm, setCreateForm] = useState<SupplierCreateForm | null>(null);
  const [busy, setBusy] = useState(false);
  /** ★ 하나의 logical create attempt 동안 유지되는 멱등키 (network retry 는 같은 키). */
  const [createKey, setCreateKey] = useState<string | null>(null);

  // URL 의 q 가 바뀌면(뒤로가기 등) 입력창도 동기화 — render 중 상태 조정.
  const [lastUrlQ, setLastUrlQ] = useState(state.q);
  if (state.q !== lastUrlQ) {
    setLastUrlQ(state.q);
    setQInput(state.q);
  }

  const apiQuery = supplierListApiQuery(searchParams);
  // ★ loading 전환은 render 중 상태 조정으로 한다 — effect 안 setState 는
  //   cascading render 를 만든다 (T05-4A 와 같은 패턴).
  const [lastApiQuery, setLastApiQuery] = useState<string | null>(null);
  if (lastApiQuery !== apiQuery) {
    setLastApiQuery(apiQuery);
    setListState('loading');
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/suppliers${apiQuery}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          // ★ 403 을 빈 목록처럼 표시하지 않는다.
          setListState(response.status === 403 ? 'forbidden' : 'error');
          setError(await readApiError(response));
          setResult(null);
          return;
        }
        setResult((await response.json()) as SupplierListResponse);
        setError(null);
        setListState('ready');
      })
      .catch(() => {
        if (!cancelled) setListState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [apiQuery]);

  function apply(patch: SupplierListPatch): void {
    const next = buildSupplierListParams(searchParams, patch);
    const query = next.toString();
    router.push(query === '' ? pathname : `${pathname}?${query}`);
  }

  async function submitCreate(): Promise<void> {
    if (createForm === null) return;
    const key = createKey ?? crypto.randomUUID();
    if (createKey === null) setCreateKey(key);
    setBusy(true);
    try {
      const response = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(buildSupplierCreatePayload(createForm)),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as { supplier: SupplierListItem };
      setCreateForm(null);
      setCreateKey(null);
      setError(null);
      // ★ 성공하면 상세로 이동한다 — 목록에 머무르지 않는다 (D-6).
      router.push(`/master/suppliers/${body.supplier.id}`);
    } finally {
      setBusy(false);
    }
  }

  const items = result?.items ?? [];
  const totalPages = result?.totalPages ?? 1;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-muted-foreground font-mono text-sm">DEEPPOINT SCM OS</p>
          <h1 className="text-2xl font-semibold tracking-tight">거래처 관리</h1>
          <p className="text-muted-foreground text-sm">
            공급업체·제조사와 공급조건·가격이력을 관리합니다. 거래처를 선택하면 공급조건과
            가격이력을 볼 수 있습니다.
          </p>
        </div>
        {canCreate && (
          <Button
            size="sm"
            data-testid="new-supplier-button"
            onClick={() => {
              setCreateForm(EMPTY_SUPPLIER_CREATE_FORM);
              setCreateKey(null);
            }}
          >
            거래처 추가
          </Button>
        )}
      </header>

      {error !== null && listState !== 'forbidden' && (
        <ErrorBanner error={error} onClose={() => setError(null)} />
      )}

      {permissions !== null && !canRead && (
        <div
          role="alert"
          data-testid="forbidden-state"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          거래처 조회 권한(<span className="font-mono">supplier.read</span>)이 없습니다. 관리자에게
          문의하세요.
        </div>
      )}

      {/* 검색·필터 — API 지원 범위(q·supplierType·status·page)와 정확히 일치 */}
      <section className="bg-card space-y-3 rounded-md border p-4" aria-label="검색 조건">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            apply({ q: qInput.trim() });
          }}
        >
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">통합검색</span>
            <input
              type="search"
              value={qInput}
              onChange={(event) => setQInput(event.target.value)}
              placeholder="거래처 코드 또는 거래처명"
              className="bg-background h-9 w-72 rounded-md border px-3 text-sm"
              aria-label="통합검색"
              data-testid="filter-q"
            />
          </label>
          <Button size="sm" type="submit">
            검색
          </Button>

          {/* ★ supplierType 은 open string 이다 — select 가 아니라 입력 + 제안이다 (D-5). */}
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">거래처유형</span>
            <input
              type="text"
              defaultValue={state.supplierType}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== state.supplierType) apply({ supplierType: value });
              }}
              list="supplier-type-suggestions"
              placeholder="전체"
              className="bg-background h-9 w-48 rounded-md border px-3 text-sm"
              aria-label="거래처유형"
              data-testid="filter-supplier-type"
            />
          </label>
          <datalist id="supplier-type-suggestions">
            {SUPPLIER_TYPE_SUGGESTIONS.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>

          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">상태</span>
            <input
              type="text"
              defaultValue={state.status}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== state.status) apply({ status: value });
              }}
              list="supplier-status-suggestions"
              placeholder="전체"
              className="bg-background h-9 w-36 rounded-md border px-3 text-sm"
              aria-label="상태"
              data-testid="filter-status"
            />
          </label>
          <datalist id="supplier-status-suggestions">
            {SUPPLIER_STATUS_SUGGESTIONS.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </form>
        <p className="text-muted-foreground text-xs">
          정렬은 거래처 코드 오름차순으로 고정이며, 한 페이지에 50건씩 표시합니다. 거래처유형·상태는
          자유 입력값이라 목록에 없는 값도 직접 입력할 수 있습니다.
        </p>
      </section>

      {/* 목록 */}
      <section aria-label="거래처 목록" className="space-y-3">
        {listState === 'loading' && (
          <p data-testid="list-loading" className="text-muted-foreground text-sm">
            불러오는 중…
          </p>
        )}

        {listState === 'forbidden' && (
          <p data-testid="list-forbidden" className="text-sm">
            조회 권한이 없어 목록을 표시할 수 없습니다. (403)
          </p>
        )}

        {listState === 'ready' && items.length === 0 && (
          <p data-testid="list-empty" className="text-muted-foreground text-sm">
            등록된 거래처가 없습니다.
          </p>
        )}

        {listState === 'ready' && items.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="supplier-table">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">거래처코드</th>
                  <th className="px-3 py-2 font-medium">거래처명</th>
                  <th className="px-3 py-2 font-medium">거래처유형</th>
                  <th className="px-3 py-2 font-medium">사업자등록번호</th>
                  <th className="px-3 py-2 font-medium">담당자</th>
                  <th className="px-3 py-2 font-medium">기본 리드타임</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                  <th className="px-3 py-2 font-medium">관리</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="border-t" data-testid="supplier-row">
                    <td className="px-3 py-2 font-mono text-xs">{row.supplierCode}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/master/suppliers/${row.id}`}
                        className="underline underline-offset-2"
                        data-testid="supplier-detail-link"
                      >
                        {row.supplierName}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{row.supplierType}</td>
                    <td className="px-3 py-2">{formatOptionalText(row.businessRegistrationNo)}</td>
                    <td className="px-3 py-2">{formatOptionalText(row.contactName)}</td>
                    <td className="px-3 py-2" data-testid="supplier-lead-time">
                      {formatLeadTimeDays(row.defaultLeadTimeDays)}
                    </td>
                    <td className="px-3 py-2">{row.status}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/master/suppliers/${row.id}`}
                        className="text-xs underline underline-offset-2"
                      >
                        상세
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {listState === 'ready' && result !== null && (
          <div className="flex items-center justify-between text-sm">
            <p className="text-muted-foreground" data-testid="list-total">
              전체 {result.total}건 · {result.page}/{Math.max(totalPages, 1)} 페이지
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={state.page <= 1}
                onClick={() => apply({ page: state.page - 1 })}
              >
                이전
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={state.page >= totalPages}
                onClick={() => apply({ page: state.page + 1 })}
              >
                다음
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* 신규 등록 dialog — /new 라우트가 아니다 (D-1·D-6) */}
      {createForm !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="거래처 추가"
          data-testid="create-dialog"
          className="bg-background/80 fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6"
        >
          <div className="bg-card w-full max-w-2xl space-y-4 rounded-md border p-6 shadow-lg">
            <h2 className="text-lg font-semibold">거래처 추가</h2>

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="거래처코드"
                required
                testId="create-supplier-code"
                value={createForm.supplierCode}
                onChange={(value) => setCreateForm({ ...createForm, supplierCode: value })}
              />
              <TextField
                label="거래처명"
                required
                testId="create-supplier-name"
                value={createForm.supplierName}
                onChange={(value) => setCreateForm({ ...createForm, supplierName: value })}
              />
              <TextField
                label="거래처유형"
                required
                testId="create-supplier-type"
                list="supplier-type-suggestions"
                value={createForm.supplierType}
                onChange={(value) => setCreateForm({ ...createForm, supplierType: value })}
              />
              <TextField
                label="사업자등록번호"
                testId="create-business-no"
                value={createForm.businessRegistrationNo}
                onChange={(value) =>
                  setCreateForm({ ...createForm, businessRegistrationNo: value })
                }
              />
              <TextField
                label="담당자"
                testId="create-contact-name"
                value={createForm.contactName}
                onChange={(value) => setCreateForm({ ...createForm, contactName: value })}
              />
              <TextField
                label="연락처"
                testId="create-contact-phone"
                value={createForm.contactPhone}
                onChange={(value) => setCreateForm({ ...createForm, contactPhone: value })}
              />
              <TextField
                label="이메일"
                testId="create-contact-email"
                value={createForm.contactEmail}
                onChange={(value) => setCreateForm({ ...createForm, contactEmail: value })}
              />
              <TextField
                label="기본 리드타임(일)"
                testId="create-lead-time"
                hint="비우면 미입력, 0 은 즉시납입니다."
                value={createForm.defaultLeadTimeDays}
                onChange={(value) => setCreateForm({ ...createForm, defaultLeadTimeDays: value })}
              />
              <div className="sm:col-span-2">
                <TextField
                  label="비고"
                  testId="create-note"
                  value={createForm.note}
                  onChange={(value) => setCreateForm({ ...createForm, note: value })}
                />
              </div>
            </div>

            <p className="text-muted-foreground text-xs">
              상태는 등록 시 자동으로 설정되며 이 화면에서 변경하지 않습니다.
            </p>

            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCreateForm(null);
                  setCreateKey(null);
                }}
              >
                취소
              </Button>
              <Button
                size="sm"
                disabled={busy}
                data-testid="create-submit"
                onClick={() => void submitCreate()}
              >
                {busy ? '저장 중…' : '저장'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function TextField({
  label,
  value,
  onChange,
  required = false,
  testId,
  hint,
  list,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  testId: string;
  hint?: string;
  list?: string;
}) {
  return (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
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
