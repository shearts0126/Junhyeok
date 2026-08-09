'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

import {
  DEFAULT_SORT,
  SKU_LIST_PAGE_SIZES,
  SKU_LIST_SORT_LABELS,
  SKU_LIST_SORTS,
  SKU_LIST_STATUSES,
  SKU_STATUS_LABELS,
  buildSkuListParams,
  readSkuListState,
  skuListApiQuery,
  type SkuListPatch,
  type SkuListStatus,
} from './list-params';

/**
 * SKU 목록 화면 (T1-5A) — 조회·검색만.
 *
 * - 검색조건·정렬·페이지는 **URL searchParams 가 단일 진실** — 뒤로가기·새로고침
 *   에서 복원된다. 미지원 파라미터가 URL 에 있으면 API 400 을 그대로 보여준다.
 * - T1-3 API 지원 범위만: q(코드·상품명·영문명)/status/itemType/brand/major/minor/
 *   page/pageSize/sort. ⛔ barcode·external alias·hasBom·mappingStatus·hasIssue
 *   필터·열은 해당 모델 도입 후(T1-5B) — placeholder 도 두지 않는다.
 * - 열은 현재 master 가 신뢰 가능하게 제공하는 값만 — 가짜 `-`/0 표시 없음.
 * - 액션 버튼 없음 — 업로드/다운로드/일괄 처리/신규 등록 폼은 이후 Task.
 * - 권한: `sku.read` (5개 역할 전부). UI 숨김은 UX 일 뿐, 서버 2겹 가드가 최종.
 * - 403 은 빈 목록으로 위장하지 않는다 — 별도 상태로 표시한다.
 */

interface SkuCodeRefView {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

interface SkuListItem {
  id: string;
  skuCode: string;
  skuName: string;
  skuNameEn: string | null;
  itemType: string;
  status: string;
  brand: SkuCodeRefView | null;
  majorCategory: SkuCodeRefView | null;
  minorCategory: SkuCodeRefView | null;
  inventoryManaged: boolean;
  createdBy: string | null;
  updatedAt: string;
}

interface SkuListResponse {
  items: SkuListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface CodeOption {
  id: string;
  code: string;
  name: string;
}

interface ApiErrorBody {
  errorCode?: string;
  message?: string;
  requestId?: string;
  publicHint?: string;
  fieldErrors?: Array<{ path: string; message: string }>;
}

interface UiError {
  status: number;
  message: string;
  requestId: string | null;
  hint: string | null;
  fields: Array<{ path: string; message: string }>;
}

async function readError(response: Response): Promise<UiError> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // 본문이 JSON 이 아니면 상태코드만 보여준다.
  }
  return {
    status: response.status,
    message: body.message ?? `요청이 실패했습니다. (HTTP ${response.status})`,
    requestId: body.requestId ?? null,
    hint: body.publicHint ?? null,
    fields: body.fieldErrors ?? [],
  };
}

