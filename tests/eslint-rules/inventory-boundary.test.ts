import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  INVENTORY_MODEL_ALLOWED_GLOBS,
  RESTRICTED_INVENTORY_MODELS,
  inventoryBoundaryConfigs,
} from '../../eslint-rules/inventory-boundary';

/**
 * 재고 원장·잔고 경계 규칙 테스트 (T0-5).
 *
 * `eslint.config.ts` 가 쓰는 **바로 그 config 배열**을 재사용한다.
 * 설정을 복제하면 테스트는 통과하는데 실제 lint 는 통과하는 상황이 생긴다.
 *
 * fixture 는 `eslint.config.ts` 의 globalIgnores 로 `pnpm lint` 대상에서 제외되어
 * 있다(전용 테스트 fixture 는 허용 위치). 여기서는 ESLint API 로 직접 검사한다.
 *
 * ⚠️ 업무 모델(`InventoryLedgerEntry`·`InventoryBalance`)은 아직 존재하지 않는다.
 *    이 규칙은 import 경로와 import 이름만 보므로 모델 없이 검증할 수 있다.
 */

const FIXTURE_ROOT = fileURLToPath(
  new URL('../../eslint-rules/__fixtures__/inventory-boundary', import.meta.url),
);
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RULE_IDS = ['no-restricted-imports', 'no-restricted-syntax'];

async function createLinter(): Promise<ESLint> {
  const parser = (await import('@typescript-eslint/parser')).default;

  // 경계 config 는 규칙만 담고 parser 를 지정하지 않는다.
  // 실제 설정에서는 eslint-config-next/typescript 가 parser 를 제공한다.
  const base: Linter.Config = {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser, sourceType: 'module' },
  };

  return new ESLint({
    cwd: PROJECT_ROOT,
    overrideConfigFile: true,
    overrideConfig: [base, ...inventoryBoundaryConfigs],
  });
}

async function lint(relativePath: string): Promise<Linter.LintMessage[]> {
  const eslint = await createLinter();
  const results = await eslint.lintFiles([`${FIXTURE_ROOT}/${relativePath}`]);
  const first = results[0];
  if (first === undefined) throw new Error(`린트 결과 없음: ${relativePath}`);
  return first.messages.filter((message) => RULE_IDS.includes(message.ruleId ?? ''));
}

// ═══════════════════════════════════════════════════════════════
// 차단
// ═══════════════════════════════════════════════════════════════
describe('★ 차단 — 타 모듈에서 재고 원장·잔고 직접 접근', () => {
  const BLOCKED_OTHER_MODULE: ReadonlyArray<[string, string]> = [
    ['named import', 'modules/purchasing/application/named-import.ts'],
    ['alias import', 'modules/purchasing/application/alias-import.ts'],
    ['type-only import', 'modules/purchasing/application/type-only-import.ts'],
    ['inline type import', 'modules/purchasing/application/inline-type-import.ts'],
    ['re-export', 'modules/purchasing/application/re-export.ts'],
    ['export *', 'modules/purchasing/application/re-export-all.ts'],
    ['namespace import', 'modules/purchasing/application/namespace-import.ts'],
    ['상대경로', 'modules/purchasing/application/relative-path.ts'],
    ['테이블명 경로', 'modules/purchasing/application/table-name-path.ts'],
  ];

  it.each(BLOCKED_OTHER_MODULE)('%s → lint 실패', async (_label, path) => {
    const messages = await lint(path);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.severity).toBe(2);
  });
});

