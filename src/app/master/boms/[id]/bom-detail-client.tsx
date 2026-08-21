'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

import { ErrorBanner, readApiError, usePermissions, type UiError } from '../../skus/sku-ui';
import {
  computeActualRequiredQty,
  computeCostSharePct,
  confirmProgress,
  resolveBomActions,
  suggestQuantityPer,
  BOM_COMPONENT_ROLE_OPTIONS,
  BOM_QUANTITY_STATUS_OPTIONS,
  BOM_SUPPLY_TYPE_OPTIONS,
} from '../bom-detail-view';
import {
  formatOptional,
  formatTimestamp,
  periodEndedLabel,
  BOM_TYPE_SUGGESTIONS,
} from '../list-params';
import { SkuPicker } from '../sku-picker';

/**
 * BOM 상세 화면 — 탭 4개 (T07-8).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` §D-6·§D-7·§D-31 ·
 *    `★ T07-8 BOM UI read-model gap closure` U8-11·U8-12·U8-13.
 *
 * - 라인 그리드는 **정확히 15열** — `비고` 는 이 grid 에 없다 (`note` 컬럼·API 는
 *   그대로 둔다).
 * - `실제 필요량` 은 `Q = outputQty` 로 D-19 를 적용한 **client 계산값**이다.
 *   ⛔ 이 값 때문에 `/explode`·`/cost` 를 부르지 않는다.
 * - `UNKNOWN` 행은 강조하고 `packQuantity` 가 있으면 `1/입수량` 을 **추천**만
 *   한다. ⛔ 자동 저장 없음 — 사용자가 수락해야 한다.
 * - 일괄 확정은 **top-level 배열**을 보낸다 (T07-4 계약 그대로).
 *   ⛔ `{items: […]}` 가 아니다.
 * - `ACTIVE` 는 전체 읽기전용 + 배너 + `버전 생성`.
 * - 원가 탭의 `비중` 분모는 **같은 `(currency, vatIncluded)` subtotal** 이다.
 */

interface LineView {
  id: string;
  lineNo: number;
  componentSkuId: string;
  componentSku: { id: string; skuCode: string; skuName: string; baseUom: string };
  quantityPer: string | null;
  quantityStatus: string;
  uom: string;
  lossRate: string | null;
  componentRole: string;
  supplyType: string | null;
  alternateGroup: string | null;
  isRequired: boolean;
  issueWarehouseId: string | null;
  packQuantity: string | null;
  specification: string | null;
  note: string | null;
}

interface DetailView {
  id: string;
  parentSkuId: string;
  parentSku: { id: string; skuCode: string; skuName: string };
  bomType: string;
  version: string;
  status: string;
  outputQty: string;
  outputUom: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  productionPartner: { id: string; supplierCode: string; supplierName: string } | null;
  destinationWarehouseId: string | null;
  overallLossRate: string | null;
  description: string | null;
  changeReason: string | null;
  approvedBy: string | null;
  lineCount: number;
  unconfirmedCount: number;
  lines: LineView[];
}

interface ExplodedNode {
  level: number;
  path: string[];
  componentSkuId: string;
  componentSku: { id: string; skuCode: string; skuName: string; baseUom: string };
  componentRole: string;
  quantityPer: string | null;
  lossRate: string | null;
  requiredQty: string | null;
  uom: string;
  isLeaf: boolean;
  quantityStatus: string;
}

interface CostComponent {
  componentSkuId: string;
  componentSku: { id: string; skuCode: string; skuName: string };
  level: number;
  requiredQty: string | null;
  uom: string;
  supplierSkuId: string | null;
  unitPrice: string | null;
  currency: string | null;
  vatIncluded: boolean | null;
  lineCost: string | null;
  provisionalReason: string | null;
}

interface CostResult {
  bomId: string;
  asOf: string;
  requestedQty: string;
  isProvisional: boolean;
  provisionalReasons: string[];
  components: CostComponent[];
  subtotals: { currency: string; vatIncluded: boolean; amount: string }[];
}

interface HistoryItem {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  occurredAt: string;
  reason: string | null;
}

type Tab = 'components' | 'explode' | 'cost' | 'history';

/**
 * 라인 추가·수정 폼 (D-9·D-14).
 *
 * 모든 값을 문자열로 들고 있다가 전송 직전에만 정규화한다 —
 * ⛔ `Number()`·`parseFloat()` 로 Decimal 을 훼손하지 않는다.
 */
interface LineForm {
  readonly mode: 'create' | 'edit';
  readonly lineId: string | null;
  readonly componentSkuId: string;
  readonly componentSkuLabel: string;
  readonly quantityPer: string;
  readonly quantityStatus: string;
  readonly uom: string;
  readonly lossRate: string;
  readonly componentRole: string;
  readonly supplyType: string;
  readonly alternateGroup: string;
  readonly isRequired: boolean;
  readonly issueWarehouseId: string;
  readonly packQuantity: string;
  readonly specification: string;
  readonly note: string;
}

const EMPTY_LINE_FORM: LineForm = {
  mode: 'create',
  lineId: null,
  componentSkuId: '',
  componentSkuLabel: '',
  quantityPer: '',
  // ⛔ 소요량을 자동으로 `"1"` 로 채우지 않는다 (D-10) — 기본은 `UNKNOWN` 이다.
  quantityStatus: 'UNKNOWN',
  uom: '',
  lossRate: '',
  componentRole: 'MATERIAL',
  supplyType: '',
  alternateGroup: '',
  isRequired: true,
  issueWarehouseId: '',
  packQuantity: '',
  specification: '',
  note: '',
};

