'use client';

import { useEffect, useState } from 'react';

import { ErrorBanner, readApiError, type UiError } from '../sku-ui';

import {
  HISTORY_ACTOR_LABEL,
  HISTORY_AFTER_LABEL,
  HISTORY_BEFORE_LABEL,
  HISTORY_EMPTY_MESSAGE,
  HISTORY_REASON_LABEL,
  formatHistoryJson,
  hasHistoryReason,
  historyActionLabel,
  historyEntityLabel,
  historyTotalPages,
  skuHistoryApiPath,
  type HistoryRow,
} from './history-view';

/**
 * SKU 상세 ⑥ 변경이력 탭 (T1-6B3) — **read-only 타임라인 + JSON diff**.
 *
 * ⚠️ 근거: `docs/16_설계복구_SKU상세잔여탭.md` §27~§40.
 *
 * ## 범위
 *
 * `GET /api/skus/{id}/history` 하나만 쓴다. 서버가 **`Sku` + 그 SKU 의
 * `SkuBarcode`** 감사로그를 최신순으로 준다.
 *
 * ⛔ 외부매핑 이력은 이 탭에 나오지 않는다 (`docs/16` §29 — 근거 없음).
 * ⛔ global `/admin/audit-logs`(전 엔티티 검색·기간·actor 필터·엑셀)를 만들지 않는다.
 * ⛔ action·기간·entity 필터 UI 없음 — API 가 `page` 만 받는다.
 * ⛔ `approvedBy`·`requestId`·`sessionId`·`ipAddress` 는 응답에도 화면에도 없다.
 *
 * ## diff
 *
 * 행은 **summary + native `<details>`** 다. 상세에서 저장된 JSON 을 그대로
 * pretty-print 한다 — ⛔ field label 매핑·action 별 렌더러·accordion framework
 * 를 만들지 않는다.
 *
 * ## 변경자
 *
 * `actorId` **UUID 원문**을 표시한다. ⛔ 사용자 조회 API 를 만들지 않으며 이름을
 * 추정하지 않는다 (SKU 상세 감사 메타의 기존 convention 과 동일).
 */

interface HistoryResponse {
  items: HistoryRow[];
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

function JsonPanel({ label, value, testId }: { label: string; value: unknown; testId: string }) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <pre
        data-testid={testId}
        className="bg-muted/40 max-h-80 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap"
      >
        {formatHistoryJson(value)}
      </pre>
    </div>
  );
}

export function HistoryTab({ skuId }: { readonly skuId: string }) {
  const [rows, setRows] = useState<readonly HistoryRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [listState, setListState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>(
    'loading',
  );
  const [listError, setListError] = useState<UiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(skuHistoryApiPath(skuId, page), { cache: 'no-store' })
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
        const body = (await response.json()) as HistoryResponse;
        if (cancelled) return;
        setRows(body.items);
        setTotal(body.total);
        setTotalPages(
          Number.isFinite(body.totalPages) ? body.totalPages : historyTotalPages(body.total),
        );
        setListError(null);
        setListState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setListError(networkError('네트워크 오류로 변경이력을 불러오지 못했습니다.'));
        setListState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [skuId, page]);

  if (listState === 'loading') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="history-tab-loading">
        변경이력을 불러오는 중…
      </p>
    );
  }

  if (listState === 'forbidden') {
    return (
      <p className="text-sm" data-testid="history-tab-forbidden">
        변경이력 조회 권한이 없습니다. (403)
      </p>
    );
  }

  return (
    <section className="space-y-4" aria-label="변경이력">
      {listState === 'error' && listError !== null && <ErrorBanner error={listError} />}

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="history-tab-empty">
          {HISTORY_EMPTY_MESSAGE}
        </p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid="history-row"
              data-entity-type={row.entityType}
              data-action={row.action}
              className="bg-card rounded-md border p-3"
            >
              <details>
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                    <span
                      className="text-muted-foreground font-mono text-xs"
                      data-testid="history-occurred-at"
                    >
                      {row.occurredAt}
                    </span>
                    <span
                      data-testid="history-entity"
                      className="bg-muted rounded px-2 py-0.5 text-xs font-medium"
                    >
                      {historyEntityLabel(row.entityType)}
                    </span>
                    <span className="font-medium" data-testid="history-action">
                      {historyActionLabel(row.action)}
                    </span>
                    <span className="text-muted-foreground text-xs underline">상세 보기</span>
                  </div>
                  <div className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                    <p>
                      {HISTORY_ACTOR_LABEL}{' '}
                      <span className="font-mono" data-testid="history-actor">
                        {row.actorId}
                      </span>
                    </p>
                    {/* ★ 값이 없으면 줄 자체를 만들지 않는다 — `—` placeholder 없음. */}
                    {hasHistoryReason(row.reason) && (
                      <p data-testid="history-reason">
                        {HISTORY_REASON_LABEL} {row.reason}
                      </p>
                    )}
                  </div>
                </summary>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <JsonPanel
                    label={HISTORY_BEFORE_LABEL}
                    value={row.beforeValue}
                    testId="history-before"
                  />
                  <JsonPanel
                    label={HISTORY_AFTER_LABEL}
                    value={row.afterValue}
                    testId="history-after"
                  />
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}

      {/* 페이지 이동은 탭 내부 상태다 — URL searchParams 를 만들지 않는다. */}
      {totalPages > 1 && (
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span data-testid="history-page-info">
            {page} / {totalPages} 페이지 · 총 {total} 건
          </span>
          <span className="space-x-2">
            <button
              type="button"
              data-testid="history-prev"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className="underline disabled:opacity-40"
            >
              이전
            </button>
            <button
              type="button"
              data-testid="history-next"
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
        SKU 자체와 해당 SKU 바코드의 변경 기록입니다. 감사로그는 수정·삭제할 수 없습니다.
      </p>
    </section>
  );
}
