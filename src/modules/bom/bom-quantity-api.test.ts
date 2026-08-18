import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import { bomLineBulkConfirmRouteScope, parseBulkConfirmQtyInput } from '@/modules/bom/application';
import { assertQuantityConsistency } from '@/modules/bom/domain';
import { ERROR_CODES, httpStatusForCode, ValidationError } from '@/shared/errors';

/**
 * BOM 소요량 일괄 확정 단위 테스트 (T07-4) — DB 없이 고정하는 계약.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-10 · §D-15 · §D-17 · §D-29 +
 *    **"T07-4 bulk-confirm gap closure"**(B1~B4).
 *
 * §D-32 test matrix 가 T07-4 unit 에 요구한 것:
 *   - 정합 3종 (`UNKNOWN`/`SUGGESTED`/`CONFIRMED` × `quantityPer`)
 *   - **자동 1 금지** (TC-BOM-010)
 *   - **0 / 음수** (TC-BOM-002)
 *
 * 여기에 gap closure 4종(빈 배열 · 중복 · 응답 · no-op)을 더해 고정한다.
 */

const LINE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const LINE_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const BOM = 'cccccccc-3333-4333-8333-333333333333';

function item(lineId: string, quantityPer: string): unknown {
  return { lineId, quantityPer };
}

// ═══════════════════════════════════════════════════════════════
// B1 — 빈 배열은 400 (gap closure)
// ═══════════════════════════════════════════════════════════════

