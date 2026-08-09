'use client';

import { useEffect, useState } from 'react';

import type { CodeOption } from './sku-form-fields';

/**
 * SKU 화면 공용 UI 조각 (T1-6A) — 오류 표시·승인검증 리포트·공통코드 옵션.
 * T0-8 `/admin/codes` 의 오류 표기 convention(공개 메시지 + requestId +
 * fieldErrors)을 그대로 재사용한다.
 */

export interface ApiErrorBody {
  errorCode?: string;
  message?: string;
  requestId?: string;
  publicHint?: string;
  fieldErrors?: Array<{ path: string; message: string }>;
  /** 공개 상세 — 승인 전 검증 실패면 `checks` 가 담긴다. */
  publicDetails?: unknown;
}

export interface UiError {
  status: number;
  code: string | null;
  message: string;
  requestId: string | null;
  hint: string | null;
  fields: Array<{ path: string; message: string }>;
  /** 승인 전 검증 실패(422)면 서버가 준 V1~V9 결과. */
  validation: ValidationReport | null;
}

export interface ValidationCheck {
  code: string;
  severity: 'ERROR' | 'WARNING';
  status: 'PASS' | 'FAIL' | 'CHECK_UNAVAILABLE' | 'NOT_APPLICABLE';
  message?: string;
}

export interface ValidationReport {
  checks: ValidationCheck[];
  hasErrors: boolean;
  hasWarnings: boolean;
}

function readValidation(body: ApiErrorBody): ValidationReport | null {
  const details = body.publicDetails as { checks?: ValidationCheck[] } | undefined;
  if (details === undefined || details === null || !Array.isArray(details.checks)) return null;
  return {
    checks: details.checks,
    hasErrors: details.checks.some(
      (check) => check.severity === 'ERROR' && check.status === 'FAIL',
    ),
    hasWarnings: details.checks.some(
      (check) => check.severity === 'WARNING' && check.status === 'FAIL',
    ),
  };
}

export async function readApiError(response: Response): Promise<UiError> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // 본문이 JSON 이 아니면 상태코드만 보여준다.
  }
  return {
    status: response.status,
    code: body.errorCode ?? null,
    message: body.message ?? `요청이 실패했습니다. (HTTP ${response.status})`,
    requestId: body.requestId ?? null,
    hint: body.publicHint ?? null,
    fields: body.fieldErrors ?? [],
    validation: readValidation(body),
  };
}

export function ErrorBanner({ error, onClose }: { error: UiError; onClose?: () => void }) {
  return (
    <div
      role="alert"
      data-testid="error-banner"
      data-error-code={error.code ?? ''}
      className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="font-medium">{error.message}</p>
          {error.hint !== null && <p>{error.hint}</p>}
          {error.fields.length > 0 && (
            <ul className="list-inside list-disc" data-testid="error-fields">
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
        {onClose !== undefined && (
          <button type="button" onClick={onClose} className="text-xs underline">
            닫기
          </button>
        )}
      </div>
    </div>
  );
}

const CHECK_STATUS_LABEL: Readonly<Record<ValidationCheck['status'], string>> = {
  PASS: '통과',
  FAIL: '실패',
  CHECK_UNAVAILABLE: '판정 불가',
  NOT_APPLICABLE: '해당 없음',
};

const CHECK_STATUS_CLASS: Readonly<Record<ValidationCheck['status'], string>> = {
  PASS: 'text-emerald-700 dark:text-emerald-300',
  FAIL: 'text-destructive font-medium',
  CHECK_UNAVAILABLE: 'text-amber-700 dark:text-amber-300',
  NOT_APPLICABLE: 'text-muted-foreground',
};

/**
 * 승인 전 검증 V1~V9 결과 (docs/08).
 *
 * ⚠️ `CHECK_UNAVAILABLE` 을 PASS 처럼 숨기지 않는다 — 판정하지 못했다는 사실을
 *    그대로 보여준다. `NOT_APPLICABLE`(바코드 모듈 부재)도 마찬가지다.
 * ⛔ 코드체계·바코드 예외승인 버튼은 아직 없다.
 */
export function ValidationReportPanel({ report }: { report: ValidationReport }) {
  return (
    <section
      data-testid="validation-report"
      className="bg-card space-y-2 rounded-md border p-4 text-sm"
      aria-label="승인 전 검증 결과"
    >
      <p className="font-medium">승인 전 검증 결과 (V1~V9)</p>
      <ul className="space-y-1">
        {report.checks.map((check) => (
          <li
            key={check.code}
            data-check={check.code}
            data-check-status={check.status}
            data-check-severity={check.severity}
            className="flex flex-wrap items-baseline gap-2"
          >
            <span className="font-mono text-xs">{check.code}</span>
            <span className="text-muted-foreground text-xs">[{check.severity}]</span>
            <span className={`text-xs ${CHECK_STATUS_CLASS[check.status]}`}>
              {CHECK_STATUS_LABEL[check.status]}
            </span>
            {check.message !== undefined && (
              <span className="text-muted-foreground text-xs">— {check.message}</span>
            )}
          </li>
        ))}
      </ul>
      {report.hasWarnings && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          경고 항목이 있습니다 — 진행은 차단되지 않습니다.
        </p>
      )}
    </section>
  );
}

export interface CommonCodeOptions {
  brand: readonly CodeOption[];
  major: readonly CodeOption[];
  minor: readonly CodeOption[];
}

/** 브랜드·대분류·소분류 활성 코드 옵션 (T0-8 공개 API 재사용). */
export function useCommonCodeOptions(): CommonCodeOptions {
  const [options, setOptions] = useState<CommonCodeOptions>({ brand: [], major: [], minor: [] });

  useEffect(() => {
    let cancelled = false;
    const load = (groupCode: string) =>
      fetch(`/api/codes/${groupCode}?active=true`, { cache: 'no-store' }).then(async (response) =>
        response.ok
          ? ((await response.json()) as { codes: CodeOption[] }).codes
          : ([] as CodeOption[]),
      );
    void Promise.all([load('BRAND'), load('MAJOR_CATEGORY'), load('MINOR_CATEGORY')])
      .then(([brand, major, minor]) => {
        if (!cancelled) setOptions({ brand, major, minor });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return options;
}

/** 내 권한 — role 이름이 아니라 permission 키로만 UI 를 판단한다. */
export function usePermissions(): readonly string[] | null {
  const [permissions, setPermissions] = useState<readonly string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setPermissions([]);
          return;
        }
        const body = (await response.json()) as { permissions: string[] };
        if (!cancelled) setPermissions(body.permissions);
      })
      .catch(() => {
        if (!cancelled) setPermissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return permissions;
}
