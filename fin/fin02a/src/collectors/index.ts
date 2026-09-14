import { CollectorRegistry } from '../queue/registry';

import { KoreaeximFxCollector } from './koreaexim-fx';

/**
 * worker 와 enqueue CLI 가 공유하는 기본 레지스트리. 여기 등록된 키만 큐에서 처리된다.
 * koreaexim-fx 는 specStatus=SNIPPET_ONLY 이므로 정기(SCHEDULED) enqueue 는 NOT_SCHEDULABLE 로 거부되고 검증 모드로만 실행된다.
 */
export function defaultRegistry(): CollectorRegistry {
  return new CollectorRegistry().register('koreaexim-fx', new KoreaeximFxCollector());
}
