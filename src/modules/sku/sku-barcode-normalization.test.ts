import { describe, expect, it } from 'vitest';

import {
  BARCODE_EMPTY_SENTINELS,
  BARCODE_ERROR_CODES,
  BARCODE_ISSUE_CODES,
  BARCODE_UNVERIFIED_SENTINELS,
  normalizeBarcode,
  type BarcodeNormalizationResult,
} from './domain';

/**
 * 바코드 정규화 단위 테스트 (T04-2) — ★ TC-SKU-002 / TC-SKU-003 분류 부분.
 *
 * 근거는 `docs/06_데이터_마이그레이션설계.md` §12.5 원문뿐이다.
 *
 * ⛔ 여기에는 DB·Prisma·권한·AuditLog·DataIssue·API 가 하나도 없다.
 *    `normalizeBarcode` 는 순수 함수이므로 대역조차 필요하지 않다.
 */

describe('normalizeBarcode — 계약 형태', () => {
  it('결과는 kind 로 구분되는 discriminated union 이다', () => {
    const kinds = new Set(
      [
        normalizeBarcode('8809619961373'),
        normalizeBarcode(null),
        normalizeBarcode(1),
        normalizeBarcode('ABC'),
      ].map((result) => result.kind),
    );
    expect([...kinds].sort()).toEqual(['EMPTY', 'ERROR', 'ISSUE', 'OK']);
  });

  it('분류 코드 목록이 원문 4종에서 늘어나지 않았다', () => {
    expect(BARCODE_ERROR_CODES).toEqual(['BARCODE_READ_AS_NUMBER', 'BARCODE_SCIENTIFIC_NOTATION']);
    expect(BARCODE_ISSUE_CODES).toEqual(['BARCODE_UNVERIFIED', 'BARCODE_INVALID_FORMAT']);
  });

  it('sentinel 목록이 원문 그대로다 — 임의 확장 없음', () => {
    expect(BARCODE_EMPTY_SENTINELS).toEqual(['', '-', '—']);
    expect(BARCODE_UNVERIFIED_SENTINELS).toEqual(['확인필요', '확인불가', '확인 필요', '바코드']);
  });
});

describe('1. 정상 숫자 문자열', () => {
  it('정상 바코드는 그대로 OK 로 통과한다', () => {
    expect(normalizeBarcode('8809619961373')).toEqual({ kind: 'OK', barcode: '8809619961373' });
  });

  it('실측 중복 2건의 원본 값도 정상 처리된다', () => {
    // 01 §1.5 — 동일 바코드 다중 SKU 2건. 중복 판정은 이 함수의 일이 아니다.
    expect(normalizeBarcode('8809619960499')).toEqual({ kind: 'OK', barcode: '8809619960499' });
    expect(normalizeBarcode('8809619960987')).toEqual({ kind: 'OK', barcode: '8809619960987' });
  });
});

describe('2~7. EMPTY — null·undefined·공란·"-"·"—"', () => {
  it('2. null → EMPTY', () => {
    expect(normalizeBarcode(null)).toEqual({ kind: 'EMPTY' });
  });

  it('3. undefined → EMPTY (인자 미전달 포함)', () => {
    expect(normalizeBarcode(undefined)).toEqual({ kind: 'EMPTY' });
    expect(normalizeBarcode(void 0)).toEqual({ kind: 'EMPTY' });
  });

  it("4. '' → EMPTY", () => {
    expect(normalizeBarcode('')).toEqual({ kind: 'EMPTY' });
  });

  it('5. 공백만 있는 문자열 → EMPTY', () => {
    for (const blank of ['   ', '\t', '\n', ' \t\n ']) {
      expect(normalizeBarcode(blank), JSON.stringify(blank)).toEqual({ kind: 'EMPTY' });
    }
  });

  it("6. '-' → EMPTY — ⚠️ 실측 376건, DataIssue 대상이 아니다 (G-04)", () => {
    expect(normalizeBarcode('-')).toEqual({ kind: 'EMPTY' });
    expect(normalizeBarcode('  -  ')).toEqual({ kind: 'EMPTY' });
  });

  it("7. '—'(em dash) → EMPTY", () => {
    expect(normalizeBarcode('—')).toEqual({ kind: 'EMPTY' });
    expect(normalizeBarcode(' — ')).toEqual({ kind: 'EMPTY' });
  });

  it("★ 문자열 'null'·'undefined' 는 EMPTY 가 아니다", () => {
    // §4 — 값 null/undefined 와 문자열은 다르다. 숫자가 아니므로 형식 이슈다.
    expect(normalizeBarcode('null')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: 'null',
    });
    expect(normalizeBarcode('undefined')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: 'undefined',
    });
  });

  it('★ 다른 기호를 EMPTY sentinel 로 넓히지 않았다', () => {
    for (const notEmpty of ['_', 'N/A', '없음', 'NULL', '–', '.', '/']) {
      expect(normalizeBarcode(notEmpty).kind, notEmpty).not.toBe('EMPTY');
    }
  });
});

