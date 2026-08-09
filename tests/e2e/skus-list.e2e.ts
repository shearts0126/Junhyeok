import { expect, test, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * SKU 목록 화면 E2E (T1-5A).
 *
 * 픽스처(setup-db): ZZS-E2E-001(ACTIVE, 브랜드 FB) / 002(DRAFT) / 003(INACTIVE, CONSUMABLE).
 * 스텁 Supabase 로그인 → Proxy 1차 가드(sku.read) → 화면 → API 2차 가드까지
 * 운영과 같은 경로다.
 */

const [ADMIN, , FINANCE] = E2E_USERS;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe.configure({ mode: 'serial' });

test.describe('SKU 목록 — 조회·검색 (ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/skus');
  });

  test('기본 목록 렌더 — 픽스처 3건과 상태 배지, 미래 열 부재', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'SKU 목록' })).toBeVisible();

    for (const skuCode of ['ZZS-E2E-001', 'ZZS-E2E-002', 'ZZS-E2E-003']) {
      await expect(page.locator(`tr[data-sku="${skuCode}"]`)).toBeVisible();
    }
    // 상태 배지 + 브랜드 표시값(T1-3 공개 contract)
    await expect(page.locator('tr[data-sku="ZZS-E2E-001"] [data-status="ACTIVE"]')).toBeVisible();
    await expect(page.locator('tr[data-sku="ZZS-E2E-002"] [data-status="DRAFT"]')).toBeVisible();
    await expect(page.locator('tr[data-sku="ZZS-E2E-001"]')).toContainText('포뷰트');

    // ⛔ 미래 열·필터 부재 — 바코드/매핑/BOM/오류
    for (const forbidden of ['바코드', '매핑', 'BOM', '오류 건수']) {
      await expect(page.locator('thead'), forbidden).not.toContainText(forbidden);
    }
    for (const label of ['hasBom', 'mappingStatus', 'hasIssue']) {
      await expect(page.locator(`[name="${label}"]`)).toHaveCount(0);
    }
    // ⛔ 금지 액션 버튼 부재.
    //    ✏️ T1-6A 에서 `신규 SKU`(등록 화면 링크)만 추가됐다 — 업로드·다운로드·
    //       일괄 처리는 계속 없다 (sku-detail.e2e.ts 가 노출 조건을 검증한다).
    for (const forbidden of ['엑셀 업로드', '엑셀 다운로드', '일괄', '삭제']) {
      await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
    }
  });

  test('q 검색 — 상품명으로 거르고 URL 이 갱신된다', async ({ page }) => {
    await page.getByRole('searchbox', { name: '통합검색' }).fill('활성 샴푸');
    await page.getByRole('button', { name: '검색' }).click();

    await expect(page).toHaveURL(/q=/);
    await expect(page.locator('tr[data-sku="ZZS-E2E-001"]')).toBeVisible();
    await expect(page.locator('tr[data-sku="ZZS-E2E-003"]')).toHaveCount(0);

    // skuCode 로도 검색된다
    await page.getByRole('searchbox', { name: '통합검색' }).fill('ZZS-E2E-003');
    await page.getByRole('button', { name: '검색' }).click();
    await expect(page.locator('tr[data-sku="ZZS-E2E-003"]')).toBeVisible();
    await expect(page.locator('tr[data-sku="ZZS-E2E-001"]')).toHaveCount(0);
  });

  test('상태·품목구분 필터 + empty state', async ({ page }) => {
    await page.getByRole('combobox', { name: '상태 필터' }).selectOption('INACTIVE');
    await expect(page).toHaveURL(/status=INACTIVE/);
    await expect(page.locator('tr[data-sku="ZZS-E2E-003"]')).toBeVisible();
    await expect(page.locator('tr[data-sku="ZZS-E2E-001"]')).toHaveCount(0);

    // INACTIVE + FINISHED_GOOD → 결과 없음 (가짜 행 없이 empty state)
    await page.getByRole('textbox', { name: '품목구분 필터' }).fill('FINISHED_GOOD');
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });

  test('브랜드 필터 — 활성 공통코드 옵션으로 거른다', async ({ page }) => {
    await page.getByRole('combobox', { name: '브랜드' }).selectOption({ label: 'FB — 포뷰트' });
    await expect(page).toHaveURL(/brandId=/);
    await expect(page.locator('tr[data-sku="ZZS-E2E-001"]')).toBeVisible();
    await expect(page.locator('tr[data-sku="ZZS-E2E-002"]')).toHaveCount(0);
  });

  test('정렬 변경 — skuCode 오름차순 + URL 반영', async ({ page }) => {
    await page.getByRole('combobox', { name: '정렬' }).selectOption('skuCode_asc');
    await expect(page).toHaveURL(/sort=skuCode_asc/);
    await expect(page.locator('tbody tr[data-sku]').first()).toBeVisible();
  });

  test('URL 직접 진입 — 검색조건이 복원된다 (back/forward 계약)', async ({ page }) => {
    await page.goto('/master/skus?status=DRAFT&sort=skuCode_asc&pageSize=20');
    await expect(page.getByRole('combobox', { name: '상태 필터' })).toHaveValue('DRAFT');
    await expect(page.getByRole('combobox', { name: '정렬' })).toHaveValue('skuCode_asc');
    await expect(page.getByRole('combobox', { name: '페이지 크기' })).toHaveValue('20');
    await expect(page.locator('tr[data-sku="ZZS-E2E-002"]')).toBeVisible();
  });

  test('★ 미지원 파라미터가 URL 에 있으면 400 을 그대로 보여준다 (조용한 제거 금지)', async ({
    page,
  }) => {
    await page.goto('/master/skus?hasBom=true');
    await expect(page.getByTestId('error-banner')).toBeVisible();
    await expect(page.getByTestId('error-state')).toBeVisible();
    await expect(page.getByTestId('error-request-id')).toBeVisible();
    // URL 은 그대로 — 파라미터를 몰래 지우고 재조회하지 않는다
    await expect(page).toHaveURL(/hasBom=true/);
  });
});

test.describe('SKU 목록 — read-only 역할(FINANCE)', () => {
  test('FINANCE 도 목록 조회가 가능하고, 어떤 액션 버튼도 없다', async ({ page }) => {
    await login(page, FINANCE);
    await page.goto('/master/skus');

    await expect(page.locator('tr[data-sku="ZZS-E2E-001"]')).toBeVisible();
    for (const forbidden of ['엑셀 업로드', '일괄', '신규 SKU', '승인', '삭제']) {
      await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
    }
  });
});
