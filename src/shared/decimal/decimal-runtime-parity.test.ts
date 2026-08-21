import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as browser from './browser';
import { readBrowserDecimalContext } from './browser-context';
import { DECIMAL_CONTEXT_CONFIG, DECIMAL_PRECISION, DECIMAL_ROUNDING } from './config';
import { readDecimalContext } from './context';
import * as server from './decimal';

/**
 * server ↔ browser Decimal 런타임 parity (T07-8 build remediation).
 *
 * ⚠️ 근거: `docs/18_설계복구_BOM.md` T07-8 build remediation ·
 *    `T07-8 BUILD BLOCKER REMEDIATION` §14·§15·§16·§17.
 *
 * ## 이 파일이 지키는 불변식
 *
 * server 는 `@/generated/prisma/client`, browser 는 `@/generated/prisma/browser`
 * 의 `Prisma.Decimal` 을 쓴다. 두 런타임은 별개 프로세스이므로 **생성자
 * identity 를 공유하지 않는다.** 공유해야 하는 것은 그게 아니라 이것이다.
 *
 *   1. 산술 설정이 같다 (`./config` 단일 출처)
 *   2. **최종 문자열 결과가 같다**
 *
 * ⛔ 그래서 이 파일은 `server === browser` 생성자 비교도,
 *    cross-runtime `instanceof` 도 하지 않는다. 둘 다 의미가 없다.
 *
 * ★ DB 전달 가능 타입 불변식(`instanceof Prisma.Decimal`)은 **server 전용**이며
 *   `decimal.test.ts` 가 그대로 지킨다 — 이 remediation 에서 손대지 않았다.
 */

