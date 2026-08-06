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
 * 두 축으로 나눠 검증한다.
 *
 *   1. **구문 형태** — fixture 파일을 실제로 린트한다.
 *      허용 glob 이 저장소 루트 기준이므로 fixture 는 전부 차단 위치에 있다.
 *      `allowed/` 의 파일은 **위치와 무관하게** 통과해야 하는 코드다.
 *   2. **경로 정책** — 실제 소스 경로에 규칙이 어떻게 적용되는지
 *      `calculateConfigForFile` 로 확인한다. `src/**` 는 타입 인식 블록의
 *      projectService 때문에 디스크에 없는 파일을 린트할 수 없다.
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
// 1. 구문 형태 — 차단
// ═══════════════════════════════════════════════════════════════
describe('★ 차단 — 재고 원장·잔고 모델 직접 접근', () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ['named import', 'blocked/named-import.ts'],
    ['alias import', 'blocked/alias-import.ts'],
    ['type-only import', 'blocked/type-only-import.ts'],
    ['inline type import', 'blocked/inline-type-import.ts'],
    ['re-export', 'blocked/re-export.ts'],
    ['export *', 'blocked/re-export-all.ts'],
    ['namespace import', 'blocked/namespace-import.ts'],
    ['상대경로', 'blocked/relative-path.ts'],
    ['테이블명 경로', 'blocked/table-name-path.ts'],
  ];

  it.each(CASES)('%s → lint 실패', async (_label, path) => {
    const messages = await lint(path);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.severity).toBe(2);
  });
});

describe('★ 차단 — inventory infrastructure 직접 참조', () => {
  // 재고 모델 이름이 import 문에 나타나지 않아도, 영속성 계층을 직접 가져오면
  // application 공개 인터페이스 원칙이 무너진다.
  const CASES: ReadonlyArray<[string, string]> = [
    ['named import', 'blocked/infrastructure-named-import.ts'],
    ['상대경로 import', 'blocked/infrastructure-relative-import.ts'],
    ['re-export', 'blocked/infrastructure-re-export.ts'],
    ['동적 import', 'blocked/infrastructure-dynamic-import.ts'],
  ];

  it.each(CASES)('%s → lint 실패', async (_label, path) => {
    const messages = await lint(path);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.severity).toBe(2);
  });
});

