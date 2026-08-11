'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

import { ErrorBanner, readApiError, type UiError } from '../sku-ui';

import {
  BARCODE_STATUS_LABELS,
  BARCODE_TYPE_OPTIONS,
  DUPLICATE_WARNING,
  EMPTY_BARCODE_CREATE_FORM,
  buildApproveDuplicatePayload,
  buildBarcodeCreatePayload,
  buildDuplicateCandidatePayload,
  buildReactivatePayload,
  buildTogglePrimaryPayload,
  formatBarcodePeriod,
  isApprovalReasonValid,
  isApprovedDuplicate,
  isDuplicateBarcodeConflict,
  isPendingDuplicate,
  orDash,
  visibleBarcodeActions,
  type BarcodeCreateForm,
  type BarcodeRow,
  type BarcodeRowStatus,
  type BarcodeTypeOption,
} from './barcode-form';

/**
 * SKU 상세 ③ 바코드 탭 (T1-6B1) — **T04-4B 중복 예외 승인 UI 를 포함**한다.
 *
 * ⚠️ 근거: `docs/16_설계복구_SKU상세잔여탭.md` (2026-08-11 Design Recovery Decision).
 *    바코드 계약 자체는 `docs/10`(T04-3) · `docs/11`(T04-4A) 이 authoritative 다.
 *
 * ## 신규 backend 0개
 *
 * 기존 6개 endpoint 만 쓴다 — GET/POST `/barcodes`, PATCH/DELETE `/barcodes/{bid}`,
 * POST `/barcodes/duplicate-candidates`, POST `/barcodes/{bid}/approve-duplicate`.
 * ⛔ 중복 사전조회 API · 사용자 조회 API · 감사로그 조회 API 를 만들지 않는다.
 *
 * ## 중복 예외 흐름 (409 **사후** 방식)
 *
 *   ① 일반 등록 → ② 409 `BARCODE_DUPLICATE` → ③ dialog 유지 · 입력값 유지
 *   → ④ 인라인 경고 → ⑤ 권한이 있으면 `중복 예외 요청` CTA
 *   → ⑥ **사용자가 명시적으로 클릭**해야 후보가 만들어진다
 *
 * ⛔ 409 를 받았다고 후보를 자동 생성하지 않는다 — 바코드 공유는 사용자의
 *    의도적 결정이며, 서버도 그래서 별도 endpoint 로 분리했다 (`docs/11` §2).
 * ⛔ 승인 취소(revoke) UI 는 없다 — 계약 자체가 존재하지 않는다 (`docs/16` §14).
 *
 * ## 조회 전용 메타
 *
 * 국가·채널·적용기간은 GET 에는 있지만 POST/PATCH V1 이 입력을 받지 않는다
 * (strict → 400). 그래서 **표시만** 하고 폼에 넣지 않는다. 값이 없으면 `—` 다.
 */

interface BarcodeListResponse {
  barcodes: BarcodeRow[];
}

