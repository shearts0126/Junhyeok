import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

/** 원본 바이트 저장소. 운영은 비공개 객체 저장소(계획서 §3)로 교체하며 인터페이스는 동일하다. */
export interface RawStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** 복구 절차용: 저장된 키 전체 */
  list(): Promise<string[]>;
}

export class FsRawStore implements RawStore {
  constructor(private readonly rootDir: string) {}

  private path(key: string): string {
    if (key.includes('..') || key.startsWith('/')) throw new Error('잘못된 저장 키');
    return join(this.rootDir, key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    // 변경 없이 그대로 기록. 동일 키 재기록은 허용하지 않는다(키에 실행 ID 포함) → 재처리 시 중복 부작용 방지.
    await writeFile(p, bytes, { flag: 'wx' });
  }

  async get(key: string): Promise<Uint8Array> {
    return readFile(this.path(key));
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push(relative(this.rootDir, p).split('\\').join('/'));
      }
    };
    await walk(this.rootDir);
    return out.sort();
  }
}

export class MemoryRawStore implements RawStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.objects.has(key)) throw new Error(`중복 저장 키: ${key}`);
    this.objects.set(key, new Uint8Array(bytes));
  }
  async get(key: string): Promise<Uint8Array> {
    const v = this.objects.get(key);
    if (!v) throw new Error(`없는 저장 키: ${key}`);
    return v;
  }
  async list(): Promise<string[]> {
    return [...this.objects.keys()].sort();
  }
}
