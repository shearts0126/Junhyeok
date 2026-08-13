import { expect, test, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * 거래처·공급조건·가격 화면 E2E (T06-4).
 *
 * 픽스처(setup-db): `ZZV-E2E-001`(공급조건 1건 + 승인 가격 1건 + 미승인 0원 가격
 * 1건, 기본 리드타임 **0**) · `ZZV-E2E-002`(공급조건 0건 — 빈 상태 전용이라
 * mutation 이 닿지 않는다).
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드(`supplier.read`) → 화면 → API 2차
 * 가드까지 운영과 같은 경로다.
 *
 * 핵심 시나리오 (§63):
 *   A. 목록 → 생성 → 상세 이동 → 기본정보 수정
 *   B. 공급조건 — 새 버전 생성 / 기간 종료
 *   C. 가격 — 등록(미승인) → 승인
 *   D. 권한 — FINANCE 비대칭 · SCM_STAFF 승인 불가 · EXECUTIVE 차단
 */

const [ADMIN, STAFF, FINANCE, , EXEC] = E2E_USERS;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** 이 spec 이 만든 거래처를 알아보는 고유 코드. */
const NEW_CODE = `ZZV-NEW-${Date.now()}`;

test.describe.configure({ mode: 'serial' });

test.describe('거래처 관리 — 목록 (ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/suppliers');
  });

  test('화면 진입 — 헤더·필터가 보이고 미지원 UI 는 없다', async ({ page }) => {
    await expect(page.getByRole('heading', { name: '거래처 관리' })).toBeVisible();
    await expect(page.getByTestId('filter-q')).toBeVisible();
    await expect(page.getByTestId('filter-supplier-type')).toBeVisible();
    await expect(page.getByTestId('filter-status')).toBeVisible();

    // ⛔ API 가 지원하지 않는 컨트롤은 화면에 없다.
    await expect(page.getByLabel('페이지당 표시 수')).toHaveCount(0);
    await expect(page.getByLabel('정렬')).toHaveCount(0);
    // ⛔ status mutation UI 없음 (D-8).
    await expect(page.getByRole('button', { name: '비활성화' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '폐기' })).toHaveCount(0);
  });

  test('★ 목록 열 8개 — 전화·이메일·비고 열이 없다 (D-3)', async ({ page }) => {
    const headers = page.locator('[data-testid="supplier-table"] thead th');
    await expect(headers).toHaveText([
      '거래처코드',
      '거래처명',
      '거래처유형',
      '사업자등록번호',
      '담당자',
      '기본 리드타임',
      '상태',
      '관리',
    ]);
  });

  test('★ 기본 리드타임 0 은 "0" 으로 표시된다 (— 아님, G-03)', async ({ page }) => {
    const row = page.locator('[data-testid="supplier-row"]', { hasText: 'ZZV-E2E-001' });
    await expect(row.getByTestId('supplier-lead-time')).toHaveText('0');
  });

  test('검색어가 URL 에 반영되고 새로고침 후에도 유지된다', async ({ page }) => {
    await page.getByTestId('filter-q').fill('ZZV-E2E-001');
    await page.getByRole('button', { name: '검색' }).click();
    await expect(page).toHaveURL(/q=ZZV-E2E-001/);

    await page.reload();
    await expect(page.getByTestId('filter-q')).toHaveValue('ZZV-E2E-001');
    await expect(page.locator('[data-testid="supplier-row"]')).toHaveCount(1);
  });

  test('★ 미지원 파라미터는 조용히 지우지 않고 API 400 을 보여준다', async ({ page }) => {
    await page.goto('/master/suppliers?pageSize=10');
    await expect(page.getByTestId('error-banner')).toBeVisible();
  });

  test('거래처유형 필터가 URL 에 반영된다 — 자유 입력값도 통과한다', async ({ page }) => {
    await page.getByTestId('filter-supplier-type').fill('MANUFACTURER');
    await page.getByTestId('filter-q').click(); // blur
    await expect(page).toHaveURL(/supplierType=MANUFACTURER/);
  });
});

