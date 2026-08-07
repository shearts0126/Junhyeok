'use client';

import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * 공통코드 관리 화면 (T0-8).
 *
 * - 데스크톱 업무 화면 가독성 우선 (모바일 최적화보다)
 * - ⛔ 삭제 버튼이 없다 — "삭제" 는 비활성화(active=false)다
 * - 코드 값은 생성 후 수정 불가 — UI 에도 명시한다
 * - `common_code.manage` 가 없으면 수정 UI 를 렌더링하지 않는다.
 *   (숨김은 UX 일 뿐, 서버 2겹 가드가 항상 최종 판정한다)
 * - 오류는 서버 공개 메시지 + requestId 만 표시한다. 내부 스택은 서버 로그에만 있다.
 */

interface GroupView {
  groupCode: string;
  groupName: string;
  parentGroupCode: string | null;
  sortOrder: number;
  active: boolean;
  codeCount: number;
  activeCodeCount: number;
}

interface ParentView {
  id: string;
  groupCode: string;
  code: string;
  name: string;
}

interface CodeView {
  id: string;
  groupCode: string;
  code: string;
  name: string;
  parent: ParentView | null;
  sortOrder: number;
  attributes: unknown;
  active: boolean;
  updatedAt: string;
}

interface ApiErrorBody {
  errorCode?: string;
  message?: string;
  requestId?: string;
  publicHint?: string;
  fieldErrors?: Array<{ path: string; message: string }>;
}

interface UiError {
  message: string;
  requestId: string | null;
  hint: string | null;
  fields: Array<{ path: string; message: string }>;
}

type ActiveFilter = 'true' | 'false' | 'all';

