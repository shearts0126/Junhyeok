import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * BOM 다단계 전개 API E2E (T07-6).
 *
 * ⚠️ T07-8 standalone UI 가 아직 없으므로 **화면이 아니라 API** 를 본다.
 *    Playwright `request` 로 실제 HTTP 스택(Proxy 1차 가드 → route → application
 *    2차 가드 → DB)을 그대로 통과시킨다.
 *
 * ## 픽스처를 새로 만들지 않는다
 *
 * `setup-db` 가 이미 전개에 필요한 그래프를 갖고 있다 — 새 SKU·BOM 을 심으면
 * `bom-tab.e2e.ts` 의 단언(구성품 SKU 는 상위 BOM 이 없다 등)을 깨뜨린다.
 *
 * ```
 *   ZZS-E2E-020  ZZB-1.0 (ACTIVE)
 *     ├ line 1 → 021  CONFIRMED 2.5        (대체그룹 ZZG-A)
 *     ├ line 2 → 021  SUGGESTED 0.033333   (대체그룹 ZZG-B · optional)
 *     └ line 3 → 022  UNKNOWN  null        (SERVICE · required)
 *                022  ZZB-SEMI-1.0 (ACTIVE)
 *                  └ line 1 → 021  CONFIRMED 1
 * ```
 *
 * 이 한 그래프가 E-1(정상 UNKNOWN) · E-2(null 전파) · E-3(`isLeaf` 독립) ·
 * E-4(SUGGESTED 정상 계산) · D-20(무합산) 을 동시에 통과시킨다.
 *
 * ⚠️ **3단계 깊이**·maxLevel 경계·순환은 DB 통합 테스트
 *    (`tests/db/bom-explode-api.test.ts`, TC-BOM-008)가 본다 — 그쪽이 그래프를
 *    자유롭게 만들 수 있는 계층이다. 여기서 보는 것은 **HTTP 스택 통과**다.
 *
 * ⛔ SKU 상세 ⑦ BOM 탭은 여전히 read-only 다 — 이 파일은 UI 를 건드리지 않는다.
 */

const [ADMIN, , , FINANCE, EXECUTIVE] = E2E_USERS;

const PARENT_SKU = 'ZZS-E2E-020';
const COMPONENT_SKU = 'ZZS-E2E-021';
const SEMI_SKU = 'ZZS-E2E-022';

interface ExplodedNode {
  level: number;
  path: string[];
  bomHeaderId: string | null;
  componentSkuId: string;
  componentSku: { id: string; skuCode: string; skuName: string; baseUom: string };
  componentRole: string;
  quantityPer: string | null;
  lossRate: string | null;
  requiredQty: string | null;
  uom: string;
  isLeaf: boolean;
  quantityStatus: string;
}