describe('8~11. UNVERIFIED sentinel', () => {
  it('8. 확인필요 → BARCODE_UNVERIFIED', () => {
    expect(normalizeBarcode('확인필요')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_UNVERIFIED',
      raw: '확인필요',
    });
  });

  it('9. 확인불가 → BARCODE_UNVERIFIED', () => {
    expect(normalizeBarcode('확인불가')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_UNVERIFIED',
      raw: '확인불가',
    });
  });

  it('10. "확인 필요"(공백 포함) → BARCODE_UNVERIFIED', () => {
    expect(normalizeBarcode('확인 필요')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_UNVERIFIED',
      raw: '확인 필요',
    });
  });

  it('11. "바코드"(헤더 오염) → BARCODE_UNVERIFIED', () => {
    expect(normalizeBarcode('바코드')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_UNVERIFIED',
      raw: '바코드',
    });
  });

  it('★ 유사 표현은 UNVERIFIED 가 아니다 — 임의 확장 없음', () => {
    for (const similar of ['확인', '확인요망', '확인  필요', '확인필요!', 'barcode']) {
      const result = normalizeBarcode(similar);
      expect(result.kind, similar).toBe('ISSUE');
      expect(result.kind === 'ISSUE' && result.code, similar).toBe('BARCODE_INVALID_FORMAT');
    }
  });
});

describe('12~13. 지수표기 → ERROR (복원 시도 금지)', () => {
  it('12. 1.23E+12 → BARCODE_SCIENTIFIC_NOTATION', () => {
    expect(normalizeBarcode('1.23E+12')).toEqual({
      kind: 'ERROR',
      code: 'BARCODE_SCIENTIFIC_NOTATION',
    });
  });

  it('13. 소문자 1.23e+12 도 동일', () => {
    expect(normalizeBarcode('1.23e+12')).toEqual({
      kind: 'ERROR',
      code: 'BARCODE_SCIENTIFIC_NOTATION',
    });
  });

  it('★ 원래 자릿수를 복원하지 않는다 — 결과에 숫자 값이 없다', () => {
    const result = normalizeBarcode('8.80962E+12');
    expect(result).toEqual({ kind: 'ERROR', code: 'BARCODE_SCIENTIFIC_NOTATION' });
    expect(result).not.toHaveProperty('barcode');
  });

  it('★ E-12 · 1e12 까지 지수표기로 넓히지 않았다 (원문 정규식 /E\\+\\d+/i 그대로)', () => {
    // 'E' 와 '-' 는 각각 숫자 아님/제거 대상이므로 형식 이슈로 떨어진다.
    expect(normalizeBarcode('1.23E-12')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: '1.23E-12',
    });
    expect(normalizeBarcode('1e12')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: '1e12',
    });
  });
});

describe('14~16. 숫자 타입 입력 → ERROR (파서 버그 탐지)', () => {
  it('14. number → BARCODE_READ_AS_NUMBER, 문자열 복원 없음', () => {
    const result = normalizeBarcode(8809619961373);
    expect(result).toEqual({ kind: 'ERROR', code: 'BARCODE_READ_AS_NUMBER' });
    // ★ "8809619961373" 으로 되살리지 않는다 — 유효자릿수 손실은 복구 불가다.
    expect(result).not.toHaveProperty('barcode');
  });

  it('15. NaN → BARCODE_READ_AS_NUMBER', () => {
    expect(normalizeBarcode(Number.NaN)).toEqual({
      kind: 'ERROR',
      code: 'BARCODE_READ_AS_NUMBER',
    });
  });

  it('16. Infinity / -Infinity → BARCODE_READ_AS_NUMBER', () => {
    expect(normalizeBarcode(Number.POSITIVE_INFINITY)).toEqual({
      kind: 'ERROR',
      code: 'BARCODE_READ_AS_NUMBER',
    });
    expect(normalizeBarcode(Number.NEGATIVE_INFINITY)).toEqual({
      kind: 'ERROR',
      code: 'BARCODE_READ_AS_NUMBER',
    });
  });

  it('★ 0 과 음수도 number 이므로 같은 오류다 (falsy 예외 없음)', () => {
    expect(normalizeBarcode(0)).toEqual({ kind: 'ERROR', code: 'BARCODE_READ_AS_NUMBER' });
    expect(normalizeBarcode(-1)).toEqual({ kind: 'ERROR', code: 'BARCODE_READ_AS_NUMBER' });
  });
});

