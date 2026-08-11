'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

import { buildCreatePayload, emptySkuForm, type SkuFormValue } from '../sku-form';
import { SKU_CREATE_TABS, SkuTabPanel, type SkuTabKey } from '../sku-form-fields';
import {
  ErrorBanner,
  readApiError,
  useCommonCodeOptions,
  usePermissions,
  type UiError,
} from '../sku-ui';

/**
 * 신규 SKU 등록 (T1-6A) — `/master/skus/new`.
 *
 * - `CreateSkuDto`(Zod strict)가 단일 기준이다. 서버 관리 필드는 payload 에
 *   들어가지 않으며, 생성 결과는 항상 `status=DRAFT` 다.
 * - `Idempotency-Key`: 논리적 생성 시도마다 1개. **retry 는 같은 key**(중복
 *   생성 방지), 사용자가 본문을 고쳐 다시 시도하면 새 key 다. replay 200 도
 *   정상 성공으로 처리한다.
 * - 권한: `sku.create`. UI 숨김은 UX 이고 서버 2겹 가드가 최종 판정한다.
 *
 * ⛔ **바코드 탭이 없다** (T1-6B1, `docs/16` §7) — 바코드는 `/api/skus/{id}/barcodes`
 *    처럼 부모 `skuId` 를 경로로 요구하는 child entity 라 저장 전에는 존재할 수
 *    없다. disabled·placeholder 탭도 만들지 않는다. 등록에 성공하면 상세로
 *    이동하므로 그 화면에서 바로 바코드를 등록할 수 있다.
 */

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function NewSkuClient() {
  const router = useRouter();
  const permissions = usePermissions();
  const options = useCommonCodeOptions();

  const [tab, setTab] = useState<SkuTabKey>('basic');
  const [form, setForm] = useState<SkuFormValue>(emptySkuForm());
  const [error, setError] = useState<UiError | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * 현재 폼 내용에 대한 멱등 키. 본문이 바뀌면 새 키가 되고(새 생성 시도),
   * 같은 본문의 재시도는 같은 키를 재사용한다(중복 생성 방지).
   */
  const payload = useMemo(() => buildCreatePayload(form), [form]);
  const payloadKey = useMemo(() => JSON.stringify(payload), [payload]);
  const [keyForPayload, setKeyForPayload] = useState<{ payloadKey: string; key: string }>(() => ({
    payloadKey,
    key: newIdempotencyKey(),
  }));
  if (keyForPayload.payloadKey !== payloadKey) {
    setKeyForPayload({ payloadKey, key: newIdempotencyKey() });
  }

  const canCreate = permissions?.includes('sku.create') ?? false;

  function patchForm(patch: Partial<SkuFormValue>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function submitCreate() {
    if (saving) return; // double submit 방지
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/skus', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': keyForPayload.key,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      // 201(최초) / 200(멱등 replay) 모두 성공이다.
      const body = (await response.json()) as { sku: { id: string } };
      router.push(`/master/skus/${body.sku.id}`);
    } catch {
      setError({
        status: 0,
        code: null,
        message: '네트워크 오류로 저장하지 못했습니다.',
        requestId: null,
        hint: null,
        fields: [],
        validation: null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-6 py-10">
      <header className="space-y-1">
        <Link href="/master/skus" className="text-muted-foreground text-sm underline">
          ← SKU 목록
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">신규 SKU 등록</h1>
        <p className="text-muted-foreground text-sm">
          저장하면 <span className="font-mono">DRAFT</span> 상태로 생성됩니다. 승인 요청은 상세
          화면에서 진행합니다.
        </p>
      </header>

      {error !== null && <ErrorBanner error={error} onClose={() => setError(null)} />}

      {permissions !== null && !canCreate && (
        <div
          role="alert"
          data-testid="forbidden-create"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          SKU 등록 권한(<span className="font-mono">sku.create</span>)이 없습니다.
        </div>
      )}

      <div className="flex gap-2 border-b" role="tablist" aria-label="SKU 입력 탭">
        {SKU_CREATE_TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            onClick={() => setTab(entry.key)}
            className={`px-4 py-2 text-sm ${
              tab === entry.key ? 'border-ring border-b-2 font-medium' : 'text-muted-foreground'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submitCreate();
        }}
      >
        <SkuTabPanel
          tab={tab}
          form={form}
          onChange={patchForm}
          disabled={!canCreate || saving}
          brandOptions={options.brand}
          majorOptions={options.major}
          minorOptions={options.minor}
        />

        <div className="flex gap-2">
          <Button type="submit" disabled={!canCreate || saving} data-testid="create-submit">
            {saving ? '저장 중…' : '저장'}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.push('/master/skus')}>
            취소
          </Button>
        </div>
      </form>
    </main>
  );
}