async function readError(response: Response): Promise<UiError> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // 본문이 JSON 이 아니면 상태코드만 보여준다.
  }
  return {
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

interface CodeFormValue {
  code: string;
  name: string;
  parentCode: string;
  sortOrder: string;
}

const EMPTY_FORM: CodeFormValue = { code: '', name: '', parentCode: '', sortOrder: '0' };

export function CodesAdminClient() {
  const [permissions, setPermissions] = useState<readonly string[] | null>(null);
  const [groups, setGroups] = useState<readonly GroupView[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('true');
  const [search, setSearch] = useState('');
  const [codes, setCodes] = useState<readonly CodeView[] | null>(null);
  const [parentOptions, setParentOptions] = useState<readonly CodeView[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [error, setError] = useState<UiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<CodeFormValue>(EMPTY_FORM);
  const [editTarget, setEditTarget] = useState<CodeView | null>(null);
  const [editForm, setEditForm] = useState<CodeFormValue>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const canManage = permissions?.includes('common_code.manage') ?? false;
  const group = groups.find((entry) => entry.groupCode === selectedGroup) ?? null;

  // ⚠️ effect 안에서는 setState 를 동기 호출하지 않는다
  //    (react-hooks/set-state-in-effect). 모든 상태 갱신은 .then 콜백에서 한다.

  // 최초 로드 — 내 권한과 그룹 목록.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { cache: 'no-store' })
      .then(async (me) => {
        if (cancelled) return;
        if (!me.ok) {
          setPermissions([]);
          setError(await readError(me));
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

  // 그룹 목록 — refreshTick 이 바뀔 때마다 다시 읽는다 (수량 갱신).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/code-groups', { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError(await readError(response));
          return;
        }
        const body = (await response.json()) as { groups: GroupView[] };
        if (cancelled) return;
        setGroups(body.groups);
        setSelectedGroup((current) => current ?? body.groups[0]?.groupCode ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // 코드 목록.
  useEffect(() => {
    if (selectedGroup === null) return;
    let cancelled = false;
    fetch(`/api/codes/${encodeURIComponent(selectedGroup)}?active=${activeFilter}`, {
      cache: 'no-store',
    })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError(await readError(response));
          setCodes([]);
          return;
        }
        const body = (await response.json()) as { codes: CodeView[] };
        if (!cancelled) setCodes(body.codes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedGroup, activeFilter, refreshTick]);

  // 부모 코드 선택지 — 그룹에 상위 그룹이 있을 때만 로드한다.
  const parentGroupCode = group?.parentGroupCode ?? null;
  useEffect(() => {
    let cancelled = false;
    const load =
      parentGroupCode === null
        ? Promise.resolve<readonly CodeView[]>([])
        : fetch(`/api/codes/${encodeURIComponent(parentGroupCode)}?active=true`, {
            cache: 'no-store',
          }).then(async (response) =>
            response.ok
              ? ((await response.json()) as { codes: CodeView[] }).codes
              : ([] as CodeView[]),
          );
    void load.then((options) => {
      if (!cancelled) setParentOptions(options);
    });
    return () => {
      cancelled = true;
    };
  }, [parentGroupCode, refreshTick]);

  const loading = codes === null;

  const visibleCodes = useMemo(() => {
    const rows = codes ?? [];
    const term = search.trim().toLowerCase();
    if (term === '') return rows;
    return rows.filter(
      (code) => code.code.toLowerCase().includes(term) || code.name.toLowerCase().includes(term),
    );
  }, [codes, search]);

  function refreshAll() {
    setRefreshTick((tick) => tick + 1);
  }

  async function submitCreate() {
    if (selectedGroup === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/codes/${encodeURIComponent(selectedGroup)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: createForm.code,
          name: createForm.name,
          parentCode: createForm.parentCode === '' ? null : createForm.parentCode,
          sortOrder: Number(createForm.sortOrder),
          attributes: null,
        }),
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      setNotice(`코드 '${createForm.code}' 을(를) 추가했습니다.`);
      setCreating(false);
      setCreateForm(EMPTY_FORM);
      refreshAll();
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit() {
    if (selectedGroup === null || editTarget === null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const patch: Record<string, unknown> = {};
      if (editForm.name !== editTarget.name) patch['name'] = editForm.name;
      const currentParent = editTarget.parent?.code ?? '';
      if (editForm.parentCode !== currentParent) {
        patch['parentCode'] = editForm.parentCode === '' ? null : editForm.parentCode;
      }
      if (Number(editForm.sortOrder) !== editTarget.sortOrder) {
        patch['sortOrder'] = Number(editForm.sortOrder);
      }

      const response = await fetch(
        `/api/codes/${encodeURIComponent(selectedGroup)}/${encodeURIComponent(editTarget.code)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      setNotice(`코드 '${editTarget.code}' 을(를) 수정했습니다.`);
      setEditTarget(null);
      refreshAll();
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(code: CodeView) {
    if (selectedGroup === null) return;
    const deactivating = code.active;
    // 비활성화 전 확인. 삭제가 아님을 함께 알린다.
    if (
      deactivating &&
      !window.confirm(
        `코드 '${code.code} ${code.name}' 을(를) 비활성화할까요?\n` +
          '데이터는 삭제되지 않으며 이력에 남습니다. 언제든 재활성화할 수 있습니다.',
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/codes/${encodeURIComponent(selectedGroup)}/${encodeURIComponent(code.code)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !code.active }),
        },
      );
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      setNotice(
        deactivating
          ? `코드 '${code.code}' 을(를) 비활성화했습니다.`
          : `코드 '${code.code}' 을(를) 재활성화했습니다.`,
      );
      refreshAll();
    } finally {
      setSaving(false);
    }
  }

  function openEdit(code: CodeView) {
    setEditTarget(code);
    setEditForm({
      code: code.code,
      name: code.name,
      parentCode: code.parent?.code ?? '',
      sortOrder: String(code.sortOrder),
    });
  }

  if (permissions === null) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <p className="text-muted-foreground text-sm">불러오는 중…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-6 py-10">
      <header className="space-y-1">
        <p className="text-muted-foreground font-mono text-sm">DEEPPOINT SCM OS</p>
        <h1 className="text-2xl font-semibold tracking-tight">공통코드 관리</h1>
        <p className="text-muted-foreground text-sm">
          코드사전의 단일 기준입니다. 코드는 물리삭제하지 않으며 비활성화로만 내립니다.
        </p>
      </header>

      {error !== null && <ErrorBanner error={error} onClose={() => setError(null)} />}
      {notice !== null && (
        <div
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        >
          {notice}
        </div>
      )}

      <div className="flex gap-6">
        {/* 그룹 목록 */}
        <aside className="w-64 shrink-0 space-y-1" aria-label="코드 그룹">
          {groups.map((entry) => {
            const selected = entry.groupCode === selectedGroup;
            return (
              <button
                key={entry.groupCode}
                type="button"
                onClick={() => {
                  setSelectedGroup(entry.groupCode);
                  setSearch('');
                  setCreating(false);
                  setEditTarget(null);
                }}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  selected ? 'bg-accent border-ring' : 'bg-card hover:bg-accent/50'
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{entry.groupName}</span>
                  <span className="text-muted-foreground font-mono text-xs">{entry.groupCode}</span>
                </span>
                <span className="text-muted-foreground text-xs">
                  전체 {entry.codeCount} · 활성 {entry.activeCodeCount} · 비활성{' '}
                  {entry.codeCount - entry.activeCodeCount}
                </span>
              </button>
            );
          })}
        </aside>

        {/* 코드 테이블 */}
        <section className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-md border" role="group" aria-label="활성 필터">
              {(
                [
                  ['true', '활성'],
                  ['false', '비활성'],
                  ['all', '전체'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setActiveFilter(value)}
                  className={`px-3 py-1.5 text-sm first:rounded-l-md last:rounded-r-md ${
                    activeFilter === value ? 'bg-accent font-medium' : 'hover:bg-accent/50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="코드·명칭 검색"
              className="bg-background h-9 w-56 rounded-md border px-3 text-sm"
              aria-label="코드·명칭 검색"
            />

            <div className="flex-1" />

            {canManage && group !== null && (
              <Button size="sm" onClick={() => setCreating((value) => !value)}>
                {creating ? '추가 취소' : '신규 코드 추가'}
              </Button>
            )}
          </div>

          {/* 신규 코드 추가 — manage 권한 전용 */}
          {canManage && creating && group !== null && (
            <form
              className="bg-card space-y-3 rounded-md border p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreate();
              }}
            >
              <p className="text-sm font-medium">신규 코드 — {group.groupName}</p>
              <p className="text-muted-foreground text-xs">
                ⚠️ 코드 값은 저장 후 변경할 수 없습니다. 명칭·정렬순서·상위 코드만 수정할 수
                있습니다.
              </p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">코드 (저장 후 변경 불가)</span>
                  <input
                    required
                    value={createForm.code}
                    onChange={(event) => setCreateForm({ ...createForm, code: event.target.value })}
                    className="bg-background h-9 w-full rounded-md border px-3 font-mono text-sm"
                    name="code"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">명칭</span>
                  <input
                    required
                    value={createForm.name}
                    onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })}
                    className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                    name="name"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">상위 코드</span>
                  <select
                    value={createForm.parentCode}
                    onChange={(event) =>
                      setCreateForm({ ...createForm, parentCode: event.target.value })
                    }
                    disabled={group.parentGroupCode === null}
                    className="bg-background h-9 w-full rounded-md border px-2 text-sm disabled:opacity-50"
                    name="parentCode"
                  >
                    <option value="">
                      {group.parentGroupCode === null ? '(상위 그룹 없음)' : '(없음)'}
                    </option>
                    {parentOptions.map((option) => (
                      <option key={option.id} value={option.code}>
                        {option.code} — {option.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">정렬순서</span>
                  <input
                    type="number"
                    min={0}
                    value={createForm.sortOrder}
                    onChange={(event) =>
                      setCreateForm({ ...createForm, sortOrder: event.target.value })
                    }
                    className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                    name="sortOrder"
                  />
                </label>
              </div>
              <div className="flex gap-2">
                <Button size="sm" type="submit" disabled={saving}>
                  저장
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => setCreating(false)}
                >
                  취소
                </Button>
              </div>
            </form>
          )}

          {/* 수정 — manage 권한 전용 */}
          {canManage && editTarget !== null && group !== null && (
            <form
              className="bg-card space-y-3 rounded-md border p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submitEdit();
              }}
            >
              <p className="text-sm font-medium">
                코드 수정 — <span className="font-mono">{editTarget.code}</span>
              </p>
              <p className="text-muted-foreground text-xs">
                ⚠️ 코드 값과 그룹은 변경할 수 없습니다.
              </p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">코드 (변경 불가)</span>
                  <input
                    value={editForm.code}
                    disabled
                    className="bg-muted h-9 w-full rounded-md border px-3 font-mono text-sm opacity-70"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">명칭</span>
                  <input
                    required
                    value={editForm.name}
                    onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
                    className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                    name="name"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">상위 코드</span>
                  <select
                    value={editForm.parentCode}
                    onChange={(event) =>
                      setEditForm({ ...editForm, parentCode: event.target.value })
                    }
                    disabled={group.parentGroupCode === null}
                    className="bg-background h-9 w-full rounded-md border px-2 text-sm disabled:opacity-50"
                    name="parentCode"
                  >
                    <option value="">
                      {group.parentGroupCode === null ? '(상위 그룹 없음)' : '(없음)'}
                    </option>
                    {parentOptions.map((option) => (
                      <option key={option.id} value={option.code}>
                        {option.code} — {option.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">정렬순서</span>
                  <input
                    type="number"
                    min={0}
                    value={editForm.sortOrder}
                    onChange={(event) =>
                      setEditForm({ ...editForm, sortOrder: event.target.value })
                    }
                    className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                    name="sortOrder"
                  />
                </label>
              </div>
              <div className="flex gap-2">
                <Button size="sm" type="submit" disabled={saving}>
                  저장
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => setEditTarget(null)}
                >
                  취소
                </Button>
              </div>
            </form>
          )}

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 text-muted-foreground border-b text-left text-xs">
                  <th className="px-3 py-2 font-medium">코드</th>
                  <th className="px-3 py-2 font-medium">명칭</th>
                  <th className="px-3 py-2 font-medium">상위 코드</th>
                  <th className="px-3 py-2 font-medium">정렬순서</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                  <th className="px-3 py-2 font-medium">수정일시</th>
                  {canManage && <th className="px-3 py-2 font-medium">작업</th>}
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td
                      colSpan={canManage ? 7 : 6}
                      className="text-muted-foreground px-3 py-6 text-center"
                    >
                      불러오는 중…
                    </td>
                  </tr>
                )}
                {!loading && visibleCodes.length === 0 && (
                  <tr>
                    <td
                      colSpan={canManage ? 7 : 6}
                      className="text-muted-foreground px-3 py-6 text-center"
                    >
                      표시할 코드가 없습니다.
                    </td>
                  </tr>
                )}
                {!loading &&
                  visibleCodes.map((code) => (
                    <tr key={code.id} className="border-b last:border-b-0" data-code={code.code}>
                      <td className="px-3 py-2 font-mono">{code.code}</td>
                      <td className="px-3 py-2">{code.name}</td>
                      <td className="text-muted-foreground px-3 py-2">
                        {code.parent === null ? (
                          '—'
                        ) : (
                          <span>
                            <span className="font-mono">{code.parent.code}</span> {code.parent.name}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{code.sortOrder}</td>
                      <td className="px-3 py-2">
                        {code.active ? (
                          <span className="text-emerald-600 dark:text-emerald-400">활성</span>
                        ) : (
                          <span className="text-muted-foreground">비활성</span>
                        )}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 font-mono text-xs">
                        {code.updatedAt.replace('T', ' ').slice(0, 19)}
                      </td>
                      {canManage && (
                        <td className="space-x-2 px-3 py-2 whitespace-nowrap">
                          <Button size="sm" variant="outline" onClick={() => openEdit(code)}>
                            수정
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={saving}
                            onClick={() => void toggleActive(code)}
                          >
                            {code.active ? '비활성화' : '재활성화'}
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <p className="text-muted-foreground text-xs">
            표시 {visibleCodes.length}건 · 삭제 기능은 제공하지 않습니다 — 사용하지 않는 코드는
            비활성화하세요. 비활성 코드도 감사·이력 목적으로 보존됩니다.
          </p>
        </section>
      </div>
    </main>
  );
}
