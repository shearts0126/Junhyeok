import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * BOM 다단계 원가 API E2E (T07-7B).
 *
 * ⚠️ T07-8 원가 UI 가 아직 없으므로 **화면이 아니라 API** 를 본다. Playwright
 *    `request` 로 실제 HTTP 스택(Proxy 1차 가드 → route → application 2차 가드
 *    → DB)을 그대로 통과시킨다.
 *
 * ## 픽스처를 새로 만들지 않는다
 *
 * `setup-db` 의 전개 그래프를 **그대로** 쓴다 — 새 SKU·BOM 을 심으면
 * `bom-tab.e2e.ts`·`bom-explode.e2e.ts` 의 단언을 깨뜨린다.
 *
 * ```
 *   ZZS-E2E-020  ZZB-1.0 (ACTIVE)
 *     ├ line 1 → 021  CONFIRMED 2.5        (대체그룹 ZZG-A)
 *     ├ line 2 → 021  SUGGESTED 0.033333   (대체그룹 ZZG-B · optional)
 *     └ line 3 → 022  UNKNOWN  null        (SERVICE · required)
 *                022  ZZB-SEMI-1.0 (ACTIVE)      ← ★ 유효 child BOM 이 있다
 *                  └ line 1 → 021  CONFIRMED 1
 * ```
 *
 * 이 한 그래프가 T07-7B 의 핵심을 동시에 통과시킨다:
 *
 * | 계약 | 이 그래프에서 |
 * |---|---|
 * | **R-1·R-6** intermediate 제외 | `022` 는 유효 child BOM 이 있으므로 `components[]` 에 **없다** |
 * | **R-7** `(componentSkuId, uom)` 집계 | `021` 의 **3 occurrence 가 1행**으로 |
 * | **R-17** 최소 level | `021` 은 level 1·1·2 로 나오지만 행의 `level` 은 **1** |
 * | **R-8** known partial 수량 | level 2 occurrence 는 `null` 이라 빠지고 나머지만 합산 |
 * | **R-12** 경로 상속 | `SUGGESTED`·`UNKNOWN` 조상 → `QTY_UNCONFIRMED` |
 * | **R-15** reason union | `QTY_UNCONFIRMED` + `NO_PRIMARY_SUPPLIER` 둘 다 |
 *
 * ⚠️ **이중계상 부재**·terminal fallback·다통화·손상 409 는 DB 통합 테스트
 *    (`tests/db/bom-cost-rollup-api.test.ts`)가 본다 — 그쪽이 그래프를 자유롭게
 *    만들 수 있는 계층이다. 여기서 보는 것은 **HTTP 스택 통과**다.
 *
 * ⛔ SKU 상세 ⑦ BOM 탭은 여전히 read-only 다 — 이 파일은 UI 를 건드리지 않는다.
 */

const [ADMIN, , , FINANCE, EXECUTIVE] = E2E_USERS;

const PARENT_SKU = 'ZZS-E2E-020';
const COMPONENT_SKU = 'ZZS-E2E-021';
const SEMI_SKU = 'ZZS-E2E-022';

interface CostComponent {
  componentSkuId: string;
  componentSku: { id: string; skuCode: string; skuName: string };
  level: number;
  requiredQty: string | null;
  uom: string;
  supplierSkuId: string | null;
  unitPrice: string | null;
  currency: string | null;
  vatIncluded: boolean | null;
  lineCost: string | null;
  provisionalReason: string | null;
}

