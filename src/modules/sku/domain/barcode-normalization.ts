/**
 * 바코드 정규화·분류 (T04-2) — **순수 함수만**.
 *
 * ⚠️ 규칙의 유일한 근거는 `docs/06_데이터_마이그레이션설계.md` §12.5
 *    (`normalizeBarcode`) 이며, 그 원문을 그대로 옮긴 것이다. 새로 해석하거나
 *    일반 바코드 상식(EAN-13 길이·체크디지트 등)을 섞지 않는다.
 *
 * ## 파이프라인
 *
 *     raw → 타입 검증 → trim → EMPTY sentinel → 지수표기 → 확인필요 sentinel
 *         → 공백·하이픈 제거 → 숫자 전용 검증 → 정규화된 바코드
 *
 * ## 이 함수가 하지 않는 것
 *
 * ⛔ DB 조회·Prisma·권한·AuditLog·DataIssue INSERT·SkuBarcode INSERT·
 *    API 응답·React — 아무것도 없다. 같은 입력이면 언제나 같은 결과다.
 * ⛔ `BARCODE_DUPLICATE` 를 판정하지 않는다 — DB raw invariant 는 T04-1 의
 *    조건부 UNIQUE(`ux_barcode_active`)가, 업무 흐름은 T04-3/T04-4 가 담당한다.
 * ⛔ `barcodeType`(UNIT·INNER_BOX·…)을 추론하지 않는다 — 호출자 입력이다.
 * ⛔ 길이 규칙을 만들지 않는다. `sku_barcode.barcode` 가 VARCHAR(100) 인 것은
 *    **DB 물리 제약**이며 정규화 업무규칙이 아니다. EAN-13 강제·8/12/13/14자리
 *    허용·체크디지트 검증·100자 초과 전용 코드 — 전부 없다. 길이·DTO validation
 *    이 필요하면 T04-3 에서 별도로 판단한다.
 *
 * ## `ISSUE` 의 의미
 *
 * `BARCODE_UNVERIFIED`·`BARCODE_INVALID_FORMAT` 은 **분류값**일 뿐이다.
 * 실제 `DataIssue` 행으로 바꾸는 것은 후속 Application 계층의 몫이며,
 * 이 Task 에서는 만들지 않는다.
 *
 * ⚠️ 전역 HTTP `ERROR_CODES` 를 확장하지 않는다 — 여기서는 도메인 문자열 리터럴
 *    union 으로 충분하다. API 오류 taxonomy 는 T04-3 에서 확정한다.
 */

/** 파서 버그·복구 불가 손실 — 행 오류로 다뤄야 하는 분류. */
export const BARCODE_ERROR_CODES = [
  'BARCODE_READ_AS_NUMBER',
  'BARCODE_SCIENTIFIC_NOTATION',
] as const;
export type BarcodeErrorCode = (typeof BARCODE_ERROR_CODES)[number];

/** 사람이 확인해야 하는 분류 — 후속 계층이 업무 이슈로 변환한다. */
export const BARCODE_ISSUE_CODES = ['BARCODE_UNVERIFIED', 'BARCODE_INVALID_FORMAT'] as const;
export type BarcodeIssueCode = (typeof BARCODE_ISSUE_CODES)[number];

export type BarcodeNormalizationResult =
  /** 미입력. ⚠️ 오류도 이슈도 아니다 (§00 G-04). */
  | { readonly kind: 'EMPTY' }
  | { readonly kind: 'OK'; readonly barcode: string }
  | { readonly kind: 'ERROR'; readonly code: BarcodeErrorCode }
  /** `raw` 는 cleaned 가 아니라 **trim 직후 원문**이다 — 원본 값을 잃지 않는다. */
  | { readonly kind: 'ISSUE'; readonly code: BarcodeIssueCode; readonly raw: string };

/**
 * 미입력으로 간주하는 값.
 *
 * ⚠️ 실데이터에서 `-` 는 376/490건(76.7%)으로 "값이 아니라 공란 표시"다.
 *    이슈를 만들면 예외큐가 무의미해지므로 **DataIssue 대상이 아니다**(§00 G-04).
 * ⛔ `_`·`N/A`·`없음`·`NULL` 같은 기호를 임의로 sentinel 에 추가하지 않는다.
 */
