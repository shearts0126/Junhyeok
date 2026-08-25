'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { readApiError, type UiError } from '../skus/sku-ui';

/**
 * SKU 선택기 — 기존 `GET /api/skus?q=` 를 그대로 재사용한다 (U8-14).
 *
 * ⛔ 새 검색 API 를 만들지 않는다 · ⛔ 새 UI library 를 들이지 않는다 ·
 * ⛔ **UUID 자유 입력을 허용하지 않는다** — 반드시 검색 결과에서 고른다.
 *
 * 상위 SKU(신규 BOM)와 구성품 SKU(라인 추가·수정)가 같은 컴포넌트를 쓴다.
 */

export interface SkuOption {
  readonly id: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly status: string;
}

export function SkuPicker({
  label,
  selectedId,
  selectedLabel,
  onPick,
  onError,
}: {
  label: string;
  selectedId: string;
  selectedLabel: string;
  onPick: (sku: SkuOption) => void;
  onError: (error: UiError) => void;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<readonly SkuOption[] | null>(null);

  const search = async () => {
    setOptions(null);
    const response = await fetch(`/api/skus?q=${encodeURIComponent(query)}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      onError(await readApiError(response));
      return;
    }
    const body = (await response.json()) as { items: SkuOption[] };
    setOptions(body.items);
  };

  return (
    <div className="mb-3">
      <span className="mb-1 block text-sm text-neutral-500">{label}</span>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border px-2 py-1"
          aria-label={`${label} 검색어`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button variant="secondary" onClick={() => void search()}>
          검색
        </Button>
      </div>

      {options !== null ? (
        <select
          className="mt-2 w-full rounded border px-2 py-1"
          aria-label={`${label} 선택`}
          size={5}
          value={selectedId}
          onChange={(event) => {
            const picked = options.find((sku) => sku.id === event.target.value);
            if (picked !== undefined) onPick(picked);
          }}
        >
          {options.map((sku) => (
            <option key={sku.id} value={sku.id}>
              {sku.skuCode} · {sku.skuName} ({sku.status})
            </option>
          ))}
        </select>
      ) : null}

      {options !== null && options.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-500">검색 결과가 없습니다.</p>
      ) : null}

      {selectedLabel !== '' ? <p className="mt-1 text-sm">선택: {selectedLabel}</p> : null}
    </div>
  );
}
