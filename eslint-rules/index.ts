import type { ESLint, Rule } from 'eslint';

import noDecimalToNumber from './no-decimal-to-number';

/**
 * 프로젝트 전용 ESLint 플러그인.
 *
 * 규칙은 `deeppoint/<rule-name>` 으로 참조한다.
 * 타입 정보를 쓰는 규칙이므로 `parserOptions.projectService` 가 필요하다.
 *
 * ⚠️ `as unknown as Rule.RuleModule` 캐스트가 필요한 이유
 *
 * `@typescript-eslint/utils` 의 `RuleModule` 과 ESLint 9 의 `Rule.RuleModule` 은
 * `RuleContext` 정의가 다르다. ESLint 9 의 새 `RuleDefinition` 타입에는
 * `getScope` 등 구버전 메서드가 없어 두 타입이 서로 대입되지 않는다.
 * **런타임 구조는 동일하며** ESLint 가 실제로 규칙을 실행하는 데 문제가 없다
 * (tests/eslint-rules/no-decimal-to-number.test.ts 가 실제 ESLint API 로 검증).
 * 타입 선언 간 불일치이므로 이 경계에서만 캐스트한다.
 */
export const deeppointPlugin: ESLint.Plugin = {
  meta: {
    name: 'eslint-plugin-deeppoint',
    version: '0.1.0',
  },
  rules: {
    'no-decimal-to-number': noDecimalToNumber as unknown as Rule.RuleModule,
  },
};

export { noDecimalToNumber };