interface CostBody {
  bomId: string;
  parentSkuId: string;
  asOf: string;
  requestedQty: string;
  isProvisional: boolean;
  provisionalReasons: string[];
  components: CostComponent[];
  subtotals: { currency: string; vatIncluded: boolean; amount: string }[];
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

/** `ZZB-1.0`(ACTIVE) 의 id — 원가 root 다. */
async function activeBomId(request: APIRequestContext): Promise<string> {
  const parentSkuId = await skuIdOf(request, PARENT_SKU);
  const listed = await request.get(`/api/boms?parentSkuId=${parentSkuId}&page=1`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const body = (await listed.json()) as { items: { id: string; version: string }[] };
  const found = body.items.find((bom) => bom.version === 'ZZB-1.0');
  expect(found, 'ZZB-1.0 픽스처').toBeDefined();
  return found!.id;
}

/**
 * ⚠️ 이 파일의 **첫 테스트**는 Next.js dev 서버가 `/api/boms/[id]/cost` 를 처음
 *    컴파일하는 비용(수십 초)을 그대로 뒤집어쓴다. 파일 단독 실행 시 기본 30초
 *    타임아웃을 넘길 수 있으므로 describe 단위로 넉넉히 준다 —
 *    ⛔ 테스트를 건너뛰거나 단언을 느슨하게 만들지 않는다.
 */
test.describe.configure({ timeout: 90_000 });

test.describe('T07-7B cost API', () => {
  test('★★★ 다단계 원가가 실제 HTTP 스택에서 terminal 만 집계한다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);
    const [componentSkuId, semiSkuId, parentSkuId] = await Promise.all([
      skuIdOf(request, COMPONENT_SKU),
      skuIdOf(request, SEMI_SKU),
      skuIdOf(request, PARENT_SKU),
    ]);

    const response = await request.get(`/api/boms/${bomId}/cost?qty=4`);
    // ⚠️ body 를 **한 번만** 읽는다 — 실패 메시지용으로 다시 읽으면 타임아웃
    //    직전에 `Response has been disposed` 로 원인이 가려진다.
    const rawBody = await response.text();
    expect(response.status(), rawBody).toBe(200);
    const body = JSON.parse(rawBody) as CostBody;

    expect(body.bomId).toBe(bomId);
    expect(body.parentSkuId).toBe(parentSkuId);
    expect(body.requestedQty).toBe('4');

    // ★★★ R-1·R-6 — `022` 는 유효 child BOM 을 가진 intermediate 이므로
    //     components 에 **없다**. explode 는 같은 그래프에서 022 를 포함한다.
    expect(body.components.map((row) => row.componentSkuId)).not.toContain(semiSkuId);

    // ★★★ R-7 — `021` 의 세 occurrence 가 **한 행**으로 합쳐진다.
    expect(body.components).toHaveLength(1);
    const line = body.components[0] as CostComponent;
    expect(line.componentSkuId).toBe(componentSkuId);
    expect(line.componentSku.skuCode).toBe(COMPONENT_SKU);

    // ★★ R-17 — level 1·1·2 중 **최소** 1 이다.
    expect(line.level).toBe(1);

    // ★★ R-8 — known 만 합산: 10 + 0.133332. level 2 occurrence 는 조상이
    //    UNKNOWN 이라 raw 가 null 이므로 빠진다. ⛔ 0 으로 더하지 않는다.
    expect(line.requiredQty).toBe('10.133332');

    // 021 에는 대표 공급조건이 없다 → 금액을 낼 수 없다.
    expect(line.supplierSkuId).toBeNull();
    expect(line.unitPrice).toBeNull();
    expect(line.currency).toBeNull();
    expect(line.vatIncluded).toBeNull();
    // ⛔ `0` 으로 채우지 않는다 (D-25).
    expect(line.lineCost).toBeNull();

    // ★★★ R-12·R-14 — SUGGESTED·UNKNOWN 조상이 경로로 상속돼 수량 사유가 붙고,
    //     단수 표시값은 F-6 우선순위로 QTY_UNCONFIRMED 다.
    expect(line.provisionalReason).toBe('QTY_UNCONFIRMED');

    // ★★ R-15 — top-level 은 **실제 사유 집합**의 union 이다. 단수 projection
    //    하나만 모은 것이 아니므로 NO_PRIMARY_SUPPLIER 도 함께 나온다.
    expect(body.provisionalReasons).toEqual(['QTY_UNCONFIRMED', 'NO_PRIMARY_SUPPLIER']);
    expect(body.isProvisional).toBe(true);

    // 계산 가능한 금액이 하나도 없으므로 소계는 빈 배열이다 (F-9).
    expect(body.subtotals).toEqual([]);
  });

  test('★★ CostResult 는 정확히 9키다 — 단일 totalCost 가 없다 (D-14·D-26)', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    const response = await request.get(`/api/boms/${bomId}/cost`);
    const body = (await response.json()) as CostBody & Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      [
        'bomId',
        'parentSkuId',
        'asOf',
        'requestedQty',
        'isProvisional',
        'provisionalReasons',
        'components',
        'subtotals',
        'requestId',
      ].sort(),
    );
    // ★ G10 — requestId 는 **body 안에** 있다 (explode 의 직접 배열과 다르다).
    expect(typeof body.requestId).toBe('string');
    // ⛔ 통화가 섞이면 하나로 합칠 수 없으므로 단일 총액 필드를 두지 않는다.
    expect(body).not.toHaveProperty('totalCost');
    // ⛔ 내부값이 새어 나오지 않는다.
    for (const forbidden of ['rawLineCost', 'rawRequiredQty', 'nodes', 'lines', 'maxLevel']) {
      expect(body, forbidden).not.toHaveProperty(forbidden);
    }

    // component 도 exact 11키 · componentSku 는 3키(baseUom 없음).
    const line = body.components[0] as CostComponent & Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(
      [
        'componentSkuId',
        'componentSku',
        'level',
        'requiredQty',
        'uom',
        'supplierSkuId',
        'unitPrice',
        'currency',
        'vatIncluded',
        'lineCost',
        'provisionalReason',
      ].sort(),
    );
    expect(Object.keys(line.componentSku).sort()).toEqual(['id', 'skuCode', 'skuName']);
    for (const forbidden of ['componentRole', 'quantityStatus', 'path', 'isLeaf', 'bomHeaderId']) {
      expect(line, forbidden).not.toHaveProperty(forbidden);
    }
  });

