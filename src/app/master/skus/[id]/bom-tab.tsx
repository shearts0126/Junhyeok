'use client';

import { useEffect, useState } from 'react';

import { ErrorBanner, readApiError, type UiError } from '../sku-ui';

import {
  bomStatusLabel,
  bomTypeLabel,
  componentRoleLabel,
  formatEffectivePeriod,
  formatQuantityPer,
  formatQuantityProgress,
  hasUnconfirmedQuantity,
  orDash,
  quantityStatusLabel,
  requiredLabel,
  skuParentBomsApiPath,
  skuWhereUsedApiPath,
  BOM_TAB_PARENT_EMPTY_MESSAGE,
  BOM_TAB_PARENT_LOADING_MESSAGE,
  BOM_TAB_PARENT_SECTION_LABEL,
  BOM_TAB_WHERE_USED_EMPTY_MESSAGE,
  BOM_TAB_WHERE_USED_LOADING_MESSAGE,
  BOM_TAB_WHERE_USED_SECTION_LABEL,
  type ParentBomResponse,
  type ParentBomRow,
  type WhereUsedResponse,
  type WhereUsedRow,
} from './bom-view';

/**
 * SKU 상세 ⑦ BOM 탭 (T1-6B5) — **read-only**.
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-30. BOM 계약 자체는 §D-6·§D-9~§D-15 다.
 *
 * ## 이 탭이 하는 일은 둘뿐이다
 *
 *   ① 이 SKU 를 **상위로 갖는** BOM 버전 목록
 *   ② 이 SKU 가 **구성품으로 쓰인** 라인 목록
 *
 * ⛔ embedded CRUD 를 만들지 않는다 — BOM 생성·수정·라인 추가/수정/삭제·소요량
 *    확정·submit·approve·activate·clone·import 전부 없다. mutation owner 는
 *    T07-8 `/master/boms` 화면이다.
 * ⛔ 전개(explode)·원가(cost)를 여기 중복 구현하지 않는다 (T07-6·T07-7).
 * ⛔ 두 섹션을 client 에서 join 하지 않는다 — 서로 다른 질문이다.
 *
 * ## 두 요청은 독립이다
 *
 * 한쪽이 실패해도 다른 쪽 정상 데이터를 숨기지 않는다 — 섹션마다 loading /
 * empty / forbidden / error 상태를 따로 갖는다.
 */

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

type SectionState = 'loading' | 'ready' | 'forbidden' | 'error';

