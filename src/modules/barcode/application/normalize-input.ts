import { normalizeBarcode } from '@/modules/sku/domain';
import { DomainError, ERROR_CODES, SystemError, ValidationError } from '@/shared/errors';

/**
 * T04-2 정규화 도메인 → T04-3 API 계약 연결 (T04-3).
 *
 * ⚠️ 근거: `docs/10_설계복구_BarcodeCRUD.md` §11·§12·§14·§15.
 *
 * | T04-2 결과                        | API 결과                              |
 * |----------------------------------|---------------------------------------|
 * | `EMPTY` (`''`·`-`·`—`·공백만)     | **204 No Content** — 저장 없음, 오류 아님 |
 * | `OK`                             | 정규화된 문자열로 진행                    |
 * | `ERROR/BARCODE_SCIENTIFIC_NOTATION` | 422 `BARCODE_SCIENTIFIC_NOTATION`   |
 * | `ISSUE/BARCODE_UNVERIFIED`       | 422 `BARCODE_UNVERIFIED`              |
 * | `ISSUE/BARCODE_INVALID_FORMAT`   | 422 `BARCODE_INVALID_FORMAT`          |
 *
 * ⛔ **DataIssue 를 만들지 않는다.** 인터랙티브 CRUD 의 잘못된 값은 HTTP 오류로
 *    끝난다 (docs/10 §1). import·migration 경로의 DataIssue 요구는 그대로 살아 있다.
 * ⛔ `BARCODE_READ_AS_NUMBER` 는 여기서 발생할 수 없다 — Zod 가 문자열을
 *    강제하므로 숫자 JSON 은 도메인에 도달하기 전에 400 이다.
 */

/**
 * DB 물리 용량 (`sku_barcode.barcode VARCHAR(100)`, T04-1).
 *
 * ⚠️ 이것은 **업무 길이 규칙이 아니다.** EAN-13 강제·8/12/13/14자리 허용·
 *    체크디지트 검증은 여전히 만들지 않는다 (T04-2 결정 유지). DB 가 22001 로
 *    거부하기 전에 API 가 필드 오류로 안전하게 알려줄 뿐이다.
 */
export const BARCODE_MAX_LENGTH = 100;

/** `EMPTY` 는 오류가 아니라 "저장할 것이 없음"이다. */
export type BarcodeInputResolution =
  { readonly kind: 'EMPTY' } | { readonly kind: 'OK'; readonly barcode: string };

function normalizationRejected(code: string, raw: string): DomainError {
  return new DomainError(code, {
    // ⚠️ 원문 값은 서버 로그에만 남긴다.
    context: { raw },
    publicDetails: { field: 'barcode' },
  });
}

/**
 * 검증된 DTO 문자열을 저장 가능한 바코드로 해석한다.
 *
 * @throws {DomainError} 422 — 지수표기·확인필요·형식 오류
 * @throws {ValidationError} 400 — 정규화 결과가 DB 물리 용량을 넘음
 */
export function resolveBarcodeInput(raw: string): BarcodeInputResolution {
  const result = normalizeBarcode(raw);

  switch (result.kind) {
    case 'EMPTY':
      return { kind: 'EMPTY' };

    case 'ERROR':
      if (result.code === 'BARCODE_SCIENTIFIC_NOTATION') {
        throw normalizationRejected(ERROR_CODES.BARCODE_SCIENTIFIC_NOTATION, raw);
      }
      // `BARCODE_READ_AS_NUMBER` — DTO 가 string 을 강제하므로 도달 불가.
      throw new SystemError({
        message: '문자열 입력에서 숫자 타입 분류가 나왔습니다 (DTO 계약 위반).',
        context: { code: result.code },
      });

    case 'ISSUE':
      throw normalizationRejected(
        result.code === 'BARCODE_UNVERIFIED'
          ? ERROR_CODES.BARCODE_UNVERIFIED
          : ERROR_CODES.BARCODE_INVALID_FORMAT,
        result.raw,
      );

    case 'OK':
      if (result.barcode.length > BARCODE_MAX_LENGTH) {
        throw new ValidationError(
          [{ path: 'barcode', message: `${BARCODE_MAX_LENGTH}자 이하여야 합니다.` }],
          { message: '바코드 등록 요청이 올바르지 않습니다.' },
        );
      }
      return { kind: 'OK', barcode: result.barcode };
  }
}
