import { expect, test, type Page } from '@playwright/test';

import { E2E_HISTORY_BARCODE, E2E_USERS } from './fixtures';

/**
 * SKU 상세 ⑥ 변경이력 탭 E2E (T1-6B3) — **read-only 타임라인 + JSON diff**.
 *
 * 픽스처(setup-db): `ZZS-E2E-016` 이 감사로그 4건을 갖는다 —
 * `Sku CREATE`(08-01) · `Sku UPDATE`(08-02, 사유 있음) ·
 * `SkuBarcode CREATE`(08-03) · **`SkuExternalMapping CREATE`(08-04)**.
 *
 * ★ 마지막 한 건은 **탭에 나오면 안 된다** — SKU 변경이력 범위는
 *   `Sku` + 그 SKU 의 `SkuBarcode` 뿐이다 (`docs/16` §29).
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드(`sku.read`) → 화면 → API 2차 가드까지
 * 운영과 같은 경로다.
 */

const [ADMIN, STAFF] = E2E_USERS;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function openDetail(page: Page, skuCode: string): Promise<void> {
  await page.goto(`/master/skus?q=${skuCode}`);
  await page.locator(`tr[data-sku="${skuCode}"]`).getByRole('link', { name: skuCode }).click();
  await expect(page).toHaveURL(/\/master\/skus\/[0-9a-f-]{36}/);
}