interface ExplodeBody {
  bomId: string;
  parentSkuId: string;
  asOf: string;
  qty: string;
  maxLevel: number;
  nodes: ExplodedNode[];
  requestId: string;
}

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function skuIdOf(request: APIRequestContext, skuCode: string): Promise<string> {
  const listed = await request.get(`/api/skus?q=${skuCode}&page=1`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const body = (await listed.json()) as { items: { id: string; skuCode: string }[] };
  const found = body.items.find((sku) => sku.skuCode === skuCode);
  expect(found, `${skuCode} 픽스처`).toBeDefined();
  return found!.id;
}

/** `ZZB-1.0`(ACTIVE) 의 id — 전개 root 다. */
async function activeBomId(request: APIRequestContext): Promise<string> {
  const parentSkuId = await skuIdOf(request, PARENT_SKU);
  const listed = await request.get(`/api/boms?parentSkuId=${parentSkuId}&page=1`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const body = (await listed.json()) as { items: { id: string; version: string }[] };
  const found = body.items.find((bom) => bom.version === 'ZZB-1.0');
  expect(found, 'ZZB-1.0 픽스처').toBeDefined();
  return found!.id;
}

test.describe('T07-6 explode API', () => {
  test('★★ 다단계 전개가 실제 HTTP 스택에서 동작한다 (D-18 · D-19)', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);
    const [componentSkuId, semiSkuId, parentSkuId] = await Promise.all([
      skuIdOf(request, COMPONENT_SKU),
      skuIdOf(request, SEMI_SKU),
      skuIdOf(request, PARENT_SKU),
    ]);

    const response = await request.get(`/api/boms/${bomId}/explode?qty=4`);
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as ExplodeBody;

    // ★ root 는 요청한 그 header 다 — 다른 버전으로 바뀌지 않았다.
    expect(body.bomId).toBe(bomId);
    expect(body.parentSkuId).toBe(parentSkuId);
    expect(body.qty).toBe('4');
    expect(body.maxLevel).toBe(10);
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.requestId).toBeTruthy();

    // ★ 평면 배열 4행 — level 1 세 개 + level 2 하나.
    expect(body.nodes).toHaveLength(4);
    expect(body.nodes.map((node) => node.level)).toEqual([1, 1, 1, 2]);

    const [alt1, alt2, semi, viaSemi] = body.nodes as [
      ExplodedNode,
      ExplodedNode,
      ExplodedNode,
      ExplodedNode,
    ];

    // ── level 1 ①  CONFIRMED 2.5 × 4 = 10
    expect(alt1.componentSkuId).toBe(componentSkuId);
    expect(alt1.quantityStatus).toBe('CONFIRMED');
    expect(alt1.requiredQty).toBe('10');
    expect(alt1.path).toEqual([parentSkuId]);
    expect(alt1.isLeaf).toBe(true);
    expect(alt1.bomHeaderId).toBeNull();

    // ── level 1 ②  ★ SUGGESTED 도 **정상 계산**된다 (E-4). 4 × 0.033333
    expect(alt2.componentSkuId).toBe(componentSkuId);
    expect(alt2.quantityStatus).toBe('SUGGESTED');
    expect(alt2.requiredQty).toBe('0.133332');

    // ── level 1 ③  ★ UNKNOWN 은 오류가 아니라 null 이다 (E-1)
    expect(semi.componentSkuId).toBe(semiSkuId);
    expect(semi.quantityStatus).toBe('UNKNOWN');
    expect(semi.quantityPer).toBeNull();
    expect(semi.requiredQty).toBeNull();
    // ★ SERVICE 라인도 걸러지지 않는다 (D-18).
    expect(semi.componentRole).toBe('SERVICE');
    // ★ E-3 — 수량이 미상이어도 하위 BOM 이 있으므로 leaf 가 아니다.
    expect(semi.isLeaf).toBe(false);
    expect(semi.bomHeaderId).not.toBeNull();

    // ── level 2  ★ E-2 — 부모가 미상이면 CONFIRMED 자식도 null 이다.
    expect(viaSemi.componentSkuId).toBe(componentSkuId);
    expect(viaSemi.quantityStatus).toBe('CONFIRMED');
    expect(viaSemi.quantityPer).toBe('1');
    expect(viaSemi.requiredQty).toBeNull();
    // ★ 구조는 그대로 전개됐다 — 수량을 모른다고 잘라내지 않았다.
    expect(viaSemi.path).toEqual([parentSkuId, semiSkuId]);
    expect(viaSemi.level).toBe(2);

    // ★ D-20 — 같은 구성품이 **세 경로**로 각각 남는다. 합산하지 않는다.
    expect(body.nodes.filter((node) => node.componentSkuId === componentSkuId)).toHaveLength(3);
  });

  test('★★ Decimal 은 전부 문자열이고 requiredQty 는 trailing zero 를 채우지 않는다 (E-6)', async ({
    page,
  }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    const response = await request.get(`/api/boms/${bomId}/explode?qty=4`);
    const body = (await response.json()) as ExplodeBody;

    for (const node of body.nodes) {
      for (const key of ['quantityPer', 'lossRate', 'requiredQty'] as const) {
        const value = node[key];
        expect(value === null || typeof value === 'string', `${key}=${String(value)}`).toBe(true);
      }
    }
    // ⛔ "10.000000" 이 아니라 "10" 이다.
    expect(body.nodes[0]?.requiredQty).toBe('10');
  });

  test('★★ ExplodedNode 는 정확히 12 키다 — 원가 필드가 새어 들어오지 않았다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    const response = await request.get(`/api/boms/${bomId}/explode`);
    const body = (await response.json()) as ExplodeBody;

    for (const node of body.nodes) {
      expect(Object.keys(node).sort()).toEqual([
        'bomHeaderId',
        'componentRole',
        'componentSku',
        'componentSkuId',
        'isLeaf',
        'level',
        'lossRate',
        'path',
        'quantityPer',
        'quantityStatus',
        'requiredQty',
        'uom',
      ]);
    }
    // ⛔ T07-7 은 미착수다 — 응답 어디에도 원가·재고 어휘가 없다.
    const raw = JSON.stringify(body);
    for (const forbidden of ['unitPrice', 'lineCost', 'currency', 'isProvisional', 'onHand']) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });

  test('★ qty 기본값은 "1" 이고 maxLevel 기본값은 10 이다 (D-18)', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    const body = (await (await request.get(`/api/boms/${bomId}/explode`)).json()) as ExplodeBody;
    expect(body.qty).toBe('1');
    expect(body.maxLevel).toBe(10);
    // 2.5 × 1 = 2.5
    expect(body.nodes[0]?.requiredQty).toBe('2.5');
  });

  test('★★ strict query — 미지원 파라미터·범위 밖 값은 400 이다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    for (const search of [
      '?aggregate=true',
      '?level=2',
      '?qty=0',
      '?qty=-1',
      '?maxLevel=0',
      '?maxLevel=11',
      '?asOf=2026-8-1',
    ]) {
      const response = await request.get(`/api/boms/${bomId}/explode${search}`);
      expect(response.status(), search).toBe(400);
      const body = (await response.json()) as { errorCode: string };
      expect(body.errorCode, search).toBe('VALIDATION_ERROR');
    }
  });

  test('★ 없는 BOM 은 404, 잘못된 UUID 는 400 이다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;

    const missing = await request.get('/api/boms/11111111-1111-4111-8111-111111111111/explode');
    expect(missing.status()).toBe(404);
    expect(((await missing.json()) as { errorCode: string }).errorCode).toBe('BOM_NOT_FOUND');

    const malformed = await request.get('/api/boms/not-a-uuid/explode');
    expect(malformed.status()).toBe(400);
  });

  test('★★ 읽기 권한이면 누구나 본다 — EXECUTIVE·FINANCE 포함 (D-15)', async ({ page }) => {
    for (const user of [EXECUTIVE, FINANCE]) {
      await login(page, user);
      const request = page.context().request;
      const bomId = await activeBomId(request);
      const response = await request.get(`/api/boms/${bomId}/explode`);
      expect(response.status(), user.email).toBe(200);
      expect(((await response.json()) as ExplodeBody).nodes.length).toBeGreaterThan(0);
    }
  });

  test('★★ 조회는 아무것도 바꾸지 않는다 — 전후 BomDetail 이 동일하다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    const before = await (await request.get(`/api/boms/${bomId}`)).json();
    await request.get(`/api/boms/${bomId}/explode?qty=7`);
    const after = await (await request.get(`/api/boms/${bomId}`)).json();

    // requestId 만 매 요청 달라진다 — 나머지가 전부 같아야 한다.
    const strip = (body: unknown): unknown => {
      const { requestId: _ignored, ...rest } = body as Record<string, unknown>;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
  });
});