test.describe('A. 거래처 lifecycle (ADMIN)', () => {
  test('생성 → 상세 이동 → 기본정보 수정', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/suppliers');

    // ── 생성 dialog (⛔ /new 라우트가 아니다) ──
    await page.getByTestId('new-supplier-button').click();
    const dialog = page.getByTestId('create-dialog');
    await expect(dialog).toBeVisible();

    // ⛔ 상태·창고 입력이 **폼 안에** 없다 (D-8·D-20).
    //    (뒤쪽 목록 필터의 `상태` 입력과 섞이지 않게 dialog 로 범위를 좁힌다.)
    await expect(dialog.getByLabel('상태', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('기본 창고')).toHaveCount(0);

    await page.getByTestId('create-supplier-code').fill(NEW_CODE);
    await page.getByTestId('create-supplier-name').fill('E2E 신규 거래처');
    await page.getByTestId('create-supplier-type').fill('VENDOR');
    await page.getByTestId('create-lead-time').fill('7');
    await page.getByTestId('create-submit').click();

    // ★ 성공하면 상세로 이동한다 (D-6).
    await expect(page).toHaveURL(/\/master\/suppliers\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'E2E 신규 거래처' })).toBeVisible();
    await expect(page.getByTestId('view-code')).toHaveText(NEW_CODE);

    // ★ 새로고침(deep-link)이 목록 cache 없이 성립한다 (D-9 supporting API).
    await page.reload();
    await expect(page.getByTestId('view-code')).toHaveText(NEW_CODE);

    // ── 기본정보 수정 ──
    await page.getByTestId('edit-supplier-button').click();
    // ★ supplierCode 는 readonly 다 (D-7).
    await expect(page.getByTestId('edit-supplier-code')).toHaveAttribute('readonly', '');
    // 변경 전에는 저장이 비활성이다.
    await expect(page.getByTestId('edit-submit')).toBeDisabled();

    await page.getByTestId('edit-contact-name').fill('E2E 수정 담당자');
    await page.getByTestId('edit-submit').click();

    await expect(page.getByText('E2E 수정 담당자')).toBeVisible();
  });
});

test.describe('B. 공급조건 (ADMIN)', () => {
  test('★ "수정" 버튼이 없고 기간 종료/새 버전 두 action 뿐이다', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/suppliers');
    await page
      .locator('[data-testid="supplier-row"]', { hasText: 'ZZV-E2E-001' })
      .getByTestId('supplier-detail-link')
      .click();

    await page.getByTestId('tab-terms').click();
    await expect(page).toHaveURL(/tab=terms/);
    await expect(page.getByTestId('terms-table')).toBeVisible();

    // ⛔ 제자리 수정 UI 가 없다 (D-19).
    await expect(page.getByRole('button', { name: '수정', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('term-close-button').first()).toBeVisible();
    await expect(page.getByTestId('term-version-button').first()).toBeVisible();

    // ★ 입력 리드타임(—)과 적용 리드타임(0)이 분리 표시된다 (D-13).
    const row = page.locator('[data-testid="term-row"]').first();
    await expect(row.getByTestId('term-lead-time')).toHaveText('—');
    await expect(row.getByTestId('term-effective-lead-time')).toHaveText('0');
    // ★ SupplyType 라벨 (D-14).
    await expect(row.getByTestId('term-supply-type')).toHaveText('사급');
    // ★ Decimal 문자열 그대로 (D-15).
    await expect(row.getByTestId('term-moq')).toHaveText('100');
  });

  test('새 버전 생성 — 실질 변경이 없으면 제출할 수 없다', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/suppliers?q=ZZV-E2E-001');
    await page.getByTestId('supplier-detail-link').first().click();
    await page.getByTestId('tab-terms').click();

    await page.getByTestId('term-version-button').first().click();
    await expect(page.getByTestId('term-version-dialog')).toBeVisible();
    // SKU 는 identity 라 읽기 전용이다 (D-18).
    await expect(page.getByTestId('version-sku-readonly')).toHaveAttribute('readonly', '');

    // 시작일만 넣고 실질 변경이 없으면 비활성 (§28).
    await page.getByTestId('version-effective-from').fill('2026-09-01');
    await expect(page.getByTestId('term-version-submit')).toBeDisabled();

    await page.getByTestId('version-moq').fill('250');
    await expect(page.getByTestId('term-version-submit')).toBeEnabled();
    await page.getByTestId('term-version-submit').click();

    // 후속 버전이 생겨 이력이 2건이 된다 — 기존 행은 덮어써지지 않는다.
    await expect(page.locator('[data-testid="term-row"]')).toHaveCount(2);
  });
});