function lineFormOf(line: LineView): LineForm {
  return {
    mode: 'edit',
    lineId: line.id,
    componentSkuId: line.componentSkuId,
    componentSkuLabel: `${line.componentSku.skuCode} ${line.componentSku.skuName}`,
    quantityPer: line.quantityPer ?? '',
    quantityStatus: line.quantityStatus,
    uom: line.uom,
    lossRate: line.lossRate ?? '',
    componentRole: line.componentRole,
    supplyType: line.supplyType ?? '',
    alternateGroup: line.alternateGroup ?? '',
    isRequired: line.isRequired,
    issueWarehouseId: line.issueWarehouseId ?? '',
    packQuantity: line.packQuantity ?? '',
    specification: line.specification ?? '',
    note: line.note ?? '',
  };
}

/** 빈 문자열 → `null`. 서버 DTO 는 `nullable().optional()` 이다. */
function nullableOf(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 폼 → 요청 body.
 *
 * `create` 는 `uom` 을 생략하면 서버가 구성품 `baseUom` 을 채운다(D-11) —
 * ⛔ 화면이 임의로 단위를 지어내지 않는다.
 */
function lineBodyOf(form: LineForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    componentSkuId: form.componentSkuId,
    quantityPer: nullableOf(form.quantityPer),
    quantityStatus: form.quantityStatus,
    lossRate: nullableOf(form.lossRate),
    componentRole: form.componentRole,
    supplyType: nullableOf(form.supplyType),
    alternateGroup: nullableOf(form.alternateGroup),
    isRequired: form.isRequired,
    issueWarehouseId: nullableOf(form.issueWarehouseId),
    packQuantity: nullableOf(form.packQuantity),
    specification: nullableOf(form.specification),
    note: nullableOf(form.note),
  };
  const uom = nullableOf(form.uom);
  if (uom !== null) body['uom'] = uom;
  return body;
}

/**
 * 헤더 수정 폼 (D-14).
 *
 * ⛔ `parentSkuId`·`version` 은 담지 않는다 — 바꾸면 다른 BOM 이므로 서버가 400 이다.
 * ⛔ generic `status` PATCH 도 없다 — 상태는 전용 endpoint 로만 바뀐다 (D-6).
 */
interface HeaderForm {
  readonly bomType: string;
  readonly outputQty: string;
  readonly outputUom: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly overallLossRate: string;
  readonly description: string;
  readonly changeReason: string;
}

function headerFormOf(detail: DetailView): HeaderForm {
  return {
    bomType: detail.bomType,
    outputQty: detail.outputQty,
    outputUom: detail.outputUom,
    effectiveFrom: detail.effectiveFrom,
    effectiveTo: detail.effectiveTo ?? '',
    overallLossRate: detail.overallLossRate ?? '',
    description: detail.description ?? '',
    changeReason: detail.changeReason ?? '',
  };
}

function headerBodyOf(form: HeaderForm): Record<string, unknown> {
  return {
    bomType: form.bomType,
    outputQty: form.outputQty.trim(),
    outputUom: form.outputUom.trim(),
    effectiveFrom: form.effectiveFrom,
    effectiveTo: nullableOf(form.effectiveTo),
    overallLossRate: nullableOf(form.overallLossRate),
    description: nullableOf(form.description),
    changeReason: nullableOf(form.changeReason),
  };
}

/** 버전 복제 폼 — 세 필드 모두 서버 필수다 (D-16·W-4). */
interface CloneForm {
  readonly newVersion: string;
  readonly effectiveFrom: string;
  readonly changeReason: string;
}

/**
 * ⛔ 버전 문자열을 자동 증가시키지 않는다 — 채번 규칙이 없으므로 사용자가 정한다.
 *    `effectiveFrom` 도 비워 둔다: 원본 값을 그대로 복사하면 기간이 겹쳐 409 다.
 */
const EMPTY_CLONE_FORM: CloneForm = { newVersion: '', effectiveFrom: '', changeReason: '' };

const emptyError = (message: string): UiError => ({
  status: 0,
  code: null,
  message,
  requestId: null,
  hint: null,
  fields: [],
  validation: null,
});