describe('★ 차단 — 동적 import·require 우회', () => {
  it('동적 import → lint 실패', async () => {
    const messages = await lint('blocked/dynamic-import.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('no-restricted-syntax');
    expect(messages[0]?.message).toContain('동적 import');
  });

  it('require() → lint 실패', async () => {
    const messages = await lint('blocked/require-call.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('no-restricted-syntax');
    expect(messages[0]?.message).toContain('require()');
  });
});

describe('★ 차단 — 중첩된 가짜 scripts·prisma 폴더', () => {
  // 허용 glob 이 저장소 루트 기준이므로, 아무 데나 scripts/ 나 prisma/ 를
  // 만들어도 경계를 우회할 수 없다.
  it.each([
    ['가짜 scripts', 'blocked/nested-fake-scripts/backfill.ts'],
    ['가짜 prisma', 'blocked/nested-fake-prisma/seed.ts'],
  ])('%s → lint 실패', async (_label, path) => {
    expect((await lint(path)).length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 1. 구문 형태 — 허용
// ═══════════════════════════════════════════════════════════════
describe('★ 허용 — 위치와 무관하게 통과해야 하는 코드', () => {
  it.each([
    ['다른 Prisma 모델', 'allowed/other-prisma-model.ts'],
    ['Prisma 네임스페이스·클라이언트', 'allowed/prisma-runtime.ts'],
    ['inventory application 공개 인터페이스', 'allowed/via-application-interface.ts'],
  ])('%s → lint 통과', async (_label, path) => {
    expect(await lint(path)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 경로 정책
// ═══════════════════════════════════════════════════════════════
describe('★ 경로 정책', () => {
  /** calculateConfigForFile 은 severity 를 숫자로 정규화한다(off=0, error=2). */
  async function severityFor(relativePath: string, ruleId: string): Promise<number | undefined> {
    const eslint = new ESLint({ cwd: PROJECT_ROOT });
    const config = (await eslint.calculateConfigForFile(`${PROJECT_ROOT}/${relativePath}`)) as {
      rules?: Record<string, [number, ...unknown[]] | undefined>;
    };
    return config.rules?.[ruleId]?.[0];
  }

  async function isBlocked(relativePath: string): Promise<boolean> {
    return (await severityFor(relativePath, 'no-restricted-imports')) === 2;
  }

  it('★ 허용 — 루트 prisma/** 와 승인된 루트 스크립트 경로', async () => {
    for (const path of [
      'prisma/seed.ts',
      'prisma/migrations/backfill.ts',
      'scripts/migration/001-initial.ts',
      'scripts/data-migration/backfill-balance.ts',
      'scripts/seed/roles.ts',
      'src/modules/inventory/infrastructure/ledger-repository.ts',
      'src/modules/inventory/infrastructure/nested/deep.ts',
    ]) {
      expect(await severityFor(path, 'no-restricted-imports'), path).toBe(0);
      expect(await severityFor(path, 'no-restricted-syntax'), path).toBe(0);
    }
  });

  it('★ 차단 — 중첩된 가짜 scripts·prisma 폴더', async () => {
    // 승인 지시서가 명시한 우회 경로들
    for (const path of [
      'src/modules/orders/scripts/backfill.ts',
      'src/modules/orders/prisma/seed.ts',
      'src/modules/inventory/application/scripts/migrate.ts',
      'src/shared/prisma/helper.ts',
      'src/scripts/backfill.ts',
      'scripts/adhoc/backfill.ts',
    ]) {
      expect(await isBlocked(path), path).toBe(true);
    }
  });

  it('★ 차단 — inventory 모듈 내부 (infrastructure 제외)', async () => {
    for (const path of [
      'src/modules/inventory/domain/entity.ts',
      'src/modules/inventory/application/service.ts',
      'src/modules/inventory/presentation/route.ts',
    ]) {
      expect(await isBlocked(path), path).toBe(true);
    }
  });

  it('★ 차단 — 그 외 모든 모듈과 공유 계층', async () => {
    for (const path of [
      'src/modules/purchasing/application/use-case.ts',
      'src/shared/db/repository.ts',
      'src/app/api/stock/route.ts',
    ]) {
      expect(await isBlocked(path), path).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 오류 메시지
// ═══════════════════════════════════════════════════════════════
describe('★ 오류 메시지', () => {
  it('모델명과 application 인터페이스 사용 원칙을 안내한다', async () => {
    const text = (await lint('blocked/named-import.ts'))[0]?.message ?? '';

    for (const model of RESTRICTED_INVENTORY_MODELS) {
      expect(text).toContain(model);
    }
    expect(text).toContain('application');
    expect(text).toContain('공개 인터페이스');
    expect(text).toContain('infrastructure');
  });

  it('infrastructure 직접 참조에는 전용 안내가 나간다', async () => {
    const text = (await lint('blocked/infrastructure-named-import.ts'))[0]?.message ?? '';
    expect(text).toContain('infrastructure');
    expect(text).toContain('공개 인터페이스');
    expect(text).toContain('InventoryLedgerEntry');
  });

  it('모든 차단 메시지가 공개 인터페이스 원칙을 포함한다', async () => {
    for (const path of [
      'blocked/namespace-import.ts',
      'blocked/dynamic-import.ts',
      'blocked/require-call.ts',
      'blocked/infrastructure-re-export.ts',
      'blocked/nested-fake-scripts/backfill.ts',
    ]) {
      const messages = await lint(path);
      expect(messages.length, path).toBeGreaterThan(0);
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

  it('★ 허용 glob 은 모두 저장소 루트 기준이다 (접미 glob 금지)', () => {
    for (const glob of INVENTORY_MODEL_ALLOWED_GLOBS) {
      expect(glob.startsWith('**/'), glob).toBe(false);
      expect(glob.includes('/**/'), glob).toBe(false);
    }
    expect(INVENTORY_MODEL_ALLOWED_GLOBS).toContain('src/modules/inventory/infrastructure/**');
    expect(INVENTORY_MODEL_ALLOWED_GLOBS).toContain('prisma/**');
  });

  it('★ 허용 config 가 차단 config 뒤에 온다 (순서가 뒤집히면 차단이 무력화된다)', async () => {
    const names = inventoryBoundaryConfigs.map((config) => config.name);
    expect(names).toEqual(['deeppoint/inventory-boundary', 'deeppoint/inventory-boundary-allowed']);

    // 순서를 뒤집으면 허용 위치가 다시 차단된다 — 순서가 본질임을 고정한다
    const parser = (await import('@typescript-eslint/parser')).default;
    const reversed = new ESLint({
      cwd: PROJECT_ROOT,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'module' } },
        ...[...inventoryBoundaryConfigs].reverse(),
      ],
    });
    const config = (await reversed.calculateConfigForFile(
      `${PROJECT_ROOT}/src/modules/inventory/infrastructure/repository.ts`,
    )) as { rules?: Record<string, [number, ...unknown[]] | undefined> };

    expect(config.rules?.['no-restricted-imports']?.[0]).toBe(2);
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

    const results = await Promise.all(
      collected.map(async (path) => ({ path, messages: await lint(path) })),
    );

    for (const { path, messages } of results) {
      const shouldBlock = path.startsWith('blocked/');
      expect(messages.length > 0, `${path} 는 ${shouldBlock ? '차단' : '허용'}되어야 한다`).toBe(
        shouldBlock,
      );
    }

    expect(results.filter((r) => r.path.startsWith('blocked/'))).toHaveLength(17);
    expect(results.filter((r) => r.path.startsWith('allowed/'))).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// 실제 프로젝트 설정
// ═══════════════════════════════════════════════════════════════
describe('★ 실제 eslint.config.ts', () => {
  it('★ fixture 는 pnpm lint 대상에서 제외된다', async () => {
    // 잘못된 예제가 전체 lint 를 상시 실패시키면 안 된다.
    const eslint = new ESLint({ cwd: PROJECT_ROOT });
    expect(await eslint.isPathIgnored(`${FIXTURE_ROOT}/blocked/named-import.ts`)).toBe(true);
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
