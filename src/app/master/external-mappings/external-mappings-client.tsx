'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

import { ErrorBanner, readApiError, usePermissions, type UiError } from '../skus/sku-ui';

import {
  MAPPING_LIST_PAGE_SIZES,
  MAPPING_LIST_STATUSES,
  MAPPING_STATUS_CLASS,
  MAPPING_STATUS_LABELS,
  REVIEW_REQUIRED_NOTICE,
  buildMappingListParams,
  formatEffectivePeriod,
  isEndedMapping,
  isInteractiveMapping,
  mappingListApiQuery,
  readMappingListState,
  type MappingListPatch,
  type MappingListStatus,
} from './list-params';
import {
  EMPTY_CREATE_FORM,
  buildCreatePayload,
  buildEndPayload,
  buildUpdatePayload,
  toEditForm,
  todayBusinessDate,
  type MappingCreateForm,
  type MappingEditForm,
} from './mapping-form';

/**
 * 외부 상품 매핑 관리 화면 `EXT-MAP-001` (T05-4A).
 *
 * ⚠️ 근거: `docs/15_설계복구_ExternalMapping관리UI.md`.
 *
 * - 목록·검색은 **URL searchParams 가 단일 진실**이다. 미지원 파라미터가 URL 에
 *   있으면 조용히 지우지 않고 API 400 을 그대로 보여준다.
 * - 신규·수정은 **같은 화면의 dialog** 다 — `/new`·`/{id}` 라우트가 없다.
 * - 권한 UI 는 `/api/me` permissions 로만 판단한다 (역할 이름 하드코딩 없음).
 *   실제 차단은 서버 2겹 가드가 한다.
 * - 403 을 빈 목록으로 위장하지 않는다.
 *
 * ⛔ 없는 것: 정렬 UI(API 에 `sort` 없음) · 창고 필터(T08-1) · 최종수정 열
 *    (`updatedAt` 컬럼 없음) · "미매칭만 보기" · 일괄 매핑 · 엑셀 업로드 ·
 *    상세 페이지 · 재활성.
 */

interface MappingRefView {
  id: string;
  skuCode?: string;
  skuName?: string;
  systemCode?: string;
  systemName?: string;
}

interface MappingListItem {
  id: string;
  skuId: string;
  externalSystemId: string;
  warehouseId: string | null;
  externalProductCode: string | null;
  externalProductName: string | null;
  externalBarcode: string | null;
  mappingStatus: string;
  isPrimary: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  note: string | null;
  createdAt: string;
  sku: MappingRefView;
  externalSystem: MappingRefView;
}

