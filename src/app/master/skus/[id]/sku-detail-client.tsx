'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

import { SKU_STATUS_LABELS, type SkuListStatus } from '../list-params';
import {
  buildUpdatePayload,
  hasSkuFormChanges,
  skuFormFromView,
  type SkuFormValue,
  type SkuViewLike,
} from '../sku-form';
import {
  SKU_DETAIL_TABS,
  SkuTabPanel,
  type SkuDetailTabKey,
  type SkuTabKey,
} from '../sku-form-fields';
import {
  ErrorBanner,
  ValidationReportPanel,
  readApiError,
  useCommonCodeOptions,
  usePermissions,
  type UiError,
  type ValidationReport,
} from '../sku-ui';

import { BarcodeTab } from './barcode-tab';

/**
 * SKU 상세·수정 (T1-6A / 바코드 탭은 T1-6B1) — `/master/skus/{id}`.
 *
 * 탭 4종 — ① 기본정보 ② 코드·분류 **③ 바코드** ⑤ 재고관리 설정.
 * 원문 8탭(`05 §11.4`)의 논리 순서를 유지하며 **구현된 탭만** 노출한다.
 *
 * ⛔ 외부매핑(T1-6B2)·변경이력(T1-6B3)·공급조건(T06)·BOM(T07) 탭은 없다 —
 *    빈 탭·placeholder 도 만들지 않는다. `suggest-code` 버튼도 없다.
 * ★ 바코드 탭은 `barcode.read` 가 있을 때만 노출한다 — SKU 를 볼 수 있다고
 *   하위 모듈 데이터를 자동으로 조회하지 않는다 (`docs/16` §12).
 *
 * ## 저장 정책
 *
 * - **변경된 필드만** PATCH 한다. 전 필드를 매번 보내면 건드리지 않은 비활성
 *   CommonCode 참조까지 재전송되어 서버가 거부한다(현재 backend 정책: 그 필드를
 *   건드리지 않으면 기존 inactive 참조 허용).
 * - 변경이 없으면 API 를 호출하지 않는다 — `PATCH {}` 로 400 을 유발하지 않는다.
 *   (backend 의 same-value 정책을 바꾸는 것이 아니라 호출을 하지 않는 것이다.)
 * - **ACTIVE 는 일반 수정이 서버에서 422 로 제한**되므로 저장 버튼을 비활성화하고
 *   사유를 안내한다. ⚠️ 이는 backend 임시정책의 반영이며, 프론트에서 허용 필드
 *   whitelist 를 발명하지 않는다. 정책이 확정되면 함께 해제한다.
 * - 그 외 상태에는 UI 가 새로운 수정 금지 정책을 만들지 않는다.
 */

interface SkuDetailView extends SkuViewLike {
  id: string;
  status: string;
  hasTransaction: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
}

interface WorkflowAction {
  readonly key: 'submit' | 'approve' | 'reject' | 'deactivate';
  readonly label: string;
  readonly permission: string;
  /** 이 상태에서만 노출한다 — 확정 전이 외의 action 을 발명하지 않는다. */
  readonly fromStatus: string;
  /** 사유 입력 정책 — reject 만 필수. */
  readonly text: 'note-optional' | 'reason-required' | 'reason-optional';
}

/**
 * 상태별 워크플로 action — T1-4A 가 실제 구현한 4종만.
 * ⛔ archive(폐기)는 T1-4B — 버튼을 만들지 않는다.
 * ⛔ REJECTED→submit, INACTIVE→ACTIVE 같은 미확정 전이도 만들지 않는다.
 */
const WORKFLOW_ACTIONS: readonly WorkflowAction[] = [
  {
    key: 'submit',
    label: '승인 요청',
    permission: 'sku.submit',
    fromStatus: 'DRAFT',
    text: 'note-optional',
  },
  {
    key: 'approve',
    label: '승인',
    permission: 'sku.approve',
    fromStatus: 'PENDING_APPROVAL',
    text: 'note-optional',
  },
  {
    key: 'reject',
    label: '반려',
    permission: 'sku.approve',
    fromStatus: 'PENDING_APPROVAL',
    text: 'reason-required',
  },
  {
    key: 'deactivate',
    label: '사용중지',
    permission: 'sku.deactivate',
    fromStatus: 'ACTIVE',
    text: 'reason-optional',
  },
];

function metaRow(label: string, value: string | null) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-mono text-xs">{value ?? '—'}</p>
    </div>
  );
}

