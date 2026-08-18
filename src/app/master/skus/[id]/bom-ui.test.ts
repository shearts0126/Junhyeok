import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveRoutePermission } from '@/modules/auth/application/route-policy';
import { BOM_PAGE_SIZE as API_PAGE_SIZE, BOM_STATUSES } from '@/modules/bom/application/dto';

import { SKU_CREATE_TABS, SKU_DETAIL_TABS } from '../sku-form-fields';

import * as bomView from './bom-view';
import {
  bomManageLinkPath,
  bomStatusLabel,
  bomTypeLabel,
  componentRoleLabel,
  formatEffectivePeriod,
  formatQuantityPer,
  formatQuantityProgress,
  hasUnconfirmedQuantity,
  orDash,
  quantityStatusLabel,
  requiredLabel,
  skuParentBomsApiPath,
  skuWhereUsedApiPath,
  BOM_STATUS_LABELS,
  BOM_TAB_MANAGE_LINK_ENABLED,
  BOM_TAB_PAGE_SIZE,
  BOM_TAB_PARENT_COLUMNS,
  BOM_TAB_PARENT_QUERY_KEYS,
  BOM_TAB_WHERE_USED_COLUMNS,
  type ParentBomRow,
} from './bom-view';
import { resolveActiveSkuDetailTab, visibleSkuDetailTabs } from './detail-tabs';

/**
 * SKU 상세 ⑦ BOM 탭 단위 테스트 (T1-6B5) — 브라우저 없이 고정하는 계약.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-30(⑦탭 경계) · §D-5·§D-6·§D-10·§D-15.
 *
 *   - 8탭 최종 순서 — BOM 은 **공급조건 뒤 · 변경이력 앞**
 *   - 탭 노출은 **`bom.read` 하나** — ★ EXECUTIVE 포함(⑥ 탭과 정반대)
 *   - 권한 상실 시 `basic` fallback
 *   - 두 endpoint exact path — ⛔ `/api/skus/{id}/boms` 같은 오탈자 금지
 *   - `unconfirmedCount` 는 `CONFIRMED` 아님(= `SUGGESTED` 포함) — "UNKNOWN 수" 아님
 *   - `quantityPer=null` 은 `—` (⛔ `0` 아님) · Decimal 문자열 그대로
 *   - `effectiveTo=null` 은 무기한 · 날짜 재파싱 없음
 *   - read-only — mutation helper 가 하나도 없다
 */

const SKU_ID = '11111111-1111-4111-8111-111111111111';
const BOM_ID = '22222222-2222-4222-8222-222222222222';

