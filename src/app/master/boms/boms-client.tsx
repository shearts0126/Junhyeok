'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

import { ErrorBanner, readApiError, usePermissions, type UiError } from '../skus/sku-ui';

import {
  buildBomListParams,
  bomListApiQuery,
  formatOptional,
  formatTimestamp,
  periodEndedLabel,
  readBomListState,
  toReferenceCostCell,
  BOM_STATUS_SUGGESTIONS,
  BOM_TYPE_SUGGESTIONS,
  type ReferenceCost,
} from './list-params';
import { SkuPicker } from './sku-picker';

/**
 * BOM 목록 화면 (T07-8).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-30·§D-31 ·
 *    `★ T07-8 BOM UI read-model gap closure` ·
 *    `★ T07-8 list reference-cost fault isolation remediation`.
 *
 * - 목록·검색은 **URL searchParams 가 단일 진실**이다. 미지원 파라미터는 조용히
 *   지우지 않고 API 400 을 그대로 보여준다.
 * - 열은 **정확히 12개**, 필터는 **정확히 7개**, 목록 버튼은 **정확히 5개**다.
 * - `기준원가` 는 KRW subtotal 을 `vatIncluded` 별로 보여주고 다른 통화가 있으면
 *   `+` 를 붙인다. ⛔ 합산·환산 없음. 무결성 오류면 **`계산 불가`** 다 —
 *   ⛔ `—`·`0원`·`잠정` 으로 위장하지 않는다 (R8-13).
 * - 권한 UI 는 `/api/me` permissions 로만 판단한다. 권한 없는 mutation control 은
 *   **렌더하지 않는다**(disabled 아님).
 *
 * ⛔ 없는 것: 엑셀 업로드 · 목록 전개/원가 버튼 · 정렬 UI · 페이지 크기 선택 ·
 *    `/new` 라우트 · 새 UI library.
 */

interface BomListItem {
  id: string;
  parentSkuId: string;
  parentSku: { id: string; skuCode: string; skuName: string };
  bomType: string;
  version: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  approvedBy: string | null;
  lineCount: number;
  unconfirmedCount: number;
  lastModifiedAt: string;
  referenceCost: ReferenceCost;
}

