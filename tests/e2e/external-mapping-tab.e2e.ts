import { expect, test, type Page } from '@playwright/test';

import {
  E2E_MAPPING_CODE,
  E2E_MAPPING_ENDED_CODE,
  E2E_MAPPING_REVIEW_NAME,
  E2E_USERS,
} from './fixtures';

/**
 * SKU 상세 ④ 외부시스템 매핑 탭 E2E (T1-6B2) — **read-only summary**.
 *
 * 픽스처(setup-db): `ZZS-E2E-015` 가 `ZZX-ERP` 와 세 건의 매핑을 갖는다 —
 * MATCHED(대표) · REVIEW_REQUIRED(상품명만) · 종료된 매핑.
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드(`external_mapping.read`) → 화면 →
 * API 2차 가드까지 운영과 같은 경로다.
 *
 * ★ 핵심은 **read-only 요약 + 관리 화면 링크**이며(`docs/16` §19~§22),
 *   EXECUTIVE 처럼 `sku.read` 는 있고 `external_mapping.read` 가 없는 역할에게는
 *   탭 자체가 보이지 않아야 한다.
 */

const [ADMIN, , FINANCE, , EXECUTIVE] = E2E_USERS;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** 목록 → 상세. 탭 클릭은 호출부가 한다. */
async function openDetail(page: Page, skuCode: string): Promise<void> {
  await page.goto(`/master/skus?q=${skuCode}`);
  await page.locator(`tr[data-sku="${skuCode}"]`).getByRole('link', { name: skuCode }).click();
  await expect(page).toHaveURL(/\/master\/skus\/[0-9a-f-]{36}/);
}