const STATUS_CLASS: Readonly<Record<string, string>> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  INACTIVE: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  PENDING_DUPLICATE: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
};

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

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function StatusBadge({ status }: { status: string }) {
  const label = BARCODE_STATUS_LABELS[status as BarcodeRowStatus] ?? status;
  return (
    <span
      data-testid="barcode-status"
      data-status={status}
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status] ?? ''}`}
    >
      {label}
    </span>
  );
}

export function BarcodeTab({
  skuId,
  skuCode,
  permissions,
}: {
  readonly skuId: string;
  readonly skuCode: string;
  readonly permissions: readonly string[] | null;
}) {
  const [rows, setRows] = useState<readonly BarcodeRow[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>(
    'loading',
  );
  const [listError, setListError] = useState<UiError | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<UiError | null>(null);

  // 신규 등록 dialog — 409 이후에도 **닫지 않고** 입력값을 유지한다.
  const [createForm, setCreateForm] = useState<BarcodeCreateForm | null>(null);
  const [createError, setCreateError] = useState<UiError | null>(null);
  /** 논리적 생성 시도 1개당 1개. 내용이 바뀌면 새 시도다. */
  const [createKey, setCreateKey] = useState<string>('');

  // 중복 예외 승인 dialog
  const [approveTarget, setApproveTarget] = useState<BarcodeRow | null>(null);
  const [approveReason, setApproveReason] = useState('');
  const [approveError, setApproveError] = useState<UiError | null>(null);

  const canCreate = permissions?.includes('barcode.create') ?? false;
  const canRequestDuplicate = permissions?.includes('barcode.request_duplicate') ?? false;

  // ⚠️ 재조회(`tick`)에서 `loading` 으로 되돌리지 않는다 — 목록을 유지한 채
  //    갱신하는 편이 낫고, effect 안의 동기 setState 는 cascading render 를 만든다.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/skus/${skuId}/barcodes`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const uiError = await readApiError(response);
          if (cancelled) return;
          setListError(uiError);
          // ★ 403 을 빈 목록으로 위장하지 않는다.
          setListState(response.status === 403 ? 'forbidden' : 'error');
          return;
        }
        const body = (await response.json()) as BarcodeListResponse;
        if (cancelled) return;
        setRows(body.barcodes);
        setListError(null);
        setListState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setListError(networkError('네트워크 오류로 바코드 목록을 불러오지 못했습니다.'));
        setListState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [skuId, tick]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  function openCreate() {
    setCreateForm(EMPTY_BARCODE_CREATE_FORM);
    setCreateError(null);
    setCreateKey(newIdempotencyKey());
    setNotice(null);
    setActionError(null);
  }

  function patchCreate(patch: Partial<BarcodeCreateForm>) {
    setCreateForm((current) => {
      if (current === null) return current;
      const next = { ...current, ...patch };
      // 내용이 바뀌면 **새 논리적 시도**다 — 새 멱등 키를 쓴다.
      setCreateKey(newIdempotencyKey());
      setCreateError(null);
      return next;
    });
  }

  /** 일반 등록. 409 `BARCODE_DUPLICATE` 면 dialog·입력값을 유지한다. */
  async function submitCreate() {
    if (createForm === null || busy) return;
    setBusy(true);
    setCreateError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/skus/${skuId}/barcodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': createKey },
        body: JSON.stringify(buildBarcodeCreatePayload(createForm)),
      });
      if (!response.ok) {
        setCreateError(await readApiError(response));
        return;
      }
      if (response.status === 204) {
        // ★ 미입력 표시값(`-`·공란) — 저장된 행이 없다. 성공으로 위장하지 않는다.
        setCreateError(
          networkError('입력값이 미입력 표시값이라 저장하지 않았습니다. 바코드를 확인하세요.'),
        );
        return;
      }
      setCreateForm(null);
      setNotice('바코드를 등록했습니다.');
      refresh();
    } catch {
      setCreateError(networkError('네트워크 오류로 등록하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 중복 예외 **요청** — 사용자가 명시적으로 눌렀을 때만 호출된다.
   * 등록 시도와는 **별개의 논리적 mutation** 이므로 새 멱등 키를 쓴다.
   */
  async function submitDuplicateCandidate() {
    if (createForm === null || busy) return;
    setBusy(true);
    setCreateError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/skus/${skuId}/barcodes/duplicate-candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newIdempotencyKey() },
        body: JSON.stringify(buildDuplicateCandidatePayload(createForm)),
      });
      if (!response.ok) {
        setCreateError(await readApiError(response));
        return;
      }
      setCreateForm(null);
      // 201(신규) · 200(기존 후보·replay) 모두 "요청이 등록된 상태"다.
      setNotice('중복 예외 요청을 등록했습니다. 승인 권한자가 검토합니다.');
      refresh();
    } catch {
      setCreateError(networkError('네트워크 오류로 중복 예외 요청을 보내지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  async function runRowMutation(
    input: RequestInfo,
    init: RequestInit,
    successMessage: string,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        setActionError(await readApiError(response));
        return;
      }
      setNotice(successMessage);
      refresh();
    } catch {
      setActionError(networkError('네트워크 오류로 요청을 처리하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  function togglePrimary(row: BarcodeRow) {
    void runRowMutation(
      `/api/skus/${skuId}/barcodes/${row.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTogglePrimaryPayload(row)),
      },
      row.isPrimary ? '대표 지정을 해제했습니다.' : '대표 바코드로 지정했습니다.',
    );
  }

  function reactivate(row: BarcodeRow) {
    void runRowMutation(
      `/api/skus/${skuId}/barcodes/${row.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildReactivatePayload()),
      },
      '바코드를 다시 활성화했습니다.',
    );
  }

  function deactivate(row: BarcodeRow, message: string) {
    void runRowMutation(`/api/skus/${skuId}/barcodes/${row.id}`, { method: 'DELETE' }, message);
  }

  async function submitApproval() {
    if (approveTarget === null || busy) return;
    if (!isApprovalReasonValid(approveReason)) {
      setApproveError(networkError('승인 사유를 입력하세요.'));
      return;
    }
    setBusy(true);
    setApproveError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/skus/${skuId}/barcodes/${approveTarget.id}/approve-duplicate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildApproveDuplicatePayload(approveReason)),
        },
      );
      if (!response.ok) {
        setApproveError(await readApiError(response));
        return;
      }
      setApproveTarget(null);
      setApproveReason('');
      setNotice('중복 예외를 승인했습니다.');
      refresh();
    } catch {
      setApproveError(networkError('네트워크 오류로 승인하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  if (listState === 'loading') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="barcode-loading">
        바코드를 불러오는 중…
      </p>
    );
  }

  if (listState === 'forbidden') {
    return (
      <p className="text-sm" data-testid="barcode-forbidden">
        바코드 조회 권한이 없습니다. (403)
      </p>
    );
  }

  return (
    <section className="space-y-4" aria-label="바코드">
      {listState === 'error' && listError !== null && <ErrorBanner error={listError} />}
      {actionError !== null && (
        <ErrorBanner error={actionError} onClose={() => setActionError(null)} />
      )}
      {notice !== null && (
        <div
          role="status"
          data-testid="barcode-notice"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        >
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          국가·채널·적용기간은 현재 API 가 입력을 받지 않아 <strong>조회 전용</strong>입니다.
        </p>
        {canCreate && (
          <Button size="sm" data-testid="new-barcode-button" onClick={openCreate} disabled={busy}>
            바코드 추가
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 text-left">바코드</th>
              <th className="px-3 py-2 text-left">타입</th>
              <th className="px-3 py-2 text-left">대표</th>
              <th className="px-3 py-2 text-left">국가</th>
              <th className="px-3 py-2 text-left">채널</th>
              <th className="px-3 py-2 text-left">적용기간</th>
              <th className="px-3 py-2 text-left">상태</th>
              <th className="px-3 py-2 text-left">중복예외</th>
              <th className="px-3 py-2 text-left">작업</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="text-muted-foreground px-3 py-6 text-center">
                  등록된 바코드가 없습니다.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const actions = visibleBarcodeActions(row.status, permissions);
              return (
                <tr
                  key={row.id}
                  data-testid="barcode-row"
                  data-barcode={row.barcode}
                  className="border-t"
                >
                  <td className="px-3 py-2 font-mono">{row.barcode}</td>
                  <td className="px-3 py-2">{row.barcodeType}</td>
                  <td className="px-3 py-2">
                    {row.isPrimary ? (
                      <span data-testid="barcode-primary" className="text-xs font-medium">
                        대표
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2" data-testid="barcode-country">
                    {orDash(row.countryCode)}
                  </td>
                  <td className="px-3 py-2" data-testid="barcode-channel">
                    {orDash(row.channelCode)}
                  </td>
                  <td className="px-3 py-2" data-testid="barcode-period">
                    {formatBarcodePeriod(row.effectiveFrom, row.effectiveTo)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-3 py-2">
                    {isApprovedDuplicate(row) ? (
                      <span className="space-y-0.5">
                        <span
                          data-testid="duplicate-exception-badge"
                          className="inline-flex rounded bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-200"
                        >
                          중복 예외
                        </span>
                        {row.exceptionReason !== null && (
                          <span
                            data-testid="duplicate-exception-reason"
                            className="text-muted-foreground block text-xs"
                          >
                            {row.exceptionReason}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="space-x-2 px-3 py-2 whitespace-nowrap">
                    {actions.includes('togglePrimary') && (
                      <button
                        type="button"
                        data-testid="barcode-toggle-primary"
                        disabled={busy}
                        onClick={() => togglePrimary(row)}
                        className="text-xs underline disabled:opacity-40"
                      >
                        {row.isPrimary ? '대표 해제' : '대표 지정'}
                      </button>
                    )}
                    {actions.includes('deactivate') && (
                      <button
                        type="button"
                        data-testid="barcode-deactivate"
                        disabled={busy}
                        onClick={() => deactivate(row, '바코드를 비활성화했습니다.')}
                        className="text-xs underline disabled:opacity-40"
                      >
                        비활성
                      </button>
                    )}
                    {actions.includes('reactivate') && (
                      <button
                        type="button"
                        data-testid="barcode-reactivate"
                        disabled={busy}
                        onClick={() => reactivate(row)}
                        className="text-xs underline disabled:opacity-40"
                      >
                        재활성
                      </button>
                    )}
                    {actions.includes('approveDuplicate') && (
                      <button
                        type="button"
                        data-testid="barcode-approve-duplicate"
                        disabled={busy}
                        onClick={() => {
                          setApproveTarget(row);
                          setApproveReason('');
                          setApproveError(null);
                        }}
                        className="text-xs underline disabled:opacity-40"
                      >
                        중복 예외 승인
                      </button>
                    )}
                    {actions.includes('cancelCandidate') && (
                      <button
                        type="button"
                        data-testid="barcode-cancel-candidate"
                        disabled={busy}
                        onClick={() => deactivate(row, '중복 예외 요청을 취소했습니다.')}
                        className="text-xs underline disabled:opacity-40"
                      >
                        요청 취소
                      </button>
                    )}
                    {actions.length === 0 && (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 신규 바코드 dialog — 409 중복이면 닫지 않고 경고 + CTA 를 붙인다. */}
      {createForm !== null && (
        <section
          role="dialog"
          aria-label="바코드 추가"
          data-testid="barcode-create-dialog"
          className="bg-card space-y-3 rounded-md border p-4"
        >
          <h3 className="text-base font-medium">바코드 추가</h3>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="space-y-1 text-xs md:col-span-2">
              <span className="text-muted-foreground">바코드 *</span>
              <input
                value={createForm.barcode}
                data-testid="barcode-create-value"
                onChange={(event) => patchCreate({ barcode: event.target.value })}
                className="bg-background h-9 w-full rounded-md border px-3 font-mono text-sm"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">타입 *</span>
              <select
                value={createForm.barcodeType}
                data-testid="barcode-create-type"
                onChange={(event) =>
                  patchCreate({ barcodeType: event.target.value as BarcodeTypeOption })
                }
                className="bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                {BARCODE_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={createForm.isPrimary}
              data-testid="barcode-create-primary"
              onChange={(event) => patchCreate({ isPrimary: event.target.checked })}
            />
            <span>대표 바코드로 지정</span>
          </label>

          {createError !== null && <ErrorBanner error={createError} />}

          {/* ★ 409 BARCODE_DUPLICATE 일 때만. 대표 충돌·후보 충돌 409 는 제외된다. */}
          {isDuplicateBarcodeConflict(createError) && (
            <div
              role="note"
              data-testid="barcode-duplicate-warning"
              className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              {DUPLICATE_WARNING}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              data-testid="barcode-create-submit"
              onClick={() => void submitCreate()}
            >
              등록
            </Button>
            {isDuplicateBarcodeConflict(createError) && canRequestDuplicate && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="barcode-request-duplicate"
                onClick={() => void submitDuplicateCandidate()}
              >
                중복 예외 요청
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setCreateForm(null);
                setCreateError(null);
              }}
            >
              취소
            </Button>
          </div>
        </section>
      )}

      {/* 중복 예외 승인 dialog — reason 필수. */}
      {approveTarget !== null && (
        <section
          role="dialog"
          aria-label="중복 예외 승인"
          data-testid="barcode-approve-dialog"
          className="bg-card space-y-3 rounded-md border p-4"
        >
          <h3 className="text-base font-medium">중복 예외 승인</h3>
          <dl className="grid gap-2 text-xs md:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">바코드</dt>
              <dd className="font-mono" data-testid="approve-barcode">
                {approveTarget.barcode}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">타입</dt>
              <dd data-testid="approve-barcode-type">{approveTarget.barcodeType}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">SKU</dt>
              <dd className="font-mono" data-testid="approve-sku">
                {skuCode}
              </dd>
            </div>
          </dl>
          <p className="text-muted-foreground text-xs" data-testid="approve-notice">
            승인하면 이 바코드가 활성 상태가 되며, 다른 SKU 와 같은 값을 공유하게 됩니다. 승인
            기록은 취소할 수 없습니다.
          </p>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">승인 사유 *</span>
            <textarea
              value={approveReason}
              data-testid="approve-reason"
              rows={3}
              onChange={(event) => setApproveReason(event.target.value)}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm"
            />
          </label>

          {approveError !== null && <ErrorBanner error={approveError} />}

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !isApprovalReasonValid(approveReason)}
              data-testid="approve-submit"
              onClick={() => void submitApproval()}
            >
              승인
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setApproveTarget(null);
                setApproveError(null);
              }}
            >
              취소
            </Button>
          </div>
        </section>
      )}

      <p className="text-muted-foreground text-xs">
        중복 예외 승인 기록은 되돌릴 수 없습니다. 사용을 멈추려면 해당 바코드를 비활성화하세요.
      </p>

      {/* ⛔ 승인자·승인시각은 표시하지 않는다 — `approvedBy` 는 UUID 뿐이고
          `approvedAt` 컬럼이 없으며, 사용자·감사로그 조회 API 도 만들지 않는다.
          `isPendingDuplicate` 는 액션 매트릭스가 이미 반영한다. */}
      <span className="sr-only" data-testid="barcode-pending-count">
        {rows.filter((row) => isPendingDuplicate(row)).length}
      </span>
    </section>
  );
}
