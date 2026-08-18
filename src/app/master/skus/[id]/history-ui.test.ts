import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import {
  SKU_HISTORY_ENTITY_TYPES,
  SKU_HISTORY_PAGE_SIZE,
  parseSkuHistoryQuery,
} from '@/modules/sku/application';

import { PERMISSION_SEED, ROLE_PERMISSION_SEED } from '../../../../../prisma/seed/roles';
import { SKU_CREATE_TABS, SKU_DETAIL_TABS } from '../sku-form-fields';

import {
  HISTORY_ACTION_LABELS,
  HISTORY_ACTOR_LABEL,
  HISTORY_AFTER_LABEL,
  HISTORY_BEFORE_LABEL,
  HISTORY_EMPTY_MESSAGE,
  HISTORY_ENTITY_LABELS,
  HISTORY_PAGE_SIZE,
  HISTORY_QUERY_KEYS,
  HISTORY_REASON_LABEL,
  buildHistoryQuery,
  formatHistoryJson,
  hasHistoryReason,
  historyActionLabel,
  historyEntityLabel,
  historyTotalPages,
  skuHistoryApiPath,
  type HistoryRow,
} from './history-view';

/**
 * SKU 상세 변경이력 탭 helper 단위 테스트 (T1-6B3).
 *
 * 계약 근거는 `docs/16_설계복구_SKU상세잔여탭.md` §27~§40 이다. 화면 동작 자체는
 * `tests/e2e/history-tab.e2e.ts` 가 실 브라우저로 본다 — repo 의 unit 프로젝트는
 * node 환경이라 컴포넌트 렌더링 대역이 없다.
 *
 * ★ 이 파일은 **탭이 보내는 쿼리가 backend DTO 와 어긋나지 않는지**와
 *   **표시 규칙이 Recovery 결정 그대로인지**를 고정한다.
 */

const SKU_ID = '55555555-5555-4555-8555-555555555555';

const ROW: HistoryRow = {
  id: '66666666-6666-4666-8666-666666666666',
  entityType: 'Sku',
  entityId: SKU_ID,
  action: 'UPDATE',
  beforeValue: { skuName: '이전' },
  afterValue: { skuName: '이후' },
  actorId: '77777777-7777-4777-8777-777777777777',
  occurredAt: '2026-08-11T00:00:00.000Z',
  reason: null,
};

// ═══════════════════════════════════════════════════════════════
// 탭 구성 (docs/16 §37·§38)
// ═══════════════════════════════════════════════════════════════

describe('★ 상세 탭 구성 — 변경이력 추가', () => {
  it('1. 등록 화면은 여전히 3탭이다 — 변경이력 없음', () => {
    expect(SKU_CREATE_TABS.map((tab) => tab.key)).toEqual(['basic', 'classification', 'inventory']);
    expect(SKU_CREATE_TABS.map((tab) => tab.key) as readonly string[]).not.toContain('history');
    expect(SKU_CREATE_TABS.map((tab) => tab.label) as readonly string[]).not.toContain('변경이력');
  });

  it('2. ★ 상세 화면은 8탭이다 (T1-6B5 ⑦ BOM 추가로 원문 8탭 완성)', () => {
    expect(SKU_DETAIL_TABS).toHaveLength(8);
  });

  it('3. ★ 상세 탭 순서가 원문 8탭의 논리 순서다 (변경이력이 마지막)', () => {
    expect(SKU_DETAIL_TABS.map((tab) => tab.key)).toEqual([
      'basic',
      'classification',
      'barcode',
      'externalMapping',
      'inventory',
      'supplier',
      'bom',
      'history',
    ]);
    expect(SKU_DETAIL_TABS.map((tab) => tab.label)).toEqual([
      '기본정보',
      '코드·분류',
      '바코드',
      '외부시스템 매핑',
      '재고관리 설정',
      '공급조건',
      'BOM',
      '변경이력',
    ]);
    // ★ ⑥ 공급조건이 ⑤ 재고관리 설정과 ⑧ 변경이력 사이에 들어갔고,
    //   변경이력은 여전히 마지막이다 (⑦ BOM 은 T07 에서 그 사이로 들어온다).
  });

  it('4. ★ 공급조건·BOM 은 상세에만 있다 (T1-6B4 · T1-6B5)', () => {
    const createLabels = SKU_CREATE_TABS.map((tab) => tab.label);
    const detailLabels = SKU_DETAIL_TABS.map((tab) => tab.label);
    // ⑥ 공급조건은 상세 전용 child 탭이다 — 등록 화면에는 없다.
    expect(detailLabels).toContain('공급조건');
    expect(createLabels).not.toContain('공급조건');
    // ✏️ T1-6B5 에서 ⑦ BOM 이 **상세 전용** child 탭으로 추가됐다.
    expect(detailLabels).toContain('BOM');
    expect(createLabels).not.toContain('BOM');
  });
});