function sourceOf(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/** 주석을 걷어낸 코드만 본다 — 금지 사실을 적어 둔 주석까지 걸면 의도가 뒤집힌다. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ═══════════════════════════════════════════════════════════════
// 1. 설정 parity (§15)
// ═══════════════════════════════════════════════════════════════

describe('1. 설정 parity', () => {
  it('★★ server·browser 컨텍스트의 실제 설정값이 같다', () => {
    const serverContext = readDecimalContext();
    const browserContext = readBrowserDecimalContext();

    expect(browserContext).toEqual(serverContext);
  });

  it('★ 두 컨텍스트 모두 `./config` 의 값을 그대로 쓴다', () => {
    for (const context of [readDecimalContext(), readBrowserDecimalContext()]) {
      expect(context.precision).toBe(DECIMAL_CONTEXT_CONFIG.precision);
      expect(context.rounding).toBe(DECIMAL_CONTEXT_CONFIG.rounding);
      expect(context.toExpNeg).toBe(DECIMAL_CONTEXT_CONFIG.toExpNeg);
      expect(context.toExpPos).toBe(DECIMAL_CONTEXT_CONFIG.toExpPos);
      expect(context.modulo).toBe(DECIMAL_CONTEXT_CONFIG.modulo);
    }
  });

  it('★ 두 생성자 모두 freeze 되어 있다 — 전역 설정 변경 불가', () => {
    expect(readDecimalContext().frozen).toBe(true);
    expect(readBrowserDecimalContext().frozen).toBe(true);
  });

  it('★ 설정값은 실측 inventory 와 일치한다 (추측 금지)', () => {
    expect(DECIMAL_PRECISION).toBe(60);
    expect(DECIMAL_ROUNDING).toBe(4); // ROUND_HALF_UP
    expect(DECIMAL_CONTEXT_CONFIG).toEqual({
      precision: 60,
      rounding: 4,
      toExpNeg: -7,
      toExpPos: 21,
      modulo: 1,
    });
    // ⚠️ `minE`·`maxE`·`crypto` 는 예나 지금이나 설정하지 않는다.
    expect(Object.keys(DECIMAL_CONTEXT_CONFIG).sort()).toEqual([
      'modulo',
      'precision',
      'rounding',
      'toExpNeg',
      'toExpPos',
    ]);
  });

  it('★★★ 공유 config 는 `clone()` 에 오염되지 않는다 (decimal.js 가 인자를 변형한다)', () => {
    // decimal.js 의 `clone(obj)` 는 빠진 속성을 넘겨받은 객체에 **직접 채운다**.
    // 두 컨텍스트가 이미 초기화된 뒤인데도 공유 상수가 5키 그대로여야 한다 —
    // 그래야 "먼저 clone 한 런타임의 기본값이 다른 쪽에 새는" 일이 없다.
    expect(Object.keys(DECIMAL_CONTEXT_CONFIG)).toHaveLength(5);
    expect(DECIMAL_CONTEXT_CONFIG).not.toHaveProperty('minE');
    expect(DECIMAL_CONTEXT_CONFIG).not.toHaveProperty('maxE');
    expect(DECIMAL_CONTEXT_CONFIG).not.toHaveProperty('crypto');
    // freeze 되어 있으므로 실수로 그대로 넘기면 즉시 터진다.
    expect(Object.isFrozen(DECIMAL_CONTEXT_CONFIG)).toBe(true);
  });

  it('★★ 두 context 는 config 사본을 넘긴다 — 원본을 그대로 넘기지 않는다', () => {
    for (const file of ['./context.ts', './browser-context.ts']) {
      const code = codeOnly(sourceOf(file));
      expect(code, file).toContain('clone({ ...DECIMAL_CONTEXT_CONFIG })');
      expect(code, file).not.toContain('clone(DECIMAL_CONTEXT_CONFIG)');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 산술 parity (§14) — 최종 문자열이 같아야 한다
// ═══════════════════════════════════════════════════════════════

/** 두 런타임에 같은 계산을 시키고 문자열 결과가 같은지 본다. */
function parity(compute: (api: typeof server) => string): string {
  const fromServer = compute(server);
  // `browser` 는 좁은 API 집합이지만 이 테스트가 쓰는 함수는 모두 갖고 있다.
  const fromBrowser = compute(browser as unknown as typeof server);
  expect(fromBrowser, 'browser 결과가 server 와 다르다').toBe(fromServer);
  return fromServer;
}

describe('2. 산술 parity', () => {
  it('★★★ A — 실제 필요량 0.2 × 1.1 × 1.05 = 0.231 (U8-12 CASE I)', () => {
    const result = parity((api) =>
      api.toDecimalString(
        api.roundToScale(
          api.multiply(api.multiply('0.2', api.add('1', '0.1')), api.add('1', '0.05')),
          6,
          api.ROUNDING.HALF_UP,
        ),
      ),
    );
    expect(result).toBe('0.231');
  });

  it('★★★ B — 소요량 추천 1 / 30 → 6dp "0.033333" (⛔ 재정규화 없음)', () => {
    const result = parity((api) =>
      api.toDecimalString(api.roundToScale(api.divide('1', '30'), 6, api.ROUNDING.HALF_UP)),
    );
    expect(result).toBe('0.033333');
  });

  it('★★★ C — 비중 1 / 3 × 100 → 2dp "33.33" (U8-11)', () => {
    const result = parity((api) =>
      api.toDecimalString(
        api.roundToScale(api.multiply(api.divide('1', '3'), '100'), 2, api.ROUNDING.HALF_UP),
      ),
    );
    expect(result).toBe('33.33');
  });

  it('★★★ D — HALF_UP 경계값이 양쪽에서 같게 올라간다', () => {
    // 정확히 .5 인 경계 — HALF_UP 은 0 에서 먼 쪽으로 간다.
    expect(
      parity((api) => api.toDecimalString(api.roundToScale('1.005', 2, api.ROUNDING.HALF_UP))),
    ).toBe('1.01');
    expect(
      parity((api) => api.toDecimalString(api.roundToScale('2.675', 2, api.ROUNDING.HALF_UP))),
    ).toBe('2.68');
    expect(
      parity((api) => api.toDecimalString(api.roundToScale('-1.005', 2, api.ROUNDING.HALF_UP))),
    ).toBe('-1.01');
    // HALF_EVEN 과 다르다는 것도 양쪽에서 동일하게 성립한다.
    expect(
      parity((api) => api.toDecimalString(api.roundToScale('1.005', 2, api.ROUNDING.HALF_EVEN))),
    ).toBe('1');
  });

  it('★★★ E — precision=60 이 실제로 적용된다 (기본 20 이면 값이 달라진다)', () => {
    // 1/3 을 자르지 않고 그대로 직렬화하면 유효자릿수만큼 나온다.
    const result = parity((api) => api.toDecimalString(api.divide('1', '3')));
    expect(result).toBe(`0.${'3'.repeat(60)}`);
    // ⛔ 기본 컨텍스트(20자리)였다면 20자리에서 끊겼을 것이다.
    expect(result.length).toBeGreaterThan('0.'.length + 20);
  });

  it('★★★ E2 — 3항 연쇄(수량 × 단가 × 계수)도 절단 없이 같다', () => {
    const result = parity((api) =>
      api.toDecimalString(
        api.multiply(api.multiply('123456789.123456', '987654.4321'), '1.0000001'),
      ),
    );
    expect(result).toBe(parity((api) => api.toDecimalString(api.toDecimal(result))));
  });

  it('★★★ F — trailing zero 직렬화가 양쪽에서 같다', () => {
    expect(parity((api) => api.toDecimalString('1.000'))).toBe('1');
    expect(parity((api) => api.toDecimalString('1.500'))).toBe('1.5');
    // scale 을 주면 0 을 채운다 — 양쪽 동일.
    expect(parity((api) => api.toDecimalString('1.5', 4))).toBe('1.5000');
    expect(parity((api) => api.toDecimalString('0', 2))).toBe('0.00');
    expect(parity((api) => api.toDecimalString('-0'))).toBe('0');
  });

  it('★ G — 지수표기 없이 펼치는 계약이 양쪽에서 같다', () => {
    expect(parity((api) => api.toDecimalString('1e-7'))).toBe('0.0000001');
    expect(parity((api) => api.toDecimalString('1e21'))).toBe('1000000000000000000000');
  });

  it('★ H — 0 나눗셈·비유한값 거부가 양쪽에서 같다', () => {
    for (const api of [server, browser as unknown as typeof server]) {
      expect(() => api.divide('1', '0')).toThrow(RangeError);
      expect(() => api.toDecimal('Infinity')).toThrow(RangeError);
      expect(() => api.toDecimal('NaN')).toThrow(RangeError);
      expect(() => api.toDecimal('1,000')).toThrow(RangeError);
    }
  });

  it('★ I — 비교 helper 결과가 같다', () => {
    for (const api of [server, browser as unknown as typeof server]) {
      expect(api.isEqual('1.0', '1')).toBe(true);
      expect(api.isGreaterThan('1.0000001', '1')).toBe(true);
      expect(api.isGreaterThan(api.ZERO, api.ZERO)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. cross-runtime 불변식의 경계 (§7 · §16)
// ═══════════════════════════════════════════════════════════════

describe('3. 런타임 경계', () => {
  it('★★ 생성자 identity 는 요구하지 않는다 — 값 동일성만 본다', () => {
    const a = server.toDecimal('1.5');
    const b = browser.toDecimal('1.5');
    // 서로 다른 런타임의 클래스이므로 constructor 는 다르다. 그것이 정상이다.
    expect(a.constructor === b.constructor).toBe(false);
    // 그래도 값과 직렬화 결과는 같다 — 이것이 진짜 계약이다.
    expect(browser.toDecimalString(b)).toBe(server.toDecimalString(a));
  });

  it('★★ browser barrel 은 DB 지향 helper 를 노출하지 않는다 (§8 좁은 범위)', () => {
    const exported = Object.keys(browser).sort();
    expect(exported).toEqual([
      'ROUNDING',
      'ZERO',
      'add',
      'divide',
      'isEqual',
      'isGreaterThan',
      'multiply',
      'roundToScale',
      'toDecimal',
      'toDecimalString',
    ]);
    // ⛔ Prisma·DB 경계 helper 는 브라우저로 나가지 않는다.
    for (const forbidden of ['isDecimal', 'sumDecimals', 'compareDecimals', 'PrismaClient']) {
      expect(exported, forbidden).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. import 그래프 가드 (§17)
// ═══════════════════════════════════════════════════════════════

describe('4. client 번들 import 그래프', () => {
  it('★★★ browser 컨텍스트는 browser Prisma entry 만 쓴다', () => {
    const code = codeOnly(sourceOf('./browser-context.ts'));
    expect(code).toContain("from '@/generated/prisma/browser'");
    // ⛔ 이 한 줄이 들어오면 클라이언트 번들이 다시 깨진다.
    expect(code).not.toContain("from '@/generated/prisma/client'");
  });

  it('★★★ server 컨텍스트는 server Prisma entry 를 유지한다', () => {
    const code = codeOnly(sourceOf('./context.ts'));
    expect(code).toContain("from '@/generated/prisma/client'");
    expect(code).not.toContain("from '@/generated/prisma/browser'");
  });

  it('★★★ 공용 factory 는 Prisma 를 **type 으로만** 참조한다', () => {
    const code = codeOnly(sourceOf('./helpers.ts'));
    // type-only import 는 컴파일 시 지워지므로 브라우저 번들에 남지 않는다.
    expect(code).toContain("import type { Prisma } from '@/generated/prisma/client'");
    expect(code).not.toMatch(/^import \{[^}]*Prisma[^}]*\} from '@\/generated\/prisma\/client'/m);
  });

  it('★★★ config 모듈은 Prisma·Node 를 전혀 참조하지 않는다', () => {
    const code = codeOnly(sourceOf('./config.ts'));
    for (const forbidden of ['@/generated/prisma', 'node:', '@prisma/client', 'import ']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('★★★ BOM 상세 helper 는 browser 바인딩을 쓴다', () => {
    const code = codeOnly(sourceOf('../../app/master/boms/bom-detail-view.ts'));
    expect(code).toContain("from '@/shared/decimal/browser'");
    // ⛔ server barrel 을 쓰면 `node:module` 이 딸려 온다.
    expect(code).not.toContain("from '@/shared/decimal'");
  });

  it('★★ next.config 로 문제를 숨기지 않았다 — alias 0 (§2·§18)', () => {
    const code = codeOnly(
      readFileSync(new URL('../../../next.config.ts', import.meta.url), 'utf8'),
    );
    expect(code).not.toContain('resolveAlias');
    expect(code).not.toContain('turbopack');
    expect(code).not.toContain('webpack');
  });
});