  test('★★ qty 기본값은 "1" 이고 asOf 는 서버 업무일자다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    const response = await request.get(`/api/boms/${bomId}/cost`);
    const body = (await response.json()) as CostBody;

    expect(body.requestedQty).toBe('1');
    // ⛔ client 가 보내지 않아도 서버가 채운다 — `YYYY-MM-DD` 형식이다.
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // qty=1 → 2.5 + 0.033333 = 2.533333
    expect(body.components[0]?.requiredQty).toBe('2.533333');
  });

  test('★★ 미지원 파라미터는 400 이다 — 조용히 무시하지 않는다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    for (const bad of [
      'maxLevel=3',
      'supplierId=x',
      'priceId=x',
      'currency=USD',
      'level=2',
      'foo=1',
    ]) {
      const response = await request.get(`/api/boms/${bomId}/cost?${bad}`);
      expect(response.status(), bad).toBe(400);
      const body = (await response.json()) as { errorCode: string };
      expect(body.errorCode, bad).toBe('VALIDATION_ERROR');
    }
  });

  test('★★ qty·asOf 검증이 HTTP 경계에서 걸린다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    for (const bad of ['qty=0', 'qty=-1', 'qty=1e3', 'asOf=2026-02-30', 'asOf=2026-13-01']) {
      const response = await request.get(`/api/boms/${bomId}/cost?${bad}`);
      expect(response.status(), bad).toBe(400);
    }

    // ★ 실존하는 윤년 날짜는 통과한다.
    const ok = await request.get(`/api/boms/${bomId}/cost?asOf=2028-02-29`);
    expect(ok.status()).toBe(200);
    expect(((await ok.json()) as CostBody).asOf).toBe('2028-02-29');
  });

  test('★★ Decimal 은 전부 문자열이다 — number 로 새지 않는다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);

    const response = await request.get(`/api/boms/${bomId}/cost?qty=4`);
    const body = (await response.json()) as CostBody;

    expect(typeof body.requestedQty).toBe('string');
    for (const line of body.components) {
      for (const key of ['requiredQty', 'unitPrice', 'lineCost'] as const) {
        const value = line[key];
        expect(value === null || typeof value === 'string', `${key}=${String(value)}`).toBe(true);
      }
    }
    // ⛔ "10.133332" 지 10.133332(number) 가 아니다.
    expect(body.components[0]?.requiredQty).toBe('10.133332');
  });

  test('★ 없는 BOM 은 404, UUID 오류는 400 이다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;

    const missing = await request.get('/api/boms/99999999-9999-4999-8999-999999999999/cost');
    expect(missing.status()).toBe(404);
    expect(((await missing.json()) as { errorCode: string }).errorCode).toBe('BOM_NOT_FOUND');

    const malformed = await request.get('/api/boms/not-a-uuid/cost');
    expect(malformed.status()).toBe(400);
  });

  test('★★ 권한 — FINANCE·EXECUTIVE 도 bom.read 로 읽는다 (D-15)', async ({ page }) => {
    for (const user of [FINANCE, EXECUTIVE]) {
      await login(page, user);
      const request = page.context().request;
      const bomId = await activeBomId(request);
      const response = await request.get(`/api/boms/${bomId}/cost`);
      expect(response.status(), user.email).toBe(200);
    }
  });

  test('★★ explode 는 그대로다 — cost 가 그 계약을 바꾸지 않았다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const bomId = await activeBomId(request);
    const semiSkuId = await skuIdOf(request, SEMI_SKU);

    const response = await request.get(`/api/boms/${bomId}/explode?qty=4`);
    const body = (await response.json()) as { componentSkuId: string; level: number }[];

    // ★ explode 는 여전히 **배열 그 자체**이고 중간 노드를 포함한다 (D-18).
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(4);
    expect(body.map((node) => node.componentSkuId)).toContain(semiSkuId);
    // ⛔ cost 가 합산한다고 explode 까지 합쳐지지 않는다 (D-20).
    expect(body.filter((node) => node.level === 1)).toHaveLength(3);
  });
});