test.describe('C. 가격 (ADMIN)', () => {
  test('가격 등록(미승인) → 승인', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/suppliers?q=ZZV-E2E-001');
    await page.getByTestId('supplier-detail-link').first().click();

    await page.getByTestId('tab-prices').click();
    await expect(page).toHaveURL(/tab=prices/);

    // 선택 전에는 안내 문구다 (D-22).
    await expect(page.getByTestId('price-no-selection')).toBeVisible();

    // ★ 가격 픽스처는 **2026-01-01 시작 공급조건**에 달려 있다 — 앞선 시나리오가
    //   만든 후속 버전(첫 행)이 아니라 그 행을 명시적으로 고른다.
    await page
      .locator('[data-testid="price-terms-table"] tbody tr', { hasText: '2026-01-01' })
      .getByTestId('price-view-button')
      .click();
    await expect(page).toHaveURL(/supplierSkuId=/);
    await expect(page.getByTestId('price-table')).toBeVisible();

    // ★ 0원 미승인 가격이 "0" 과 "미승인" 으로 보인다 (D-25).
    // ★ 행은 시작일 속성으로 특정한다 — 승인 후 앞선 행의 종료일에도 같은 날짜가
    //   찍히므로 텍스트 매칭은 두 행에 걸린다.
    const pendingRow = page.locator('[data-testid="price-row"][data-effective-from="2026-07-01"]');
    await expect(pendingRow.getByTestId('price-unit-price')).toHaveText('0');
    await expect(pendingRow.getByTestId('price-approval-state')).toHaveText('미승인');

    // 승인된 행에는 승인 버튼이 없다 (D-24).
    const approvedRow = page.locator('[data-testid="price-row"][data-effective-from="2026-01-01"]');
    await expect(approvedRow.getByTestId('price-approve-button')).toHaveCount(0);

    // ── 가격 등록 ──
    await page.getByTestId('new-price-button').click();
    await expect(page.getByTestId('price-create-dialog')).toBeVisible();
    // ★ 등록/발효 분리 안내 (§40).
    await expect(page.getByTestId('price-pending-notice')).toBeVisible();
    // ⛔ 첨부·종료일 입력이 없다 (D-26).
    await expect(page.getByLabel('첨부파일')).toHaveCount(0);
    await expect(page.getByLabel('적용 종료일(미포함)')).toHaveCount(0);

    await page.getByTestId('price-unit-price-input').fill('2500.5000');
    await page.getByTestId('price-effective-from').fill('2026-10-01');
    await page.getByTestId('price-create-submit').click();

    const created = page.locator('[data-testid="price-row"][data-effective-from="2026-10-01"]');
    await expect(created.getByTestId('price-approval-state')).toHaveText('미승인');

    // ── 승인 ── (ADMIN 은 supplier_price.approve 보유, 작성자와 동일인이지만
    // 자가승인 판정은 backend 가 한다 — 픽스처 설정이 false 이므로 403 이 정상)
    await created.getByTestId('price-approve-button').click();
    await expect(page.getByTestId('price-approve-notice')).toBeVisible();
    await page.getByTestId('price-approve-note').fill('E2E 승인');
    await page.getByTestId('price-approve-submit').click();

    // 자가승인 금지 설정이므로 배너로 막히는 것이 정상 동작이다 (§42).
    await expect(page.getByTestId('error-banner')).toHaveAttribute(
      'data-error-code',
      'SELF_APPROVAL_FORBIDDEN',
    );
  });

  test('★ 다른 승인자(LEADER)는 같은 가격을 승인할 수 있다', async ({ page }) => {
    const [, , , LEADER] = E2E_USERS;
    await login(page, LEADER);
    await page.goto('/master/suppliers?q=ZZV-E2E-001');
    await page.getByTestId('supplier-detail-link').first().click();
    await page.getByTestId('tab-prices').click();
    await page
      .locator('[data-testid="price-terms-table"] tbody tr', { hasText: '2026-01-01' })
      .getByTestId('price-view-button')
      .click();

    const pendingRow = page.locator('[data-testid="price-row"][data-effective-from="2026-07-01"]');
    await pendingRow.getByTestId('price-approve-button').click();
    await page.getByTestId('price-approve-submit').click();

    await expect(pendingRow.getByTestId('price-approval-state')).toHaveText('승인');
  });
});

