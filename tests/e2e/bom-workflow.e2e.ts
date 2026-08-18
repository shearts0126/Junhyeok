import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * BOM workflow API E2E (T07-5) — **E2E-05 · E2E-06** (`docs/18` §D-32 test matrix).
 *
 * ⚠️ T07-8 standalone UI 가 아직 없으므로 **화면이 아니라 API 체인**을 본다.
 *    Playwright `request` 로 실제 HTTP 스택(Proxy 1차 가드 → route → application
 *    2차 가드 → DB)을 그대로 통과시킨다 — 단위·DB 테스트가 건너뛰는 구간이다.
 *
 * ```
 *   E2E-05  생성 → 라인 → 일괄확정 → 승인요청 → 승인 → 활성화
 *   E2E-06  활성 수정 차단 → clone(새 DRAFT) → 승인 → 활성화(구 버전 기간 마감)
 * ```
 *
 * ⛔ SKU 상세 ⑦ BOM 탭은 여전히 read-only 다 — 이 파일은 UI 를 건드리지 않는다.
 */

const [ADMIN, STAFF, , , EXECUTIVE] = E2E_USERS;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** 고유 접미사 — 같은 DB 를 여러 번 돌려도 version·code 가 충돌하지 않는다. */
function unique(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

interface Created {
  readonly bomId: string;
  readonly parentSkuId: string;
  readonly componentSkuId: string;
}

/**
 * ★ **workflow 전용 픽스처 SKU** 로 BOM 하나를 만든다.
 *
 * ⚠️ 공유 픽스처(`ZZS-E2E-020` 등)를 상위로 쓰지 않는다 — 그 SKU 에는 이미
 *    `ZZB-1.0` 이 `ACTIVE [2020-01-01, ∞)` 로 붙어 있어서 여기서 activate 하면
 *    **그 기간이 마감되어** `bom-tab.e2e.ts` 의 `2020-01-01 ~ 무기한` 단언을
 *    깨뜨린다.
 * ⚠️ 새 SKU 를 API 로 만들지도 않는다 — 생성 직후 `DRAFT` 이고 D-12 가 `DRAFT`
 *    상위를 `BOM_PARENT_NOT_ELIGIBLE`(422)로 막기 때문이다.
 * ★ 그래서 setup-db 가 **BOM 이 하나도 없는 ACTIVE SKU** 6종을 따로 심는다.
 *   `ZZS-E2E-030` 이 구성품, `031~035` 가 상위이며 **테스트마다 다른 상위**를
 *   써서 서로의 temporal chain 을 건드리지 않는다.
 */
const COMPONENT_SKU_CODE = 'ZZS-E2E-030';

async function skuIdOf(request: APIRequestContext, skuCode: string): Promise<string> {
  const listed = await request.get(`/api/skus?q=${skuCode}&page=1`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const body = (await listed.json()) as { items: { id: string; skuCode: string }[] };
  const found = body.items.find((sku) => sku.skuCode === skuCode);
  expect(found, `${skuCode} 픽스처`).toBeDefined();
  return found!.id;
}

async function createBom(
  request: APIRequestContext,
  parentSkuCode: string,
  effectiveFrom: string,
  version: string,
): Promise<Created> {
  const parentSkuId = await skuIdOf(request, parentSkuCode);
  const componentSkuId = await skuIdOf(request, COMPONENT_SKU_CODE);

  const created = await request.post('/api/boms', {
    data: { parentSkuId, bomType: 'MANUFACTURING', version, effectiveFrom },
  });
  expect(created.status(), await created.text()).toBe(201);
  const payload = (await created.json()) as { bom: { id: string } };
  return { bomId: payload.bom.id, parentSkuId, componentSkuId };
}

test.describe.configure({ mode: 'serial' });

test.describe('E2E-05 — 생성 → 확정 → 승인 → 활성화', () => {
  test('★★ 전체 체인이 실제 HTTP 스택에서 동작한다', async ({ page }) => {
    // ★ 작성자와 승인자를 **다른 사람**으로 둔다 — 같은 사람이면 자가승인
    //   금지(D-8)에 걸린다. 아래에서 그 차단 자체도 확인한다.
    await login(page, STAFF);
    const request = page.context().request;
    const suffix = unique();

    const { bomId, componentSkuId } = await createBom(
      request,
      'ZZS-E2E-031',
      '2040-01-01',
      `E5-${suffix}`,
    );

    // ── 라인 추가 — 소요량 미확정(UNKNOWN)으로 시작한다 ──────────
    const lineResponse = await request.post(`/api/boms/${bomId}/lines`, {
      data: { componentSkuId, componentRole: 'MATERIAL' },
    });
    expect(lineResponse.status(), await lineResponse.text()).toBe(201);
    const { line } = (await lineResponse.json()) as { line: { id: string } };

    // ── ★ 미확정 상태로 submit 하면 422 다 (D-10 게이트) ─────────
    const blocked = await request.post(`/api/boms/${bomId}/submit`, { data: {} });
    expect(blocked.status()).toBe(422);
    // ★ 오류 envelope 의 키는 `errorCode` 다 (`shared/errors/response.ts`).
    expect((await blocked.json()).errorCode).toBe('BOM_QTY_UNCONFIRMED');

    // ── T07-4 일괄 확정 ────────────────────────────────────────
    const confirmed = await request.post(`/api/boms/${bomId}/lines/bulk-confirm-qty`, {
      data: [{ lineId: line.id, quantityPer: '2.5' }],
    });
    expect(confirmed.status(), await confirmed.text()).toBe(200);
    expect((await confirmed.json()).bom.unconfirmedCount).toBe(0);

    // ── submit ─────────────────────────────────────────────────
    const submitted = await request.post(`/api/boms/${bomId}/submit`, {
      data: { note: 'E2E 승인 요청' },
    });
    expect(submitted.status(), await submitted.text()).toBe(200);
    expect((await submitted.json()).bom.status).toBe('PENDING_APPROVAL');

    // ── ★★ 자가승인 차단 — 작성자(STAFF)에게는 애초에 bom.approve 가 없다 ──
    const selfApprove = await request.post(`/api/boms/${bomId}/approve`, { data: {} });
    expect(selfApprove.status()).toBe(403);

    // ── approve — ⛔ 활성화가 아니다 ────────────────────────────
    await login(page, ADMIN);
    const approvedResponse = await request.post(`/api/boms/${bomId}/approve`, { data: {} });
    expect(approvedResponse.status(), await approvedResponse.text()).toBe(200);
    const approvedBom = (await approvedResponse.json()).bom;
    expect(approvedBom.status).toBe('APPROVED');
    expect(approvedBom.activatedAt).toBeNull();

    // ── activate ───────────────────────────────────────────────
    const activated = await request.post(`/api/boms/${bomId}/activate`, { data: {} });
    expect(activated.status(), await activated.text()).toBe(200);
    const activeBom = (await activated.json()).bom;
    expect(activeBom.status).toBe('ACTIVE');
    expect(activeBom.activatedAt).not.toBeNull();
    expect(activeBom.effectiveFrom).toBe('2040-01-01');

    // ── ★ 반복 activate 는 200 no-op 이다 (D-17) ────────────────
    const repeated = await request.post(`/api/boms/${bomId}/activate`, { data: {} });
    expect(repeated.status()).toBe(200);
    expect((await repeated.json()).bom.activatedAt).toBe(activeBom.activatedAt);
  });
});

test.describe('E2E-06 — 활성 수정 차단 → clone → 새 버전 활성화', () => {
  test('★★ ACTIVE 는 수정할 수 없고, clone 한 새 DRAFT 로 버전을 올린다', async ({ page }) => {
    await login(page, STAFF);
    const request = page.context().request;
    const suffix = unique();

    // ── 활성 버전 하나를 만든다 (작성 = STAFF, 승인 = ADMIN) ────
    const { bomId, componentSkuId } = await createBom(
      request,
      'ZZS-E2E-032',
      '2041-01-01',
      `E6A-${suffix}`,
    );
    const lineResponse = await request.post(`/api/boms/${bomId}/lines`, {
      data: {
        componentSkuId,
        componentRole: 'MATERIAL',
        quantityStatus: 'CONFIRMED',
        quantityPer: '1',
      },
    });
    expect(lineResponse.status(), await lineResponse.text()).toBe(201);
    await request.post(`/api/boms/${bomId}/submit`, { data: {} });
    await login(page, ADMIN);
    await request.post(`/api/boms/${bomId}/approve`, { data: {} });
    const activated = await request.post(`/api/boms/${bomId}/activate`, { data: {} });
    expect(activated.status(), await activated.text()).toBe(200);

    // ── ★ 활성 BOM 수정은 422 `BOM_ACTIVE_IMMUTABLE` ────────────
    const patch = await request.patch(`/api/boms/${bomId}`, { data: { description: '수정 시도' } });
    expect(patch.status()).toBe(422);
    expect((await patch.json()).errorCode).toBe('BOM_ACTIVE_IMMUTABLE');

    // ── clone — 새 DRAFT 가 생긴다 (최초 201) ───────────────────
    //   ★ 작성자를 STAFF 로 되돌린다 — 이후 ADMIN 승인이 자가승인이 아니게 된다.
    await login(page, STAFF);
    const cloned = await request.post(`/api/boms/${bomId}/clone`, {
      data: {
        newVersion: `E6B-${suffix}`,
        effectiveFrom: '2042-01-01',
        changeReason: '구성 변경',
      },
    });
    expect(cloned.status(), await cloned.text()).toBe(201);
    const clone = (await cloned.json()).bom;
    expect(clone.status).toBe('DRAFT');
    expect(clone.id).not.toBe(bomId);
    // ★ 승인·활성 metadata 를 승계하지 않는다 (W-5).
    expect(clone.approvedAt).toBeNull();
    expect(clone.approvedBy).toBeNull();
    expect(clone.activatedAt).toBeNull();
    expect(clone.effectiveTo).toBeNull();
    // ★ 라인은 수량·상태까지 그대로 복제된다 (W-6).
    expect(clone.lineCount).toBe(1);
    expect(clone.lines[0].quantityPer).toBe('1');
    expect(clone.lines[0].quantityStatus).toBe('CONFIRMED');

    // ── 새 버전을 활성화하면 구 버전 기간이 마감된다 (D-7) ──────
    await request.post(`/api/boms/${clone.id}/submit`, { data: {} });
    await login(page, ADMIN);
    await request.post(`/api/boms/${clone.id}/approve`, { data: {} });
    const activatedClone = await request.post(`/api/boms/${clone.id}/activate`, { data: {} });
    expect(activatedClone.status(), await activatedClone.text()).toBe(200);

    const previous = await request.get(`/api/boms/${bomId}`);
    const previousBom = (await previous.json()).bom;
    // ★ 기간만 닫힌다 — status 는 ACTIVE 그대로다 (D-7 superseded).
    expect(previousBom.effectiveTo).toBe('2042-01-01');
    expect(previousBom.status).toBe('ACTIVE');
  });
});

test.describe('workflow 권한 (D-15)', () => {
  test('★ SCM_STAFF 는 submit 은 되지만 approve 는 403 이다', async ({ page }) => {
    await login(page, STAFF);
    const request = page.context().request;
    const suffix = unique();

    const { bomId, componentSkuId } = await createBom(
      request,
      'ZZS-E2E-033',
      '2043-01-01',
      `PS-${suffix}`,
    );
    await request.post(`/api/boms/${bomId}/lines`, {
      data: {
        componentSkuId,
        componentRole: 'MATERIAL',
        quantityStatus: 'CONFIRMED',
        quantityPer: '1',
      },
    });

    const submitted = await request.post(`/api/boms/${bomId}/submit`, { data: {} });
    expect(submitted.status(), await submitted.text()).toBe(200);

    const approve = await request.post(`/api/boms/${bomId}/approve`, { data: {} });
    expect(approve.status()).toBe(403);
  });

  test('★ EXECUTIVE 는 읽기만 — workflow 는 403 이다', async ({ page }) => {
    await login(page, EXECUTIVE);
    const request = page.context().request;

    const listed = await request.get('/api/boms?page=1');
    expect(listed.status()).toBe(200);

    const created = await request.post('/api/boms', {
      data: {
        parentSkuId: '00000000-0000-4000-8000-000000000001',
        bomType: 'MANUFACTURING',
        version: 'X',
        effectiveFrom: '2044-01-01',
      },
    });
    expect(created.status()).toBe(403);
  });
});

test.describe('strict API (§38)', () => {
  test('★ workflow route 는 query 를 받지 않고 unknown body 를 거부한다', async ({ page }) => {
    await login(page, ADMIN);
    const request = page.context().request;
    const suffix = unique();
    const { bomId } = await createBom(request, 'ZZS-E2E-034', '2045-01-01', `ST-${suffix}`);

    // query 는 무엇이 오든 400.
    const withQuery = await request.post(`/api/boms/${bomId}/submit?force=1`, { data: {} });
    expect(withQuery.status()).toBe(400);

    // unknown body key 도 400.
    const unknownField = await request.post(`/api/boms/${bomId}/submit`, {
      data: { note: 'ok', bogus: 1 },
    });
    expect(unknownField.status()).toBe(400);

    // ★ server-managed 필드 입력 금지.
    const managed = await request.post(`/api/boms/${bomId}/approve`, {
      data: { approvedBy: '00000000-0000-4000-8000-000000000001' },
    });
    expect(managed.status()).toBe(400);

    // reject 는 reason 필수.
    const noReason = await request.post(`/api/boms/${bomId}/reject`, { data: {} });
    expect(noReason.status()).toBe(400);

    // ★ archive 도 reason 필수다 (W-1).
    const noArchiveReason = await request.post(`/api/boms/${bomId}/archive`, { data: {} });
    expect(noArchiveReason.status()).toBe(400);
  });

  test('★★ deactivate 는 미래 종료일을 400 으로 막는다 (W-3)', async ({ page }) => {
    await login(page, STAFF);
    const request = page.context().request;
    const suffix = unique();

    const { bomId, componentSkuId } = await createBom(
      request,
      'ZZS-E2E-035',
      '2046-01-01',
      `DA-${suffix}`,
    );
    await request.post(`/api/boms/${bomId}/lines`, {
      data: {
        componentSkuId,
        componentRole: 'MATERIAL',
        quantityStatus: 'CONFIRMED',
        quantityPer: '1',
      },
    });
    await request.post(`/api/boms/${bomId}/submit`, { data: {} });
    await login(page, ADMIN);
    await request.post(`/api/boms/${bomId}/approve`, { data: {} });
    await request.post(`/api/boms/${bomId}/activate`, { data: { effectiveFrom: '2020-01-01' } });

    // 미래 종료 — 400.
    const future = await request.post(`/api/boms/${bomId}/deactivate`, {
      data: { effectiveTo: '2099-01-01', reason: '미래 예약' },
    });
    expect(future.status()).toBe(400);

    // 과거 종료 — 성공.
    const past = await request.post(`/api/boms/${bomId}/deactivate`, {
      data: { effectiveTo: '2021-01-01', reason: '단종' },
    });
    expect(past.status(), await past.text()).toBe(200);
    expect((await past.json()).bom.status).toBe('INACTIVE');
  });
});