async function openHistoryTab(page: Page, skuCode: string): Promise<void> {
  await openDetail(page, skuCode);
  await page.getByRole('tab', { name: '변경이력' }).click();
  await expect(page.getByTestId('history-tab-loading')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.describe('탭 구성 — 상세 7탭 / 등록 3탭', () => {
  test('★ 상세는 변경이력 포함 7탭이고 변경이력이 마지막이다, 등록에는 없다', async ({ page }) => {
    await login(page, ADMIN);

    await page.goto('/master/skus/new');
    await expect(page.getByRole('tab')).toHaveCount(3);
    // ⛔ 등록 화면에는 변경이력 탭이 없다 — disabled placeholder 도 없다.
    await expect(page.getByRole('tab', { name: '변경이력' })).toHaveCount(0);

    await openDetail(page, 'ZZS-E2E-016');
    const tabs = page.getByRole('tab');
    // ★ T1-6B4 에서 ⑥ 공급조건이 더해졌고, 변경이력은 **여전히 마지막**이다.
    await expect(tabs).toHaveCount(7);
    await expect(tabs.nth(0)).toHaveText('기본정보');
    await expect(tabs.nth(1)).toHaveText('코드·분류');
    await expect(tabs.nth(2)).toHaveText('바코드');
    await expect(tabs.nth(3)).toHaveText('외부시스템 매핑');
    await expect(tabs.nth(4)).toHaveText('재고관리 설정');
    await expect(tabs.nth(5)).toHaveText('공급조건');
    await expect(tabs.nth(6)).toHaveText('변경이력');

    // ⛔ 아직 없는 탭 — T07
    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(0);
  });
});

test.describe('★ 변경이력 타임라인 (ADMIN)', () => {
  test('★ SKU·바코드 이력이 최신순으로 보이고 외부매핑 이력은 없다', async ({ page }) => {
    await login(page, ADMIN);
    await openHistoryTab(page, 'ZZS-E2E-016');

    const rows = page.getByTestId('history-row');
    // ★ 픽스처 4건 중 외부매핑 1건은 제외 → 3건.
    await expect(rows).toHaveCount(3);

    // ── 최신순: 바코드 CREATE(08-03) → SKU UPDATE(08-02) → SKU CREATE(08-01)
    await expect(rows.nth(0)).toHaveAttribute('data-entity-type', 'SkuBarcode');
    await expect(rows.nth(0).getByTestId('history-entity')).toHaveText('바코드');
    await expect(rows.nth(0).getByTestId('history-action')).toHaveText('등록');

    await expect(rows.nth(1)).toHaveAttribute('data-entity-type', 'Sku');
    await expect(rows.nth(1).getByTestId('history-entity')).toHaveText('SKU');
    await expect(rows.nth(1).getByTestId('history-action')).toHaveText('수정');

    await expect(rows.nth(2)).toHaveAttribute('data-action', 'CREATE');
    await expect(rows.nth(2).getByTestId('history-action')).toHaveText('등록');

    // ⛔ 외부매핑 이력은 나오지 않는다 (docs/16 §29).
    await expect(page.locator('[data-entity-type="SkuExternalMapping"]')).toHaveCount(0);
    await expect(page.getByTestId('history-row').filter({ hasText: 'ZZX-HIST-016' })).toHaveCount(
      0,
    );

    // 변경자 UUID 원문 — 이름을 추정하지 않는다.
    await expect(rows.nth(0).getByTestId('history-actor')).toHaveText(ADMIN.id);

    // 사유/메모는 있는 행에만 나온다.
    await expect(rows.nth(1).getByTestId('history-reason')).toContainText('E2E 변경 사유');
    await expect(rows.nth(0).getByTestId('history-reason')).toHaveCount(0);
    await expect(rows.nth(2).getByTestId('history-reason')).toHaveCount(0);
  });

  test('★ 상세 보기 — 변경 전/후 JSON 이 그대로 보인다', async ({ page }) => {
    await login(page, ADMIN);
    await openHistoryTab(page, 'ZZS-E2E-016');

    const rows = page.getByTestId('history-row');

    // ── SKU UPDATE — before/after 둘 다 object, nested 유지 ─────
    await rows.nth(1).locator('summary').click();
    await expect(rows.nth(1).getByTestId('history-before')).toContainText('E2E 변경이력 이전');
    const after = rows.nth(1).getByTestId('history-after');
    await expect(after).toContainText('E2E 변경이력 대상');
    // nested object 를 평탄화하지 않는다.
    await expect(after).toContainText('"brand"');
    await expect(after).toContainText('"code": "FB"');

    // ── SKU CREATE — beforeValue 는 null 로 표시된다 ─────────────
    await rows.nth(2).locator('summary').click();
    await expect(rows.nth(2).getByTestId('history-before')).toHaveText('null');
    await expect(rows.nth(2).getByTestId('history-after')).toContainText('ZZS-E2E-016');

    // ── 바코드 CREATE ────────────────────────────────────────────
    await rows.nth(0).locator('summary').click();
    await expect(rows.nth(0).getByTestId('history-after')).toContainText(E2E_HISTORY_BARCODE);
  });

  test('★ 필터·페이지크기 선택·technical metadata 가 없다', async ({ page }) => {
    await login(page, ADMIN);
    await openHistoryTab(page, 'ZZS-E2E-016');

    // ⛔ API 가 page 만 받으므로 필터 UI 를 만들지 않는다.
    for (const absent of ['액션', '기간', '변경자 검색', '엑셀 다운로드']) {
      await expect(page.getByRole('button', { name: absent }), absent).toHaveCount(0);
    }
    await expect(page.getByLabel('페이지 크기')).toHaveCount(0);

    // ⛔ 3건뿐이라 pagination 컨트롤 자체가 없다.
    await expect(page.getByTestId('history-prev')).toHaveCount(0);
    await expect(page.getByTestId('history-next')).toHaveCount(0);

    // ⛔ requestId·sessionId·ipAddress 는 응답에도 화면에도 없다.
    await expect(page.locator('body')).not.toContainText('sessionId');
    await expect(page.locator('body')).not.toContainText('ipAddress');

    // ★ URL 은 그대로다 — 탭·페이지 상태를 searchParams 에 쓰지 않는다.
    await expect(page).toHaveURL(/\/master\/skus\/[0-9a-f-]{36}$/);
  });

  test('감사로그가 없는 SKU 는 빈 상태를 보여준다', async ({ page }) => {
    await login(page, ADMIN);
    // ★ `ZZS-E2E-003` 은 어떤 spec 도 mutation 하지 않는 조회 전용 픽스처다
    //   (`skus-list` 의 필터 대상일 뿐). 다른 spec 이 바코드 CRUD 로 건드리는 SKU 를
    //   쓰면 그 감사로그가 쌓여 이 테스트가 실행 순서에 따라 깨진다.
    await openHistoryTab(page, 'ZZS-E2E-003');

    await expect(page.getByTestId('history-tab-empty')).toHaveText('변경이력이 없습니다.');
    await expect(page.getByTestId('history-row')).toHaveCount(0);
  });

  test('★ 51건이면 이전/다음으로 페이지를 옮긴다 (URL 은 그대로)', async ({ page }) => {
    await login(page, ADMIN);
    await openHistoryTab(page, 'ZZS-E2E-017');

    // 페이지 크기는 서버 고정 50 이다.
    await expect(page.getByTestId('history-row')).toHaveCount(50);
    await expect(page.getByTestId('history-page-info')).toHaveText('1 / 2 페이지 · 총 51 건');
    await expect(page.getByTestId('history-prev')).toBeDisabled();

    await page.getByTestId('history-next').click();
    await expect(page.getByTestId('history-row')).toHaveCount(1);
    await expect(page.getByTestId('history-page-info')).toHaveText('2 / 2 페이지 · 총 51 건');
    await expect(page.getByTestId('history-next')).toBeDisabled();
    // ★ 페이지 상태는 탭 내부다 — URL 에 남기지 않는다.
    await expect(page).toHaveURL(/\/master\/skus\/[0-9a-f-]{36}$/);

    await page.getByTestId('history-prev').click();
    await expect(page.getByTestId('history-row')).toHaveCount(50);
    await expect(page.getByTestId('history-page-info')).toHaveText('1 / 2 페이지 · 총 51 건');
  });
});

test.describe('권한 — sku.read', () => {
  test('SCM_STAFF 도 변경이력을 조회할 수 있다 (별도 권한 없음)', async ({ page }) => {
    await login(page, STAFF);
    await openHistoryTab(page, 'ZZS-E2E-016');

    await expect(page.getByTestId('history-tab-forbidden')).toHaveCount(0);
    await expect(page.getByTestId('history-row')).toHaveCount(3);
  });

  test('★ 미지원 쿼리는 400 을 그대로 보여준다', async ({ page }) => {
    await login(page, ADMIN);
    await openDetail(page, 'ZZS-E2E-016');
    const skuId = new URL(page.url()).pathname.split('/').pop() ?? '';

    // API 계약을 직접 확인한다 — 화면에는 이런 파라미터를 만들 수단이 없다.
    const rejected = await page.request.get(`/api/skus/${skuId}/history?pageSize=10`);
    expect(rejected.status()).toBe(400);

    const unknown = await page.request.get(`/api/skus/${skuId}/history?action=CREATE`);
    expect(unknown.status()).toBe(400);

    const missing = await page.request.get(
      '/api/skus/00000000-0000-4000-8000-000000000000/history',
    );
    expect(missing.status()).toBe(404);
  });
});
