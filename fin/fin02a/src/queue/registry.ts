import type { Collector } from '../collector/types';

/** 수집기 레지스트리: 작업의 collector_key → 수집기 인스턴스. 등록되지 않은 키는 worker 가 외부 요청 없이 거부한다. */
export class CollectorRegistry {
  private readonly map = new Map<string, Collector<unknown, unknown>>();
  register(key: string, collector: Collector<unknown, unknown>): this {
    if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(key)) throw new Error(`잘못된 수집기 키: ${key}`);
    this.map.set(key, collector);
    return this;
  }
  get(key: string): Collector<unknown, unknown> | undefined {
    return this.map.get(key);
  }
  keys(): string[] {
    return [...this.map.keys()].sort();
  }
}