describe('★★ B1 — 빈 대상 배열은 400 이다', () => {
  it('★ `[]` 은 400 — ⛔ 조용한 200 no-op 이 아니다', () => {
    expect(() => parseBulkConfirmQtyInput([])).toThrow(ValidationError);
  });

  it('1건이면 통과한다 — 경계는 정확히 1이다', () => {
    expect(parseBulkConfirmQtyInput([item(LINE_A, '2.5')])).toHaveLength(1);
  });

  it('배열이 아닌 body 는 400', () => {
    for (const body of [{}, null, 'x', 42, { items: [] }]) {
      expect(() => parseBulkConfirmQtyInput(body)).toThrow(ValidationError);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// B2 — lineId 중복은 400 (gap closure)
// ═══════════════════════════════════════════════════════════════

describe('★★ B2 — 같은 요청 안의 lineId 중복은 400 이다', () => {
  it('★ 수량이 **같아도** 거부한다', () => {
    expect(() => parseBulkConfirmQtyInput([item(LINE_A, '2'), item(LINE_A, '2')])).toThrow(
      ValidationError,
    );
  });

  it('★ 수량이 **달라도** 거부한다', () => {
    expect(() => parseBulkConfirmQtyInput([item(LINE_A, '2'), item(LINE_A, '3')])).toThrow(
      ValidationError,
    );
  });

  it('★ silent dedupe / first-wins / last-wins 를 하지 않는다', () => {
    // 통과했다면 길이가 1로 줄어 있을 것이다 — 그런 경로가 없어야 한다.
    let parsed: unknown;
    try {
      parsed = parseBulkConfirmQtyInput([item(LINE_A, '2'), item(LINE_A, '3')]);
    } catch {
      parsed = undefined;
    }
    expect(parsed).toBeUndefined();
  });

  it('오류가 중복된 원소의 경로를 가리킨다', () => {
    try {
      parseBulkConfirmQtyInput([item(LINE_A, '2'), item(LINE_A, '3')]);
      expect.unreachable('중복은 400 이어야 한다');
    } catch (error) {
      const fields = (error as ValidationError).fieldErrors;
      expect(fields.some((field) => field.path.includes('lineId'))).toBe(true);
    }
  });

  it('서로 다른 lineId 는 그대로 통과하며 순서가 보존된다', () => {
    const parsed = parseBulkConfirmQtyInput([item(LINE_B, '1'), item(LINE_A, '2')]);
    expect(parsed.map((entry) => entry.lineId)).toEqual([LINE_B, LINE_A]);
  });
});

// ═══════════════════════════════════════════════════════════════
// DTO strict — D-14 공통 규칙
// ═══════════════════════════════════════════════════════════════

describe('BulkConfirmQtyDto strict (D-14 공통 규칙)', () => {
  it('★ 원소의 unknown key 는 400', () => {
    expect(() =>
      parseBulkConfirmQtyInput([{ lineId: LINE_A, quantityPer: '2', quantityStatus: 'CONFIRMED' }]),
    ).toThrow(ValidationError);
  });

  it('★ generic line PATCH 필드를 섞을 수 없다 — 이 endpoint 는 수량 전용이다', () => {
    for (const extra of [
      'componentSkuId',
      'alternateGroup',
      'componentRole',
      'supplyType',
      'isRequired',
      'uom',
      'lineNo',
      'issueWarehouseId',
      'packQuantity',
    ]) {
      expect(() =>
        parseBulkConfirmQtyInput([{ lineId: LINE_A, quantityPer: '2', [extra]: 'x' }]),
      ).toThrow(ValidationError);
    }
  });

  it('lineId 는 UUID 여야 한다', () => {
    expect(() => parseBulkConfirmQtyInput([item('not-a-uuid', '2')])).toThrow(ValidationError);
  });

  it('lineId 누락은 400', () => {
    expect(() => parseBulkConfirmQtyInput([{ quantityPer: '2' }])).toThrow(ValidationError);
  });

  it('★ quantityPer 누락은 400 — 확정은 값을 요구한다', () => {
    expect(() => parseBulkConfirmQtyInput([{ lineId: LINE_A }])).toThrow(ValidationError);
  });

  it('★ quantityPer = null 을 받지 않는다 — UNKNOWN 으로 되돌리는 경로가 없다', () => {
    expect(() => parseBulkConfirmQtyInput([{ lineId: LINE_A, quantityPer: null }])).toThrow(
      ValidationError,
    );
  });

  it('★★ JSON number 는 400 — Decimal 은 문자열 계약이다', () => {
    expect(() => parseBulkConfirmQtyInput([{ lineId: LINE_A, quantityPer: 2 }])).toThrow(
      ValidationError,
    );
    expect(() => parseBulkConfirmQtyInput([{ lineId: LINE_A, quantityPer: 0.033333 }])).toThrow(
      ValidationError,
    );
  });

  it('★ 지수표기·부호·천단위 구분자는 400', () => {
    for (const bad of ['1e3', '1E3', '+2', '-2', '1,000', ' 2 ', '', '2.', '.5', 'NaN']) {
      expect(() => parseBulkConfirmQtyInput([item(LINE_A, bad)]), bad).toThrow(ValidationError);
    }
  });

  it('★ 소수 7자리 이상은 400 — Decimal(18,6) 이다', () => {
    expect(() => parseBulkConfirmQtyInput([item(LINE_A, '0.0333333')])).toThrow(ValidationError);
    expect(parseBulkConfirmQtyInput([item(LINE_A, '0.033333')])[0]?.quantityPer).toBe('0.033333');
  });

  it('★★ Decimal 문자열이 그대로 보존된다 — 반올림·정규화 없음', () => {
    expect(parseBulkConfirmQtyInput([item(LINE_A, '2.500000')])[0]?.quantityPer).toBe('2.500000');
    expect(parseBulkConfirmQtyInput([item(LINE_A, '0.033333')])[0]?.quantityPer).toBe('0.033333');
  });

  it('★★ `0` 과 음수는 DTO 를 통과해 도메인이 422 로 판정한다 (400/422 경계)', () => {
    // 형식은 맞으므로 DTO 는 통과시킨다 — 값 판정은 업무 규칙이다.
    expect(parseBulkConfirmQtyInput([item(LINE_A, '0')])[0]?.quantityPer).toBe('0');
    // 음수는 형식 자체가 아니라 400 이다.
    expect(() => parseBulkConfirmQtyInput([item(LINE_A, '-1')])).toThrow(ValidationError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 정합 3종 + TC-BOM-002 · TC-BOM-010 (D-10 · §D-32 test matrix)
// ═══════════════════════════════════════════════════════════════

describe('★ 최종 상태 정합 — 확정 결과는 언제나 CONFIRMED (D-10)', () => {
  it('CONFIRMED + 양수 → 통과', () => {
    expect(() =>
      assertQuantityConsistency({ quantityPer: '2.5', quantityStatus: 'CONFIRMED' }),
    ).not.toThrow();
  });

  it('★★ TC-BOM-002 — CONFIRMED + `0` 은 422 `BOM_QTY_INVALID`', () => {
    expect(() =>
      assertQuantityConsistency({ quantityPer: '0', quantityStatus: 'CONFIRMED' }),
    ).toThrowError(expect.objectContaining({ code: ERROR_CODES.BOM_QTY_INVALID }));
    expect(() =>
      assertQuantityConsistency({ quantityPer: '0.000000', quantityStatus: 'CONFIRMED' }),
    ).toThrowError(expect.objectContaining({ code: ERROR_CODES.BOM_QTY_INVALID }));
  });

  it('★ CONFIRMED + null 은 422 `BOM_QTY_STATUS_MISMATCH`', () => {
    expect(() =>
      assertQuantityConsistency({ quantityPer: null, quantityStatus: 'CONFIRMED' }),
    ).toThrowError(expect.objectContaining({ code: ERROR_CODES.BOM_QTY_STATUS_MISMATCH }));
  });

  it('세 상태의 정합 규칙이 그대로다 (UNKNOWN=null · SUGGESTED/CONFIRMED>0)', () => {
    expect(() =>
      assertQuantityConsistency({ quantityPer: null, quantityStatus: 'UNKNOWN' }),
    ).not.toThrow();
    expect(() =>
      assertQuantityConsistency({ quantityPer: '1', quantityStatus: 'UNKNOWN' }),
    ).toThrow();
    expect(() =>
      assertQuantityConsistency({ quantityPer: '1', quantityStatus: 'SUGGESTED' }),
    ).not.toThrow();
  });

  it('★★ TC-BOM-010 — 자동 `"1"` 을 만들 여지가 없다', () => {
    // DTO 는 quantityPer 를 **필수**로 받는다. 생략하면 기본값을 채우는 대신
    // 400 이므로, 서버가 `"1"` 을 발명할 경로 자체가 없다.
    expect(() => parseBulkConfirmQtyInput([{ lineId: LINE_A }])).toThrow(ValidationError);
    const parsed = parseBulkConfirmQtyInput([item(LINE_A, '7')]);
    expect(parsed[0]?.quantityPer).toBe('7');
  });
});

// ═══════════════════════════════════════════════════════════════
// D-17 멱등 scope · D-29 오류코드 · D-15 route-policy
// ═══════════════════════════════════════════════════════════════

describe('★ 멱등 routeScope 는 D-17 표 그대로다', () => {
  it('`bom:{bomId}:line:bulk-confirm`', () => {
    expect(bomLineBulkConfirmRouteScope(BOM)).toBe(`bom:${BOM}:line:bulk-confirm`);
  });

  it('★ scope 에 실제 bomId 가 들어간다 — BOM 마다 독립이다', () => {
    expect(bomLineBulkConfirmRouteScope(BOM)).not.toBe(bomLineBulkConfirmRouteScope(LINE_A));
  });

  it('line create scope 와 겹치지 않는다', () => {
    expect(bomLineBulkConfirmRouteScope(BOM)).not.toContain(':line:create');
  });
});

describe('T07-4 가 재사용하는 오류코드의 HTTP 상태 (D-29)', () => {
  it('신규 코드를 만들지 않고 기존 코드만 쓴다', () => {
    expect(httpStatusForCode(ERROR_CODES.BOM_QTY_INVALID)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.BOM_QTY_STATUS_MISMATCH)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.BOM_NOT_EDITABLE)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.BOM_ACTIVE_IMMUTABLE)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.BOM_NOT_FOUND)).toBe(404);
  });

  it('★ bulk 전용 오류코드를 발명하지 않았다', () => {
    const codes = Object.keys(ERROR_CODES).filter((code) => code.startsWith('BOM_'));
    for (const invented of ['BOM_BULK', 'BOM_QTY_BULK', 'BOM_CONFIRM']) {
      expect(
        codes.some((code) => code.startsWith(invented)),
        invented,
      ).toBe(false);
    }
  });
});

describe('★★ route-policy — bulk-confirm 은 bom.update 이며 bom.create 에 shadow 되지 않는다', () => {
  const PATH = `/api/boms/${BOM}/lines/bulk-confirm-qty`;

  it('★ POST → `bom.update` (D-15 `contains:/lines`)', () => {
    expect(resolveRoutePermission({ pathname: PATH, method: 'POST' })).toBe('bom.update');
  });

  it('★★ 일반 `POST /api/boms`(bom.create)에 잡히지 않는다', () => {
    expect(resolveRoutePermission({ pathname: PATH, method: 'POST' })).not.toBe('bom.create');
    // 일반 규칙 자체는 그대로 살아 있다 — first-match 순서만 다르다.
    expect(resolveRoutePermission({ pathname: '/api/boms', method: 'POST' })).toBe('bom.create');
  });

  it('기존 line route 정책이 회귀하지 않았다', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/lines`, method: 'POST' })).toBe(
      'bom.update',
    );
    expect(
      resolveRoutePermission({ pathname: `/api/boms/${BOM}/lines/${LINE_A}`, method: 'PATCH' }),
    ).toBe('bom.update');
    expect(
      resolveRoutePermission({ pathname: `/api/boms/${BOM}/lines/${LINE_A}`, method: 'DELETE' }),
    ).toBe('bom.update');
  });

  it('T07-5 workflow 예약 정책이 회귀하지 않았다', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/submit`, method: 'POST' })).toBe(
      'bom.submit',
    );
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/approve`, method: 'POST' })).toBe(
      'bom.approve',
    );
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}/clone`, method: 'POST' })).toBe(
      'bom.create',
    );
  });

  it('★ GET 은 여전히 bom.read 다 — 이 Task 가 읽기 정책을 건드리지 않았다', () => {
    expect(resolveRoutePermission({ pathname: `/api/boms/${BOM}`, method: 'GET' })).toBe(
      'bom.read',
    );
    expect(resolveRoutePermission({ pathname: PATH, method: 'GET' })).toBe('bom.read');
  });
});
