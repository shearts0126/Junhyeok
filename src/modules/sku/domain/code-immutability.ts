import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * SKU 코드 불변식 (T1-2, TC-SKU-007) — **순수 도메인 규칙.**
 *
 * 확정 규칙:
 *   - `hasTransaction = false` → 코드 변경 가능
 *   - `hasTransaction = true`  → 기존 코드와 **다른** 코드로 변경 불가
 *
 * ## 이 규칙이 하지 않는 것
 *
 *   - **중복 검사** — `sku_code` 전역 UNIQUE 는 DB(T1-1)의 책임이다.
 *     도메인에서 DB 를 조회해 uniqueness 를 재구현하지 않는다.
 *   - **정규화** — 대소문자·공백을 임의로 접어서 "같은 코드"로 간주하지 않는다.
 *     `' ABC '` 와 `'ABC'`, `'abc'` 와 `'ABC'` 는 여기서 서로 **다른 코드**다.
 *     canonical 형식(빈 값·앞뒤 공백 금지)은 DB CHECK 와 입력 validation 의
 *     책임이며 이 규칙이 침범하지 않는다.
 *   - **hasTransaction 값 변경** — 이 값은 입력 사실이다. 실제 거래 생성 시
 *     false→true 로 바꾸는 것은 향후 Inventory Posting 의 몫이고,
 *     true→false 로 되돌리는 도메인 경로는 존재하지 않는다.
 */

export interface SkuCodeChangeInput {
  /** 이 SKU 로 거래가 발생했는가 — 호출자가 판정해 전달하는 사실 */
  readonly hasTransaction: boolean;
  readonly currentSkuCode: string;
  readonly nextSkuCode: string;
}

/** 코드 변경이 허용되는가. 동일 코드는 "변경"이 아니므로 항상 허용이다. */
export function canChangeSkuCode(input: SkuCodeChangeInput): boolean {
  if (input.currentSkuCode === input.nextSkuCode) return true;
  return !input.hasTransaction;
}

/**
 * 거래 발생 후 코드 변경을 차단한다.
 *
 * @throws {DomainError} `SKU_CODE_IMMUTABLE` / HTTP 422
 */
export function assertSkuCodeChangeAllowed(input: SkuCodeChangeInput): void {
  if (canChangeSkuCode(input)) return;

  throw new DomainError(ERROR_CODES.SKU_CODE_IMMUTABLE, {
    message: `거래가 발생한 SKU 의 코드는 변경할 수 없습니다. ('${input.currentSkuCode}' → '${input.nextSkuCode}')`,
    // ⚠️ 코드 값은 화면에 이미 보이는 마스터 식별자다 — 공개 가능.
    publicDetails: { currentSkuCode: input.currentSkuCode },
    publicHint: '거래 이력이 있는 SKU 는 새 SKU 를 등록해 대체하세요.',
  });
}