function StatusBadge({ status }: { readonly status: string }) {
  return (
    <span
      data-testid="bom-tab-status"
      data-status={status}
      className="bg-muted rounded px-2 py-0.5 text-xs font-medium"
    >
      {bomStatusLabel(status)}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════
// 섹션 A — 이 SKU 의 BOM
// ═══════════════════════════════════════════════════════════════

function ParentBomSection({ skuId }: { readonly skuId: string }) {
  const [rows, setRows] = useState<readonly ParentBomRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<SectionState>('loading');
  const [error, setError] = useState<UiError | null>(null);

  // ⚠️ 여기서 `setState('loading')` 을 다시 부르지 않는다 — effect 안의 동기
  //    setState 는 `react-hooks/set-state-in-effect` 위반이고, T1-6B4 공급조건
  //    탭도 같은 이유로 초기 state 만 쓴다. 페이지 이동 중에는 직전 페이지가
  //    잠깐 남으며, 이는 기존 탭들과 동일한 동작이다.
  useEffect(() => {
    let cancelled = false;
    fetch(skuParentBomsApiPath(skuId, page), { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const uiError = await readApiError(response);
          if (cancelled) return;
          setError(uiError);
          // ★ 403 을 빈 목록으로 위장하지 않는다.
          setState(response.status === 403 ? 'forbidden' : 'error');
          return;
        }
        const body = (await response.json()) as ParentBomResponse;
        if (cancelled) return;
        setRows(body.items);
        setTotal(body.total);
        setTotalPages(Math.max(body.totalPages, 1));
        setError(null);
        setState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setError(networkError('네트워크 오류로 BOM 을 불러오지 못했습니다.'));
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [skuId, page]);

  return (
    <section className="space-y-3" aria-label={BOM_TAB_PARENT_SECTION_LABEL}>
      <h2 className="text-sm font-semibold" data-testid="bom-tab-parent-heading">
        {BOM_TAB_PARENT_SECTION_LABEL}
      </h2>

      {state === 'loading' && (
        <p className="text-muted-foreground text-sm" data-testid="bom-tab-parent-loading">
          {BOM_TAB_PARENT_LOADING_MESSAGE}
        </p>
      )}

      {state === 'forbidden' && (
        <p className="text-sm" data-testid="bom-tab-parent-forbidden">
          BOM 조회 권한이 없습니다. (403)
        </p>
      )}

      {state === 'error' && error !== null && <ErrorBanner error={error} />}

      {state === 'ready' &&
        (rows.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="bom-tab-parent-empty">
            {BOM_TAB_PARENT_EMPTY_MESSAGE}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="bom-tab-parent-table">
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">버전</th>
                  <th className="px-3 py-2 text-left">유형</th>
                  <th className="px-3 py-2 text-left">상태</th>
                  <th className="px-3 py-2 text-left">적용기간</th>
                  <th className="px-3 py-2 text-left">구성품 수</th>
                  <th className="px-3 py-2 text-left">소요량 확정</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t" data-testid="bom-tab-parent-row">
                    <td className="px-3 py-2 font-mono text-xs" data-testid="bom-tab-version">
                      {row.version}
                    </td>
                    <td className="px-3 py-2" data-testid="bom-tab-type">
                      {bomTypeLabel(row.bomType)}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    {/* ★ `[from, to)` — effectiveTo=null 은 무기한. 날짜 재파싱 없음. */}
                    <td className="px-3 py-2 font-mono text-xs" data-testid="bom-tab-period">
                      {formatEffectivePeriod(row.effectiveFrom, row.effectiveTo)}
                    </td>
                    <td className="px-3 py-2" data-testid="bom-tab-line-count">
                      {row.lineCount}
                    </td>
                    {/* ★ 확정 N / 전체 M — unconfirmedCount 는 SUGGESTED 도 포함한다. */}
                    <td
                      className="px-3 py-2"
                      data-testid="bom-tab-progress"
                      data-unconfirmed={row.unconfirmedCount}
                    >
                      <span className={hasUnconfirmedQuantity(row) ? 'text-amber-700' : undefined}>
                        {formatQuantityProgress(row.lineCount, row.unconfirmedCount)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {/* 페이지 이동은 **탭 내부 local state** 다 — SKU 상세 URL 에 붙이지 않는다. */}
      {state === 'ready' && totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground" data-testid="bom-tab-parent-total">
            전체 {total}건 · {page}/{totalPages} 페이지
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
              className="rounded-md border px-3 py-1 text-xs disabled:opacity-40"
            >
              이전
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((current) => current + 1)}
              className="rounded-md border px-3 py-1 text-xs disabled:opacity-40"
            >
              다음
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════
// 섹션 B — 구성품으로 사용된 BOM (where-used)
// ═══════════════════════════════════════════════════════════════

function WhereUsedSection({ skuId }: { readonly skuId: string }) {
  const [rows, setRows] = useState<readonly WhereUsedRow[]>([]);
  const [state, setState] = useState<SectionState>('loading');
  const [error, setError] = useState<UiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(skuWhereUsedApiPath(skuId), { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const uiError = await readApiError(response);
          if (cancelled) return;
          setError(uiError);
          setState(response.status === 403 ? 'forbidden' : 'error');
          return;
        }
        const body = (await response.json()) as WhereUsedResponse;
        if (cancelled) return;
        // ★ 응답 순서·행 수를 그대로 쓴다 — dedup·정렬·필터를 하지 않는다.
        setRows(body.items);
        setError(null);
        setState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setError(networkError('네트워크 오류로 사용처를 불러오지 못했습니다.'));
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [skuId]);

  return (
    <section className="space-y-3" aria-label={BOM_TAB_WHERE_USED_SECTION_LABEL}>
      <h2 className="text-sm font-semibold" data-testid="bom-tab-where-used-heading">
        {BOM_TAB_WHERE_USED_SECTION_LABEL}
      </h2>

      {state === 'loading' && (
        <p className="text-muted-foreground text-sm" data-testid="bom-tab-where-used-loading">
          {BOM_TAB_WHERE_USED_LOADING_MESSAGE}
        </p>
      )}

      {state === 'forbidden' && (
        <p className="text-sm" data-testid="bom-tab-where-used-forbidden">
          BOM 조회 권한이 없습니다. (403)
        </p>
      )}

      {state === 'error' && error !== null && <ErrorBanner error={error} />}

      {state === 'ready' &&
        (rows.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="bom-tab-where-used-empty">
            {BOM_TAB_WHERE_USED_EMPTY_MESSAGE}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="bom-tab-where-used-table">
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">상위 SKU</th>
                  <th className="px-3 py-2 text-left">버전</th>
                  <th className="px-3 py-2 text-left">상태</th>
                  <th className="px-3 py-2 text-left">적용기간</th>
                  <th className="px-3 py-2 text-left">순번</th>
                  <th className="px-3 py-2 text-left">소요량</th>
                  <th className="px-3 py-2 text-left">소요량 상태</th>
                  <th className="px-3 py-2 text-left">구성품 유형</th>
                  <th className="px-3 py-2 text-left">필수</th>
                  <th className="px-3 py-2 text-left">대체그룹</th>
                </tr>
              </thead>
              <tbody>
                {/* ★ key 는 `lineId` — 같은 header 가 여러 행으로 나올 수 있다. */}
                {rows.map((row) => (
                  <tr key={row.lineId} className="border-t" data-testid="bom-tab-where-used-row">
                    <td className="px-3 py-2" data-bom-header-id={row.bomHeaderId}>
                      <span className="block">{row.parentSku.skuName}</span>
                      <span className="text-muted-foreground block font-mono text-xs">
                        {row.parentSku.skuCode}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{row.version}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {formatEffectivePeriod(row.effectiveFrom, row.effectiveTo)}
                    </td>
                    <td className="px-3 py-2">{row.lineNo}</td>
                    {/* ★ Decimal 문자열 그대로. UNKNOWN 은 `—` 이며 0 이 아니다. */}
                    <td className="px-3 py-2 font-mono text-xs" data-testid="bom-tab-quantity">
                      {formatQuantityPer(row.quantityPer, row.uom)}
                    </td>
                    <td className="px-3 py-2" data-testid="bom-tab-quantity-status">
                      {quantityStatusLabel(row.quantityStatus)}
                    </td>
                    <td className="px-3 py-2">{componentRoleLabel(row.componentRole)}</td>
                    <td className="px-3 py-2">{requiredLabel(row.isRequired)}</td>
                    <td className="px-3 py-2" data-testid="bom-tab-alternate-group">
                      {orDash(row.alternateGroup)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

export function BomTab({ skuId }: { readonly skuId: string }) {
  return (
    <div className="space-y-6" aria-label="BOM">
      <p className="text-muted-foreground text-xs" data-testid="bom-tab-notice">
        조회 전용입니다. BOM 등록·수정은 BOM 관리 화면에서 합니다.
      </p>
      <ParentBomSection skuId={skuId} />
      <WhereUsedSection skuId={skuId} />
    </div>
  );
}