export function BomDetailClient({ bomId }: { bomId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const permissions = usePermissions();
  const [tab, setTab] = useState<Tab>('components');
  const [detail, setDetail] = useState<DetailView | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  /** 일괄 확정 편집 버퍼 — lineId → 입력값. ⛔ 자동 저장하지 않는다. */
  const [draftQty, setDraftQty] = useState<Record<string, string>>({});
  const [lineForm, setLineForm] = useState<LineForm | null>(null);
  const [headerForm, setHeaderForm] = useState<HeaderForm | null>(null);

  /**
   * ★ 목록의 `복사` 버튼이 `?clone=1` 로 보낸다 — 도착과 동시에 dialog 를 연다.
   * ⛔ 자동으로 복제를 실행하지 않는다: 새 버전·적용일·변경사유는 사람이 정한다.
   */
  const [cloneForm, setCloneForm] = useState<CloneForm | null>(
    searchParams.get('clone') === '1' ? EMPTY_CLONE_FORM : null,
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/boms/${bomId}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setState(response.status === 403 ? 'forbidden' : 'error');
          setError(await readApiError(response));
          return;
        }
        const body = (await response.json()) as { bom: DetailView };
        setDetail(body.bom);
        setError(null);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) {
          setState('error');
          setError(emptyError('BOM 을 불러오지 못했습니다.'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bomId, reload]);

  const actions = resolveBomActions(detail?.status ?? '', permissions ?? []);
  const businessDate = new Date().toISOString().slice(0, 10);

  const send = async (method: string, path: string, body?: unknown) => {
    setBusy(true);
    try {
      const response = await fetch(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return false;
      }
      setError(null);
      setReload((token) => token + 1);
      return true;
    } finally {
      setBusy(false);
    }
  };

  const post = (path: string, body: unknown) => send('POST', path, body);

  /**
   * ★ 일괄 확정 — **top-level 배열**을 보낸다 (T07-4 authoritative contract).
   * ⛔ `{ items: [...] }` wrapper 를 만들지 않는다.
   */
  const submitBulkConfirm = async () => {
    const items = Object.entries(draftQty)
      .filter(([, value]) => value.trim() !== '')
      .map(([lineId, quantityPer]) => ({ lineId, quantityPer: quantityPer.trim() }));
    if (items.length === 0) return;
    const ok = await post(`/api/boms/${bomId}/lines/bulk-confirm-qty`, items);
    if (ok) setDraftQty({});
  };

  /**
   * 라인 저장 — `create` 는 `POST …/lines`, `edit` 는 `PATCH …/lines/{lineId}`.
   *
   * ⛔ 두 메서드 모두 `Idempotency-Key` 를 붙이지 않는다: PATCH 는 계약상 받지
   *    않고(D-17), POST 는 사용자가 명시적으로 누르는 단건 추가다.
   */
  const submitLine = async () => {
    if (lineForm === null || lineForm.componentSkuId === '') return;
    const body = lineBodyOf(lineForm);
    const ok =
      lineForm.mode === 'create'
        ? await send('POST', `/api/boms/${bomId}/lines`, body)
        : await send('PATCH', `/api/boms/${bomId}/lines/${lineForm.lineId ?? ''}`, body);
    if (ok) setLineForm(null);
  };

  /** ⛔ 되돌릴 수 없으므로 확인을 받는다. 응답은 204 다. */
  const deleteLine = async (line: LineView) => {
    if (!window.confirm(`${line.lineNo}번 라인(${line.componentSku.skuCode})을 삭제할까요?`)) {
      return;
    }
    await send('DELETE', `/api/boms/${bomId}/lines/${line.id}`);
  };

  const submitHeader = async () => {
    if (headerForm === null) return;
    const ok = await send('PATCH', `/api/boms/${bomId}`, headerBodyOf(headerForm));
    if (ok) setHeaderForm(null);
  };

  /** 버전 복제 — 결과는 언제나 새 `DRAFT` 다. 성공하면 새 BOM 으로 이동한다. */
  const submitClone = async () => {
    if (cloneForm === null) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/boms/${bomId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cloneForm),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as { bom: { id: string } };
      setCloneForm(null);
      router.push(`/master/boms/${body.bom.id}`);
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return <main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm">불러오는 중…</main>;
  }
  if (state === 'forbidden') {
    return (
      <main className="mx-auto w-full max-w-7xl px-6 py-10">
        <p className="text-sm text-red-600">BOM 을 조회할 권한이 없습니다.</p>
      </main>
    );
  }
  if (detail === null) {
    return (
      <main className="mx-auto w-full max-w-7xl px-6 py-10">
        {error !== null ? <ErrorBanner error={error} /> : null}
      </main>
    );
  }

  const ended = periodEndedLabel(detail, businessDate);

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <div className="mb-4">
        <Link className="text-sm underline" href="/master/boms">
          ← BOM 목록
        </Link>
      </div>

      {error !== null ? <ErrorBanner error={error} /> : null}

      {/* ── 헤더 (D-31 exact facts) ───────────────────────────── */}
      <header className="mb-4">
        <h1 className="text-xl font-semibold">
          {detail.parentSku.skuCode} · {detail.version}
        </h1>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
          <Meta
            label="상위 SKU"
            value={`${detail.parentSku.skuCode} ${detail.parentSku.skuName}`}
          />
          <Meta label="BOM 유형" value={detail.bomType} />
          <Meta label="버전" value={detail.version} />
          <Meta
            label="상태"
            value={ended === null ? detail.status : `${detail.status} · ${ended}`}
          />
          <Meta label="기준수량" value={detail.outputQty} />
          <Meta label="기준단위" value={detail.outputUom} />
          <Meta
            label="적용기간"
            value={`${detail.effectiveFrom} ~ ${formatOptional(detail.effectiveTo)}`}
          />
          <Meta
            label="조립·생산처"
            value={
              detail.productionPartner === null
                ? '—'
                : `${detail.productionPartner.supplierCode} ${detail.productionPartner.supplierName}`
            }
          />
          {/* ★ 창고 이름 lookup 없음 — UUID 그대로 (D-31·D-32, T08 미착수). */}
          <Meta label="기본 입고처" value={formatOptional(detail.destinationWarehouseId)} />
          <Meta label="전체 로스율" value={formatOptional(detail.overallLossRate)} />
          <Meta label="설명" value={formatOptional(detail.description)} />
          <Meta label="변경사유" value={formatOptional(detail.changeReason)} />
          <Meta label="승인자" value={formatOptional(detail.approvedBy)} />
        </dl>
      </header>

      {/* ★ ACTIVE 는 전체 읽기전용 + 배너 + 버전 생성 (D-31). */}
      {detail.status === 'ACTIVE' ? (
        <div
          className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
          data-testid="active-readonly-banner"
        >
          활성 BOM은 수정할 수 없습니다. 새 버전을 생성하세요.
          {actions.canClone ? (
            <Button
              className="ml-3"
              variant="secondary"
              onClick={() => setCloneForm(EMPTY_CLONE_FORM)}
            >
              버전 생성
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* ── workflow controls — 권한 없으면 렌더하지 않는다 ─────── */}
      <div className="mb-4 flex flex-wrap gap-2">
        {actions.canEditHeader ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setHeaderForm(headerFormOf(detail))}
          >
            헤더 수정
          </Button>
        ) : null}
        {actions.canSubmit ? (
          <Button disabled={busy} onClick={() => void post(`/api/boms/${bomId}/submit`, {})}>
            승인 요청
          </Button>
        ) : null}
        {actions.canApprove ? (
          <Button disabled={busy} onClick={() => void post(`/api/boms/${bomId}/approve`, {})}>
            승인
          </Button>
        ) : null}
        {actions.canReject ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void post(`/api/boms/${bomId}/reject`, { reason: '반려' })}
          >
            반려
          </Button>
        ) : null}
        {actions.canActivate ? (
          <Button disabled={busy} onClick={() => void post(`/api/boms/${bomId}/activate`, {})}>
            활성화
          </Button>
        ) : null}
        {actions.canDeactivate ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void post(`/api/boms/${bomId}/deactivate`, {
                effectiveTo: businessDate,
                reason: '사용종료',
              })
            }
          >
            사용종료
          </Button>
        ) : null}
        {actions.canArchive ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void post(`/api/boms/${bomId}/archive`, { reason: '보관' })}
          >
            보관
          </Button>
        ) : null}
        {/* ★ 복제는 **모든 status** 에서 가능하며 결과는 언제나 새 `DRAFT` 다 (D-16). */}
        {actions.canClone ? (
          <Button variant="outline" disabled={busy} onClick={() => setCloneForm(EMPTY_CLONE_FORM)}>
            버전 복제
          </Button>
        ) : null}
      </div>

      {/* ── 탭 4개 ─────────────────────────────────────────────── */}
      <nav className="mb-4 flex gap-2 border-b" role="tablist">
        {(
          [
            ['components', '구성품'],
            ['explode', '전개'],
            ['cost', '원가'],
            ['history', '변경이력'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`px-3 py-2 text-sm ${tab === key ? 'border-b-2 border-black font-semibold' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'components' ? (
        <ComponentsTab
          detail={detail}
          canMutate={actions.canMutateLines}
          canBulkConfirm={actions.canBulkConfirm}
          draftQty={draftQty}
          setDraftQty={setDraftQty}
          busy={busy}
          onBulkConfirm={() => void submitBulkConfirm()}
          onAddLine={() => setLineForm(EMPTY_LINE_FORM)}
          onEditLine={(line) => setLineForm(lineFormOf(line))}
          onDeleteLine={(line) => void deleteLine(line)}
        />
      ) : null}
      {tab === 'explode' ? <ExplodeTab bomId={bomId} /> : null}
      {tab === 'cost' ? <CostTab bomId={bomId} /> : null}
      {tab === 'history' ? <HistoryTab bomId={bomId} /> : null}

      {lineForm !== null ? (
        <LineDialog
          form={lineForm}
          busy={busy}
          onChange={setLineForm}
          onCancel={() => setLineForm(null)}
          onSubmit={() => void submitLine()}
          onError={setError}
        />
      ) : null}

      {headerForm !== null ? (
        <HeaderDialog
          form={headerForm}
          busy={busy}
          onChange={setHeaderForm}
          onCancel={() => setHeaderForm(null)}
          onSubmit={() => void submitHeader()}
        />
      ) : null}

      {cloneForm !== null ? (
        <CloneDialog
          form={cloneForm}
          busy={busy}
          onChange={setCloneForm}
          onCancel={() => setCloneForm(null)}
          onSubmit={() => void submitClone()}
        />
      ) : null}
    </main>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="inline text-neutral-500">{label}: </dt>
      {/* testid 로 값만 집어낼 수 있게 한다 — label 과 값이 다른 요소이기 때문. */}
      <dd className="inline" data-testid={`bom-meta-${label}`}>
        {value}
      </dd>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ① 구성품 — 15열 + 소요량 확정 5단계 UX
// ═══════════════════════════════════════════════════════════════

function ComponentsTab({
  detail,
  canMutate,
  canBulkConfirm,
  draftQty,
  setDraftQty,
  busy,
  onBulkConfirm,
  onAddLine,
  onEditLine,
  onDeleteLine,
}: {
  detail: DetailView;
  canMutate: boolean;
  canBulkConfirm: boolean;
  draftQty: Record<string, string>;
  setDraftQty: (next: Record<string, string>) => void;
  busy: boolean;
  onBulkConfirm: () => void;
  onAddLine: () => void;
  onEditLine: (line: LineView) => void;
  onDeleteLine: (line: LineView) => void;
}) {
  return (
    <section>
      {/* ★ ⑤ 진행률 — `SUGGESTED` 도 미확정이다. */}
      <p className="mb-3 text-sm" data-testid="confirm-progress">
        {confirmProgress(detail.lineCount, detail.unconfirmedCount)}
      </p>

      <div className="mb-3 flex gap-2">
        {canMutate ? (
          <Button disabled={busy} onClick={onAddLine}>
            구성품 추가
          </Button>
        ) : null}
        {canBulkConfirm ? (
          <Button variant="secondary" disabled={busy} onClick={onBulkConfirm}>
            선택 소요량 일괄 확정
          </Button>
        ) : null}
      </div>

      <table className="w-full border-collapse text-sm" data-testid="bom-line-grid">
        <thead>
          <tr className="border-b text-left text-neutral-500">
            <th className="px-2 py-2">순번</th>
            <th className="px-2 py-2">구성품 SKU</th>
            <th className="px-2 py-2">상품명</th>
            <th className="px-2 py-2">소요량</th>
            <th className="px-2 py-2">소요량 상태</th>
            <th className="px-2 py-2">단위</th>
            <th className="px-2 py-2">로스율</th>
            <th className="px-2 py-2">실제 필요량</th>
            <th className="px-2 py-2">구성품 유형</th>
            <th className="px-2 py-2">공급유형</th>
            <th className="px-2 py-2">대체그룹</th>
            <th className="px-2 py-2">필수</th>
            <th className="px-2 py-2">투입창고</th>
            <th className="px-2 py-2">입수량</th>
            <th className="px-2 py-2">상세사양</th>
            {/* ★ 작업 열은 **15열 계약 밖의 control 열**이다 — 편집 가능할 때만 존재한다. */}
            {canMutate ? <th className="px-2 py-2">작업</th> : null}
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((line) => {
            const actual = computeActualRequiredQty({
              outputQty: detail.outputQty,
              quantityPer: line.quantityPer,
              lossRate: line.lossRate,
              overallLossRate: detail.overallLossRate,
            });
            const suggestion = suggestQuantityPer(line.packQuantity);
            const unknown = line.quantityStatus === 'UNKNOWN';
            return (
              <tr
                key={line.id}
                // ★ ① UNKNOWN 행 강조 (D-31).
                className={`border-b ${unknown ? 'bg-red-50' : ''}`}
                data-testid={`line-${line.lineNo}`}
              >
                <td className="px-2 py-2">{line.lineNo}</td>
                <td className="px-2 py-2">{line.componentSku.skuCode}</td>
                <td className="px-2 py-2">{line.componentSku.skuName}</td>
                <td className="px-2 py-2">
                  {canMutate ? (
                    <span className="flex items-center gap-1">
                      <input
                        className="w-24 rounded border px-1"
                        aria-label={`${line.lineNo} 소요량`}
                        value={draftQty[line.id] ?? line.quantityPer ?? ''}
                        onChange={(event) =>
                          setDraftQty({ ...draftQty, [line.id]: event.target.value })
                        }
                      />
                      {/* ★ ②③ 추천값(회색) + 수락 버튼. ⛔ 자동 저장 없음. */}
                      {suggestion !== null ? (
                        <button
                          type="button"
                          className="text-xs text-neutral-500 underline"
                          onClick={() => setDraftQty({ ...draftQty, [line.id]: suggestion })}
                        >
                          추천 {suggestion}
                        </button>
                      ) : null}
                    </span>
                  ) : (
                    formatOptional(line.quantityPer)
                  )}
                </td>
                <td className="px-2 py-2">{line.quantityStatus}</td>
                <td className="px-2 py-2">{line.uom}</td>
                <td className="px-2 py-2">{formatOptional(line.lossRate)}</td>
                <td className="px-2 py-2">{actual ?? '—'}</td>
                <td className="px-2 py-2">{line.componentRole}</td>
                <td className="px-2 py-2">{formatOptional(line.supplyType)}</td>
                <td className="px-2 py-2">{formatOptional(line.alternateGroup)}</td>
                <td className="px-2 py-2">{line.isRequired ? '예' : '아니오'}</td>
                <td className="px-2 py-2">{formatOptional(line.issueWarehouseId)}</td>
                <td className="px-2 py-2">{formatOptional(line.packQuantity)}</td>
                <td className="px-2 py-2">{formatOptional(line.specification)}</td>
                {canMutate ? (
                  <td className="px-2 py-2">
                    <span className="flex gap-1">
                      <button
                        type="button"
                        className="text-xs underline"
                        aria-label={`${line.lineNo} 수정`}
                        disabled={busy}
                        onClick={() => onEditLine(line)}
                      >
                        수정
                      </button>
                      <button
                        type="button"
                        className="text-xs text-red-600 underline"
                        aria-label={`${line.lineNo} 삭제`}
                        disabled={busy}
                        onClick={() => onDeleteLine(line)}
                      >
                        삭제
                      </button>
                    </span>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>

      {detail.lines.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">구성품이 없습니다.</p>
      ) : null}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════
// 헤더 수정 dialog (D-14)
// ═══════════════════════════════════════════════════════════════

function HeaderDialog({
  form,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: HeaderForm;
  busy: boolean;
  onChange: (next: HeaderForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const set = <K extends keyof HeaderForm>(key: K, value: HeaderForm[K]) =>
    onChange({ ...form, [key]: value });

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-black/30 p-4">
      <div className="w-full max-w-2xl rounded bg-white p-5" role="dialog" aria-label="헤더 수정">
        <h2 className="mb-3 text-lg font-semibold">헤더 수정</h2>
        {/* ⛔ 상위 SKU·버전은 바꿀 수 없다 — 바꾸면 다른 BOM 이다 (D-14). */}
        <p className="mb-3 text-sm text-neutral-500">
          상위 SKU 와 버전은 변경할 수 없습니다. 새 버전이 필요하면 <b>버전 복제</b>를 쓰세요.
        </p>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="BOM 유형">
            <select
              className="w-full rounded border px-2 py-1"
              aria-label="BOM 유형"
              value={form.bomType}
              onChange={(event) => set('bomType', event.target.value)}
            >
              {BOM_TYPE_SUGGESTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>

          <Field label="기준수량">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="기준수량"
              value={form.outputQty}
              onChange={(event) => set('outputQty', event.target.value)}
            />
          </Field>

          <Field label="기준단위">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="기준단위"
              value={form.outputUom}
              onChange={(event) => set('outputUom', event.target.value)}
            />
          </Field>

          <Field label="전체 로스율">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="전체 로스율"
              value={form.overallLossRate}
              onChange={(event) => set('overallLossRate', event.target.value)}
            />
          </Field>

          <Field label="적용 시작일">
            <input
              type="date"
              className="w-full rounded border px-2 py-1"
              aria-label="헤더 적용 시작일"
              value={form.effectiveFrom}
              onChange={(event) => set('effectiveFrom', event.target.value)}
            />
          </Field>

          <Field label="적용 종료일">
            <input
              type="date"
              className="w-full rounded border px-2 py-1"
              aria-label="헤더 적용 종료일"
              value={form.effectiveTo}
              onChange={(event) => set('effectiveTo', event.target.value)}
            />
          </Field>

          <Field label="설명">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="설명"
              value={form.description}
              onChange={(event) => set('description', event.target.value)}
            />
          </Field>

          <Field label="변경사유">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="헤더 변경사유"
              value={form.changeReason}
              onChange={(event) => set('changeReason', event.target.value)}
            />
          </Field>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            취소
          </Button>
          <Button disabled={busy} onClick={onSubmit}>
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 라인 추가·수정 dialog (D-9·D-14)
// ═══════════════════════════════════════════════════════════════

function LineDialog({
  form,
  busy,
  onChange,
  onCancel,
  onSubmit,
  onError,
}: {
  form: LineForm;
  busy: boolean;
  onChange: (next: LineForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onError: (error: UiError) => void;
}) {
  const title = form.mode === 'create' ? '구성품 추가' : '구성품 수정';
  const set = <K extends keyof LineForm>(key: K, value: LineForm[K]) =>
    onChange({ ...form, [key]: value });

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-black/30 p-4">
      <div className="w-full max-w-2xl rounded bg-white p-5" role="dialog" aria-label={title}>
        <h2 className="mb-3 text-lg font-semibold">{title}</h2>

        {/* ★ 구성품도 같은 SKU 검색기를 쓴다. ⛔ UUID 자유 입력 금지 (U8-14). */}
        <SkuPicker
          label="구성품 SKU"
          selectedId={form.componentSkuId}
          selectedLabel={form.componentSkuLabel}
          onPick={(sku) =>
            onChange({
              ...form,
              componentSkuId: sku.id,
              componentSkuLabel: `${sku.skuCode} ${sku.skuName}`,
            })
          }
          onError={onError}
        />

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="소요량">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="소요량"
              value={form.quantityPer}
              onChange={(event) => set('quantityPer', event.target.value)}
            />
          </Field>

          <Field label="소요량 상태">
            <select
              className="w-full rounded border px-2 py-1"
              aria-label="소요량 상태"
              value={form.quantityStatus}
              onChange={(event) => set('quantityStatus', event.target.value)}
            >
              {BOM_QUANTITY_STATUS_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>

          <Field label="단위 (비우면 구성품 기본단위)">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="단위"
              value={form.uom}
              onChange={(event) => set('uom', event.target.value)}
            />
          </Field>

          <Field label="로스율">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="로스율"
              value={form.lossRate}
              onChange={(event) => set('lossRate', event.target.value)}
            />
          </Field>

          <Field label="구성품 유형">
            <select
              className="w-full rounded border px-2 py-1"
              aria-label="구성품 유형"
              value={form.componentRole}
              onChange={(event) => set('componentRole', event.target.value)}
            >
              {BOM_COMPONENT_ROLE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>

          <Field label="공급유형">
            <select
              className="w-full rounded border px-2 py-1"
              aria-label="공급유형"
              value={form.supplyType}
              onChange={(event) => set('supplyType', event.target.value)}
            >
              <option value="">(없음)</option>
              {BOM_SUPPLY_TYPE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>

          <Field label="대체그룹">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="대체그룹"
              value={form.alternateGroup}
              onChange={(event) => set('alternateGroup', event.target.value)}
            />
          </Field>

          <Field label="입수량">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="입수량"
              value={form.packQuantity}
              onChange={(event) => set('packQuantity', event.target.value)}
            />
          </Field>

          {/* ★ 창고는 staged scalar 다 — UUID 입력이며 존재 검증은 없다 (D-32). */}
          <Field label="투입창고 ID">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="투입창고 ID"
              value={form.issueWarehouseId}
              onChange={(event) => set('issueWarehouseId', event.target.value)}
            />
          </Field>

          <Field label="필수 여부">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label="필수 여부"
                checked={form.isRequired}
                onChange={(event) => set('isRequired', event.target.checked)}
              />
              <span>필수 구성품</span>
            </label>
          </Field>

          <Field label="상세사양">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="상세사양"
              value={form.specification}
              onChange={(event) => set('specification', event.target.value)}
            />
          </Field>

          {/* ★ `note` 는 그리드 15열에는 없지만 API 계약에는 있다 — 여기서 편집한다. */}
          <Field label="비고">
            <input
              className="w-full rounded border px-2 py-1"
              aria-label="비고"
              value={form.note}
              onChange={(event) => set('note', event.target.value)}
            />
          </Field>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            취소
          </Button>
          <Button disabled={busy || form.componentSkuId === ''} onClick={onSubmit}>
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

// ═══════════════════════════════════════════════════════════════
// 버전 복제 dialog (D-16 · W-4)
// ═══════════════════════════════════════════════════════════════

function CloneDialog({
  form,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: CloneForm;
  busy: boolean;
  onChange: (next: CloneForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded bg-white p-5" role="dialog" aria-label="버전 복제">
        <h2 className="mb-3 text-lg font-semibold">버전 복제</h2>
        <p className="mb-3 text-sm text-neutral-500">
          구성품을 그대로 복사한 새 <code>DRAFT</code> BOM 을 만듭니다.
        </p>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-neutral-500">새 버전</span>
          <input
            className="w-full rounded border px-2 py-1"
            aria-label="새 버전"
            value={form.newVersion}
            onChange={(event) => onChange({ ...form, newVersion: event.target.value })}
          />
        </label>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-neutral-500">적용 시작일</span>
          <input
            type="date"
            className="w-full rounded border px-2 py-1"
            aria-label="복제 적용 시작일"
            value={form.effectiveFrom}
            onChange={(event) => onChange({ ...form, effectiveFrom: event.target.value })}
          />
        </label>

        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-neutral-500">변경사유</span>
          <input
            className="w-full rounded border px-2 py-1"
            aria-label="변경사유"
            value={form.changeReason}
            onChange={(event) => onChange({ ...form, changeReason: event.target.value })}
          />
        </label>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            취소
          </Button>
          <Button
            disabled={
              busy ||
              form.newVersion === '' ||
              form.effectiveFrom === '' ||
              form.changeReason === ''
            }
            onClick={onSubmit}
          >
            복제
          </Button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ② 전개 — D-31 이 좁혀 놓은 범위 그대로
// ═══════════════════════════════════════════════════════════════

function ExplodeTab({ bomId }: { bomId: string }) {
  const [maxLevel, setMaxLevel] = useState('10');
  const [nodes, setNodes] = useState<ExplodedNode[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/boms/${bomId}/explode?maxLevel=${maxLevel}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError(await readApiError(response));
          setNodes(null);
          return;
        }
        // ★ explode 응답은 **배열 그 자체**다 (D-18).
        setNodes((await response.json()) as ExplodedNode[]);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError(emptyError('전개를 불러오지 못했습니다.'));
      });
    return () => {
      cancelled = true;
    };
  }, [bomId, maxLevel]);

  return (
    <section>
      <label className="mb-3 block text-sm">
        <span className="mr-2 text-neutral-500">최대 레벨</span>
        <select
          className="rounded border px-2 py-1"
          aria-label="최대 레벨"
          value={maxLevel}
          onChange={(event) => setMaxLevel(event.target.value)}
        >
          {Array.from({ length: 10 }, (_, index) => String(index + 1)).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      {error !== null ? <ErrorBanner error={error} /> : null}

      {nodes !== null ? (
        <table className="w-full border-collapse text-sm" data-testid="explode-tree">
          <thead>
            <tr className="border-b text-left text-neutral-500">
              <th className="px-2 py-2">레벨</th>
              <th className="px-2 py-2">구성품 SKU</th>
              <th className="px-2 py-2">상품명</th>
              <th className="px-2 py-2">소요량</th>
              <th className="px-2 py-2">단위</th>
              <th className="px-2 py-2">구성품 유형</th>
              <th className="px-2 py-2">말단</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node, index) => (
              <tr key={`${node.componentSkuId}-${index}`} className="border-b">
                <td className="px-2 py-2">{node.level}</td>
                <td className="px-2 py-2" style={{ paddingLeft: `${node.level * 12}px` }}>
                  {node.componentSku.skuCode}
                </td>
                <td className="px-2 py-2">{node.componentSku.skuName}</td>
                <td className="px-2 py-2">{node.requiredQty ?? '—'}</td>
                <td className="px-2 py-2">{node.uom}</td>
                <td className="px-2 py-2">{node.componentRole}</td>
                <td className="px-2 py-2">{node.isLeaf ? '예' : '아니오'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════
// ③ 원가 — 비중 분모는 같은 (currency, vatIncluded) subtotal
// ═══════════════════════════════════════════════════════════════

function CostTab({ bomId }: { bomId: string }) {
  const [asOf, setAsOf] = useState('');
  const [qty, setQty] = useState('1');
  const [result, setResult] = useState<CostResult | null>(null);
  const [error, setError] = useState<UiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (qty !== '') params.set('qty', qty);
    if (asOf !== '') params.set('asOf', asOf);
    const query = params.toString();
    fetch(`/api/boms/${bomId}/cost${query === '' ? '' : `?${query}`}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          // ★ 단건 원가는 strict 다 — 409/422 를 그대로 보여준다 (R8-14).
          setError(await readApiError(response));
          setResult(null);
          return;
        }
        setResult((await response.json()) as CostResult);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError(emptyError('원가를 불러오지 못했습니다.'));
      });
    return () => {
      cancelled = true;
    };
  }, [bomId, asOf, qty]);

  return (
    <section>
      <div className="mb-3 flex gap-3 text-sm">
        <label>
          <span className="mr-2 text-neutral-500">기준일</span>
          <input
            type="date"
            className="rounded border px-2 py-1"
            aria-label="원가 기준일"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
          />
        </label>
        <label>
          <span className="mr-2 text-neutral-500">수량</span>
          <input
            className="w-24 rounded border px-2 py-1"
            aria-label="원가 수량"
            value={qty}
            onChange={(event) => setQty(event.target.value)}
          />
        </label>
      </div>

      {error !== null ? <ErrorBanner error={error} /> : null}

      {result !== null ? (
        <>
          <p className="mb-2 text-sm">
            기준일 {result.asOf} · 수량 {result.requestedQty}
            {result.isProvisional ? (
              <span className="ml-2 rounded bg-amber-200 px-1 text-xs">잠정</span>
            ) : null}
          </p>

          <table className="w-full border-collapse text-sm" data-testid="cost-components">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                <th className="px-2 py-2">레벨</th>
                <th className="px-2 py-2">구성품</th>
                <th className="px-2 py-2">소요량</th>
                <th className="px-2 py-2">단가</th>
                <th className="px-2 py-2">통화</th>
                <th className="px-2 py-2">VAT</th>
                <th className="px-2 py-2">라인원가</th>
                <th className="px-2 py-2">비중</th>
                <th className="px-2 py-2">미확정</th>
              </tr>
            </thead>
            <tbody>
              {result.components.map((component) => (
                <tr key={`${component.componentSkuId}-${component.uom}`} className="border-b">
                  <td className="px-2 py-2">{component.level}</td>
                  <td className="px-2 py-2">{component.componentSku.skuCode}</td>
                  <td className="px-2 py-2">{component.requiredQty ?? '—'}</td>
                  <td className="px-2 py-2">{component.unitPrice ?? '—'}</td>
                  <td className="px-2 py-2">{component.currency ?? '—'}</td>
                  <td className="px-2 py-2">
                    {component.vatIncluded === null ? '—' : component.vatIncluded ? '포함' : '별도'}
                  </td>
                  <td className="px-2 py-2">{component.lineCost ?? '—'}</td>
                  {/* ★ U8-11 — 같은 (currency, vatIncluded) bucket 안에서의 비중. */}
                  <td className="px-2 py-2">
                    {computeCostSharePct(component, result.subtotals) ?? '—'}
                  </td>
                  <td className="px-2 py-2">{component.provisionalReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ★ 통화·VAT 별 subtotal. ⛔ 단일 총액 없음 (D-26). */}
          <ul className="mt-3 text-sm" data-testid="cost-subtotals">
            {result.subtotals.map((row) => (
              <li key={`${row.currency}-${String(row.vatIncluded)}`}>
                {row.currency} ({row.vatIncluded ? 'VAT 포함' : 'VAT 별도'}): {row.amount}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════
// ④ 변경이력 — 삭제된 라인 포함
// ═══════════════════════════════════════════════════════════════

function HistoryTab({ bomId }: { bomId: string }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{
    items: HistoryItem[];
    page: number;
    total: number;
    totalPages: number;
  } | null>(null);
  const [error, setError] = useState<UiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/boms/${bomId}/history?page=${page}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError(await readApiError(response));
          setResult(null);
          return;
        }
        setResult(
          (await response.json()) as {
            items: HistoryItem[];
            page: number;
            total: number;
            totalPages: number;
          },
        );
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError(emptyError('변경이력을 불러오지 못했습니다.'));
      });
    return () => {
      cancelled = true;
    };
  }, [bomId, page]);

  return (
    <section>
      {error !== null ? <ErrorBanner error={error} /> : null}
      {result !== null ? (
        <>
          <table className="w-full border-collapse text-sm" data-testid="history-timeline">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                <th className="px-2 py-2">일시</th>
                <th className="px-2 py-2">대상</th>
                <th className="px-2 py-2">동작</th>
                <th className="px-2 py-2">수행자</th>
                <th className="px-2 py-2">사유</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.id} className="border-b">
                  <td className="px-2 py-2">{formatTimestamp(item.occurredAt)}</td>
                  <td className="px-2 py-2">{item.entityType}</td>
                  <td className="px-2 py-2">{item.action}</td>
                  {/* ★ actorId UUID 원문 — ⛔ 사용자 조회 API 를 만들지 않는다. */}
                  <td className="px-2 py-2">{item.actorId}</td>
                  <td className="px-2 py-2">{formatOptional(item.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.items.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">변경이력이 없습니다.</p>
          ) : null}

          <nav className="mt-3 flex items-center gap-3 text-sm">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              이전
            </Button>
            <span>
              {result.page} / {Math.max(result.totalPages, 1)} (총 {result.total})
            </span>
            <Button
              variant="secondary"
              disabled={page >= result.totalPages}
              onClick={() => setPage(page + 1)}
            >
              다음
            </Button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
