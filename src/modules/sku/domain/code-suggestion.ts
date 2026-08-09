import { ConflictError, ERROR_CODES } from '@/shared/errors';

/**
 * SKU 코드 추천 규칙 — `STANDARD_PRODUCT_V1` (T03-7). 순수 함수만.
 *
 * ⚠️ 원 PRD(§11.1·§11.5) 유실로 `docs/09_설계복구_SKU코드추천.md` (2026-08-09
 *    Design Recovery Decision)가 규칙의 유일한 근거다. 여기서 임의로 바꾸지 않는다.
 *
 * ## 형식
 *
 *     {BRAND.code}-{MAJOR_CATEGORY.code}-{MINOR_CATEGORY.code}-{NNN}
 *     예: FB-OY-CW-001
 *
 * ⛔ 레거시 체계(부자재 `완제품코드-부자재분류-일련번호`, 공용부자재
 *    `브랜드-CM-일련번호`, 보관처 분기 등)는 **자동 생성 대상이 아니다.**
 *    해당 SKU 는 사용자가 skuCode 를 직접 입력한다.
 * ⛔ `additionalCode`(-EU·-GL·-BK …)를 자동으로 붙이지 않는다 — 결과는 항상
 *    4세그먼트다.
 */

export const SKU_CODE_POLICY = 'STANDARD_PRODUCT_V1';

export const SKU_SERIAL_MIN = 1;
export const SKU_SERIAL_MAX = 999;
export const SKU_SERIAL_DIGITS = 3;

/** 정확히 3자리 ASCII 숫자. `A01`·`01`·`0001` 은 해당하지 않는다. */
const SERIAL_PATTERN = /^[0-9]{3}$/;

/**
 * 분류 3종의 코드로 prefix 를 만든다.
 *
 * ⛔ 대소문자 변환·trim·alias 치환을 하지 않는다 — `CommonCode.code` 를
 *    저장된 그대로 쓴다 (채널이 대분류에 섞인 문제도 여기서 재설계하지 않는다).
 */
export function buildSkuCodePrefix(input: {
  brandCode: string;
  majorCode: string;
  minorCode: string;
}): string {
  return `${input.brandCode}-${input.majorCode}-${input.minorCode}`;
}

/** `1` → `'001'`. zero-padding 3자리. */
export function formatSkuSerial(serial: number): string {
  return String(serial).padStart(SKU_SERIAL_DIGITS, '0');
}

/**
 * prefix 를 공유하는 기존 코드에서 **사용된 serial** 을 뽑는다.
 *
 * 규칙 (09 문서 §5):
 *   - `{prefix}-` 로 시작해야 한다.
 *   - 그 직후 세그먼트가 **정확히 3자리 숫자**면 사용된 serial 이다.
 *   - 뒤에 세그먼트가 더 있어도 사용으로 본다 — `FB-OY-CW-001-EU` → 001.
 *   - `A01`·`01`·`0001` 은 계산 대상이 아니다 (억지 정규화 금지).
 *   - `000` 은 유효 범위(001~999) 밖이므로 제외한다.
 *
 * ⚠️ regex 에 `CommonCode.code` 를 삽입하지 않는다 — prefix 는 문자열 비교로,
 *    serial 만 고정 패턴으로 판정한다 (escape 문제 회피).
 */
export function usedSkuSerials(prefix: string, skuCodes: readonly string[]): ReadonlySet<number> {
  const marker = `${prefix}-`;
  const used = new Set<number>();

  for (const skuCode of skuCodes) {
    if (!skuCode.startsWith(marker)) continue;
    const rest = skuCode.slice(marker.length);
    const firstSegment = rest.split('-', 1)[0] ?? '';
    if (!SERIAL_PATTERN.test(firstSegment)) continue;
    const serial = Number(firstSegment);
    if (serial < SKU_SERIAL_MIN || serial > SKU_SERIAL_MAX) continue;
    used.add(serial);
  }

  return used;
}

/**
 * 다음 serial — **MAX + 1**. gap 을 재사용하지 않는다.
 *
 * `001,002,004` → `005` (`003` 아님). 삭제·과거사용·레거시 이력을 번호 재사용으로
 * 혼동시키지 않기 위함이며, `skuCode` 전역 UNIQUE 정책과도 일치한다.
 *
 * @returns 사용 이력이 없으면 `1`. 상한(999)을 넘으면 `null`.
 */
export function nextSkuSerial(used: ReadonlySet<number>): number | null {
  const max = used.size === 0 ? 0 : Math.max(...used);
  const next = max + 1;
  return next > SKU_SERIAL_MAX ? null : next;
}

/** 일련번호 소진 — 4자리 확장·다른 분류 대체를 하지 않고 409 로 알린다. */
export function skuSerialExhausted(prefix: string): ConflictError {
  return new ConflictError(ERROR_CODES.SKU_CODE_SEQUENCE_EXHAUSTED, {
    message: `'${prefix}' 조합의 일련번호(001~${SKU_SERIAL_MAX})가 모두 사용되었습니다.`,
    publicDetails: { prefix, maxSerial: SKU_SERIAL_MAX, policy: SKU_CODE_POLICY },
    publicHint: '코드 정책 검토가 필요합니다. 자동으로 자릿수를 늘리지 않습니다.',
    retryable: false,
  });
}