describe('17~20. 정규화 — 앞자리 0 보존 · 공백/하이픈 제거', () => {
  it('17. 앞자리 0 을 보존한다', () => {
    expect(normalizeBarcode('001234567890')).toEqual({ kind: 'OK', barcode: '001234567890' });
    expect(normalizeBarcode('0')).toEqual({ kind: 'OK', barcode: '0' });
    expect(normalizeBarcode('0000000000000')).toEqual({ kind: 'OK', barcode: '0000000000000' });
  });

  it('18. 내부 공백을 제거한다', () => {
    expect(normalizeBarcode('8809 6199 61373')).toEqual({ kind: 'OK', barcode: '8809619961373' });
  });

  it('19. ASCII 하이픈을 제거한다', () => {
    expect(normalizeBarcode('8809-6199-61373')).toEqual({ kind: 'OK', barcode: '8809619961373' });
  });

  it('20. 공백 + 하이픈 혼합, 앞뒤 공백까지 함께 처리한다', () => {
    expect(normalizeBarcode('  8809-6199 61373  ')).toEqual({
      kind: 'OK',
      barcode: '8809619961373',
    });
    // tab·개행도 \s 이므로 제거된다.
    expect(normalizeBarcode('8809\t6199\n61373')).toEqual({
      kind: 'OK',
      barcode: '8809619961373',
    });
  });

  it('★ §19 회귀 고정 — "  001-234 567  " → OK "001234567" (앞 00 보존)', () => {
    expect(normalizeBarcode('  001-234 567  ')).toEqual({ kind: 'OK', barcode: '001234567' });
  });

  it('★ §19 회귀 고정 — " 확인필요 " → trim 후 UNVERIFIED, raw 는 "확인필요"', () => {
    expect(normalizeBarcode(' 확인필요 ')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_UNVERIFIED',
      raw: '확인필요',
    });
  });

  it('★ 유니코드 대시(—)는 제거 대상이 아니다 — ASCII 하이픈만 제거한다', () => {
    expect(normalizeBarcode('8809—61373')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: '8809—61373',
    });
  });
});

describe('21~24. INVALID_FORMAT', () => {
  it('21. 알파벳이 섞이면 BARCODE_INVALID_FORMAT', () => {
    expect(normalizeBarcode('ABC123')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: 'ABC123',
    });
  });

  it('22. 슬래시가 섞이면 BARCODE_INVALID_FORMAT', () => {
    expect(normalizeBarcode('8809/1234')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: '8809/1234',
    });
  });

  it('23. 언더스코어가 섞이면 BARCODE_INVALID_FORMAT', () => {
    expect(normalizeBarcode('123_456')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: '123_456',
    });
  });

  it('24. ★ raw 에는 cleaned 가 아니라 trim 직후 원문이 담긴다', () => {
    const result = normalizeBarcode('  88 09/12-34  ');
    expect(result).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      // 앞뒤 공백만 제거된 상태 — 내부 공백·하이픈이 살아 있다.
      raw: '88 09/12-34',
    });
    expect(result.kind === 'ISSUE' && result.raw).not.toBe('880912 34');
  });

  it('★ 제거 후 남는 것이 없으면 EMPTY 가 아니라 형식 이슈다', () => {
    // '- -' 는 EMPTY sentinel 목록에 없다 — 원문 판정 순서를 그대로 따른다.
    expect(normalizeBarcode('- -')).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: '- -',
    });
  });

  it('★ 부호·소수점·전각 숫자는 숫자 전용 검증을 통과하지 못한다', () => {
    for (const bad of ['+8809', '88.09', '１２３']) {
      const result = normalizeBarcode(bad);
      expect(result.kind, bad).toBe('ISSUE');
      expect(result.kind === 'ISSUE' && result.code, bad).toBe('BARCODE_INVALID_FORMAT');
    }
  });

  it('★ 문자열이 아닌 값도 String() 후 같은 규칙으로 분류된다', () => {
    expect(normalizeBarcode(true)).toEqual({
      kind: 'ISSUE',
      code: 'BARCODE_INVALID_FORMAT',
      raw: 'true',
    });
    expect(normalizeBarcode({}).kind).toBe('ISSUE');
  });
});

