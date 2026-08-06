import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    rules: {
      // 미사용 변수는 오류. _ 접두사는 의도적 무시로 허용한다.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // import 순서를 고정해 diff 노이즈를 줄인다.
      // type import 를 별도 그룹으로 두지 않고 원본 모듈 그룹에 함께 정렬한다
      // (`import type { Metadata } from 'next'` 이 next/font 뒤로 밀리는 것을 방지).
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  /* ── 모듈 경계 강제 ───────────────────────────────────────────
   * T0-5 에서 재고원장 모델 직접 import 차단 규칙을 추가한다.
   * 현재는 아키텍처 문서(02_시스템_아키텍처와_모듈구조.md §4.4)의
   * 계층 규칙만 명시해 두고, 실제 제한은 대상 코드가 생긴 뒤 건다.
   */

  // Prettier 와 충돌하는 포매팅 규칙 해제. 반드시 마지막에 위치해야 한다.
  prettier,

  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    'src/generated/**',
    'next-env.d.ts',
    'node_modules/**',
  ]),
]);

export default eslintConfig;