// ═══════════════════════════════════════════════════════════════
// 권한 (docs/16 §30)
// ═══════════════════════════════════════════════════════════════

describe('★ 권한 — sku.read 재사용', () => {
  const rolesFor = (key: string) =>
    ROLE_PERMISSION_SEED.filter((entry) => entry.permissionKey === key)
      .map((entry) => entry.roleCode)
      .sort();

  it('5. ★ 신규 permission 을 만들지 않았다', () => {
    const keys = PERMISSION_SEED.map((entry) => entry.permissionKey);
    expect(keys).not.toContain('audit.read');
    expect(keys).not.toContain('sku.history.read');
    expect(keys).toContain('sku.read');
  });

  it('6. `sku.read` 는 5역할 전부다 — 변경이력 탭도 같은 범위다', () => {
    expect(rolesFor('sku.read')).toEqual([
      'ADMIN',
      'EXECUTIVE',
      'FINANCE',
      'SCM_LEADER',
      'SCM_STAFF',
    ]);
  });

  it('7. ★ proxy 1차 정책은 기존 /api/skus GET 정책이 그대로 잡는다', () => {
    expect(resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/history`, method: 'GET' })).toBe(
      'sku.read',
    );
    // 상세 화면 진입도 같은 권한이라 별도 탭 visibility 필터가 없다.
    expect(resolveRoutePermission({ pathname: '/master/skus', method: 'GET' })).toBe('sku.read');
  });
});

// ═══════════════════════════════════════════════════════════════
// 쿼리 계약 (docs/16 §30)
// ═══════════════════════════════════════════════════════════════

describe('★ 쿼리 — page 하나뿐', () => {
  it('8. ★ 정확히 page 만 보낸다', () => {
    expect([...buildHistoryQuery(1).keys()]).toEqual(['page']);
    expect([...HISTORY_QUERY_KEYS]).toEqual(['page']);
  });

  it('9. ★ pageSize 를 보내지 않는다 (서버 고정 50)', () => {
    const params = buildHistoryQuery(3);
    expect(params.get('pageSize')).toBeNull();
    expect(HISTORY_PAGE_SIZE).toBe(50);
    expect(HISTORY_PAGE_SIZE).toBe(SKU_HISTORY_PAGE_SIZE);
  });

  it('10. ★ filter 계열 파라미터를 보내지 않는다', () => {
    const params = buildHistoryQuery(2);
    for (const forbidden of [
      'action',
      'entityType',
      'actorId',
      'dateFrom',
      'dateTo',
      'sort',
      'q',
    ]) {
      expect(params.get(forbidden), forbidden).toBeNull();
    }
  });

  it('11. page 는 1-base 이며 0·음수는 1 로 보정한다', () => {
    expect(buildHistoryQuery(1).get('page')).toBe('1');
    expect(buildHistoryQuery(5).get('page')).toBe('5');
    expect(buildHistoryQuery(0).get('page')).toBe('1');
    expect(buildHistoryQuery(-2).get('page')).toBe('1');
  });

  it('12. API 경로가 그 쿼리 그대로다', () => {
    expect(skuHistoryApiPath(SKU_ID, 2)).toBe(`/api/skus/${SKU_ID}/history?page=2`);
  });

  it('13. ★ 이 쿼리가 실제 backend DTO 를 통과한다', () => {
    expect(parseSkuHistoryQuery(buildHistoryQuery(2)).page).toBe(2);
    expect(parseSkuHistoryQuery(buildHistoryQuery(1)).page).toBe(1);
  });

  it('14. ★ backend 는 page 생략 시 1, 잘못된 page 는 400 이다', () => {
    expect(parseSkuHistoryQuery(new URLSearchParams()).page).toBe(1);
    expect(() => parseSkuHistoryQuery(new URLSearchParams('page=0'))).toThrow();
    expect(() => parseSkuHistoryQuery(new URLSearchParams('page=-1'))).toThrow();
    expect(() => parseSkuHistoryQuery(new URLSearchParams('page=abc'))).toThrow();
  });

  it('15. ★ backend 는 pageSize·기타 unknown 쿼리를 400 으로 거부한다', () => {
    for (const bad of ['pageSize=10', 'action=CREATE', 'entityType=Sku', 'sort=asc', 'foo=bar']) {
      expect(() => parseSkuHistoryQuery(new URLSearchParams(bad)), bad).toThrow();
    }
  });

  it('16. totalPages 는 0건이면 0 이다 (1 로 올리지 않는다)', () => {
    expect(historyTotalPages(0)).toBe(0);
    expect(historyTotalPages(1)).toBe(1);
    expect(historyTotalPages(50)).toBe(1);
    expect(historyTotalPages(51)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// entity / action 라벨 (docs/16 §33·§34)
// ═══════════════════════════════════════════════════════════════

describe('★ 라벨', () => {
  it('17. ★ entity 라벨은 Sku·SkuBarcode 둘뿐이다', () => {
    expect(Object.keys(HISTORY_ENTITY_LABELS).sort()).toEqual(['Sku', 'SkuBarcode']);
    expect(historyEntityLabel('Sku')).toBe('SKU');
    expect(historyEntityLabel('SkuBarcode')).toBe('바코드');
    // API scope 와 정확히 같다.
    expect(Object.keys(HISTORY_ENTITY_LABELS).sort()).toEqual([...SKU_HISTORY_ENTITY_TYPES].sort());
  });

  it('18. ★ 범위 밖 entity 라벨을 만들지 않았다 (registry 금지)', () => {
    for (const outside of ['SkuExternalMapping', 'CommonCode', 'SystemSetting', 'SupplierSku']) {
      expect(HISTORY_ENTITY_LABELS[outside], outside).toBeUndefined();
      // fallback 은 원문 그대로다.
      expect(historyEntityLabel(outside)).toBe(outside);
    }
  });

  it('19. ★ known action 8종의 한글 라벨', () => {
    expect(HISTORY_ACTION_LABELS).toEqual({
      CREATE: '등록',
      UPDATE: '수정',
      SUBMIT: '승인 요청',
      APPROVE: '승인',
      REJECT: '반려',
      DEACTIVATE: '비활성화',
      REQUEST_DUPLICATE: '중복 예외 요청',
      APPROVE_DUPLICATE: '중복 예외 승인',
    });
  });

  it('20. ★ unknown action 은 원문 그대로 fallback 한다', () => {
    expect(historyActionLabel('FUTURE_ACTION')).toBe('FUTURE_ACTION');
    expect(historyActionLabel('REACTIVATE')).toBe('REACTIVATE');
    expect(historyActionLabel('')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// reason / actor (docs/16 §32·§35)
// ═══════════════════════════════════════════════════════════════

describe('★ 사유·변경자', () => {
  it('21. reason 은 값이 있을 때만 표시 대상이다', () => {
    expect(hasHistoryReason(null)).toBe(false);
    expect(hasHistoryReason('')).toBe(false);
    expect(hasHistoryReason('   ')).toBe(false);
    expect(hasHistoryReason('반려 사유')).toBe(true);
  });

  it('22. ★ 라벨이 note/reason 양쪽 semantics 를 담는다', () => {
    expect(HISTORY_REASON_LABEL).toBe('사유/메모');
    expect(HISTORY_ACTOR_LABEL).toBe('변경자');
  });

  it('23. ★ 승인자·technical metadata 표시 helper 가 없다', async () => {
    const historyView = await import('./history-view');
    for (const name of Object.keys(historyView)) {
      expect(name, name).not.toMatch(/approvedBy|approver|승인자|sessionId|ipAddress|requestId/i);
    }
    // 행 타입에도 그 필드들이 없다.
    const keys = Object.keys(ROW);
    for (const forbidden of ['approvedBy', 'requestId', 'sessionId', 'ipAddress']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// diff (docs/16 §33)
// ═══════════════════════════════════════════════════════════════

describe('★ diff — 저장된 JSON 원형', () => {
  it('24. 라벨은 변경 전/후다', () => {
    expect(HISTORY_BEFORE_LABEL).toBe('변경 전');
    expect(HISTORY_AFTER_LABEL).toBe('변경 후');
  });

  it('25. object 는 2-space pretty print 다', () => {
    expect(formatHistoryJson({ a: 1, b: 'x' })).toBe('{\n  "a": 1,\n  "b": "x"\n}');
  });

  it('26. ★ null 은 `null` 로 표시한다 (JSON null·SQL NULL 구분 없음)', () => {
    expect(formatHistoryJson(null)).toBe('null');
    expect(formatHistoryJson(undefined)).toBe('null');
  });

  it('27. ★ nested object·array 를 평탄화하지 않는다', () => {
    const nested = { brand: { id: 'b1', code: 'FB', name: '브랜드', active: true }, tags: [1, 2] };
    const printed = formatHistoryJson(nested);
    expect(printed).toContain('"brand"');
    expect(printed).toContain('"code": "FB"');
    expect(printed).toContain('"tags"');
    expect(JSON.parse(printed)).toEqual(nested);
  });

  it('28. ★ 값 자체를 변형하지 않는다 — Decimal 문자열·ISO 날짜·REDACTED 그대로', () => {
    const stored = {
      unitConversionQty: '2.500000',
      createdAt: '2026-08-11T00:00:00.000Z',
      password: '[REDACTED]',
      sellable: false,
      note: null,
    };
    expect(JSON.parse(formatHistoryJson(stored))).toEqual(stored);
  });

  it('29. ★ unknown future key 도 그대로 나온다 (label mapping 없음)', () => {
    const printed = formatHistoryJson({ brandNewField: 'x' });
    expect(printed).toContain('"brandNewField"');
  });

  it('30. 빈 목록 문구', () => {
    expect(HISTORY_EMPTY_MESSAGE).toBe('변경이력이 없습니다.');
  });
});