describe('25~26. 결과 타입·순수성', () => {
  it('25. OK 의 barcode 는 언제나 string 이다 — Number/BigInt/Decimal 변환 없음', () => {
    for (const input of ['8809619961373', '001234567890', '0', '  8809-6199 61373  ']) {
      const result = normalizeBarcode(input);
      expect(result.kind, input).toBe('OK');
      if (result.kind !== 'OK') continue;
      expect(typeof result.barcode, input).toBe('string');
      expect(Number.isNaN(Number(result.barcode)), input).toBe(false);
      // 숫자 왕복이었다면 앞자리 0 이 사라졌을 값도 문자열로 남는다.
      expect(result.barcode, input).toBe(String(result.barcode));
    }
  });

  it('26. 입력 문자열을 변형하지 않는다', () => {
    const input = '  001-234 567  ';
    const snapshot = `${input}`;
    const result = normalizeBarcode(input);

    expect(input).toBe(snapshot);
    expect(result).toEqual({ kind: 'OK', barcode: '001234567' });
    // 결과 문자열은 입력과 다른 새 값이다 (입력을 그대로 되돌려주지 않는다).
    expect(result.kind === 'OK' && result.barcode).not.toBe(input);
  });

  it('★ 순수 함수 — 같은 입력이면 몇 번을 불러도 같은 결과다', () => {
    const inputs: readonly unknown[] = [
      '8809619961373',
      '1.23E+12',
      '확인필요',
      '-',
      null,
      8809619961373,
      'ABC123',
    ];
    for (const input of inputs) {
      const first = normalizeBarcode(input);
      const second = normalizeBarcode(input);
      const third = normalizeBarcode(input);
      expect(second, String(input)).toEqual(first);
      expect(third, String(input)).toEqual(first);
    }
  });

  it('★ 중복 판정을 하지 않는다 — 같은 값을 여러 번 넣어도 항상 OK 다', () => {
    // BARCODE_DUPLICATE 는 T04-1 DB UNIQUE 와 T04-3/T04-4 흐름의 몫이다.
    const results: BarcodeNormalizationResult[] = [
      normalizeBarcode('8809619960499'),
      normalizeBarcode('8809619960499'),
      normalizeBarcode('88096-19960499'),
    ];
    for (const result of results) {
      expect(result).toEqual({ kind: 'OK', barcode: '8809619960499' });
    }
  });

  it('★ T04-1 DB 제약과 정합 — OK 결과는 not-blank·btrim·숫자 전용을 만족한다', () => {
    for (const input of ['  8809-6199 61373  ', '001-234 567', '0000000000000']) {
      const result = normalizeBarcode(input);
      expect(result.kind, input).toBe('OK');
      if (result.kind !== 'OK') continue;
      expect(result.barcode.length, input).toBeGreaterThan(0); // barcode_not_blank_check
      expect(result.barcode, input).toBe(result.barcode.trim()); // barcode = btrim(barcode)
      expect(result.barcode, input).not.toMatch(/\s|-/);
      expect(result.barcode, input).toMatch(/^\d+$/);
    }
  });
});

describe('★ T04-2 범위 고정 — 길이·타입·중복 규칙을 발명하지 않는다', () => {
  it('EAN-13 등 길이 규칙이 없다 — 1자리도 200자리도 OK 다', () => {
    expect(normalizeBarcode('1')).toEqual({ kind: 'OK', barcode: '1' });

    const long = '9'.repeat(200);
    expect(normalizeBarcode(long)).toEqual({ kind: 'OK', barcode: long });
    // DB VARCHAR(100) 은 물리 제약이며 정규화 결과 코드로 바뀌지 않는다.
  });

  it('체크디지트를 검증하지 않는다 — 체크디지트가 틀린 값도 OK 다', () => {
    // 8809619961373 의 마지막 자리를 바꾼 값. 업무 판정 없이 통과해야 한다.
    expect(normalizeBarcode('8809619961374')).toEqual({ kind: 'OK', barcode: '8809619961374' });
  });

  it('barcodeType(UNIT/INNER_BOX/…)을 추론하지 않는다 — 결과에 타입 필드가 없다', () => {
    const result = normalizeBarcode('8809619961373');
    expect(Object.keys(result).sort()).toEqual(['barcode', 'kind']);
  });

  it('EMPTY 결과에는 code 도 raw 도 없다 — 오류·이슈가 아니다', () => {
    expect(Object.keys(normalizeBarcode('-'))).toEqual(['kind']);
  });
});