async function openMappingTab(page: Page, skuCode: string): Promise<void> {
  await openDetail(page, skuCode);
  await page.getByRole('tab', { name: '외부시스템 매핑' }).click();
  await expect(page.getByTestId('mapping-tab-loading')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.describe('탭 구성 — 상세 7탭 / 등록 3탭', () => {
  test('★ 상세는 외부시스템 매핑 포함 5탭, 등록에는 없다', async ({ page }) => {
    await login(page, ADMIN);

    await page.goto('/master/skus/new');
    const createTabs = page.getByRole('tab');
    await expect(createTabs).toHaveCount(3);
    // ⛔ 등록 화면에는 child entity 탭이 없다 — disabled placeholder 도 없다.
    await expect(page.getByRole('tab', { name: '외부시스템 매핑' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '바코드' })).toHaveCount(0);

    await openDetail(page, 'ZZS-E2E-015');
    const detailTabs = page.getByRole('tab');
    // ★ T1-6B5 에서 ⑦ BOM 이 공급조건과 변경이력 사이에 들어가 **8탭**이 됐다.
    await expect(detailTabs).toHaveCount(8);
    await expect(detailTabs.nth(0)).toHaveText('기본정보');
    await expect(detailTabs.nth(1)).toHaveText('코드·분류');
    await expect(detailTabs.nth(2)).toHaveText('바코드');
    await expect(detailTabs.nth(3)).toHaveText('외부시스템 매핑');
    await expect(detailTabs.nth(4)).toHaveText('재고관리 설정');
    await expect(detailTabs.nth(5)).toHaveText('공급조건');
    await expect(detailTabs.nth(6)).toHaveText('BOM');
    await expect(detailTabs.nth(7)).toHaveText('변경이력');
  });
});

test.describe('read-only 요약 (ADMIN)', () => {
  test('★ MATCHED · REVIEW_REQUIRED · 종료된 매핑이 모두 보인다', async ({ page }) => {
    await login(page, ADMIN);
    await openMappingTab(page, 'ZZS-E2E-015');

    await expect(page.getByTestId('tab-mapping-row')).toHaveCount(3);

    // ── MATCHED (대표) ────────────────────────────────────────
    const matched = page.locator('tr[data-testid="tab-mapping-row"]', {
      hasText: E2E_MAPPING_CODE,
    });
    await expect(matched.getByTestId('tab-mapping-system')).toContainText('ZZX-ERP');
    await expect(matched.getByTestId('tab-mapping-system')).toContainText('E2E 이카운트');
    await expect(matched.getByTestId('tab-mapping-code')).toHaveText(E2E_MAPPING_CODE);
    await expect(matched.getByTestId('tab-mapping-name')).toHaveText('E2E 이카운트 상품명');
    await expect(matched.locator('[data-status="MATCHED"]')).toBeVisible();
    await expect(matched.getByTestId('tab-mapping-primary')).toHaveText('대표');
    await expect(matched.getByTestId('tab-mapping-period')).toContainText('2026-01-01');
    // 종료 표식이 없다 — 진행 중인 매핑이다.
    await expect(matched.getByTestId('tab-mapping-ended')).toHaveCount(0);

    // ── REVIEW_REQUIRED (상품명만) ─────────────────────────────
    const review = page.locator('tr[data-testid="tab-mapping-row"]', {
      hasText: E2E_MAPPING_REVIEW_NAME,
    });
    await expect(review.locator('[data-status="REVIEW_REQUIRED"]')).toBeVisible();
    await expect(review.getByTestId('tab-mapping-code')).toHaveText('');
    await expect(review.getByTestId('tab-mapping-primary')).toHaveText('');

    // ── 종료된 매핑 — 숨기지 않는다 ─────────────────────────────
    const ended = page.locator('tr[data-testid="tab-mapping-row"]', {
      hasText: E2E_MAPPING_ENDED_CODE,
    });
    await expect(ended.getByTestId('tab-mapping-ended')).toHaveText('종료됨');
    await expect(ended.getByTestId('tab-mapping-period')).toContainText('2025-12-31');

    // ── 외부 상품명 안내 ───────────────────────────────────────
    await expect(page.getByTestId('external-name-notice')).toContainText(
      'SKU 표준 상품명을 변경하지 않습니다',
    );
  });

  test('★ embedded CRUD·창고 열이 없다', async ({ page }) => {
    await login(page, ADMIN);
    await openMappingTab(page, 'ZZS-E2E-015');

    // ⛔ 이 탭은 read-only 다 — 모든 mutation 은 관리 화면에서 한다.
    for (const absent of ['신규 매핑', '수정', '매핑 해제', '엑셀 업로드', '일괄 매핑']) {
      await expect(page.getByRole('button', { name: absent }), absent).toHaveCount(0);
    }
    await expect(page.getByTestId('create-dialog')).toHaveCount(0);
    await expect(page.getByTestId('edit-dialog')).toHaveCount(0);

    // ⛔ 창고는 T08-1 — 열도 placeholder 도 없다.
    await expect(page.locator('th', { hasText: '창고' })).toHaveCount(0);
  });

  test('매핑이 없는 SKU 는 빈 상태를 보여준다', async ({ page }) => {
    await login(page, ADMIN);
    await openMappingTab(page, 'ZZS-E2E-011');

    await expect(page.getByTestId('mapping-tab-empty')).toHaveText(
      '등록된 외부시스템 매핑이 없습니다.',
    );
    await expect(page.getByTestId('tab-mapping-row')).toHaveCount(0);
    // 빈 상태에서도 관리 화면 링크는 남는다 (mutation CTA 가 아니다).
    await expect(page.getByTestId('external-mapping-manage-link')).toBeVisible();
  });
});

test.describe('★ 관리 화면 링크', () => {
  test('★ 클릭하면 해당 SKU 로 필터된 EXT-MAP-001 로 이동한다', async ({ page }) => {
    await login(page, ADMIN);
    await openMappingTab(page, 'ZZS-E2E-015');

    const skuId = new URL(page.url()).pathname.split('/').pop() ?? '';
    expect(skuId).toMatch(/^[0-9a-f-]{36}$/);

    await page.getByTestId('external-mapping-manage-link').click();

    await expect(page).toHaveURL(`/master/external-mappings?skuId=${skuId}`);
    // 관리 화면이 그 SKU 로 필터된 상태로 열린다 — 400 이 아니다.
    await expect(page.getByRole('heading', { name: '외부 상품 매핑' })).toBeVisible();
    await expect(page.getByTestId('error-banner')).toHaveCount(0);
    await expect(page.locator('tr[data-testid="mapping-row"]')).toHaveCount(3);
  });
});

test.describe('권한 — external_mapping.read', () => {
  test('★ EXECUTIVE 는 SKU 상세·바코드 탭은 되지만 외부시스템 매핑 탭이 없다', async ({ page }) => {
    await login(page, EXECUTIVE);
    await openDetail(page, 'ZZS-E2E-015');

    // sku.read 는 있다.
    await expect(page.getByTestId('detail-status')).toBeVisible();
    // barcode.read 도 있다.
    await expect(page.getByRole('tab', { name: '바코드' })).toBeVisible();
    // ★ external_mapping.read 가 없어 탭 자체가 노출되지 않는다.
    await expect(page.getByRole('tab', { name: '외부시스템 매핑' })).toHaveCount(0);
    // ✏️ T1-6B5 — EXECUTIVE 는 `bom.read` 를 가지므로 ⑦ BOM 탭이 **보인다**
    //    (D-15). 그래서 노출 탭이 5 → 6 으로 늘었다.
    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(1);
    // ⛔ 공급조건은 여전히 숨는다 — 두 탭의 권한 계약이 다르다.
    await expect(page.getByRole('tab', { name: '공급조건' })).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(6);
  });

  test('FINANCE 는 탭을 열어 요약을 볼 수 있다 (변경 UI 는 원래 없다)', async ({ page }) => {
    await login(page, FINANCE);
    await openMappingTab(page, 'ZZS-E2E-015');

    await expect(page.getByTestId('mapping-tab-forbidden')).toHaveCount(0);
    await expect(page.getByTestId('tab-mapping-row')).toHaveCount(3);
    await expect(page.getByTestId('external-mapping-manage-link')).toBeVisible();
    // 이 탭에는 애초에 mutation control 이 없다 — 역할과 무관하다.
    await expect(page.getByRole('button', { name: '신규 매핑' })).toHaveCount(0);
  });
});