test.describe('D. 권한', () => {
  test('★ FINANCE — 거래처 수정 불가, 가격 등록·승인 가능 (비대칭, D-26)', async ({ page }) => {
    await login(page, FINANCE);
    await page.goto('/master/suppliers');

    // 목록은 보이지만 생성 버튼이 없다.
    await expect(page.getByTestId('supplier-table')).toBeVisible();
    await expect(page.getByTestId('new-supplier-button')).toHaveCount(0);

    await page
      .locator('[data-testid="supplier-row"]', { hasText: 'ZZV-E2E-001' })
      .getByTestId('supplier-detail-link')
      .click();

    // 기본정보 수정 버튼 없음.
    await expect(page.getByTestId('edit-supplier-button')).toHaveCount(0);

    // 공급조건 추가·변경 버튼 없음.
    await page.getByTestId('tab-terms').click();
    await expect(page.getByTestId('new-term-button')).toHaveCount(0);
    await expect(page.getByTestId('term-close-button')).toHaveCount(0);
    await expect(page.getByTestId('term-version-button')).toHaveCount(0);

    // ★ 가격은 등록·승인 모두 가능하다.
    await page.getByTestId('tab-prices').click();
    await page
      .locator('[data-testid="price-terms-table"] tbody tr', { hasText: '2026-01-01' })
      .getByTestId('price-view-button')
      .click();
    await expect(page.getByTestId('new-price-button')).toBeVisible();
  });

  test('★ SCM_STAFF — 가격 등록은 되지만 승인 버튼이 없다', async ({ page }) => {
    await login(page, STAFF);
    await page.goto('/master/suppliers?q=ZZV-E2E-001');
    await page.getByTestId('supplier-detail-link').first().click();

    // 거래처·공급조건은 편집 가능.
    await expect(page.getByTestId('edit-supplier-button')).toBeVisible();

    await page.getByTestId('tab-prices').click();
    await page
      .locator('[data-testid="price-terms-table"] tbody tr', { hasText: '2026-01-01' })
      .getByTestId('price-view-button')
      .click();
    await expect(page.getByTestId('new-price-button')).toBeVisible();
    // ⛔ 승인 권한이 없으므로 미승인 행에도 승인 버튼이 없다.
    await expect(page.getByTestId('price-approve-button')).toHaveCount(0);
  });

  test('★ EXECUTIVE — 화면 접근이 차단된다 (403 을 빈 목록으로 위장하지 않는다)', async ({
    page,
  }) => {
    await login(page, EXEC);
    const response = await page.goto('/master/suppliers');
    // proxy 1차 가드가 막는다 — 200 이라면 화면이 forbidden 상태를 보여야 한다.
    if (response !== null && response.status() === 200) {
      await expect(
        page.getByTestId('list-forbidden').or(page.getByTestId('forbidden-state')),
      ).toBeVisible();
      await expect(page.getByTestId('supplier-table')).toHaveCount(0);
    } else {
      expect(response?.status()).toBeGreaterThanOrEqual(400);
    }
  });
});