function ErrorBanner({ error, onClose }: { error: UiError; onClose: () => void }) {
  return (
    <div
      role="alert"
      data-testid="error-banner"
      className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="font-medium">{error.message}</p>
          {error.hint !== null && <p>{error.hint}</p>}
          {error.fields.length > 0 && (
            <ul className="list-inside list-disc">
              {error.fields.map((field) => (
                <li key={`${field.path}:${field.message}`}>
                  <span className="font-mono">{field.path}</span> — {field.message}
                </li>
              ))}
            </ul>
          )}
          {error.requestId !== null && (
            <p className="font-mono text-xs opacity-80" data-testid="error-request-id">
              requestId: {error.requestId}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="text-xs underline">
          닫기
        </button>
      </div>
    </div>
  );
}

/** SkuStatus 7종 배지 — 상태를 발명하지 않는다 (모르는 값은 원문 그대로). */
const STATUS_BADGE_CLASS: Readonly<Record<SkuListStatus, string>> = {
  DRAFT: 'bg-muted text-muted-foreground',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  REJECTED: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  ACTIVE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  INACTIVE: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  DISCONTINUED: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  ARCHIVED: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};

function StatusBadge({ status }: { status: string }) {
  const known = (SKU_LIST_STATUSES as readonly string[]).includes(status);
  const label = known ? SKU_STATUS_LABELS[status as SkuListStatus] : status;
  const badgeClass = known ? STATUS_BADGE_CLASS[status as SkuListStatus] : 'bg-muted';
  return (
    <span
      data-status={status}
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${badgeClass}`}
    >
      {label}
    </span>
  );
}

function refCell(ref: SkuCodeRefView | null) {
  if (ref === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span title={ref.code}>
      {ref.name}
      {!ref.active && <span className="text-muted-foreground text-xs"> (비활성)</span>}
    </span>
  );
}

/** 활성 공통코드 select — URL 의 기존 값이 목록에 없어도 조용히 바꾸지 않는다. */
function CodeFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly CodeOption[];
  onChange: (value: string) => void;
}) {
  const valueInOptions = value === '' || options.some((option) => option.id === value);
  return (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="bg-background h-9 w-full rounded-md border px-2 text-sm"
        aria-label={label}
      >
        <option value="">(전체)</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.code} — {option.name}
          </option>
        ))}
        {!valueInOptions && (
          <option value={value}>(URL 지정 값 유지 — 활성 목록에 없음: {value.slice(0, 8)}…)</option>
        )}
      </select>
    </label>
  );
}

export function SkusListClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => readSkuListState(searchParams), [searchParams]);

  const [permissions, setPermissions] = useState<readonly string[] | null>(null);
  const [result, setResult] = useState<SkuListResponse | null>(null);
  const [listState, setListState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<UiError | null>(null);
  const [qInput, setQInput] = useState(state.q);

  const [brandOptions, setBrandOptions] = useState<readonly CodeOption[]>([]);
  const [majorOptions, setMajorOptions] = useState<readonly CodeOption[]>([]);
  const [minorOptions, setMinorOptions] = useState<readonly CodeOption[]>([]);

  const canRead = permissions?.includes('sku.read') ?? false;

  // ⚠️ effect 안에서는 setState 를 동기 호출하지 않는다 — 모든 갱신은 .then 콜백.

  // 내 권한.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { cache: 'no-store' })
      .then(async (me) => {
        if (cancelled) return;
        if (!me.ok) {
          setPermissions([]);
          return;
        }
        const body = (await me.json()) as { permissions: string[] };
        if (!cancelled) setPermissions(body.permissions);
      })
      .catch(() => {
        if (!cancelled) setPermissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 브랜드·대분류·소분류 필터 옵션 — 활성 코드만. (T0-8 공개 API 재사용)
  useEffect(() => {
    let cancelled = false;
    const loadCodes = (groupCode: string) =>
      fetch(`/api/codes/${groupCode}?active=true`, { cache: 'no-store' }).then(async (response) =>
        response.ok
          ? ((await response.json()) as { codes: CodeOption[] }).codes
          : ([] as CodeOption[]),
      );
    void Promise.all([loadCodes('BRAND'), loadCodes('MAJOR_CATEGORY'), loadCodes('MINOR_CATEGORY')])
      .then(([brands, majors, minors]) => {
        if (cancelled) return;
        setBrandOptions(brands);
        setMajorOptions(majors);
        setMinorOptions(minors);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // URL 의 q 가 바뀌면(뒤로가기 등) 입력창도 동기화한다 — render 중 상태 조정
  // 패턴 (effect 내 동기 setState 금지 규칙 준수).
  const [lastUrlQ, setLastUrlQ] = useState(state.q);
  if (state.q !== lastUrlQ) {
    setLastUrlQ(state.q);
    setQInput(state.q);
  }

  // 목록 — URL searchParams 를 **그대로** API 에 전달한다.
  // 쿼리가 바뀌면 loading 으로 전환 (render 중 상태 조정 — effect 는 fetch 만).
  const apiQuery = skuListApiQuery(searchParams);
  const [lastApiQuery, setLastApiQuery] = useState<string | null>(null);
  if (lastApiQuery !== apiQuery) {
    setLastApiQuery(apiQuery);
    setListState('loading');
  }
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/skus${apiQuery}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const uiError = await readError(response);
          if (cancelled) return;
          setError(uiError);
          setResult(null);
          // ★ 403 을 빈 목록처럼 표시하지 않는다.
          setListState(response.status === 403 ? 'forbidden' : 'error');
          return;
        }
        const body = (await response.json()) as SkuListResponse;
        if (cancelled) return;
        setResult(body);
        setListState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setError({
          status: 0,
          message: '네트워크 오류로 목록을 불러오지 못했습니다.',
          requestId: null,
          hint: null,
          fields: [],
        });
        setListState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [apiQuery]);

  function apply(patch: SkuListPatch) {
    const next = buildSkuListParams(searchParams, patch);
    const query = next.toString();
    router.push(query === '' ? pathname : `${pathname}?${query}`);
  }

  const items = result?.items ?? [];
  const totalPages = result?.totalPages ?? 1;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-10">
      <header className="space-y-1">
        <p className="text-muted-foreground font-mono text-sm">DEEPPOINT SCM OS</p>
        <h1 className="text-2xl font-semibold tracking-tight">SKU 목록</h1>
        <p className="text-muted-foreground text-sm">
          코드·상품명·영문명 통합검색과 상태·품목구분·분류 필터를 지원합니다. 바코드·외부몰 별칭
          검색과 BOM·매핑 관련 열은 해당 모듈 도입 후 제공됩니다.
        </p>
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
          SKU 조회 권한(<span className="font-mono">sku.read</span>)이 없습니다. 관리자에게
          문의하세요.
        </div>
      )}

      {/* 검색·필터 */}
      <section className="bg-card space-y-3 rounded-md border p-4" aria-label="검색 조건">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            apply({ q: qInput.trim() });
          }}
        >
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">통합검색 (코드·상품명·영문명)</span>
            <input
              type="search"
              value={qInput}
              onChange={(event) => setQInput(event.target.value)}
              placeholder="SKU 코드·상품명 검색"
              className="bg-background h-9 w-64 rounded-md border px-3 text-sm"
              aria-label="통합검색"
            />
          </label>
          <Button size="sm" type="submit">
            검색
          </Button>

          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">상태</span>
            <select
              value={state.status}
              onChange={(event) => apply({ status: event.target.value })}
              className="bg-background h-9 rounded-md border px-2 text-sm"
              aria-label="상태 필터"
            >
              <option value="">(전체)</option>
              {SKU_LIST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {SKU_STATUS_LABELS[status]} ({status})
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">품목구분 (정확히 일치)</span>
            <input
              value={state.itemType}
              onChange={(event) => apply({ itemType: event.target.value })}
              placeholder="예: FINISHED_GOOD"
              className="bg-background h-9 w-52 rounded-md border px-3 font-mono text-sm"
              aria-label="품목구분 필터"
            />
          </label>

          <div className="w-52">
            <CodeFilter
              label="브랜드"
              value={state.brandId}
              options={brandOptions}
              onChange={(value) => apply({ brandId: value })}
            />
          </div>
          <div className="w-52">
            <CodeFilter
              label="대분류"
              value={state.majorCategoryId}
              options={majorOptions}
              onChange={(value) => apply({ majorCategoryId: value })}
            />
          </div>
          <div className="w-52">
            {/* ⚠️ MAJOR↔MINOR 계층 규칙 미확정 — 대분류 선택으로 소분류를 거르지 않는다. */}
            <CodeFilter
              label="소분류"
              value={state.minorCategoryId}
              options={minorOptions}
              onChange={(value) => apply({ minorCategoryId: value })}
            />
          </div>

          <div className="flex-1" />

          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">정렬</span>
            <select
              value={state.sort}
              onChange={(event) => apply({ sort: event.target.value })}
              className="bg-background h-9 rounded-md border px-2 text-sm"
              aria-label="정렬"
            >
              {SKU_LIST_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {SKU_LIST_SORT_LABELS[sort]}
                  {sort === DEFAULT_SORT ? ' (기본)' : ''}
                </option>
              ))}
            </select>
          </label>
        </form>
      </section>

      {/* 목록 */}
      <section className="space-y-3">
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground border-b text-left text-xs">
                <th className="px-3 py-2 font-medium">상태</th>
                <th className="px-3 py-2 font-medium">SKU 코드</th>
                <th className="px-3 py-2 font-medium">상품명</th>
                <th className="px-3 py-2 font-medium">품목구분</th>
                <th className="px-3 py-2 font-medium">브랜드</th>
                <th className="px-3 py-2 font-medium">대분류</th>
                <th className="px-3 py-2 font-medium">소분류</th>
                <th className="px-3 py-2 font-medium">재고관리</th>
                <th className="px-3 py-2 font-medium">생성자</th>
                <th className="px-3 py-2 font-medium">최종수정일</th>
              </tr>
            </thead>
            <tbody>
              {listState === 'loading' && (
                <tr>
                  <td
                    colSpan={10}
                    className="text-muted-foreground px-3 py-8 text-center"
                    data-testid="loading-state"
                  >
                    불러오는 중…
                  </td>
                </tr>
              )}
              {listState === 'forbidden' && (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center" data-testid="forbidden-list">
                    <span className="text-amber-700 dark:text-amber-300">
                      조회 권한이 없어 목록을 표시할 수 없습니다. (403
                      {error?.requestId !== null && error !== null
                        ? ` · requestId: ${error.requestId}`
                        : ''}
                      )
                    </span>
                  </td>
                </tr>
              )}
              {listState === 'error' && (
                <tr>
                  <td
                    colSpan={10}
                    className="text-destructive px-3 py-8 text-center"
                    data-testid="error-state"
                  >
                    목록 조회에 실패했습니다. 위 오류 내용을 확인하세요.
                  </td>
                </tr>
              )}
              {listState === 'ready' && items.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="text-muted-foreground px-3 py-8 text-center"
                    data-testid="empty-state"
                  >
                    조건에 맞는 SKU 가 없습니다.
                  </td>
                </tr>
              )}
              {listState === 'ready' &&
                items.map((item) => (
                  <tr key={item.id} className="border-b last:border-b-0" data-sku={item.skuCode}>
                    <td className="px-3 py-2">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-3 py-2 font-mono">{item.skuCode}</td>
                    <td className="px-3 py-2">
                      {item.skuName}
                      {item.skuNameEn !== null && (
                        <span className="text-muted-foreground text-xs"> · {item.skuNameEn}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{item.itemType}</td>
                    <td className="px-3 py-2">{refCell(item.brand)}</td>
                    <td className="px-3 py-2">{refCell(item.majorCategory)}</td>
                    <td className="px-3 py-2">{refCell(item.minorCategory)}</td>
                    <td className="px-3 py-2">{item.inventoryManaged ? '관리' : '미관리'}</td>
                    <td className="text-muted-foreground px-3 py-2 font-mono text-xs">
                      {item.createdBy === null ? (
                        '—'
                      ) : (
                        <span title={item.createdBy}>{item.createdBy.slice(0, 8)}…</span>
                      )}
                    </td>
                    <td className="text-muted-foreground px-3 py-2 font-mono text-xs">
                      {item.updatedAt.replace('T', ' ').slice(0, 19)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* 페이지네이션 — backend pagination 그대로 */}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground" data-testid="list-total">
            {listState === 'ready' && result !== null
              ? `전체 ${result.total}건 · ${result.page}/${result.totalPages} 페이지`
              : ''}
          </span>
          <div className="flex-1" />
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            페이지 크기
            <select
              value={state.pageSize}
              onChange={(event) => apply({ pageSize: Number(event.target.value) })}
              className="bg-background h-8 rounded-md border px-2 text-sm"
              aria-label="페이지 크기"
            >
              {SKU_LIST_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={listState !== 'ready' || state.page <= 1}
            onClick={() => apply({ page: state.page - 1 })}
          >
            이전
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={listState !== 'ready' || state.page >= totalPages}
            onClick={() => apply({ page: state.page + 1 })}
          >
            다음
          </Button>
        </div>

        <p className="text-muted-foreground text-xs">
          바코드·외부 매핑·BOM·오류 건수 열과 관련 필터는 해당 모듈 도입 후 제공됩니다 — 이 화면은
          존재하지 않는 데이터를 가짜 값으로 표시하지 않습니다.
        </p>
      </section>
    </main>
  );
}
