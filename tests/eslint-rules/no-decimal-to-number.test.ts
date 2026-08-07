import { fileURLToPath } from 'node:url';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';

import { deeppointPlugin } from '../../eslint-rules';
import rule from '../../eslint-rules/no-decimal-to-number';

/**
 * `deeppoint/no-decimal-to-number` 규칙 테스트.
 *
 * 두 층으로 검증한다.
 *
 *   1. **RuleTester** — 독립 fixture 프로젝트에서 판정 로직을 검증한다.
 *      빠르고, 위반/허용 케이스를 촘촘히 나열할 수 있다.
 *   2. **ESLint API** — 실제 Prisma Decimal 을 쓰는 fixture 파일을 프로젝트
 *      tsconfig 로 린트해, 대역이 아닌 진짜 타입에서도 동작하는지 확인한다.
 *
 * 위반 예제 파일은 `eslint.config.ts` 의 globalIgnores 로 `pnpm lint` 대상에서
 * 빠져 있다. 잘못된 예제가 전체 lint 를 상시 실패시키지 않게 하기 위함이다.
 */

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTesterRootDir = fileURLToPath(
  new URL('../../eslint-rules/__fixtures__/rule-tester', import.meta.url),
);
const projectRootDir = fileURLToPath(new URL('../..', import.meta.url));

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: ruleTesterRootDir,
    },
  },
});

/** fixture 의 Decimal 대역을 가져오는 공통 머리말. */
const IMPORT = `import { Decimal, Money, getQuantity, maybeQuantity, type OrderLine } from './decimal-lib';\n`;

ruleTester.run('no-decimal-to-number', rule, {
  valid: [
    // ── 일반 문자열·number 변환은 허용 ──────────────────────────
    { code: `const n = Number('123');` },
    { code: `const n = parseFloat('1.25');` },
    { code: `const n = parseInt('10', 10);` },
    { code: `const raw: string = '5'; const n = +raw;` },
    { code: `const n = Number(1);` },
    { code: `declare const s: string; const n = parseFloat(s);` },

    // ── Decimal 을 Decimal 로 다루는 것은 허용 ──────────────────
    { code: `${IMPORT}const d = new Decimal('1').plus('2');` },
    { code: `${IMPORT}declare const d: Decimal; const s = d.toFixed(6);` },
    { code: `${IMPORT}declare const d: Decimal; const s = d.toString();` },
    { code: `${IMPORT}declare const d: Decimal; const z = d.isZero();` },
    { code: `${IMPORT}declare const line: OrderLine; const s = line.quantity.toFixed();` },

    // ── Decimal 이 아닌 값의 toNumber 는 규칙 대상이 아니다 ─────
    {
      code: `declare const meter: { toNumber(): number }; const n = meter.toNumber();`,
    },

    // ── 전역이 아닌 Number 를 가린 경우 ─────────────────────────
    {
      code: `${IMPORT}declare const d: Decimal;
function scope() {
  const Number = (value: unknown): string => String(value);
  return Number(d);
}`,
    },
  ],

  invalid: [
    // ① Prisma Decimal 직접 생성값
    {
      code: `${IMPORT}const n = new Decimal('1.5').toNumber();`,
      errors: [{ messageId: 'toNumberCall' }],
    },
    // ② 함수 인자로 받은 Decimal
    {
      code: `${IMPORT}function f(qty: Decimal) { return qty.toNumber(); }`,
      errors: [{ messageId: 'toNumberCall' }],
    },
    {
      code: `${IMPORT}function f(qty: Decimal) { return Number(qty); }`,
      errors: [{ messageId: 'numberCoercion' }],
    },
    {
      code: `${IMPORT}function f(qty: Decimal) { return +qty; }`,
      errors: [{ messageId: 'unaryPlus' }],
    },
    // ③ 객체 속성의 Decimal
    {
      code: `${IMPORT}declare const line: OrderLine; const n = Number(line.quantity);`,
      errors: [{ messageId: 'numberCoercion' }],
    },
    {
      code: `${IMPORT}declare const line: OrderLine; const n = line.quantity.toNumber();`,
      errors: [{ messageId: 'toNumberCall' }],
    },
    {
      code: `${IMPORT}declare const line: OrderLine; const n = +line.quantity;`,
      errors: [{ messageId: 'unaryPlus' }],
    },
    // ④ 연산 결과 Decimal
    {
      code: `${IMPORT}declare const a: Decimal; declare const b: Decimal; const n = a.plus(b).toNumber();`,
      errors: [{ messageId: 'toNumberCall' }],
    },
    {
      code: `${IMPORT}const n = getQuantity().minus('1').toNumber();`,
      errors: [{ messageId: 'toNumberCall' }],
    },
    // ⑤ 별칭 import
    {
      code: `import { Decimal as D } from './decimal-lib';\nconst n = new D('1').toNumber();`,
      errors: [{ messageId: 'toNumberCall' }],
    },
    {
      code: `import { Decimal as D } from './decimal-lib';\ndeclare const d: D; const n = Number(d);`,
      errors: [{ messageId: 'numberCoercion' }],
    },
    // ⑥ 상속한 타입
    {
      code: `${IMPORT}declare const m: Money; const n = m.toNumber();`,
      errors: [{ messageId: 'toNumberCall' }],
    },
    // ⑦ 유니온 타입에 Decimal 이 섞인 경우
    {
      code: `${IMPORT}const q = maybeQuantity(); const n = Number(q);`,
      errors: [{ messageId: 'numberCoercion' }],
    },

    // ── 우회 패턴 회귀 ────────────────────────────────────────
    {
      code: `${IMPORT}declare const d: Decimal; const n = parseFloat(d.toString());`,
      errors: [{ messageId: 'parseFromDecimal' }],
    },
    {
      code: `${IMPORT}declare const d: Decimal; const n = parseInt(d.toString(), 10);`,
      errors: [{ messageId: 'parseFromDecimal' }],
    },
    {
      code: `${IMPORT}declare const d: Decimal; const n = Number(d.toString());`,
      errors: [{ messageId: 'numberCoercion' }],
    },
    {
      code: `${IMPORT}declare const d: Decimal; const n = Number(d.toFixed(6));`,
      errors: [{ messageId: 'numberCoercion' }],
    },
    {
      code: `${IMPORT}declare const d: Decimal; const n = parseFloat(d.toFixed());`,
      errors: [{ messageId: 'parseFromDecimal' }],
    },
    // ★ 변수명을 바꿔도 우회되지 않는다 (이름이 아니라 타입으로 판정)
    {
      code: `${IMPORT}declare const totalWeight: Decimal; const n = totalWeight.toNumber();`,
      errors: [{ messageId: 'toNumberCall' }],
    },
    {
      code: `${IMPORT}declare const x: Decimal; const n = +x;`,
      errors: [{ messageId: 'unaryPlus' }],
    },
    // 한 파일에 여러 위반
    {
      code: `${IMPORT}declare const d: Decimal;
const a = d.toNumber();
const b = Number(d);
const c = +d;`,
      errors: [
        { messageId: 'toNumberCall' },
        { messageId: 'numberCoercion' },
        { messageId: 'unaryPlus' },
      ],
    },
  ],
});