export const BARCODE_EMPTY_SENTINELS = ['', '-', '—'] as const;

/**
 * 담당자가 명시적으로 확인을 요청한 값 (실측 `확인필요` 3 · `확인불가` 2 ·
 * 헤더 오염 `바코드` 1). **정확히 일치**할 때만 해당한다.
 * ⛔ 대소문자·유사 표현·띄어쓰기 변형을 임의로 늘리지 않는다.
 */
export const BARCODE_UNVERIFIED_SENTINELS = [
  '확인필요',
  '확인불가',
  '확인 필요',
  '바코드',
] as const;

/**
 * 엑셀이 바코드를 숫자로 읽어 지수표기로 바뀐 흔적.
 * ⛔ `E-12`·`1e12` 까지 넓히지 않는다 — 원문 정규식 그대로다.
 */
const SCIENTIFIC_NOTATION_PATTERN = /E\+\d+/i;

/** 제거 대상: 모든 공백류(`\s`)와 ASCII 하이픈. 유니코드 대시(`—`)는 제거하지 않는다. */
const CLEANUP_PATTERN = /[\s-]/g;

/** ASCII 숫자 전용. 전각 숫자·부호·소수점은 해당하지 않는다. */
const DIGITS_ONLY_PATTERN = /^\d+$/;

function isEmptySentinel(value: string): boolean {
  return (BARCODE_EMPTY_SENTINELS as readonly string[]).includes(value);
}

function isUnverifiedSentinel(value: string): boolean {
  return (BARCODE_UNVERIFIED_SENTINELS as readonly string[]).includes(value);
}

/**
 * 원시 셀 값을 정규화하고 분류한다.
 *
 * - `null` / `undefined` → `EMPTY`.
 *   ⚠️ 문자열 `'null'`·`'undefined'` 는 EMPTY 가 **아니다** — 숫자가 아니므로
 *   `BARCODE_INVALID_FORMAT` 으로 분류된다.
 * - `number` → 즉시 `BARCODE_READ_AS_NUMBER`. 문자열로 되돌리지 않는다.
 *   유효자릿수가 이미 손실됐을 수 있어 **복원 시도 자체가 금지**다 (§00 L-07).
 *   `NaN`·`Infinity` 도 number 이므로 같은 오류다.
 * - 그 외에는 `String(raw).trim()` 후 sentinel → 지수표기 → 확인필요 →
 *   공백·하이픈 제거 → 숫자 전용 검증 순으로 판정한다.
 *
 * 앞자리 0 은 언제나 보존된다 — 결과는 항상 문자열이며 Number/BigInt/Decimal
 * 변환이 어디에도 없다.
 */
export function normalizeBarcode(raw: unknown): BarcodeNormalizationResult {
  // `== null` 은 null 과 undefined 를 함께 잡는다 (원문 §12.5 ①).
  if (raw === null || raw === undefined) return { kind: 'EMPTY' };

  // ① 셀을 문자열로 강제 읽었는지 검증 — 숫자면 파서 버그다.
  if (typeof raw === 'number') return { kind: 'ERROR', code: 'BARCODE_READ_AS_NUMBER' };

  // ② sentinel·형식 판정을 위한 첫 단계 trim. 최종 정규화는 아래 cleaned 다.
  const s = String(raw).trim();

  if (isEmptySentinel(s)) return { kind: 'EMPTY' };

  if (SCIENTIFIC_NOTATION_PATTERN.test(s)) {
    return { kind: 'ERROR', code: 'BARCODE_SCIENTIFIC_NOTATION' };
  }

  if (isUnverifiedSentinel(s)) return { kind: 'ISSUE', code: 'BARCODE_UNVERIFIED', raw: s };

  // ③ 공백·하이픈 제거 (PRD §12.3). 앞자리 0 은 보존된다.
  const cleaned = s.replace(CLEANUP_PATTERN, '');

  if (!DIGITS_ONLY_PATTERN.test(cleaned)) {
    // ⚠️ raw 에는 cleaned 가 아니라 trim 직후 원문을 담는다.
    return { kind: 'ISSUE', code: 'BARCODE_INVALID_FORMAT', raw: s };
  }

  return { kind: 'OK', barcode: cleaned };
}
