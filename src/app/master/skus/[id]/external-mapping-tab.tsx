'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  MAPPING_STATUS_CLASS,
  MAPPING_STATUS_LABELS,
  REVIEW_REQUIRED_NOTICE,
  formatEffectivePeriod,
  isEndedMapping,
  type MappingListStatus,
} from '../../external-mappings/list-params';
import { ErrorBanner, readApiError, type UiError } from '../sku-ui';

import {
  EXTERNAL_PRODUCT_NAME_NOTICE,
  MAPPING_TAB_EMPTY_MESSAGE,
  externalMappingManagementHref,
  externalSystemLabel,
  mappingTabTotalPages,
  orBlank,
  primaryLabel,
  skuMappingApiPath,
  type MappingSummaryRow,
} from './external-mapping-view';

/**
 * SKU 상세 ④ 외부시스템 매핑 탭 (T1-6B2) — **read-only summary**.
 *
 * ⚠️ 근거: `docs/16_설계복구_SKU상세잔여탭.md` §19~§21.
 *    매핑 계약 자체는 `docs/13`(T05-2) · `docs/15`(T05-4A) 가 authoritative 다.
 *
 * ## 이 탭이 하는 일은 셋뿐이다
 *
 *   ① 해당 SKU 의 외부 매핑 조회  ② 매핑상태 요약  ③ `EXT-MAP-001` 로 이동
 *
 * ⛔ embedded CRUD 를 만들지 않는다 — 신규/수정 dialog · 매핑 해제 · 외부시스템
 *    selector · SKU selector · identifier editor · 대표 토글 · `effectiveTo`
 *    mutation 전부 없다. 모든 변경은 `/master/external-mappings` 에서 한다.
 * ⛔ 창고 열이 없다 — `Warehouse` 는 T08-1 이며 placeholder 도 두지 않는다.
 * ⛔ 관리 화면의 URL-state 아키텍처를 가져오지 않는다 — 페이지 이동은 탭 내부
 *    local state 다 (searchParams 미사용).
 *
 * ## 신규 backend 0개
 *
 * `GET /api/external-mappings?skuId=…&page=…&pageSize=50` 하나만 쓴다.
 */

interface MappingListResponse {
  items: MappingSummaryRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
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

function StatusBadge({ status }: { status: string }) {
  const label = MAPPING_STATUS_LABELS[status as MappingListStatus] ?? status;
  return (
    <span
      data-testid="tab-mapping-status"
      data-status={status}
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${MAPPING_STATUS_CLASS[status] ?? ''}`}
      title={status === 'REVIEW_REQUIRED' ? REVIEW_REQUIRED_NOTICE : undefined}
    >
      {label}
    </span>
  );
}

export function ExternalMappingTab({ skuId }: { readonly skuId: string }) {
  const [rows, setRows] = useState<readonly MappingSummaryRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [listState, setListState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>(
    'loading',
  );
  const [listError, setListError] = useState<UiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(skuMappingApiPath(skuId, page), { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const uiError = await readApiError(response);
          if (cancelled) return;
          setListError(uiError);
          // ★ 403 을 빈 목록으로 위장하지 않는다. 400/404/500 도 구분해 보여준다.
          setListState(response.status === 403 ? 'forbidden' : 'error');
          return;
        }
        const body = (await response.json()) as MappingListResponse;
        if (cancelled) return;
        setRows(body.items);
        setTotal(body.total);
        // 서버가 준 totalPages 를 우선하고, 없으면 total 로 계산한다.
        setTotalPages(body.totalPages > 0 ? body.totalPages : mappingTabTotalPages(body.total));
        setListError(null);
        setListState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setListError(networkError('네트워크 오류로 외부 매핑을 불러오지 못했습니다.'));
        setListState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [skuId, page]);

  const managementLink = (
    <Link
      href={externalMappingManagementHref(skuId)}
      data-testid="external-mapping-manage-link"
      className="text-sm underline"
    >
      외부 매핑 관리
    </Link>
  );

  if (listState === 'loading') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="mapping-tab-loading">
        외부 매핑을 불러오는 중…
      </p>
    );
  }

  if (listState === 'forbidden') {
    return (
      <p className="text-sm" data-testid="mapping-tab-forbidden">
        외부 매핑 조회 권한이 없습니다. (403)
      </p>
    );
  }

  return (
    <section className="space-y-4" aria-label="외부시스템 매핑">
      {listState === 'error' && listError !== null && <ErrorBanner error={listError} />}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-muted-foreground text-xs" data-testid="external-name-notice">
          {EXTERNAL_PRODUCT_NAME_NOTICE}
        </p>
        {managementLink}
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="mapping-tab-empty">
          {MAPPING_TAB_EMPTY_MESSAGE}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs">
              <tr>
                <th className="px-3 py-2 text-left">외부시스템</th>
                <th className="px-3 py-2 text-left">외부코드</th>
                <th className="px-3 py-2 text-left">외부상품명</th>
                <th className="px-3 py-2 text-left">매핑상태</th>
                <th className="px-3 py-2 text-left">대표</th>
                <th className="px-3 py-2 text-left">적용기간</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid="tab-mapping-row"
                  data-mapping-id={row.id}
                  className="border-t"
                >
                  <td className="px-3 py-2" data-testid="tab-mapping-system">
                    {externalSystemLabel(row.externalSystem)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs" data-testid="tab-mapping-code">
                    {orBlank(row.externalProductCode)}
                  </td>
                  <td className="px-3 py-2" data-testid="tab-mapping-name">
                    {orBlank(row.externalProductName)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.mappingStatus} />
                  </td>
                  <td className="px-3 py-2" data-testid="tab-mapping-primary">
                    {primaryLabel(row.isPrimary)}
                  </td>
                  <td className="px-3 py-2 text-xs" data-testid="tab-mapping-period">
                    {formatEffectivePeriod(row.effectiveFrom, row.effectiveTo)}
                    {/* 종료된 매핑도 숨기지 않는다 — 이력이다 (T05-2 GET 계약). */}
                    {isEndedMapping(row.effectiveTo) && (
                      <span data-testid="tab-mapping-ended" className="text-muted-foreground ml-2">
                        종료됨
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 페이지 이동은 탭 내부 상태다 — URL searchParams 를 만들지 않는다. */}
      {totalPages > 1 && (
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span data-testid="mapping-tab-page-info">
            {page} / {totalPages} 페이지 · 총 {total} 건
          </span>
          <span className="space-x-2">
            <button
              type="button"
              data-testid="mapping-tab-prev"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className="underline disabled:opacity-40"
            >
              이전
            </button>
            <button
              type="button"
              data-testid="mapping-tab-next"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => value + 1)}
              className="underline disabled:opacity-40"
            >
              다음
            </button>
          </span>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        신규 매핑 · 수정 · 매핑 해제는 외부 매핑 관리 화면에서 수행합니다.
      </p>
    </section>
  );
}
