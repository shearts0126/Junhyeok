import { normalizeBarcode } from '@/modules/sku/domain';
import { DomainError, ERROR_CODES, SystemError, ValidationError } from '@/shared/errors';

import { EXTERNAL_BARCODE_MAX_LENGTH } from './dto';

/**
 * 외부 식별자 정규화 (T05-2).
 *
 * ⚠️ 근거: `docs/13_설계복구_외부상품매핑CRUD.md` §6·§7.
 *
 * ## 문자열 canonicalization — API 계약과 DB storage 계약의 분리
 *
 * T05-1 은 `external_product_code` 에 **NULL 과 `''` 를 모두** 저장할 수 있게
 * 두었다(둘 다 `ux_external_mapping_code` predicate 밖). 그것은
 * **migration/raw storage 계약**이다. interactive API 는 그보다 좁게 —
 * blank 를 `null` 로 canonicalize 해 "값 없음"의 표현을 하나로 고정한다.
 *
 *   `'  P001  '` → `'P001'`   `'00123'` → `'00123'`   `'   '` → `null`   `''` → `null`
 *
 * ⛔ 대소문자 접기·내부 공백 제거·앞자리 0 제거를 하지 않는다 — 외부 원문이다.
 */

/** trim 후 비어 있으면 `null`. 내부 문자는 그대로 둔다. */
export function normalizeExternalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 외부 바코드 정규화 — **T04-2 `normalizeBarcode` 를 그대로 재사용**한다 (§7).
 *
 * ⚠️ 이것은 바코드 **문자열 정규화만** 공유한다는 뜻이다.
 * ⛔ `SkuBarcode` 행을 만들지 않는다. ⛔ 활성 중복 검사·대표 바코드·
 *    `duplicateException` 같은 `SkuBarcode` 업무규칙을 가져오지 않는다 (§7).
 * ⛔ `externalBarcode` 의 UNIQUE 제약을 새로 만들지 않는다 — T05-1 에 없다.
 *    동일 외부 바코드가 여러 매핑에 걸릴 때의 ambiguity 는 T05-3 에서 정한다.
 *
 * | T04-2 결과                          | API 결과                            |
 * |------------------------------------|-------------------------------------|
 * | `EMPTY` (`''`·`-`·`—`·공백만)       | `null` — 저장 없음, 오류 아님          |
 * | `OK`                               | 정규화된 문자열                        |
 * | `ERROR/BARCODE_SCIENTIFIC_NOTATION`| 422 `BARCODE_SCIENTIFIC_NOTATION`   |
 * | `ISSUE/BARCODE_UNVERIFIED`         | 422 `BARCODE_UNVERIFIED`            |
 * | `ISSUE/BARCODE_INVALID_FORMAT`     | 422 `BARCODE_INVALID_FORMAT`        |
 */
export function normalizeExternalBarcode(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;

  const classified = classifyExternalBarcode(value);
  switch (classified.kind) {
    case 'ABSENT':
      return null;
    case 'VALUE':
      return classified.barcode;
    case 'INVALID':
      throw classified.toError();
  }
}

/**
 * ★ 위 canonicalization 의 **비throw 형태** (T05-3 에서 추가).
 *
 * 정규화 규칙 자체는 하나다 — 이 함수가 유일한 판정이고
 * `normalizeExternalBarcode` 는 여기에 "INVALID 면 던진다"만 얹은 얇은 wrapper 다.
 * T05-2 의 동작(422·400)은 그대로다.
 *
 * 외부 데이터 수집 경로(T05-3 resolver)는 잘못된 바코드 하나 때문에 행 전체
 * 해석을 중단하면 안 되므로, 오류를 던지지 않고 "조회 불가"로 분류만 한다.
 */
export type ExternalBarcodeClassification =
  /** 값이 없다 — `null`·EMPTY 표시값(`''`·`-`·`—`·공백). 오류가 아니다. */
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'VALUE'; readonly barcode: string }
  /** 정규화로 유효한 바코드를 만들 수 없다. `toError()` 는 T05-2 가 던지던 그 오류다. */
  | { readonly kind: 'INVALID'; readonly toError: () => Error };

export function classifyExternalBarcode(value: string | null): ExternalBarcodeClassification {
  if (value === null) return { kind: 'ABSENT' };

  const result = normalizeBarcode(value);

  switch (result.kind) {
    case 'EMPTY':
      return { kind: 'ABSENT' };

    case 'ERROR':
      if (result.code === 'BARCODE_SCIENTIFIC_NOTATION') {
        return {
          kind: 'INVALID',
          toError: () => rejected(ERROR_CODES.BARCODE_SCIENTIFIC_NOTATION, value),
        };
      }
      // `BARCODE_READ_AS_NUMBER` — DTO 가 string 을 강제하므로 도달 불가.
      return {
        kind: 'INVALID',
        toError: () =>
          new SystemError({
            message: '문자열 입력에서 숫자 타입 분류가 나왔습니다 (DTO 계약 위반).',
            context: { code: result.code },
          }),
      };

    case 'ISSUE': {
      const code =
        result.code === 'BARCODE_UNVERIFIED'
          ? ERROR_CODES.BARCODE_UNVERIFIED
          : ERROR_CODES.BARCODE_INVALID_FORMAT;
      return { kind: 'INVALID', toError: () => rejected(code, result.raw) };
    }

    case 'OK':
      if (result.barcode.length > EXTERNAL_BARCODE_MAX_LENGTH) {
        return {
          kind: 'INVALID',
          toError: () =>
            new ValidationError(
              [
                {
                  path: 'externalBarcode',
                  message: `${EXTERNAL_BARCODE_MAX_LENGTH}자 이하여야 합니다.`,
                },
              ],
              { message: '외부 매핑 요청이 올바르지 않습니다.' },
            ),
        };
      }
      return { kind: 'VALUE', barcode: result.barcode };
  }
}

function rejected(code: string, raw: string): DomainError {
  return new DomainError(code, {
    // ⚠️ 원문 값은 서버 로그에만 남긴다.
    context: { raw },
    publicDetails: { field: 'externalBarcode' },
  });
}

/** 정규화된 식별자 3종 — `undefined` 는 "이 요청이 건드리지 않음"이다. */
export interface NormalizedIdentifiers {
  readonly externalProductCode: string | null | undefined;
  readonly externalProductName: string | null | undefined;
  readonly externalBarcode: string | null | undefined;
}

export function normalizeIdentifiers(input: {
  readonly externalProductCode?: string | null | undefined;
  readonly externalProductName?: string | null | undefined;
  readonly externalBarcode?: string | null | undefined;
}): NormalizedIdentifiers {
  return {
    externalProductCode: normalizeExternalText(input.externalProductCode),
    externalProductName: normalizeExternalText(input.externalProductName),
    externalBarcode: normalizeExternalBarcode(input.externalBarcode),
  };
}
