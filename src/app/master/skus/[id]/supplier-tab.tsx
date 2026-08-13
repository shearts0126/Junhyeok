'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { supplyTypeLabel } from '@/modules/supplier/presentation/supply-type';

import { ErrorBanner, readApiError, type UiError } from '../sku-ui';

import {
  formatEffectiveLeadTime,
  formatRecentPrice,
  orDash,
  primaryTabLabel,
  skuSupplierApiPath,
  supplierManagementHref,
  supplierSkuLabel,
  SUPPLIER_TAB_EMPTY_MESSAGE,
  SUPPLIER_TAB_LOADING_MESSAGE,
  type SupplierSummaryResponse,
  type SupplierSummaryRow,
} from './supplier-view';

/**
 * SKU 상세 ⑥ 공급조건 탭 (T1-6B4) — **read-only summary**.
 *
 * ⚠️ 근거: `docs/16_설계복구_SKU상세잔여탭.md` §41~. 공급조건·가격 계약 자체는
 *    `docs/17`(T06-1~T06-4)이 authoritative 다.
 *
 * ## 이 탭이 하는 일은 셋뿐이다
 *
 *   ① 이 SKU 의 **현재 유효** 공급조건 조회  ② 적용 리드타임·최근 단가 요약
 *   ③ 거래처 관리 화면으로 이동
 *
 * ⛔ embedded CRUD 를 만들지 않는다 — 공급조건 추가·수정·기간 종료/단축·
 *    새 버전 생성·가격 등록·가격 승인·삭제 전부 없다. **모든 변경은
 *    `/master/suppliers` 에서 한다** (docs/17 §95 D-34·D-35).
 * ⛔ 과거·미래 이력을 보여주지 않는다 — 이력 owner 는 T06-4 관리화면이다.
 * ⛔ `asOf` 입력 UI 가 없다 — 기준일은 서버 업무일자다.
 * ⛔ 창고·첨부 열이 없다 (T08·Attachment 미착수).
 *
 * ## 신규 backend 1개
 *
 * `GET /api/skus/{id}/supplier-skus?page=…` 하나만 쓴다. 가격까지 이 응답에
 * 들어 있어 **행마다 `/prices` 를 부르지 않는다**(N+1 없음).
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

export function SupplierTab({ skuId }: { readonly skuId: string }) {
  const [rows, setRows] = useState<readonly SupplierSummaryRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [listState, setListState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>(
    'loading',
  );
  const [listError, setListError] = useState<UiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(skuSupplierApiPath(skuId, page), { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const uiError = await readApiError(response);
          if (cancelled) return;
          setListError(uiError);
          // ★ 403 을 빈 목록으로 위장하지 않는다. 409(가격 chain 손상)도 그대로 보인다.
          setListState(response.status === 403 ? 'forbidden' : 'error');
          return;
        }
        const body = (await response.json()) as SupplierSummaryResponse;
        if (cancelled) return;
        setRows(body.items);
        setTotal(body.total);
        setTotalPages(Math.max(body.totalPages, 1));
        setAsOf(body.asOf);
        setListError(null);
        setListState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setListError(networkError('네트워크 오류로 공급조건을 불러오지 못했습니다.'));
        setListState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [skuId, page]);

  if (listState === 'loading') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="supplier-tab-loading">
        {SUPPLIER_TAB_LOADING_MESSAGE}
      </p>
    );
  }

  if (listState === 'forbidden') {
    return (
      <p className="text-sm" data-testid="supplier-tab-forbidden">
        공급조건 조회 권한이 없습니다. (403)
      </p>
    );
  }

  return (
    <section className="space-y-4" aria-label="공급조건">
      {listState === 'error' && listError !== null && <ErrorBanner error={listError} />}

      <p className="text-muted-foreground text-xs" data-testid="supplier-tab-notice">
        {asOf === null ? '' : `${asOf} 기준 `}현재 유효한 공급조건과 승인된 단가입니다. 과거·미래
        이력과 등록·수정은 거래처 관리 화면에서 합니다.
      </p>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="supplier-tab-empty">
          {SUPPLIER_TAB_EMPTY_MESSAGE}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="supplier-tab-table">
            <thead className="bg-muted/50 text-muted-foreground text-xs">
              <tr>
                <th className="px-3 py-2 text-left">공급업체</th>
                <th className="px-3 py-2 text-left">공급업체 SKU</th>
                <th className="px-3 py-2 text-left">MOQ</th>
                <th className="px-3 py-2 text-left">리드타임</th>
                <th className="px-3 py-2 text-left">공급유형</th>
                <th className="px-3 py-2 text-left">우선공급업체</th>
                <th className="px-3 py-2 text-left">최근 단가</th>
                <th className="px-3 py-2 text-left">관리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t" data-testid="supplier-tab-row">
                  <td className="px-3 py-2">
                    <span className="block">{row.supplier.supplierName}</span>
                    <span className="text-muted-foreground block font-mono text-xs">
                      {row.supplier.supplierCode}
                    </span>
                  </td>
                  <td className="px-3 py-2" data-testid="supplier-tab-sku">
                    {supplierSkuLabel(row)}
                  </td>
                  {/* ★ Decimal 문자열 그대로 — 숫자 변환 없음. */}
                  <td className="px-3 py-2 font-mono text-xs" data-testid="supplier-tab-moq">
                    {orDash(row.moq)}
                  </td>
                  {/* ★ 적용 리드타임(파생) — 0 은 0 으로 보인다. */}
                  <td className="px-3 py-2" data-testid="supplier-tab-lead-time">
                    {formatEffectiveLeadTime(row.effectiveLeadTimeDays)}
                  </td>
                  <td className="px-3 py-2" data-testid="supplier-tab-supply-type">
                    {supplyTypeLabel(row.supplyType)}
                  </td>
                  <td className="px-3 py-2" data-testid="supplier-tab-primary">
                    {primaryTabLabel(row.isPrimary)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs" data-testid="supplier-tab-price">
                    {formatRecentPrice(row.recentPrice)}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={supplierManagementHref(row.supplierId)}
                      data-testid="supplier-tab-manage-link"
                      className="text-xs underline underline-offset-2"
                    >
                      거래처 관리에서 보기
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 페이지 이동은 **탭 내부 local state** 다 — SKU 상세 URL 에 붙이지 않는다. */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground" data-testid="supplier-tab-total">
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
