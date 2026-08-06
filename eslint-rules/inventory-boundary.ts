import type { Linter } from 'eslint';

/**
 * 재고 원장·잔고 모델 직접 접근 차단 (T0-5).
 *
 * 설계 문서 `02_시스템_아키텍처와_모듈구조.md` §4.4 의 계층 규칙을 lint 로 강제한다.
 *
 * ## 왜 막는가
 *
 * `inventory_ledger_entry` 는 **불변 원장**이고 `inventory_balance` 는 그 원장에서
 * 파생된 **캐시**다. 두 테이블을 아무 곳에서나 읽고 쓸 수 있으면
 *
 *   - 원장을 거치지 않은 현재고 직접 수정이 생기고,
 *   - 원장과 잔고가 어긋나며,
 *   - 감사로그 없이 재고가 바뀐다.
 *
 * 재고를 바꾸는 모든 경로는 `InventoryPostingService` 를 통과해야 한다.
 * 그 서비스를 우회할 수 있는 첫 번째 문이 Prisma 모델 직접 import 다.
 *
 * ## 경계
 *
 * ┌────────────────────────────────────────────┬──────┐
 * │ 위치                                       │ 접근 │
 * ├────────────────────────────────────────────┼──────┤
 * │ src/modules/inventory/infrastructure/**    │ ✅   │
 * │ Prisma 생성 코드 (src/generated/**)        │ ✅   │
 * │ 마이그레이션·전환 스크립트 (prisma/, scripts/) │ ✅   │
 * │ 전용 테스트 fixture                        │ ✅   │
 * ├────────────────────────────────────────────┼──────┤
 * │ src/modules/inventory/domain/**            │ ❌   │
 * │ src/modules/inventory/application/**       │ ❌   │
 * │ src/modules/inventory/presentation/**      │ ❌   │
 * │ 그 외 모든 모듈                            │ ❌   │
 * └────────────────────────────────────────────┴──────┘
 *
 * 같은 inventory 모듈 안이어도 infrastructure 밖에서는 막는다. 영속성 세부사항이
 * 도메인 규칙으로 새어 들어오면 계층 분리가 이름만 남는다.
 *
 * 다른 업무 모듈은 inventory **application 계층의 공개 인터페이스**로만 조회·명령한다.
 *
 * ## 구성
 *
 * 규칙만 담은 config 조각이다. parser 는 설정하지 않는다. `eslint.config.ts` 가
 * 앞에서 지정한 parser 를 그대로 쓰고, 테스트는 자체 parser 를 붙여 이 배열을
 * **그대로 재사용**한다. 테스트가 설정을 복제하지 않게 하기 위함이다.
 *
 * ⚠️ T0-5 시점에는 두 모델이 **아직 존재하지 않는다**(업무 모델은 R1a-2).
 *    규칙은 import 경로와 import 이름만 보므로 모델 없이도 동작하며,
 *    fixture 로 검증한다. 임시 모델을 만들지 않는다.
 */

/** 직접 import 를 막을 Prisma 모델명. */
export const RESTRICTED_INVENTORY_MODELS = ['InventoryLedgerEntry', 'InventoryBalance'] as const;

/**
 * Prisma 생성 코드 경로.
 *
 * path alias(`@/generated/prisma/client`)와 상대경로
 * (`../../generated/prisma/client`)를 모두 잡도록 접미 glob 을 쓴다.
 */
const PRISMA_GENERATED_GROUPS = [
  '**/generated/prisma',
  '**/generated/prisma/*',
  '**/generated/prisma/**',
];

/**
 * 테이블명 표현으로 만들어질 수 있는 모듈 경로.
 *
 * 나중에 `.../infrastructure/inventory_ledger_entry.ts` 같은 파일이 생기고
 * 그것을 도메인에서 직접 import 하는 우회를 막는다.
 */
const TABLE_NAME_GROUPS = [
  '**/inventory_ledger_entry',
  '**/inventory_ledger_entry/**',
  '**/inventory_ledger_entry.*',
  '**/inventory_balance',
  '**/inventory_balance/**',
  '**/inventory_balance.*',
];

/** 원장·잔고에 직접 접근할 수 있는 위치. */
export const INVENTORY_MODEL_ALLOWED_GLOBS = [
  // 재고 모듈의 영속성 계층 — 유일한 정상 접근 지점
  '**/modules/inventory/infrastructure/**',
  // 마이그레이션·시드·전환 스크립트
  '**/prisma/**',
  '**/scripts/**',
];

const GUIDANCE =
  'InventoryLedgerEntry·InventoryBalance 직접 접근은 금지됩니다. ' +
  '재고 원장은 불변이고 현재고는 원장에서 파생되므로, 모든 재고 변경은 ' +
  'InventoryPostingService 를 통과해야 합니다. ' +
  '재고 조회·명령은 inventory 모듈 application 계층의 공개 인터페이스를 사용하세요. ' +
  'Prisma 모델 직접 접근은 src/modules/inventory/infrastructure/** 에서만 허용됩니다.';

const DYNAMIC_GUIDANCE =
  'Prisma 생성 코드를 동적 import 하지 마세요. 동적 import 는 import 이름을 정적으로 ' +
  '확인할 수 없어 InventoryLedgerEntry·InventoryBalance 차단을 우회합니다. ' +
  GUIDANCE;

const REQUIRE_GUIDANCE =
  'Prisma 생성 코드를 require() 로 불러오지 마세요. ' +
  '정적 import 차단을 우회하는 경로입니다. ' +
  GUIDANCE;

/**
 * 재고 원장·잔고 경계 규칙.
 *
 * 순서가 중요하다. 뒤 config 가 앞 config 를 덮으므로 **허용 위치를 뒤에** 둔다.
 */
export const inventoryBoundaryConfigs: Linter.Config[] = [
  {
    name: 'deeppoint/inventory-boundary',
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // 정적 import·re-export 차단.
      // named / alias / type-only / inline type / namespace / export-from 을 모두 잡는다.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: PRISMA_GENERATED_GROUPS,
              importNames: [...RESTRICTED_INVENTORY_MODELS],
              message: GUIDANCE,
            },
            {
              group: TABLE_NAME_GROUPS,
              message: GUIDANCE,
            },
          ],
        },
      ],

      // 동적 import·require 차단.
      // no-restricted-imports 는 정적 구문만 대상으로 한다.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/generated\\u002Fprisma/]',
          message: DYNAMIC_GUIDANCE,
        },
        {
          selector: 'ImportExpression[source.value=/inventory_(ledger_entry|balance)/]',
          message: DYNAMIC_GUIDANCE,
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/generated\\u002Fprisma/]",
          message: REQUIRE_GUIDANCE,
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/inventory_(ledger_entry|balance)/]",
          message: REQUIRE_GUIDANCE,
        },
      ],
    },
  },

  {
    name: 'deeppoint/inventory-boundary-allowed',
    files: INVENTORY_MODEL_ALLOWED_GLOBS,
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