// ═══════════════════════════════════════════════════════════════
// 실제 Prisma Decimal fixture — ESLint API 로 직접 검사
// ═══════════════════════════════════════════════════════════════
describe('★ 실제 Prisma Decimal fixture', () => {
  async function lintFixture(): Promise<ESLint.LintResult> {
    const eslint = new ESLint({
      cwd: projectRootDir,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        languageOptions: {
          parser: (await import('@typescript-eslint/parser')).default,
          parserOptions: {
            projectService: true,
            tsconfigRootDir: projectRootDir,
          },
        },
        plugins: { deeppoint: deeppointPlugin },
        rules: { 'deeppoint/no-decimal-to-number': 'error' },
      },
    });

    const results = await eslint.lintFiles(['eslint-rules/__fixtures__/prisma-decimal.ts']);
    const first = results[0];
    if (first === undefined) throw new Error('fixture 린트 결과가 없습니다.');
    return first;
  }

  it('★ 완료조건: 실제 Prisma Decimal 변환은 lint 오류가 된다', async () => {
    const result = await lintFixture();
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('★ 위반 9건을 모두 잡는다', async () => {
    const result = await lintFixture();
    const messages = result.messages.filter((m) => m.ruleId === 'deeppoint/no-decimal-to-number');

    expect(messages).toHaveLength(9);
  });

  it('★ 오류 종류별 건수가 기대와 같다', async () => {
    const result = await lintFixture();
    const byMessage = result.messages.reduce<Record<string, number>>((counts, message) => {
      const key = message.messageId ?? 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});

    expect(byMessage).toEqual({
      toNumberCall: 4, // ①④⑤⑧
      numberCoercion: 2, // ②⑨
      unaryPlus: 1, // ③
      parseFromDecimal: 2, // ⑥⑦
    });
  });

  it('★ 오류 메시지에 정밀도 손실 사유가 담긴다', async () => {
    const result = await lintFixture();
    for (const message of result.messages) {
      expect(message.message).toContain('정밀도');
      expect(message.ruleId).toBe('deeppoint/no-decimal-to-number');
      expect(message.severity).toBe(2);
    }
  });

  it('★ 오류 위치가 위반 함수와 일치한다', async () => {
    const result = await lintFixture();
    const source = (await import('node:fs/promises')).readFile;
    const text = await source(
      new URL('../../eslint-rules/__fixtures__/prisma-decimal.ts', import.meta.url),
      'utf8',
    );
    const lines = text.split('\n');

    // 보고된 모든 줄은 violation 으로 시작하는 함수 본문 안에 있어야 한다.
    for (const message of result.messages) {
      const line = lines[message.line - 1] ?? '';
      expect(line).not.toBe('');
      // 허용 예제(allowed*)가 잘못 보고되지 않았는지 역으로 확인한다
      expect(line).not.toContain("Number('123')");
      expect(line).not.toContain("parseFloat('1.25')");
      expect(line).not.toContain("parseInt('10', 10)");
    }
  });

  it('★ 허용 예제는 보고되지 않는다', async () => {
    const result = await lintFixture();
    const reportedLines = new Set(result.messages.map((m) => m.line));

    const text = await (
      await import('node:fs/promises')
    ).readFile(
      new URL('../../eslint-rules/__fixtures__/prisma-decimal.ts', import.meta.url),
      'utf8',
    );
    const lines = text.split('\n');

    lines.forEach((line, index) => {
      const isAllowedExample =
        line.includes("Number('123')") ||
        line.includes("parseFloat('1.25')") ||
        line.includes("parseInt('10', 10)") ||
        line.includes('return quantity.toFixed();') ||
        line.includes('return +raw;');
      if (isAllowedExample) {
        expect(reportedLines.has(index + 1), `허용 예제가 보고됨: ${line.trim()}`).toBe(false);
      }
    });
  });
});
