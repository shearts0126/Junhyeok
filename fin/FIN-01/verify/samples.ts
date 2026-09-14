/**
 * 비식별 가상 샘플 로더. 모든 샘플은 _meta.synthetic === true 여야 하며,
 * 실제 원천 응답이 아니다. 실제 응답이 확보되면 별도 폴더로 분리한다.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');

export interface SampleMeta {
  synthetic: boolean;
  description: string;
  modeledOn: string;
}

export function loadSample<T>(fileName: string): { meta: SampleMeta; data: T } {
  const raw = JSON.parse(readFileSync(join(SAMPLES_DIR, fileName), 'utf8')) as {
    _meta?: SampleMeta;
    data?: T;
  };
  if (!raw._meta || raw._meta.synthetic !== true) {
    throw new Error(`샘플 ${fileName} 은 _meta.synthetic === true 표시가 필요하다`);
  }
  if (raw.data === undefined) throw new Error(`샘플 ${fileName} 에 data 가 없다`);
  return { meta: raw._meta, data: raw.data };
}

export function samplePath(fileName: string): string {
  return join(SAMPLES_DIR, fileName);
}