describe('★ 차단 — inventory 모듈 내부 (infrastructure 제외)', () => {
  const BLOCKED_INSIDE: ReadonlyArray<[string, string]> = [
    ['domain', 'modules/inventory/domain/direct-import.ts'],
    ['application', 'modules/inventory/application/direct-import.ts'],
    ['presentation', 'modules/inventory/presentation/direct-import.ts'],
  ];

  it.each(BLOCKED_INSIDE)('inventory %s → lint 실패', async (_label, path) => {
    const messages = await lint(path);
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe('★ 차단 — 동적 import·require 우회', () => {
  it('동적 import → lint 실패', async () => {
    const messages = await lint('modules/purchasing/application/dynamic-import.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('no-restricted-syntax');
    expect(messages[0]?.message).toContain('동적 import');
  });

  it('require() → lint 실패', async () => {
    const messages = await lint('modules/purchasing/application/require-call.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('no-restricted-syntax');
    expect(messages[0]?.message).toContain('require()');
  });
});

// ═══════════════════════════════════════════════════════════════
// 허용
// ═══════════════════════════════════════════════════════════════
describe('★ 허용', () => {
  const ALLOWED: ReadonlyArray<[string, string]> = [
    ['inventory infrastructure', 'modules/inventory/infrastructure/ledger-repository.ts'],
    ['infrastructure 의 동적 import·require', 'modules/inventory/infrastructure/dynamic-load.ts'],
    ['전환 스크립트', 'scripts/backfill-balance.ts'],
    ['마이그레이션·시드 스크립트', 'prisma/seed.ts'],
    ['다른 Prisma 모델', 'modules/purchasing/application/other-prisma-model.ts'],
    ['Prisma 네임스페이스·클라이언트', 'modules/purchasing/application/prisma-runtime.ts'],
    [
      'inventory application 공개 인터페이스',
      'modules/purchasing/application/via-application-interface.ts',
    ],
  ];

  it.each(ALLOWED)('%s → lint 통과', async (_label, path) => {
    expect(await lint(path)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 오류 메시지
// ═══════════════════════════════════════════════════════════════
describe('★ 오류 메시지', () => {
  it('모델명과 application 인터페이스 사용 원칙을 안내한다', async () => {
    const messages = await lint('modules/purchasing/application/named-import.ts');
    const text = messages[0]?.message ?? '';

    for (const model of RESTRICTED_INVENTORY_MODELS) {
      expect(text).toContain(model);
    }
    expect(text).toContain('application');
    expect(text).toContain('공개 인터페이스');
    expect(text).toContain('infrastructure');
  });

  it('모든 차단 메시지가 같은 안내를 포함한다', async () => {
    const paths = [
      'modules/purchasing/application/namespace-import.ts',
      'modules/inventory/domain/direct-import.ts',
      'modules/purchasing/application/dynamic-import.ts',
      'modules/purchasing/application/require-call.ts',
    ];

    for (const path of paths) {
      const messages = await lint(path);
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        expect(message.message).toContain('InventoryLedgerEntry');
        expect(message.message).toContain('공개 인터페이스');
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 구성 자체에 대한 검증
// ═══════════════════════════════════════════════════════════════
describe('★ 경계 구성', () => {
  it('차단 대상 모델은 두 개다', () => {
    expect([...RESTRICTED_INVENTORY_MODELS]).toEqual(['InventoryLedgerEntry', 'InventoryBalance']);
  });

  it('허용 위치에 inventory infrastructure 가 포함된다', () => {
    expect(INVENTORY_MODEL_ALLOWED_GLOBS).toContain('**/modules/inventory/infrastructure/**');
  });

  it('★ 허용 config 가 차단 config 뒤에 온다 (순서가 뒤집히면 차단이 무력화된다)', () => {
    const names = inventoryBoundaryConfigs.map((config) => config.name);
    expect(names).toEqual(['deeppoint/inventory-boundary', 'deeppoint/inventory-boundary-allowed']);
  });

  it('★ fixture 전체가 차단·허용 어느 한쪽으로 분류된다 (검사 누락 방지)', async () => {
    const collected: string[] = [];

    async function walk(directory: string, prefix: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(`${directory}/${entry.name}`, next);
        } else if (entry.name.endsWith('.ts')) {
          collected.push(next);
        }
      }
    }
    await walk(FIXTURE_ROOT, '');

    // fixture 21개가 모두 위 테스트에 등장해야 한다
    expect(collected.length).toBe(21);

    const results = await Promise.all(
      collected.map(async (path) => ({ path, messages: await lint(path) })),
    );

    const blocked = results.filter((r) => r.messages.length > 0).map((r) => r.path);
    const allowed = results.filter((r) => r.messages.length === 0).map((r) => r.path);

    expect(blocked).toHaveLength(14);
    expect(allowed).toHaveLength(7);

    // 허용 목록에 infrastructure·스크립트가 아닌 파일이 섞이지 않았는지 확인
    for (const path of allowed) {
      const isAllowedLocation =
        path.includes('modules/inventory/infrastructure/') ||
        path.startsWith('scripts/') ||
        path.startsWith('prisma/') ||
        path.includes('other-prisma-model') ||
        path.includes('prisma-runtime') ||
        path.includes('via-application-interface');
      expect(isAllowedLocation, `허용되면 안 되는 파일: ${path}`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 실제 프로젝트 설정
// ═══════════════════════════════════════════════════════════════
describe('★ 실제 eslint.config.ts', () => {
  it('★ fixture 는 pnpm lint 대상에서 제외된다', async () => {
    // 잘못된 예제가 전체 lint 를 상시 실패시키면 안 된다.
    const eslint = new ESLint({ cwd: PROJECT_ROOT });
    expect(
      await eslint.isPathIgnored(`${FIXTURE_ROOT}/modules/purchasing/application/named-import.ts`),
    ).toBe(true);
  });

  /**
   * 실제 소스 경로는 `lintText` 로 검사할 수 없다. T0-4 의 타입 인식 블록이
   * `src/**` 에 projectService 를 켜므로, 디스크에 없는 파일은 파싱 단계에서
   * 거부된다. 대신 **해당 경로에 규칙이 어떻게 적용되는지**를 직접 확인한다.
   * 규칙이 실제로 무엇을 잡는지는 위의 fixture 테스트가 검증한다.
   */
  /** calculateConfigForFile 은 severity 를 숫자로 정규화한다(off=0, error=2). */
  async function severityFor(relativePath: string, ruleId: string): Promise<number | undefined> {
    const eslint = new ESLint({ cwd: PROJECT_ROOT });
    const config = (await eslint.calculateConfigForFile(`${PROJECT_ROOT}/${relativePath}`)) as {
      rules?: Record<string, [number, ...unknown[]] | undefined>;
    };
    return config.rules?.[ruleId]?.[0];
  }

  it('★ 실제 소스 경로에 차단 규칙이 error 로 적용된다', async () => {
    for (const path of [
      'src/modules/purchasing/application/use-case.ts',
      'src/modules/inventory/domain/entity.ts',
      'src/modules/inventory/application/service.ts',
      'src/modules/inventory/presentation/route.ts',
      'src/shared/db/repository.ts',
    ]) {
      expect(await severityFor(path, 'no-restricted-imports'), path).toBe(2); // error
      expect(await severityFor(path, 'no-restricted-syntax'), path).toBe(2);
    }
  });

  it('★ inventory infrastructure 와 스크립트에서는 규칙이 off 다', async () => {
    for (const path of [
      'src/modules/inventory/infrastructure/ledger-repository.ts',
      'prisma/seed.ts',
      'scripts/backfill.ts',
    ]) {
      expect(await severityFor(path, 'no-restricted-imports'), path).toBe(0); // off
      expect(await severityFor(path, 'no-restricted-syntax'), path).toBe(0);
    }
  });

  it('★ 기존 shared 코드의 Prisma import 는 영향받지 않는다', async () => {
    const eslint = new ESLint({ cwd: PROJECT_ROOT });
    const results = await eslint.lintFiles([
      `${PROJECT_ROOT}/src/shared/db/prisma.ts`,
      `${PROJECT_ROOT}/src/shared/decimal/context.ts`,
      `${PROJECT_ROOT}/src/shared/db/transaction.ts`,
    ]);

    for (const result of results) {
      const messages = result.messages.filter((m) => RULE_IDS.includes(m.ruleId ?? ''));
      expect(messages, result.filePath).toEqual([]);
    }
  });
});