interface MappingListResponse {
  items: MappingListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface ExternalSystemOption {
  id: string;
  systemCode: string;
  systemName: string;
  systemType: string;
  active: boolean;
}

interface SkuOption {
  id: string;
  skuCode: string;
  skuName: string;
  status: string;
}

function StatusBadge({ status }: { status: string }) {
  const label = MAPPING_STATUS_LABELS[status as MappingListStatus] ?? status;
  return (
    <span
      data-testid="mapping-status"
      data-status={status}
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${MAPPING_STATUS_CLASS[status] ?? ''}`}
      title={status === 'REVIEW_REQUIRED' ? REVIEW_REQUIRED_NOTICE : undefined}
    >
      {label}
    </span>
  );
}

function networkError(message: string): UiError {
  return {
    status: 0,
    code: null,
    message,
    requestId: null,
    hint: null,
    fields: [],
    validation: null,
  };
}

export function ExternalMappingsClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => readMappingListState(searchParams), [searchParams]);
  const permissions = usePermissions();

  const canRead = permissions?.includes('external_mapping.read') ?? false;
  const canCreate = permissions?.includes('external_mapping.create') ?? false;
  const canUpdate = permissions?.includes('external_mapping.update') ?? false;

  const [result, setResult] = useState<MappingListResponse | null>(null);
  const [listState, setListState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<UiError | null>(null);
  const [qInput, setQInput] = useState(state.q);
  const [reloadToken, setReloadToken] = useState(0);

  const [systems, setSystems] = useState<readonly ExternalSystemOption[]>([]);
  const [skuOptions, setSkuOptions] = useState<readonly SkuOption[]>([]);
  const [skuQuery, setSkuQuery] = useState('');

  const [createForm, setCreateForm] = useState<MappingCreateForm | null>(null);
  const [editTarget, setEditTarget] = useState<MappingListItem | null>(null);
  const [editForm, setEditForm] = useState<MappingEditForm | null>(null);
  const [busy, setBusy] = useState(false);
  /** ★ 하나의 logical create attempt 동안 유지되는 멱등키 (network retry 는 같은 키). */
  const [createKey, setCreateKey] = useState<string | null>(null);

  // URL 의 q 가 바뀌면(뒤로가기 등) 입력창도 동기화 — render 중 상태 조정.
  const [lastUrlQ, setLastUrlQ] = useState(state.q);
  if (state.q !== lastUrlQ) {
    setLastUrlQ(state.q);
    setQInput(state.q);
  }

  // 외부시스템 lookup — inactive 도 숨기지 않는다 (선택 자체를 막지 않는다).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/external-systems', { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { items: ExternalSystemOption[] };
        if (!cancelled) setSystems(body.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // SKU lookup — 기존 `/api/skus` 재사용. ⛔ status eligibility 를 새로 만들지 않는다.
  useEffect(() => {
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
  }, [skuQuery]);

  // 목록 — URL searchParams 를 **그대로** API 에 전달한다.
  const apiQuery = mappingListApiQuery(searchParams);
  const [lastApiQuery, setLastApiQuery] = useState<string | null>(null);
  if (lastApiQuery !== apiQuery) {
    setLastApiQuery(apiQuery);
    setListState('loading');
  }
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/external-mappings${apiQuery}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const uiError = await readApiError(response);
          if (cancelled) return;
          setError(uiError);
          setResult(null);
          // ★ 403 을 빈 목록처럼 표시하지 않는다.
          setListState(response.status === 403 ? 'forbidden' : 'error');
          return;
        }
        const body = (await response.json()) as MappingListResponse;
        if (cancelled) return;
        setResult(body);
        setListState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setError(networkError('네트워크 오류로 목록을 불러오지 못했습니다.'));
        setListState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [apiQuery, reloadToken]);

  function apply(patch: MappingListPatch): void {
    const next = buildMappingListParams(searchParams, patch);
    const query = next.toString();
    router.push(query === '' ? pathname : `${pathname}?${query}`);
  }

  const refetch = (): void => setReloadToken((token) => token + 1);

  async function submitCreate(): Promise<void> {
    if (createForm === null) return;
    const key = createKey ?? crypto.randomUUID();
    if (createKey === null) setCreateKey(key);
    setBusy(true);
    try {
      const response = await fetch('/api/external-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(buildCreatePayload(createForm)),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      setCreateForm(null);
      setCreateKey(null);
      setError(null);
      refetch();
    } catch {
      setError(networkError('네트워크 오류로 매핑을 등록하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  async function patchMapping(id: string, payload: unknown): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch(`/api/external-mappings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return false;
      }
      setError(null);
      refetch();
      return true;
    } catch {
      setError(networkError('네트워크 오류로 요청을 처리하지 못했습니다.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(): Promise<void> {
    if (editTarget === null || editForm === null) return;
    const payload = buildUpdatePayload(editTarget, editForm);
    // ★ 변경이 없으면 PATCH 자체를 호출하지 않는다.
    if (payload === null) {
      setEditTarget(null);
      setEditForm(null);
      return;
    }
    if (await patchMapping(editTarget.id, payload)) {
      setEditTarget(null);
      setEditForm(null);
    }
  }

  async function endMapping(row: MappingListItem): Promise<void> {
    await patchMapping(row.id, buildEndPayload(row, todayBusinessDate()));
  }

  const items = result?.items ?? [];
  const totalPages = result?.totalPages ?? 1;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-muted-foreground font-mono text-sm">DEEPPOINT SCM OS</p>
          <h1 className="text-2xl font-semibold tracking-tight">외부 상품 매핑</h1>
          <p className="text-muted-foreground text-sm">
            내부 SKU 와 ERP·WMS·3PL 외부코드/바코드/상품명의 연결을 관리합니다. 외부 상품명은 내부
            표준 상품명을 덮어쓰지 않습니다. 미매칭 목록·일괄 매핑·엑셀 업로드는 이후 Task 입니다.
          </p>
        </div>
        {canCreate && (
          <Button
            size="sm"
            data-testid="new-mapping-button"
            onClick={() => {
              setCreateForm(EMPTY_CREATE_FORM);
              setCreateKey(null);
            }}
          >
            신규 매핑
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
          외부 매핑 조회 권한(<span className="font-mono">external_mapping.read</span>)이 없습니다.
          관리자에게 문의하세요.
        </div>
      )}

      {/* 검색·필터 — API 지원 범위와 정확히 일치 */}
      <section className="bg-card space-y-3 rounded-md border p-4" aria-label="검색 조건">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            apply({ q: qInput.trim() });
          }}
        >
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">
              통합검색 (SKU 코드·상품명 · 외부코드·외부상품명)
            </span>
            <input
              type="search"
              value={qInput}
              onChange={(event) => setQInput(event.target.value)}
              placeholder="SKU 코드·외부코드 검색"
              className="bg-background h-9 w-72 rounded-md border px-3 text-sm"
              aria-label="통합검색"
            />
          </label>
          <Button size="sm" type="submit">
            검색
          </Button>

          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">외부시스템</span>
            <select
              value={state.externalSystemId}
              onChange={(event) => apply({ externalSystemId: event.target.value })}
              aria-label="외부시스템"
              data-testid="filter-external-system"
              className="bg-background h-9 rounded-md border px-2 text-sm"
            >
              <option value="">전체</option>
              {systems.map((system) => (
                <option key={system.id} value={system.id}>
                  {system.systemCode} — {system.systemName}
                  {system.active ? '' : ' (비활성)'}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">매핑상태</span>
            <select
              value={state.mappingStatus}
              onChange={(event) => apply({ mappingStatus: event.target.value })}
              aria-label="매핑상태"
              data-testid="filter-mapping-status"
              className="bg-background h-9 rounded-md border px-2 text-sm"
            >
              <option value="">전체</option>
              {MAPPING_LIST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {MAPPING_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">페이지당</span>
            <select
              value={String(state.pageSize)}
              onChange={(event) => apply({ pageSize: Number(event.target.value) })}
              aria-label="페이지당 표시 수"
              className="bg-background h-9 rounded-md border px-2 text-sm"
            >
              {MAPPING_LIST_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </form>
        <p className="text-muted-foreground text-xs">
          정렬은 등록 최신순으로 고정입니다. 창고 필터는 창고 마스터 도입 후 제공됩니다.
        </p>
      </section>

      {/* 목록 */}
      <section aria-label="외부 매핑 목록" className="space-y-3">
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
            조건에 맞는 매핑이 없습니다.
          </p>
        )}

        {listState === 'ready' && items.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="mapping-table">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">외부시스템</th>
                  <th className="px-3 py-2 font-medium">외부코드</th>
                  <th className="px-3 py-2 font-medium">외부상품명</th>
                  <th className="px-3 py-2 font-medium">외부바코드</th>
                  <th className="px-3 py-2 font-medium">SKU 코드</th>
                  <th className="px-3 py-2 font-medium">표준 상품명</th>
                  <th className="px-3 py-2 font-medium">매핑상태</th>
                  <th className="px-3 py-2 font-medium">대표</th>
                  <th className="px-3 py-2 font-medium">적용기간</th>
                  <th className="px-3 py-2 font-medium">작업</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const editable = isInteractiveMapping(item.mappingStatus, item.effectiveTo);
                  const ended = isEndedMapping(item.effectiveTo);
                  return (
                    <tr key={item.id} data-testid="mapping-row" data-mapping-id={item.id}>
                      <td className="px-3 py-2">{item.externalSystem.systemCode}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {item.externalProductCode ?? ''}
                      </td>
                      <td className="px-3 py-2">{item.externalProductName ?? ''}</td>
                      <td className="px-3 py-2 font-mono text-xs">{item.externalBarcode ?? ''}</td>
                      <td className="px-3 py-2 font-mono text-xs">{item.sku.skuCode}</td>
                      <td className="px-3 py-2">{item.sku.skuName}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status={item.mappingStatus} />
                      </td>
                      <td className="px-3 py-2">{item.isPrimary ? '대표' : ''}</td>
                      <td className="px-3 py-2 text-xs" data-testid="effective-period">
                        {formatEffectivePeriod(item.effectiveFrom, item.effectiveTo)}
                      </td>
                      <td className="space-x-2 px-3 py-2">
                        {/* ⛔ 종료·UNMATCHED 행에는 액션을 노출하지 않는다 — 서버가 422 다. */}
                        {canUpdate && editable && (
                          <button
                            type="button"
                            data-testid="edit-mapping"
                            disabled={busy}
                            onClick={() => {
                              setEditTarget(item);
                              setEditForm(toEditForm(item));
                            }}
                            className="text-xs underline"
                          >
                            수정
                          </button>
                        )}
                        {canUpdate && editable && (
                          <button
                            type="button"
                            data-testid="end-mapping"
                            disabled={busy}
                            onClick={() => void endMapping(item)}
                            className="text-xs underline"
                          >
                            매핑 해제
                          </button>
                        )}
                        {ended && (
                          <span
                            data-testid="ended-mapping"
                            className="text-muted-foreground text-xs"
                          >
                            종료됨
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* 상품명 기반 매핑 안내 — 유일하게 설계 근거가 있는 warning */}
        {items.some((item) => item.mappingStatus === 'REVIEW_REQUIRED') && (
          <p
            data-testid="review-required-notice"
            className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            {REVIEW_REQUIRED_NOTICE}
          </p>
        )}

        {listState === 'ready' && result !== null && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground" data-testid="list-total">
              전체 {result.total}건 · {result.page}/{totalPages} 페이지
            </span>
            <span className="space-x-2">
              <button
                type="button"
                disabled={state.page <= 1}
                onClick={() => apply({ page: state.page - 1 })}
                className="underline disabled:opacity-40"
              >
                이전
              </button>
              <button
                type="button"
                data-testid="next-page"
                disabled={state.page >= totalPages}
                onClick={() => apply({ page: state.page + 1 })}
                className="underline disabled:opacity-40"
              >
                다음
              </button>
            </span>
          </div>
        )}
      </section>

      {/* 신규 매핑 dialog */}
      {createForm !== null && (
        <section
          role="dialog"
          aria-label="신규 매핑"
          data-testid="create-dialog"
          className="bg-card space-y-3 rounded-md border p-4"
        >
          <h2 className="text-lg font-medium">신규 매핑</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">외부시스템 *</span>
              <select
                value={createForm.externalSystemId}
                data-testid="create-external-system"
                onChange={(event) =>
                  setCreateForm({ ...createForm, externalSystemId: event.target.value })
                }
                className="bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="">선택</option>
                {systems.map((system) => (
                  <option key={system.id} value={system.id}>
                    {system.systemCode} — {system.systemName}
                    {system.active ? '' : ' (비활성)'}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">SKU 검색</span>
              <input
                type="search"
                value={skuQuery}
                onChange={(event) => setSkuQuery(event.target.value)}
                placeholder="SKU 코드·상품명"
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                aria-label="SKU 검색"
              />
            </label>

            <label className="space-y-1 text-xs md:col-span-2">
              <span className="text-muted-foreground">SKU *</span>
              <select
                value={createForm.skuId}
                data-testid="create-sku"
                onChange={(event) => setCreateForm({ ...createForm, skuId: event.target.value })}
                className="bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="">선택</option>
                {skuOptions.map((sku) => (
                  <option key={sku.id} value={sku.id}>
                    {sku.skuCode} — {sku.skuName} ({sku.status})
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">외부코드</span>
              <input
                value={createForm.externalProductCode}
                data-testid="create-external-code"
                onChange={(event) =>
                  setCreateForm({ ...createForm, externalProductCode: event.target.value })
                }
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">외부상품명</span>
              <input
                value={createForm.externalProductName}
                data-testid="create-external-name"
                onChange={(event) =>
                  setCreateForm({ ...createForm, externalProductName: event.target.value })
                }
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">외부바코드</span>
              <input
                value={createForm.externalBarcode}
                data-testid="create-external-barcode"
                onChange={(event) =>
                  setCreateForm({ ...createForm, externalBarcode: event.target.value })
                }
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={createForm.isPrimary}
                data-testid="create-is-primary"
                onChange={(event) =>
                  setCreateForm({ ...createForm, isPrimary: event.target.checked })
                }
              />
              <span>대표 매핑</span>
            </label>
            <label className="space-y-1 text-xs md:col-span-2">
              <span className="text-muted-foreground">비고</span>
              <input
                value={createForm.note}
                onChange={(event) => setCreateForm({ ...createForm, note: event.target.value })}
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
          </div>
          <p className="text-muted-foreground text-xs">
            매핑상태는 외부코드·바코드·상품명 조합으로 서버가 결정합니다. 상품명만 입력하면 확인
            필요(REVIEW_REQUIRED) 상태가 됩니다.
          </p>
          <div className="space-x-2">
            <Button
              size="sm"
              data-testid="create-submit"
              disabled={busy}
              onClick={() => void submitCreate()}
            >
              저장
            </Button>
            <button
              type="button"
              className="text-xs underline"
              onClick={() => {
                setCreateForm(null);
                setCreateKey(null);
              }}
            >
              취소
            </button>
          </div>
        </section>
      )}

      {/* 수정 dialog */}
      {editTarget !== null && editForm !== null && (
        <section
          role="dialog"
          aria-label="매핑 수정"
          data-testid="edit-dialog"
          className="bg-card space-y-3 rounded-md border p-4"
        >
          <h2 className="text-lg font-medium">매핑 수정</h2>
          <dl className="text-muted-foreground grid gap-1 text-xs md:grid-cols-3">
            <div>
              <dt className="inline">외부시스템: </dt>
              <dd className="inline" data-testid="edit-system-readonly">
                {editTarget.externalSystem.systemCode}
              </dd>
            </div>
            <div>
              <dt className="inline">SKU: </dt>
              <dd className="inline" data-testid="edit-sku-readonly">
                {editTarget.sku.skuCode}
              </dd>
            </div>
            <div>
              <dt className="inline">매핑상태: </dt>
              <dd className="inline" data-testid="edit-status-readonly">
                {editTarget.mappingStatus}
              </dd>
            </div>
          </dl>
          <p className="text-muted-foreground text-xs">
            SKU·외부시스템·매핑상태는 이 화면에서 변경할 수 없습니다. 다른 SKU 로 옮기려면 기존
            매핑을 해제하고 새로 등록하세요.
          </p>
          {editTarget.mappingStatus === 'REVIEW_REQUIRED' && (
            <p
              data-testid="edit-review-notice"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              {REVIEW_REQUIRED_NOTICE}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">외부코드</span>
              <input
                value={editForm.externalProductCode}
                data-testid="edit-external-code"
                onChange={(event) =>
                  setEditForm({ ...editForm, externalProductCode: event.target.value })
                }
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">외부상품명</span>
              <input
                value={editForm.externalProductName}
                data-testid="edit-external-name"
                onChange={(event) =>
                  setEditForm({ ...editForm, externalProductName: event.target.value })
                }
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">외부바코드</span>
              <input
                value={editForm.externalBarcode}
                data-testid="edit-external-barcode"
                onChange={(event) =>
                  setEditForm({ ...editForm, externalBarcode: event.target.value })
                }
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={editForm.isPrimary}
                data-testid="edit-is-primary"
                onChange={(event) => setEditForm({ ...editForm, isPrimary: event.target.checked })}
              />
              <span>대표 매핑</span>
            </label>
            <label className="space-y-1 text-xs md:col-span-2">
              <span className="text-muted-foreground">비고</span>
              <input
                value={editForm.note}
                onChange={(event) => setEditForm({ ...editForm, note: event.target.value })}
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
          </div>
          <div className="space-x-2">
            <Button
              size="sm"
              data-testid="edit-submit"
              disabled={busy}
              onClick={() => void submitEdit()}
            >
              저장
            </Button>
            <button
              type="button"
              className="text-xs underline"
              onClick={() => {
                setEditTarget(null);
                setEditForm(null);
              }}
            >
              취소
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
