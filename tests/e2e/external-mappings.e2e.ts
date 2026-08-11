import { expect, test, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * 외부 상품 매핑 관리 화면 E2E `EXT-MAP-001` (T05-4A).
 *
 * 픽스처(setup-db): 외부시스템 `ZZX-ERP`(활성) / `ZZX-OFF`(비활성),
 * SKU `ZZS-E2E-001`(ACTIVE).
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드(`external_mapping.read`) → 화면 →
 * API 2차 가드까지 운영과 같은 경로다.
 *
 * 핵심 시나리오는 **name-only → REVIEW_REQUIRED → 외부코드 추가 → MATCHED → 해제** 다
 * (docs/15 §26 AC-3~AC-8).
 */

const [ADMIN, , FINANCE, , EXEC] = E2E_USERS;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** 이 spec 이 만든 매핑을 알아보는 고유 외부상품명. */
const NAME = `E2E 외부명 ${Date.now()}`;
const CODE = `ZZX-P-${Date.now()}`;

test.describe.configure({ mode: 'serial' });

test.describe('외부 상품 매핑 — 관리 (ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/external-mappings');
  });

  test('화면 진입 — 헤더·필터가 보이고 미래 기능 UI 는 없다', async ({ page }) => {
    await expect(page.getByRole('heading', { name: '외부 상품 매핑' })).toBeVisible();
    await expect(page.getByTestId('filter-external-system')).toBeVisible();
    await expect(page.getByTestId('filter-mapping-status')).toBeVisible();

    // ⛔ T05-4B / 미지원 기능은 화면에 없다.
    await expect(page.getByRole('button', { name: '미매칭만 보기' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '일괄 매핑' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '엑셀 업로드' })).toHaveCount(0);
    await expect(page.getByLabel('정렬')).toHaveCount(0);
    await expect(page.getByLabel('창고')).toHaveCount(0);
    await expect(page.locator('th', { hasText: '최종수정' })).toHaveCount(0);
  });

  test('외부시스템 lookup — 비활성 시스템도 선택지에 있다', async ({ page }) => {
    const select = page.getByTestId('filter-external-system');
    await expect(select.locator('option', { hasText: 'ZZX-ERP' })).toHaveCount(1);
    const inactive = select.locator('option', { hasText: 'ZZX-OFF' });
    await expect(inactive).toHaveCount(1);
    await expect(inactive).toContainText('(비활성)');
  });

  test('★ 상품명만으로 생성 → REVIEW_REQUIRED → 외부코드 추가 → MATCHED → 매핑 해제', async ({
    page,
  }) => {
    // ── 신규 매핑 (name-only) ─────────────────────────────────
    await page.getByTestId('new-mapping-button').click();
    await expect(page.getByTestId('create-dialog')).toBeVisible();

    await page
      .getByTestId('create-external-system')
      .selectOption({ label: 'ZZX-ERP — E2E 이카운트' });
    await page.getByLabel('SKU 검색').fill('ZZS-E2E-001');
    await expect(
      page.getByTestId('create-sku').locator('option', { hasText: 'ZZS-E2E-001' }),
    ).toHaveCount(1);
    await page
      .getByTestId('create-sku')
      .selectOption({ label: 'ZZS-E2E-001 — E2E 활성 샴푸 (ACTIVE)' });
    await page.getByTestId('create-external-name').fill(NAME);
    await page.getByTestId('create-submit').click();

    // ── REVIEW_REQUIRED 표시 + 자동반영 불가 안내 ────────────────
    const row = page.locator('tr[data-testid="mapping-row"]', { hasText: NAME });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-status="REVIEW_REQUIRED"]')).toBeVisible();
    await expect(page.getByTestId('review-required-notice')).toContainText('자동 원장 반영 대상이');

    // ── 외부코드 추가 → 서버 파생 상태가 MATCHED 로 바뀐다 ────────
    await row.getByTestId('edit-mapping').click();
    await expect(page.getByTestId('edit-dialog')).toBeVisible();
    // identity·상태는 읽기 전용이다.
    await expect(page.getByTestId('edit-sku-readonly')).toContainText('ZZS-E2E-001');
    await expect(page.getByTestId('edit-system-readonly')).toContainText('ZZX-ERP');
    await expect(page.getByTestId('edit-status-readonly')).toContainText('REVIEW_REQUIRED');

    await page.getByTestId('edit-external-code').fill(CODE);
    await page.getByTestId('edit-submit').click();

    const matched = page.locator('tr[data-testid="mapping-row"]', { hasText: CODE });
    await expect(matched.locator('[data-status="MATCHED"]')).toBeVisible();

    // ── 매핑 해제 → effectiveTo 설정, 이후 액션 없음 ─────────────
    await matched.getByTestId('end-mapping').click();

    const ended = page.locator('tr[data-testid="mapping-row"]', { hasText: CODE });
    await expect(ended.getByTestId('ended-mapping')).toBeVisible();
    await expect(ended.getByTestId('edit-mapping')).toHaveCount(0);
    await expect(ended.getByTestId('end-mapping')).toHaveCount(0);
    await expect(ended.getByTestId('effective-period')).toContainText('~');
  });

  test('필터가 URL 과 동기화되고, 미지원 파라미터는 400 을 그대로 보여준다', async ({ page }) => {
    await page.getByTestId('filter-mapping-status').selectOption('MATCHED');
    await expect(page).toHaveURL(/mappingStatus=MATCHED/);

    // ★ UI 가 모르는 파라미터를 조용히 제거하지 않는다 — backend 400 이 보인다.
    await page.goto('/master/external-mappings?sort=createdAt_desc');
    await expect(page.getByTestId('error-banner')).toBeVisible();
    await expect(page.getByTestId('error-banner')).toContainText('지원하지 않는');
  });
});

test.describe('외부 상품 매핑 — 권한', () => {
  test('FINANCE 는 조회만 가능하고 변경 UI 가 없다', async ({ page }) => {
    await login(page, FINANCE);
    await page.goto('/master/external-mappings');

    await expect(page.getByRole('heading', { name: '외부 상품 매핑' })).toBeVisible();
    await expect(page.getByTestId('new-mapping-button')).toHaveCount(0);
    await expect(page.getByTestId('edit-mapping')).toHaveCount(0);
    await expect(page.getByTestId('end-mapping')).toHaveCount(0);
    await expect(page.getByTestId('list-forbidden')).toHaveCount(0);
  });

  test('★ EXECUTIVE 는 화면에 진입하지 못한다 (proxy 1차 가드)', async ({ page }) => {
    await login(page, EXEC);
    const response = await page.goto('/master/external-mappings');
    expect(response?.status()).toBe(403);
  });
});