interface BomListResponse {
  items: BomListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface CreateForm {
  parentSkuId: string;
  parentSkuLabel: string;
  bomType: string;
  version: string;
  effectiveFrom: string;
}

const EMPTY_CREATE: CreateForm = {
  parentSkuId: '',
  parentSkuLabel: '',
  bomType: 'MANUFACTURING',
  version: '',
  effectiveFrom: '',
};

export function BomsClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => readBomListState(searchParams), [searchParams]);
  const permissions = usePermissions();

  const canRead = permissions?.includes('bom.read') ?? false;
  const canCreate = permissions?.includes('bom.create') ?? false;
  const canSubmit = permissions?.includes('bom.submit') ?? false;
  const canApprove = permissions?.includes('bom.approve') ?? false;

  const [result, setResult] = useState<BomListResponse | null>(null);
  const [listState, setListState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<UiError | null>(null);
  const [qInput, setQInput] = useState(state.q);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createForm, setCreateForm] = useState<CreateForm | null>(null);

  const [lastUrlQ, setLastUrlQ] = useState(state.q);
  if (state.q !== lastUrlQ) {
    setLastUrlQ(state.q);
    setQInput(state.q);
  }

  const apiQuery = bomListApiQuery(searchParams);
  const [lastApiQuery, setLastApiQuery] = useState<string | null>(null);
  if (lastApiQuery !== apiQuery) {
    setLastApiQuery(apiQuery);
    setListState('loading');
  }

  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/boms${apiQuery}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          // ★ 403 을 빈 목록처럼 표시하지 않는다.
          setListState(response.status === 403 ? 'forbidden' : 'error');
          setError(await readApiError(response));
          setResult(null);
          return;
        }
        setResult((await response.json()) as BomListResponse);
        setError(null);
        setListState('ready');
      })
      .catch(async (cause: unknown) => {
        if (cancelled) return;
        setListState('error');
        setError({
          status: 0,
          code: null,
          message: cause instanceof Error ? cause.message : '목록을 불러오지 못했습니다.',
          requestId: null,
          hint: null,
          fields: [],
          validation: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [apiQuery, reloadToken]);

  const patch = (next: Parameters<typeof buildBomListParams>[1]) => {
    router.replace(`${pathname}?${buildBomListParams(searchParams, next).toString()}`);
  };

  const submitCreate = async () => {
    if (createForm === null) return;
    setBusy(true);
    try {
      const response = await fetch('/api/boms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentSkuId: createForm.parentSkuId,
          bomType: createForm.bomType,
          version: createForm.version,
          effectiveFrom: createForm.effectiveFrom,
        }),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as { bom: { id: string } };
      setCreateForm(null);
      // 생성 성공 → 새 BOM 상세로 이동 (T06-4 와 같은 convention).
      router.push(`/master/boms/${body.bom.id}`);
    } finally {
      setBusy(false);
    }
  };

  /** 목록 workflow action — 선택한 한 건에 대해 실행한다. */
  const runAction = async (action: string, body: Record<string, string>) => {
    if (selected === null) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/boms/${selected}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      setError(null);
      setReloadToken((token) => token + 1);
    } finally {
      setBusy(false);
    }
  };

  const businessDate = new Date().toISOString().slice(0, 10);

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">BOM 관리</h1>
          <p className="mt-1 text-sm text-neutral-500">
            BOM 의 생성·수정·승인은 이 화면에서 합니다.
          </p>
        </div>
        {/* ★ 목록 버튼 정확히 5개. ⛔ 업로드·전개·원가 버튼 없음 (D-31). */}
        <div className="flex gap-2">
          {canCreate ? <Button onClick={() => setCreateForm(EMPTY_CREATE)}>신규</Button> : null}
          {canCreate ? (
            <Button
              variant="secondary"
              disabled={selected === null || busy}
              onClick={() => {
                if (selected !== null) router.push(`/master/boms/${selected}?clone=1`);
              }}
            >
              복사
            </Button>
          ) : null}
          {canSubmit ? (
            <Button
              variant="secondary"
              disabled={selected === null || busy}
              onClick={() => void runAction('submit', {})}
            >
              승인 요청
            </Button>
          ) : null}
          {canApprove ? (
            <Button
              variant="secondary"
              disabled={selected === null || busy}
              onClick={() => void runAction('activate', {})}
            >
              활성화
            </Button>
          ) : null}
          {canApprove ? (
            <Button
              variant="secondary"
              disabled={selected === null || busy}
              onClick={() =>
                void runAction('deactivate', {
                  effectiveTo: businessDate,
                  reason: '목록에서 사용종료',
                })
              }
            >
              사용종료
            </Button>
          ) : null}
        </div>
      </header>

      {error !== null ? <ErrorBanner error={error} /> : null}

      {/* ★ 필터 정확히 7개 (page 는 하단 페이저). */}
      <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="bom-filters">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">상위 SKU 검색</span>
          <input
            className="w-full rounded border px-2 py-1"
            value={qInput}
            aria-label="상위 SKU 검색"
            onChange={(event) => setQInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') patch({ q: qInput });
            }}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">상태</span>
          <select
            className="w-full rounded border px-2 py-1"
            value={state.status}
            aria-label="상태"
            onChange={(event) => patch({ status: event.target.value })}
          >
            <option value="">전체</option>
            {BOM_STATUS_SUGGESTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">BOM 유형</span>
          <select
            className="w-full rounded border px-2 py-1"
            value={state.bomType}
            aria-label="BOM 유형"
            onChange={(event) => patch({ bomType: event.target.value })}
          >
            <option value="">전체</option>
            {BOM_TYPE_SUGGESTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">상위 SKU ID</span>
          <input
            className="w-full rounded border px-2 py-1"
            defaultValue={state.parentSkuId}
            aria-label="상위 SKU ID"
            onBlur={(event) => patch({ parentSkuId: event.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">적용 기준일</span>
          <input
            type="date"
            className="w-full rounded border px-2 py-1"
            defaultValue={state.effectiveOn}
            aria-label="적용 기준일"
            onChange={(event) => patch({ effectiveOn: event.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">미확정 수량</span>
          <select
            className="w-full rounded border px-2 py-1"
            value={state.hasUnknownQty}
            aria-label="미확정 수량"
            onChange={(event) => patch({ hasUnknownQty: event.target.value })}
          >
            <option value="">전체</option>
            <option value="true">미확정 있음</option>
            <option value="false">미확정 없음</option>
          </select>
        </label>
      </section>

      {listState === 'loading' ? <p className="text-sm">불러오는 중…</p> : null}
      {listState === 'forbidden' ? (
        <p className="text-sm text-red-600">BOM 을 조회할 권한이 없습니다.</p>
      ) : null}

      {listState === 'ready' && result !== null ? (
        <>
          <table className="w-full border-collapse text-sm" data-testid="bom-list">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                {canCreate || canSubmit || canApprove ? <th className="w-8 px-2 py-2" /> : null}
                <th className="px-2 py-2">상태</th>
                <th className="px-2 py-2">상위 SKU</th>
                <th className="px-2 py-2">상품명</th>
                <th className="px-2 py-2">BOM 유형</th>
                <th className="px-2 py-2">버전</th>
                <th className="px-2 py-2">적용 시작일</th>
                <th className="px-2 py-2">적용 종료일</th>
                <th className="px-2 py-2">구성품 수</th>
                <th className="px-2 py-2">기준원가</th>
                <th className="px-2 py-2">미확정 항목 수</th>
                <th className="px-2 py-2">승인자</th>
                <th className="px-2 py-2">수정일</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((row) => {
                const cell = toReferenceCostCell(row.referenceCost);
                const ended = periodEndedLabel(row, businessDate);
                return (
                  <tr key={row.id} className="border-b align-top">
                    {canCreate || canSubmit || canApprove ? (
                      <td className="px-2 py-2">
                        <input
                          type="radio"
                          name="bom-select"
                          aria-label={`${row.parentSku.skuCode} ${row.version} 선택`}
                          checked={selected === row.id}
                          onChange={() => setSelected(row.id)}
                        />
                      </td>
                    ) : null}
                    <td className="px-2 py-2">
                      <span>{row.status}</span>
                      {/* ★ status 와 적용기간을 분리 표시한다 (D-7). */}
                      {ended !== null ? (
                        <span className="ml-1 rounded bg-neutral-200 px-1 text-xs">{ended}</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">
                      <Link className="underline" href={`/master/boms/${row.id}`}>
                        {row.parentSku.skuCode}
                      </Link>
                    </td>
                    <td className="px-2 py-2">{row.parentSku.skuName}</td>
                    <td className="px-2 py-2">{row.bomType}</td>
                    <td className="px-2 py-2">{row.version}</td>
                    <td className="px-2 py-2">{row.effectiveFrom}</td>
                    <td className="px-2 py-2">{formatOptional(row.effectiveTo)}</td>
                    <td className="px-2 py-2">{row.lineCount}</td>
                    <td className="px-2 py-2" data-testid={`reference-cost-${row.id}`}>
                      {cell.kind === 'unavailable' ? (
                        // ★ R8-13 — 무결성 오류를 숨기지 않는다.
                        <span className="text-red-600" title={cell.errorCode}>
                          계산 불가 · {cell.label}
                        </span>
                      ) : cell.kind === 'empty' ? (
                        <span>—</span>
                      ) : (
                        <span>
                          {cell.amounts.length === 0 ? '—' : cell.amounts.join(' / ')}
                          {cell.hasOtherCurrency ? ' +' : ''}
                          {cell.isProvisional ? (
                            <span className="ml-1 rounded bg-amber-200 px-1 text-xs">잠정</span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2">{row.unconfirmedCount}</td>
                    <td className="px-2 py-2">{formatOptional(row.approvedBy)}</td>
                    <td className="px-2 py-2">{formatTimestamp(row.lastModifiedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {result.items.length === 0 ? (
            <p className="mt-4 text-sm text-neutral-500">조건에 맞는 BOM 이 없습니다.</p>
          ) : null}

          <nav className="mt-4 flex items-center gap-3 text-sm">
            <Button
              variant="secondary"
              disabled={result.page <= 1}
              onClick={() => patch({ page: String(result.page - 1) })}
            >
              이전
            </Button>
            <span>
              {result.page} / {Math.max(result.totalPages, 1)} (총 {result.total})
            </span>
            <Button
              variant="secondary"
              disabled={result.page >= result.totalPages}
              onClick={() => patch({ page: String(result.page + 1) })}
            >
              다음
            </Button>
          </nav>
        </>
      ) : null}

      {!canRead && permissions !== null ? (
        <p className="text-sm text-red-600">BOM 을 조회할 권한이 없습니다.</p>
      ) : null}

      {createForm !== null ? (
        <div className="fixed inset-0 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg rounded bg-white p-5" role="dialog" aria-label="신규 BOM">
            <h2 className="mb-3 text-lg font-semibold">신규 BOM</h2>

            {/* ★ 상위 SKU 는 기존 `/api/skus?q=` 검색으로 고른다. ⛔ UUID 직접 입력 금지. */}
            <SkuPicker
              label="상위 SKU"
              selectedId={createForm.parentSkuId}
              selectedLabel={createForm.parentSkuLabel}
              onPick={(sku) =>
                setCreateForm({
                  ...createForm,
                  parentSkuId: sku.id,
                  parentSkuLabel: `${sku.skuCode} ${sku.skuName}`,
                })
              }
              onError={setError}
            />

            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-neutral-500">BOM 유형</span>
              <select
                className="w-full rounded border px-2 py-1"
                aria-label="BOM 유형 선택"
                value={createForm.bomType}
                onChange={(event) => setCreateForm({ ...createForm, bomType: event.target.value })}
              >
                {BOM_TYPE_SUGGESTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-neutral-500">버전</span>
              <input
                className="w-full rounded border px-2 py-1"
                aria-label="버전"
                value={createForm.version}
                onChange={(event) => setCreateForm({ ...createForm, version: event.target.value })}
              />
            </label>

            <label className="mb-4 block text-sm">
              <span className="mb-1 block text-neutral-500">적용 시작일</span>
              <input
                type="date"
                className="w-full rounded border px-2 py-1"
                aria-label="적용 시작일"
                value={createForm.effectiveFrom}
                onChange={(event) =>
                  setCreateForm({ ...createForm, effectiveFrom: event.target.value })
                }
              />
            </label>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreateForm(null)}>
                취소
              </Button>
              <Button
                disabled={busy || createForm.parentSkuId === '' || createForm.version === ''}
                onClick={() => void submitCreate()}
              >
                생성
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
