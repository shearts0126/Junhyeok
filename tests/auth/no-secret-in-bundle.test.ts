import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * secret / service-role 키가 새어 나가지 않는지 확인한다 (T0-6).
 *
 * T0-6 은 Supabase Admin API 를 쓰지 않으므로 secret 키가 **아예 필요 없다.**
 * 필요 없는 키를 코드가 참조하고 있지 않은지 소스 전체를 훑는다.
 *
 * `NEXT_PUBLIC_` 접두사가 붙은 값은 클라이언트 번들에 그대로 들어간다.
 * `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` 같은 이름이 생기는 순간
 * service-role 키가 브라우저로 유출된다.
 */

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 소스에 나타나면 안 되는 환경변수명. */
const FORBIDDEN_ENV_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'NEXT_PUBLIC_SUPABASE_SECRET_KEY',
];

const SEARCH_DIRECTORIES = ['src', 'prisma/seed'];
const SKIP_DIRECTORIES = new Set(['generated', 'node_modules', '.next']);

async function collectSourceFiles(directory: string, collected: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await collectSourceFiles(path, collected);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      collected.push(path);
    }
  }
}

describe('★ secret·service-role 키 미사용', () => {
  it('★ 소스 어디에도 service-role / secret 키 이름이 없다', async () => {
    const files: string[] = [];
    for (const directory of SEARCH_DIRECTORIES) {
      await collectSourceFiles(`${PROJECT_ROOT}/${directory}`, files);
    }
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      // 이 테스트 파일 자신은 금지어를 목록으로 갖고 있으므로 제외한다
      if (file.endsWith('no-secret-in-bundle.test.ts')) continue;

      const content = await readFile(file, 'utf8');
      for (const name of FORBIDDEN_ENV_NAMES) {
        if (content.includes(name)) {
          offenders.push(`${file.replace(PROJECT_ROOT, '')} → ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('★ .env.example 에 service-role 키가 없다', async () => {
    const content = await readFile(`${PROJECT_ROOT}/.env.example`, 'utf8');

    for (const name of FORBIDDEN_ENV_NAMES) {
      expect(content.includes(name), name).toBe(false);
    }
  });

  it('.env.example 이 publishable key 를 안내한다', async () => {
    const content = await readFile(`${PROJECT_ROOT}/.env.example`, 'utf8');
    expect(content).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(content).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  });

  it('★ 권한 판정에 getSession() 을 쓰지 않는다', async () => {
    const files: string[] = [];
    await collectSourceFiles(`${PROJECT_ROOT}/src`, files);

    const offenders = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      // 주석에서의 언급(왜 쓰지 않는지 설명)은 허용한다.
      const codeLines = content
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
      if (codeLines.some((line) => line.includes('getSession('))) {
        offenders.push(file.replace(PROJECT_ROOT, ''));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('★ 인증 검증은 getClaims() 를 쓴다', async () => {
    const verify = await readFile(
      `${PROJECT_ROOT}/src/modules/auth/infrastructure/verify.ts`,
      'utf8',
    );
    expect(verify).toContain('getClaims');
  });
});