/**
 * ★ 주석을 걷어낸 **실행 코드**만 남긴다.
 *
 * 아래 R2·R4 검사는 "화면에 이런 문자열이 나오는가 / 코드가 이런 값을
 * 조립하는가"를 본다. 설명 주석에 `bomCode`·"BOM 코드"·`/master/boms` 가
 * 등장하는 것은 **금지 대상이 아니다** — 오히려 왜 만들지 않는지를 적어둔
 * 문장이다. 주석까지 걸면 그 설명을 지워야만 통과하게 되어 의도가 뒤집힌다.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function parentRow(overrides: Partial<ParentBomRow> = {}): ParentBomRow {
  return {
    id: BOM_ID,
    parentSkuId: SKU_ID,
    parentSku: { id: SKU_ID, skuCode: 'FB-OY-CW-001', skuName: '완제품' },
    bomType: 'MANUFACTURING',
    version: '1.0',
    status: 'DRAFT',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    lineCount: 10,
    unconfirmedCount: 3,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// 8탭 최종 순서 (D-30)
// ═══════════════════════════════════════════════════════════════

describe('★ SKU 상세 최종 8탭 (D-30)', () => {
  it('★ 정확히 8개이며 BOM 은 공급조건 뒤 · 변경이력 앞이다', () => {
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
  });

  it('BOM 탭 라벨은 `BOM` 이다', () => {
    expect(SKU_DETAIL_TABS.find((tab) => tab.key === 'bom')?.label).toBe('BOM');
  });

  it('★ 기존 탭의 상대 순서가 바뀌지 않았다', () => {
    const keys = SKU_DETAIL_TABS.map((tab) => tab.key) as readonly string[];
    expect(keys.indexOf('supplier')).toBeLessThan(keys.indexOf('bom'));
    expect(keys.indexOf('bom')).toBeLessThan(keys.indexOf('history'));
    expect(keys.indexOf('inventory')).toBeLessThan(keys.indexOf('supplier'));
  });

  it('★ 생성 화면에는 BOM 탭이 없다 — child 탭은 상세 전용이다', () => {
    expect(SKU_CREATE_TABS.map((tab) => tab.key)).toEqual(['basic', 'classification', 'inventory']);
    expect(SKU_CREATE_TABS.some((tab) => (tab.key as string) === 'bom')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 탭 노출 권한 (D-15)
// ═══════════════════════════════════════════════════════════════

const ALL_TAB_PERMISSIONS = [
  'barcode.read',
  'external_mapping.read',
  'supplier.read',
  'supplier_price.read',
  'bom.read',
];

function visibleKeys(permissions: readonly string[] | null): readonly string[] {
  return visibleSkuDetailTabs({ permissions }).map((tab) => tab.key);
}

describe('★ BOM 탭 노출은 `bom.read` 하나로 판정한다 (D-15)', () => {
  it('bom.read 가 있으면 보인다', () => {
    expect(visibleKeys(['bom.read'])).toContain('bom');
  });

  it('★ bom.read 가 없으면 숨는다 — 다른 권한으로 대체되지 않는다', () => {
    expect(visibleKeys([])).not.toContain('bom');
    expect(visibleKeys(['sku.read'])).not.toContain('bom');
    // 공급조건 권한이 있어도 BOM 은 열리지 않는다.
    expect(visibleKeys(['supplier.read', 'supplier_price.read'])).not.toContain('bom');
  });

  it('★ 로딩 중(null)은 "없음"으로 본다 — 깜빡였다 사라지지 않는다', () => {
    expect(visibleKeys(null)).not.toContain('bom');
  });

  it('★ 역할이 아니라 permission fact 로 판정한다 — 5역할 전부 bom.read 를 가진다', () => {
    // ADMIN · SCM_LEADER · SCM_STAFF · FINANCE · EXECUTIVE 전부 bom.read 보유(D-15).
    // 테스트는 role 이름을 쓰지 않고 **권한 fixture** 로만 검증한다.
    for (const label of ['ADMIN', 'SCM_LEADER', 'SCM_STAFF', 'FINANCE', 'EXECUTIVE']) {
      expect(visibleKeys(['bom.read']), label).toContain('bom');
    }
  });

  it('★★ EXECUTIVE 시나리오 — BOM 은 보이고 공급조건은 숨는다 (정반대 계약)', () => {
    // EXECUTIVE 실제 권한: bom.read 는 있고 supplier.* 는 없다.
    const keys = visibleKeys(['sku.read', 'bom.read']);
    expect(keys).toContain('bom');
    expect(keys).not.toContain('supplier');
  });

  it('★ FINANCE 시나리오 — BOM read 가 보인다 (mutation 권한은 애초에 UI 에 없다)', () => {
    const keys = visibleKeys(['supplier.read', 'supplier_price.read', 'bom.read']);
    expect(keys).toContain('bom');
    expect(keys).toContain('supplier');
  });

  it('권한이 전부 있으면 8탭이 모두 보인다', () => {
    expect(visibleKeys(ALL_TAB_PERMISSIONS)).toHaveLength(8);
  });

  it('★ 기존 탭 노출 규칙이 회귀하지 않았다', () => {
    expect(visibleKeys(['barcode.read'])).toContain('barcode');
    expect(visibleKeys(['external_mapping.read'])).toContain('externalMapping');
    // 공급조건은 여전히 두 권한을 모두 요구한다.
    expect(visibleKeys(['supplier.read'])).not.toContain('supplier');
    // 권한이 필요 없는 탭은 항상 보인다.
    expect(visibleKeys([])).toEqual(['basic', 'classification', 'inventory', 'history']);
  });
});

describe('★ 권한 상실 fallback (T1-6B4 와 같은 계약)', () => {
  it('★ BOM 탭 선택 중 bom.read 를 잃으면 basic 으로 되돌아간다', () => {
    const before = visibleSkuDetailTabs({ permissions: ['bom.read'] });
    expect(resolveActiveSkuDetailTab('bom', before)).toBe('bom');

    const after = visibleSkuDetailTabs({ permissions: [] });
    expect(resolveActiveSkuDetailTab('bom', after)).toBe('basic');
  });

  it('권한이 유지되면 선택이 보존된다', () => {
    const visible = visibleSkuDetailTabs({ permissions: ALL_TAB_PERMISSIONS });
    expect(resolveActiveSkuDetailTab('bom', visible)).toBe('bom');
  });

  it('로딩 중에도 basic 으로 떨어진다', () => {
    const visible = visibleSkuDetailTabs({ permissions: null });
    expect(resolveActiveSkuDetailTab('bom', visible)).toBe('basic');
  });

  // ── remediation R3 — 4단계 계약을 한 곳에 고정한다 ─────────────
  it('★★ ① 있음 → 보임 · ② 없음 → 숨김 · ③ 선택 중 상실 → basic', () => {
    const withRead = visibleSkuDetailTabs({ permissions: ['sku.read', 'bom.read'] });
    // ① 보인다.
    expect(withRead.map((tab) => tab.key)).toContain('bom');
    // ③ 선택 상태가 보존된다.
    expect(resolveActiveSkuDetailTab('bom', withRead)).toBe('bom');

    const withoutRead = visibleSkuDetailTabs({ permissions: ['sku.read'] });
    // ② 숨는다 — 다른 권한이 대신 열어주지 않는다.
    expect(withoutRead.map((tab) => tab.key)).not.toContain('bom');
    // ③ 선택 중이던 탭이 basic 으로 되돌아간다.
    expect(resolveActiveSkuDetailTab('bom', withoutRead)).toBe('basic');
  });

  it('★★ ④ 권한이 없으면 `BomTab` 자체가 마운트되지 않는다 → 자식 fetch 0', () => {
    // 렌더 분기는 `activeTab === 'bom'` 하나뿐이다. 위 ③ 에서 activeTab 이
    // 'basic' 으로 확정되므로 `BomTab` 이 마운트되지 않고, 따라서 그 안의
    // 두 `useEffect` fetch(`/api/boms`·`/where-used`)도 발생하지 않는다.
    const client = codeOnly(
      readFileSync(new URL('./sku-detail-client.tsx', import.meta.url), 'utf8'),
    );
    expect(client).toContain("activeTab === 'bom'");
    // ⛔ 탭 선택과 무관하게 항상 렌더되는 자리에 BomTab 이 없다.
    expect(client.match(/<BomTab\b/g) ?? []).toHaveLength(1);
    // activeTab 은 반드시 fallback 을 거친 값이다 — 원본 `tab` 을 직접 쓰지 않는다.
    expect(client).toContain('resolveActiveSkuDetailTab(tab, visibleTabs)');

    // 두 fetch 는 BomTab 컴포넌트 안에만 있다 — 상위에서 미리 부르지 않는다.
    const tabSource = codeOnly(readFileSync(new URL('./bom-tab.tsx', import.meta.url), 'utf8'));
    expect(tabSource.match(/fetch\(/g) ?? []).toHaveLength(2);
    expect(client).not.toContain('/api/boms');
    expect(client).not.toContain('where-used');
  });

  it('★ 판정에 role 이름을 쓰지 않는다 — permission key 로만 본다', () => {
    const source = codeOnly(readFileSync(new URL('./detail-tabs.ts', import.meta.url), 'utf8'));
    const logic = source.slice(source.indexOf('export function visibleSkuDetailTabs'));
    for (const role of ['ADMIN', 'SCM_LEADER', 'SCM_STAFF', 'FINANCE', 'EXECUTIVE']) {
      expect(logic, role).not.toContain(`'${role}'`);
    }
    expect(logic).toContain("'bom.read'");
  });
});

// ═══════════════════════════════════════════════════════════════
// endpoint exact path (D-30)
// ═══════════════════════════════════════════════════════════════

describe('★ 두 endpoint 를 정확히 호출한다', () => {
  it('★ 섹션 A — `GET /api/boms?parentSkuId=…&page=…`', () => {
    expect(skuParentBomsApiPath(SKU_ID, 1)).toBe(`/api/boms?parentSkuId=${SKU_ID}&page=1`);
    expect(skuParentBomsApiPath(SKU_ID, 3)).toBe(`/api/boms?parentSkuId=${SKU_ID}&page=3`);
  });

  it('page 는 1 미만이면 1 로 보정한다', () => {
    expect(skuParentBomsApiPath(SKU_ID, 0)).toContain('page=1');
    expect(skuParentBomsApiPath(SKU_ID, -5)).toContain('page=1');
  });

  it('★ 섹션 A 는 parentSkuId·page 외의 필터를 붙이지 않는다', () => {
    const query = new URL(`https://x${skuParentBomsApiPath(SKU_ID, 2)}`).searchParams;
    expect([...query.keys()].sort()).toEqual([...BOM_TAB_PARENT_QUERY_KEYS].sort());
    for (const forbidden of [
      'status',
      'effectiveOn',
      'hasUnknownQty',
      'bomType',
      'q',
      'pageSize',
    ]) {
      expect(query.has(forbidden), forbidden).toBe(false);
    }
  });

  it('★ 섹션 B — `GET /api/skus/{id}/where-used`, 쿼리 없음', () => {
    expect(skuWhereUsedApiPath(SKU_ID)).toBe(`/api/skus/${SKU_ID}/where-used`);
    expect(skuWhereUsedApiPath(SKU_ID)).not.toContain('?');
  });

  it('★ 존재하지 않는 경로를 쓰지 않는다', () => {
    const paths = [skuParentBomsApiPath(SKU_ID, 1), skuWhereUsedApiPath(SKU_ID)];
    for (const wrong of [`/api/skus/${SKU_ID}/boms`, `/api/boms/${SKU_ID}/where-used`]) {
      expect(paths).not.toContain(wrong);
    }
  });

  it('페이지 크기는 backend 고정값과 같다', () => {
    expect(BOM_TAB_PAGE_SIZE).toBe(50);
    expect(BOM_TAB_PAGE_SIZE).toBe(API_PAGE_SIZE);
  });
});

describe('★ proxy first-match — 두 경로의 권한 (D-15)', () => {
  it('두 endpoint 모두 `bom.read` 다', () => {
    expect(resolveRoutePermission({ pathname: '/api/boms', method: 'GET' })).toBe('bom.read');
    expect(
      resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}/where-used`, method: 'GET' }),
    ).toBe('bom.read');
  });

  it('★ where-used 가 일반 `/api/skus` 정책(`sku.read`)에 shadow 되지 않는다', () => {
    expect(resolveRoutePermission({ pathname: `/api/skus/${SKU_ID}`, method: 'GET' })).toBe(
      'sku.read',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 소요량 진행률 (T07-3 확정 semantics)
// ═══════════════════════════════════════════════════════════════

describe('★★ 소요량 진행률 — unconfirmedCount 는 SUGGESTED 를 포함한다', () => {
  it('★ 확정 = 전체 − 미확정', () => {
    expect(formatQuantityProgress(10, 3)).toBe('확정 7 / 전체 10');
    expect(formatQuantityProgress(5, 0)).toBe('확정 5 / 전체 5');
    expect(formatQuantityProgress(0, 0)).toBe('확정 0 / 전체 0');
  });

  it('★★ "UNKNOWN N건" 으로 표시하지 않는다 — SUGGESTED 가 미입력으로 둔갑한다', () => {
    const text = formatQuantityProgress(10, 3);
    expect(text).not.toContain('UNKNOWN');
    expect(text).not.toContain('미입력');
    expect(text).toContain('확정');
  });

  it('미확정이 1건이라도 있으면 강조 대상이다', () => {
    expect(hasUnconfirmedQuantity(parentRow({ unconfirmedCount: 1 }))).toBe(true);
    expect(hasUnconfirmedQuantity(parentRow({ unconfirmedCount: 0 }))).toBe(false);
  });

  it('★ 라인 상세를 다시 부르지 않는다 — 목록 응답의 두 수만 쓴다', () => {
    // helper 가 row 두 필드 외에는 아무것도 요구하지 않는다(N+1 없음).
    expect(formatQuantityProgress(parentRow().lineCount, parentRow().unconfirmedCount)).toBe(
      '확정 7 / 전체 10',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 표시 계약
// ═══════════════════════════════════════════════════════════════

describe('★ 소요량 표시 — UNKNOWN 은 `—` 이며 0 이 아니다 (D-10)', () => {
  it('null 은 `—`', () => {
    expect(formatQuantityPer(null, 'EA')).toBe('—');
    expect(formatQuantityPer(null, 'EA')).not.toBe('0');
    expect(formatQuantityPer(null, 'EA')).not.toContain('0');
  });

  it('★ Decimal 문자열을 그대로 쓴다 — 숫자 변환·반올림 없음', () => {
    expect(formatQuantityPer('0.033333', 'EA')).toBe('0.033333 EA');
    expect(formatQuantityPer('1.000000', 'KG')).toBe('1.000000 KG');
    expect(formatQuantityPer('12345678901.123456', 'EA')).toBe('12345678901.123456 EA');
  });

  it('★ 0 은 실재하는 값이라 그대로 보인다 — `—` 와 다르다', () => {
    expect(formatQuantityPer('0', 'EA')).toBe('0 EA');
  });
});

describe('★ 적용기간 — 반열림 `[from, to)` 를 훼손하지 않는다 (D-5)', () => {
  it('effectiveTo=null 은 무기한이다 — 오늘 날짜를 채우지 않는다', () => {
    expect(formatEffectivePeriod('2026-01-01', null)).toBe('2026-01-01 ~ 무기한');
  });

  it('★ 날짜 문자열을 재파싱하지 않는다 — 하루 밀림 없음', () => {
    expect(formatEffectivePeriod('2026-01-01', '2027-01-01')).toBe('2026-01-01 ~ 2027-01-01');
    // 입력 문자열이 출력에 **그대로** 들어 있다.
    expect(formatEffectivePeriod('2026-03-01', '2026-12-31')).toContain('2026-03-01');
    expect(formatEffectivePeriod('2026-03-01', '2026-12-31')).toContain('2026-12-31');
  });
});

describe('★ status 라벨 — 7종을 합치지 않는다 (D-6)', () => {
  it('BomStatus 7종 전부 라벨이 있다', () => {
    expect(Object.keys(BOM_STATUS_LABELS).sort()).toEqual([...BOM_STATUSES].sort());
  });

  // ── remediation R1 — exact key coverage ──────────────────────
  //
  // 위 테스트는 `BOM_STATUSES`(DTO) 와의 **정합**만 본다. DTO 자체가 틀리면
  // 둘이 나란히 틀린 채 통과하므로, authoritative 7종을 **리터럴로 한 번 더**
  // 못 박는다. 근거는 `prisma/schema.prisma` `enum BomStatus` 다.
  it('★★ authoritative 7종 exact key — DTO 도 함께 검증한다', () => {
    const AUTHORITATIVE = [
      'DRAFT',
      'PENDING_APPROVAL',
      'REJECTED',
      'APPROVED',
      'ACTIVE',
      'INACTIVE',
      'ARCHIVED',
    ];
    expect([...BOM_STATUSES].sort()).toEqual([...AUTHORITATIVE].sort());
    expect(Object.keys(BOM_STATUS_LABELS).sort()).toEqual([...AUTHORITATIVE].sort());
    expect(Object.keys(BOM_STATUS_LABELS)).toHaveLength(7);
  });

  it('★★ `PENDING` 은 key 가 아니다 — exact key 는 `PENDING_APPROVAL` 이다', () => {
    expect(Object.keys(BOM_STATUS_LABELS)).toContain('PENDING_APPROVAL');
    expect(Object.keys(BOM_STATUS_LABELS)).not.toContain('PENDING');
    expect(bomStatusLabel('PENDING_APPROVAL')).toBe('승인대기');
    // 축약형은 미지의 값이므로 라벨이 붙지 않고 원문이 나온다.
    expect(bomStatusLabel('PENDING')).toBe('PENDING');
  });

  it('★★ `APPROVED` 는 누락되지 않으며 `ACTIVE` 와 다른 값이다', () => {
    expect(bomStatusLabel('APPROVED')).toBe('승인됨');
    expect(bomStatusLabel('APPROVED')).not.toBe(bomStatusLabel('ACTIVE'));
    // 승인 완료(APPROVED) ≠ 발효 중(ACTIVE) — 두 사실을 합치지 않는다.
    expect(bomStatusLabel('APPROVED')).not.toContain('활성');
  });

  it('★★ `ARCHIVED` 는 누락되지 않으며 `INACTIVE` 와 다른 값이다', () => {
    expect(bomStatusLabel('ARCHIVED')).toBe('보관');
    expect(bomStatusLabel('ARCHIVED')).not.toBe(bomStatusLabel('INACTIVE'));
  });

  it('★★ 7종 중 어느 것도 fallback(원문 노출)으로 새지 않는다', () => {
    for (const status of BOM_STATUSES) {
      // 라벨이 붙었다면 결과가 enum key 원문과 달라야 한다.
      expect(bomStatusLabel(status), status).not.toBe(status);
    }
  });

  it('★ 라벨이 서로 겹치지 않는다', () => {
    const labels = Object.values(BOM_STATUS_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('★ ACTIVE 를 "현재 적용중"으로 오역하지 않는다 — status 와 기간은 다른 축이다', () => {
    expect(bomStatusLabel('ACTIVE')).toBe('활성');
    expect(bomStatusLabel('ACTIVE')).not.toContain('현재');
    expect(bomStatusLabel('ACTIVE')).not.toContain('적용중');
  });

  it('미지의 status 는 원문 그대로 보여준다 — 조용히 숨기지 않는다', () => {
    expect(bomStatusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('enum 라벨 helper', () => {
  it('bomType 3종', () => {
    expect(bomTypeLabel('MANUFACTURING')).toBe('제조');
    expect(bomTypeLabel('KIT')).toBe('키트');
    expect(bomTypeLabel('REPACK')).toBe('재포장');
    expect(bomTypeLabel('XX')).toBe('XX');
  });

  it('componentRole 4종 — SERVICE 는 임가공이다', () => {
    expect(componentRoleLabel('SERVICE')).toBe('임가공');
    expect(componentRoleLabel('MATERIAL')).toBe('자재');
    expect(componentRoleLabel('PACKAGING')).toBe('포장');
    expect(componentRoleLabel('PRODUCT')).toBe('제품');
  });

  it('quantityStatus 3종 — SUGGESTED 는 확정이 아니다', () => {
    expect(quantityStatusLabel('CONFIRMED')).toBe('확정');
    expect(quantityStatusLabel('SUGGESTED')).toBe('추천');
    expect(quantityStatusLabel('UNKNOWN')).toBe('미입력');
    expect(quantityStatusLabel('SUGGESTED')).not.toBe(quantityStatusLabel('CONFIRMED'));
  });

  it('isRequired 라벨', () => {
    expect(requiredLabel(true)).toBe('필수');
    expect(requiredLabel(false)).toBe('선택');
  });

  it('orDash — null·빈 문자열은 `—`', () => {
    expect(orDash(null)).toBe('—');
    expect(orDash('   ')).toBe('—');
    expect(orDash('ALT-A')).toBe('ALT-A');
  });
});

// ═══════════════════════════════════════════════════════════════
// read-only 경계 (D-30)
// ═══════════════════════════════════════════════════════════════

describe('★★ read-only — mutation helper 가 하나도 없다', () => {
  it('★ view 모듈이 내보내는 경로 helper 는 GET 두 개뿐이다', () => {
    const pathHelpers = Object.keys(bomView).filter((name) => name.endsWith('ApiPath'));
    expect(pathHelpers.sort()).toEqual(['skuParentBomsApiPath', 'skuWhereUsedApiPath']);
  });

  it('★ mutation·워크플로·전개·원가 helper 이름이 존재하지 않는다', () => {
    const names = Object.keys(bomView).join(' ').toLowerCase();
    for (const forbidden of [
      'create',
      'update',
      'delete',
      'submit',
      'approve',
      'reject',
      'activate',
      'deactivate',
      'archive',
      'clone',
      'import',
      'explode',
      'cost',
      // ⚠️ `confirm` 은 넣지 않는다 — `hasUnconfirmedQuantity`(표시 판정)에
      //    부분 문자열로 걸린다. 대신 실제 mutation 이름을 아래에서 본다.
      'bulkconfirm',
      'confirmquantity',
      'savequantity',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it('★ T07-8 이 없으므로 관리 링크를 렌더하지 않는다 (R4 — deferred rendering)', () => {
    // `/master/boms/{id}` 는 T07-8 소관이라 아직 404 다. 활성 링크를 만들면
    // 사용자를 없는 화면으로 보내므로, route 가 생길 때 함께 켠다.
    expect(BOM_TAB_MANAGE_LINK_ENABLED).toBe(false);
  });

  it('★ 토글은 dead marker 가 아니다 — 컴포넌트가 실제로 조건으로 쓴다 (R4)', () => {
    const source = codeOnly(readFileSync(new URL('./bom-tab.tsx', import.meta.url), 'utf8'));
    // 머리글 열과 셀 렌더 두 곳 모두 이 상수를 조건으로 본다.
    expect(source).toContain('BOM_TAB_MANAGE_LINK_ENABLED &&');
    expect(source).toContain('if (!BOM_TAB_MANAGE_LINK_ENABLED) return null;');
    // 경로 계약은 helper 가 고정한다 — T07-8 은 토글만 켜면 된다.
    expect(bomManageLinkPath(BOM_ID)).toBe(`/master/boms/${BOM_ID}`);
    // ⛔ 토글이 꺼진 동안 helper 를 우회해 경로를 직접 조립하지 않는다.
    expect(source).not.toContain("'/master/boms");
    expect(source).not.toContain('`/master/boms');
  });
});

// ═══════════════════════════════════════════════════════════════
// R2 — 표시 식별자 계약: `BomHeader` 에 `bomCode` 는 없다
// ═══════════════════════════════════════════════════════════════

describe('★★ 표 열 이름은 실제 표시 필드와 일치한다 (R2)', () => {
  const PARENT_SOURCE = codeOnly(readFileSync(new URL('./bom-tab.tsx', import.meta.url), 'utf8'));

  it('★ 섹션 A 열 — 버전·유형·상태·적용기간·구성품 수·소요량 확정', () => {
    expect([...BOM_TAB_PARENT_COLUMNS]).toEqual([
      '버전',
      '유형',
      '상태',
      '적용기간',
      '구성품 수',
      '소요량 확정',
    ]);
  });

  it('★ 섹션 B 열 — 첫 열은 `상위 SKU` 다 (`parentSku.skuCode`/`skuName`)', () => {
    expect(BOM_TAB_WHERE_USED_COLUMNS[0]).toBe('상위 SKU');
    expect([...BOM_TAB_WHERE_USED_COLUMNS]).toEqual([
      '상위 SKU',
      '버전',
      '상태',
      '적용기간',
      '순번',
      '소요량',
      '소요량 상태',
      '구성품 유형',
      '필수',
      '대체그룹',
    ]);
  });

  it('★★ "BOM 코드" 라는 열이 없다 — `BomHeader` 에 그 필드가 없기 때문이다', () => {
    // T07-1 `BomHeader` scalar 19 개(docs/18 §D-2)에 bomCode 는 없다.
    for (const column of [...BOM_TAB_PARENT_COLUMNS, ...BOM_TAB_WHERE_USED_COLUMNS]) {
      expect(column, column).not.toBe('BOM 코드');
      expect(column, column).not.toBe('BOM코드');
    }
    expect(PARENT_SOURCE).not.toContain('BOM 코드');
    expect(PARENT_SOURCE).not.toContain('BOM코드');
  });

  it('★★ 합성 BOM 식별자를 만들지 않는다 — `${skuCode}-${version}` 조립 없음', () => {
    const names = Object.keys(bomView).join(' ');
    // view 모듈에 bomCode 계열 helper·상수가 존재하지 않는다.
    expect(names.toLowerCase()).not.toContain('bomcode');
    expect(PARENT_SOURCE.toLowerCase()).not.toContain('bomcode');
    // 코드와 버전을 한 문자열로 잇는 조립이 없다.
    expect(PARENT_SOURCE).not.toMatch(/skuCode\}\s*[-/]\s*\$\{/);
    expect(PARENT_SOURCE).not.toMatch(/\$\{[^}]*version\}[-/]/);
  });

  it('★★ `BomHeader.id`(uuid) 를 코드처럼 표시하지 않는다', () => {
    // uuid 는 key·`data-bom-header-id`·관리 링크 경로에만 쓰인다.
    expect(PARENT_SOURCE).toContain('key={row.id}');
    expect(PARENT_SOURCE).toContain('data-bom-header-id={row.bomHeaderId}');
    // 셀 본문으로 uuid 를 그리는 곳이 없다.
    expect(PARENT_SOURCE).not.toMatch(/>\s*\{row\.id\}\s*</);
    expect(PARENT_SOURCE).not.toMatch(/>\s*\{row\.bomHeaderId\}\s*</);
  });

  it('★ 응답 타입에도 bomCode 가 없다 — API contract 를 발명하지 않는다', () => {
    const viewSource = codeOnly(readFileSync(new URL('./bom-view.ts', import.meta.url), 'utf8'));
    expect(viewSource.toLowerCase()).not.toContain('bomcode');
  });
});