export function SkuDetailClient({ skuId }: { skuId: string }) {
  const permissions = usePermissions();
  const options = useCommonCodeOptions();

  const [tab, setTab] = useState<SkuDetailTabKey>('basic');
  const [detail, setDetail] = useState<SkuDetailView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [original, setOriginal] = useState<SkuFormValue | null>(null);
  const [form, setForm] = useState<SkuFormValue | null>(null);

  const [error, setError] = useState<UiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const [actionKey, setActionKey] = useState<WorkflowAction['key'] | null>(null);
  const [actionText, setActionText] = useState('');

  const canUpdate = permissions?.includes('sku.update') ?? false;
  /** ★ 바코드는 독립 capability 다 — `sku.read` 로 대신 판단하지 않는다. */
  const canReadBarcode = permissions?.includes('barcode.read') ?? false;

  // 상세 조회 — 400/403/404 를 빈 화면으로 위장하지 않는다.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/skus/${skuId}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const uiError = await readApiError(response);
          if (cancelled) return;
          setError(uiError);
          setDetail(null);
          setLoadState('error');
          return;
        }
        const body = (await response.json()) as { sku: SkuDetailView };
        if (cancelled) return;
        const nextForm = skuFormFromView(body.sku);
        setDetail(body.sku);
        setOriginal(nextForm);
        setForm(nextForm);
        setLoadState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setError({
          status: 0,
          code: null,
          message: '네트워크 오류로 상세를 불러오지 못했습니다.',
          requestId: null,
          hint: null,
          fields: [],
          validation: null,
        });
        setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [skuId, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);

  function patchForm(patch: Partial<SkuFormValue>) {
    setForm((current) => (current === null ? current : { ...current, ...patch }));
  }

  const isActive = detail?.status === 'ACTIVE';
  const dirty = original !== null && form !== null && hasSkuFormChanges(original, form);
  const editable = canUpdate && !isActive;

  async function submitUpdate() {
    if (original === null || form === null || saving) return;
    const payload = buildUpdatePayload(original, form);
    if (Object.keys(payload).length === 0) {
      setNotice('변경사항이 없습니다.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/skus/${skuId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      setNotice('저장했습니다.');
      refresh();
    } finally {
      setSaving(false);
    }
  }

  async function runWorkflow(action: WorkflowAction) {
    if (saving) return;
    const text = actionText;
    if (action.text === 'reason-required' && text.trim() === '') {
      setError({
        status: 0,
        code: 'VALIDATION_ERROR',
        message: '반려 사유를 입력하세요.',
        requestId: null,
        hint: null,
        fields: [{ path: 'reason', message: '필수 입력입니다.' }],
        validation: null,
      });
      return;
    }

    const body: Record<string, string> = {};
    if (text !== '') {
      if (action.text === 'note-optional') body['note'] = text;
      else body['reason'] = text;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    setValidation(null);
    try {
      const response = await fetch(`/api/skus/${skuId}/${action.key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const uiError = await readApiError(response);
        setError(uiError);
        // 승인 전 검증 실패면 V1~V9 결과를 그대로 보여준다.
        if (uiError.validation !== null) setValidation(uiError.validation);
        return;
      }
      const result = (await response.json()) as { validation?: ValidationReport };
      if (result.validation !== undefined) setValidation(result.validation);
      setNotice(`${action.label} 처리했습니다.`);
      setActionKey(null);
      setActionText('');
      // ★ 서버 결과를 추정하지 않고 상세를 다시 읽는다.
      refresh();
    } finally {
      setSaving(false);
    }
  }

  if (loadState === 'loading') {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <p className="text-muted-foreground text-sm" data-testid="detail-loading">
          불러오는 중…
        </p>
      </main>
    );
  }

  if (loadState === 'error' || detail === null || form === null) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 px-6 py-10">
        <Link href="/master/skus" className="text-muted-foreground text-sm underline">
          ← SKU 목록
        </Link>
        {error !== null && <ErrorBanner error={error} />}
        <p className="text-sm" data-testid="detail-error">
          {error?.status === 404
            ? 'SKU 를 찾을 수 없습니다.'
            : error?.status === 403
              ? 'SKU 조회 권한이 없습니다.'
              : error?.status === 400
                ? '잘못된 SKU 식별자입니다.'
                : '상세를 불러오지 못했습니다.'}
        </p>
      </main>
    );
  }

  const availableActions = WORKFLOW_ACTIONS.filter(
    (action) =>
      action.fromStatus === detail.status && (permissions?.includes(action.permission) ?? false),
  );
  const statusLabel = SKU_STATUS_LABELS[detail.status as SkuListStatus] ?? detail.status;
  const visibleTabs = SKU_DETAIL_TABS.filter((entry) => entry.key !== 'barcode' || canReadBarcode);
  // 권한을 잃은 상태로 남은 탭 선택을 붙들지 않는다.
  const activeTab: SkuDetailTabKey = visibleTabs.some((entry) => entry.key === tab) ? tab : 'basic';

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-6 py-10">
      <header className="space-y-2">
        <Link href="/master/skus" className="text-muted-foreground text-sm underline">
          ← SKU 목록
        </Link>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{detail.skuCode}</h1>
          <span
            data-testid="detail-status"
            data-status={detail.status}
            className="bg-muted rounded px-2 py-0.5 text-xs font-medium"
          >
            {statusLabel} ({detail.status})
          </span>
          {detail.hasTransaction && (
            <span className="text-muted-foreground text-xs" data-testid="has-transaction">
              거래 이력 있음
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-sm">{detail.skuName}</p>
      </header>

      {error !== null && <ErrorBanner error={error} onClose={() => setError(null)} />}
      {notice !== null && (
        <div
          role="status"
          data-testid="notice"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        >
          {notice}
        </div>
      )}
      {validation !== null && <ValidationReportPanel report={validation} />}

      {/* 워크플로 action bar — 현재 상태·권한으로 실제 구현된 action 만 */}
      <section className="bg-card space-y-3 rounded-md border p-4" aria-label="워크플로">
        {availableActions.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="no-workflow-action">
            현재 상태에서 수행할 수 있는 워크플로 작업이 없습니다.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {availableActions.map((action) => (
              <Button
                key={action.key}
                size="sm"
                variant={action.key === 'approve' ? 'default' : 'outline'}
                disabled={saving}
                data-testid={`action-${action.key}`}
                onClick={() => {
                  setActionKey((current) => (current === action.key ? null : action.key));
                  setActionText('');
                  setError(null);
                }}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}

        {actionKey !== null && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const action = WORKFLOW_ACTIONS.find((entry) => entry.key === actionKey);
              if (action !== undefined) void runWorkflow(action);
            }}
          >
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">
                {actionKey === 'reject'
                  ? '반려 사유 (필수)'
                  : actionKey === 'deactivate'
                    ? '사유 (선택)'
                    : '메모 (선택)'}
              </span>
              <input
                name={actionKey === 'submit' || actionKey === 'approve' ? 'note' : 'reason'}
                value={actionText}
                onChange={(event) => setActionText(event.target.value)}
                aria-label="워크플로 사유"
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
              />
            </label>
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={saving} data-testid="action-confirm">
                확인
              </Button>
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  setActionKey(null);
                  setActionText('');
                }}
              >
                취소
              </Button>
            </div>
          </form>
        )}
      </section>

      {/* 탭 — 바코드는 `barcode.read` 가 있을 때만 노출한다 (숨김 = 미노출이지
          위장이 아니다. 권한이 있는데 서버가 403 이면 탭 안에서 그대로 보여준다). */}
      <div className="flex gap-2 border-b" role="tablist" aria-label="SKU 상세 탭">
        {visibleTabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={activeTab === entry.key}
            onClick={() => setTab(entry.key)}
            className={`px-4 py-2 text-sm ${
              activeTab === entry.key
                ? 'border-ring border-b-2 font-medium'
                : 'text-muted-foreground'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* ★ 바코드 탭은 SKU 폼과 다른 모듈의 mutation 을 다룬다 — SKU 저장 폼
          안에 넣지 않는다 (제출·dirty 판정이 섞이면 안 된다). */}
      {activeTab === 'barcode' ? (
        <BarcodeTab skuId={skuId} skuCode={detail.skuCode} permissions={permissions} />
      ) : (
        <>
          {isActive && (
            <div
              role="note"
              data-testid="active-edit-restricted"
              className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              ACTIVE SKU 수정 허용 필드 정책이 아직 확정되지 않아 현재 일반 수정은 제한됩니다.
            </div>
          )}

          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitUpdate();
            }}
          >
            <SkuTabPanel
              tab={activeTab as SkuTabKey}
              form={form}
              onChange={patchForm}
              disabled={!editable || saving}
              skuCodeLocked={detail.hasTransaction}
              brandOptions={options.brand}
              majorOptions={options.major}
              minorOptions={options.minor}
            />

            {canUpdate && !isActive && (
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={saving || !dirty} data-testid="detail-save">
                  {saving ? '저장 중…' : '저장'}
                </Button>
                {!dirty && <span className="text-muted-foreground text-xs">변경사항 없음</span>}
              </div>
            )}
          </form>
        </>
      )}

      {/* 감사 메타데이터 — 서버가 주는 형태 그대로 (사용자 이름 추정 없음) */}
      <section className="grid gap-3 rounded-md border p-4 md:grid-cols-3" aria-label="변경 정보">
        {metaRow('생성일시', detail.createdAt)}
        {metaRow('생성자', detail.createdBy)}
        {metaRow('수정일시', detail.updatedAt)}
        {metaRow('수정자', detail.updatedBy)}
        {metaRow('승인일시', detail.approvedAt)}
        {metaRow('승인자', detail.approvedBy)}
      </section>

      <p className="text-muted-foreground text-xs">
        외부 매핑·공급조건·BOM·변경이력 탭은 해당 모듈 도입 후 제공됩니다.
      </p>
    </main>
  );
}
