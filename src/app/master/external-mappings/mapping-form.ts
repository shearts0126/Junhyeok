/**
 * 외부 매핑 등록·수정 폼 헬퍼 (T05-4A) — 순수 함수만. 클라이언트 번들에 안전하다.
 *
 * ⚠️ `@/modules/external-mapping/application` barrel 을 import 하지 않는다
 *    (Prisma 런타임을 끌고 온다). 대신 **unit 테스트가 backend contract 와의
 *    정합을 고정**한다 — T1-6A `sku-form.ts` 와 같은 구조다.
 *
 * ## 계약 준수
 *
 *   - `CreateMappingDto` / `UpdateMappingDto`(Zod strict)가 단일 기준이다.
 *     UI 가 규칙을 완화·강화하지 않는다.
 *   - ⛔ server-managed 필드를 payload 에 넣지 않는다 —
 *     `id` · `mappingStatus` · `effectiveFrom` · `createdAt` · `warehouseId`.
 *   - ⛔ `skuId` · `externalSystemId` 는 매핑 identity 라 **PATCH 대상이 아니다**.
 *   - trim/blank→null canonicalization 은 **서버가 한다**. UI 는 입력값을
 *     그대로 보내고 서버 판정을 표시한다.
 */

/** 신규 매핑 폼 상태 — 전부 문자열/불리언. */
export interface MappingCreateForm {
  readonly externalSystemId: string;
  readonly skuId: string;
  readonly externalProductCode: string;
  readonly externalProductName: string;
  readonly externalBarcode: string;
  readonly isPrimary: boolean;
  readonly note: string;
}

export const EMPTY_CREATE_FORM: MappingCreateForm = {
  externalSystemId: '',
  skuId: '',
  externalProductCode: '',
  externalProductName: '',
  externalBarcode: '',
  isPrimary: false,
  note: '',
};

/** POST body — T05-2 `createMappingSchema` 와 정확히 같은 필드 집합. */
export interface MappingCreatePayload {
  skuId: string;
  externalSystemId: string;
  externalProductCode?: string;
  externalProductName?: string;
  externalBarcode?: string;
  isPrimary?: boolean;
  note?: string;
}

/**
 * 비어 있는 선택 입력은 **키 자체를 보내지 않는다.**
 *
 * `''` 를 보내도 서버가 `null` 로 canonicalize 하지만, 사용자가 손대지 않은
 * 필드를 굳이 payload 에 넣지 않는 편이 계약이 선명하다. 식별자를 하나도 채우지
 * 않으면 서버가 422 `EXTERNAL_MAPPING_IDENTIFIER_REQUIRED` 로 알려준다 —
 * UI 가 그 판정을 앞질러 막지 않는다.
 */
export function buildCreatePayload(form: MappingCreateForm): MappingCreatePayload {
  const payload: MappingCreatePayload = {
    skuId: form.skuId,
    externalSystemId: form.externalSystemId,
  };
  if (form.externalProductCode !== '') payload.externalProductCode = form.externalProductCode;
  if (form.externalProductName !== '') payload.externalProductName = form.externalProductName;
  if (form.externalBarcode !== '') payload.externalBarcode = form.externalBarcode;
  if (form.isPrimary) payload.isPrimary = true;
  if (form.note !== '') payload.note = form.note;
  return payload;
}

/** 수정 대상 행의 현재 값 (목록 projection 에서 그대로 온다). */
export interface MappingEditRow {
  readonly externalProductCode: string | null;
  readonly externalProductName: string | null;
  readonly externalBarcode: string | null;
  readonly isPrimary: boolean;
  readonly note: string | null;
}

/** 수정 폼 상태 — identity·상태 필드는 read-only 라 폼에 없다. */
export interface MappingEditForm {
  readonly externalProductCode: string;
  readonly externalProductName: string;
  readonly externalBarcode: string;
  readonly isPrimary: boolean;
  readonly note: string;
}

export function toEditForm(row: MappingEditRow): MappingEditForm {
  return {
    externalProductCode: row.externalProductCode ?? '',
    externalProductName: row.externalProductName ?? '',
    externalBarcode: row.externalBarcode ?? '',
    isPrimary: row.isPrimary,
    note: row.note ?? '',
  };
}

/** PATCH body — T05-2 `updateMappingSchema` 의 부분집합. */
export interface MappingUpdatePayload {
  externalProductCode?: string | null;
  externalProductName?: string | null;
  externalBarcode?: string | null;
  isPrimary?: boolean;
  note?: string | null;
}

/**
 * **변경된 필드만** 담는다. 바뀐 것이 없으면 `null` — 그러면 UI 는 PATCH 자체를
 * 호출하지 않는다 (서버 no-change 200 에 의존하지 않는다).
 *
 * 값을 지우는 것은 `''` → `null` 로 표현한다 (서버 canonicalization 과 동일 결과).
 */
export function buildUpdatePayload(
  row: MappingEditRow,
  form: MappingEditForm,
): MappingUpdatePayload | null {
  const payload: MappingUpdatePayload = {};

  const text = (
    key: 'externalProductCode' | 'externalProductName' | 'externalBarcode' | 'note',
  ): void => {
    const next = form[key] === '' ? null : form[key];
    if (next !== (row[key] ?? null)) payload[key] = next;
  };

  text('externalProductCode');
  text('externalProductName');
  text('externalBarcode');
  text('note');
  if (form.isPrimary !== row.isPrimary) payload.isPrimary = form.isPrimary;

  return Object.keys(payload).length === 0 ? null : payload;
}

/** 매핑 해제 payload — 대표 매핑이면 같은 요청에서 대표를 함께 해제해야 한다. */
export interface MappingEndPayload {
  isPrimary?: false;
  effectiveTo: string;
}

/**
 * ★ 대표(`isPrimary=true`) 행을 그냥 종료하면 서버가 422
 *   `EXTERNAL_MAPPING_PRIMARY_MUST_BE_CLEARED_BEFORE_END` 로 거부한다
 *   (종료된 대표가 새 대표를 영구히 막지 않게 하려는 규칙, docs/14 참조).
 *   UI 는 그 규칙을 우회하지 않고 **같은 PATCH 에 `isPrimary:false` 를 넣는다.**
 */
export function buildEndPayload(
  row: Pick<MappingEditRow, 'isPrimary'>,
  today: string,
): MappingEndPayload {
  return row.isPrimary ? { isPrimary: false, effectiveTo: today } : { effectiveTo: today };
}

/**
 * 업무일자(Asia/Seoul) `YYYY-MM-DD`.
 *
 * ⚠️ backend `businessDateOf`(`modules/external-mapping/application/effective-date`)
 *    와 **같은 규칙**이다 — `en-CA` 로케일 + `Asia/Seoul`. 새 timezone 유틸을
 *    만든 것이 아니라, Prisma 를 끌고 오는 barrel 을 클라이언트 번들에 넣지 않기
 *    위해 같은 계산을 여기서 반복한 것이며 **unit 테스트가 두 값의 일치를
 *    고정**한다.
 */
export const BUSINESS_TIME_ZONE = 'Asia/Seoul';

export function todayBusinessDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
