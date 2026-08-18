import { expect, test, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * SKU 상세 ⑥ 공급조건 탭 E2E (T1-6B4) — **read-only summary**.
 *
 * 픽스처(setup-db): `ZZS-E2E-018` 이 네 거래처와 관계를 갖는다 —
 * `ZZV-TAB-CUR`(현재 유효 · 리드타임 미입력 → 거래처 기본값 **7** fallback ·
 * MOQ 100 · 대표 · **0원 승인 가격** + 미래 미승인 99999) ·
 * `ZZV-TAB-NOPRICE`(현재 유효 · **지금 발효 구간의 미승인 가격 55555 만** 보유) ·
 * `ZZV-TAB-PAST`(이미 종료) · `ZZV-TAB-FUT`(미래 시작).
 *
 * `ZZS-E2E-019` 는 **가격 chain 손상** 전용이다 — 승인 가격 두 건이 동시에 유효해
 * 409 `SUPPLIER_PRICE_CHAIN_CONFLICT` 가 난다. whole-request 오류라 정상
 * 시나리오와 **반드시 다른 SKU** 여야 한다.
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드(`supplier.read`) → 화면 →
 * API 2차 가드(`supplier.read` **AND** `supplier_price.read`)까지 운영과 같은 경로다.
 *
 * ★ 핵심은 **현재 유효 공급조건만 + 승인 유효단가 요약 + 관리화면 링크**이며,
 *   EXECUTIVE 처럼 `sku.read` 는 있고 supplier capability 가 없는 역할에게는
 *   탭 자체가 보이지 않아야 한다.
 *
 * ⚠️ "탭 선택 후 권한 상실 → basic fallback" 은 여기 없다. 권한은 mount 시
 *    `/api/me` 를 1회만 조회하고 선택 탭은 remount 하면 초기화되므로 브라우저
 *    세션에서 그 전이를 만들 수 없다. 규칙은 `src/app/master/skus/[id]/
 *    detail-tabs.ts` 의 순수 함수로 분리해 `supplier-ui.test.ts` 가 고정한다.
 */

const [ADMIN, STAFF, FINANCE, , EXECUTIVE] = E2E_USERS;

const TAB_SKU = 'ZZS-E2E-018';
/** 승인 가격 2건이 동시에 유효한 손상 픽스처. */
const CONFLICT_SKU = 'ZZS-E2E-019';

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

async function openSupplierTab(page: Page, skuCode: string): Promise<void> {
  await openDetail(page, skuCode);
  await page.getByRole('tab', { name: '공급조건' }).click();
}

test.describe('SKU 상세 ⑥ 공급조건 탭 (ADMIN)', () => {
  test('★ 탭 위치 — 재고관리 설정과 BOM 사이다 (T1-6B5 이후)', async ({ page }) => {
    await login(page, ADMIN);
    await openDetail(page, TAB_SKU);

    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText([
      '기본정보',
      '코드·분류',
      '바코드',
      '외부시스템 매핑',
      '재고관리 설정',
      '공급조건',
      'BOM',
      '변경이력',
    ]);
    // ✏️ T1-6B5 — ⑦ BOM 이 공급조건 **뒤**에 들어갔다.
    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(1);
  });

  test('★ 현재 유효 공급조건만 보인다 — 과거·미래는 없다 (D-5)', async ({ page }) => {
    await login(page, ADMIN);
    await openSupplierTab(page, TAB_SKU);

    await expect(page.getByTestId('supplier-tab-table')).toBeVisible();
    await expect(page.locator('[data-testid="supplier-tab-row"]')).toHaveCount(2);
    await expect(page.getByText('ZZV-TAB-CUR')).toBeVisible();
    await expect(page.getByText('ZZV-TAB-NOPRICE')).toBeVisible();
    await expect(page.getByText('ZZV-TAB-PAST')).toHaveCount(0);
    await expect(page.getByText('ZZV-TAB-FUT')).toHaveCount(0);
  });

  test('★ 8열 · 리드타임 fallback · MOQ · 사급/턴키 · 대표 · 0원 단가', async ({ page }) => {
    await login(page, ADMIN);
    await openSupplierTab(page, TAB_SKU);

    const headers = page.locator('[data-testid="supplier-tab-table"] thead th');
    await expect(headers).toHaveText([
      '공급업체',
      '공급업체 SKU',
      'MOQ',
      '리드타임',
      '공급유형',
      '우선공급업체',
      '최근 단가',
      '관리',
    ]);

    const row = page.locator('[data-testid="supplier-tab-row"]').filter({ hasText: 'ZZV-TAB-CUR' });
    await expect(row.getByTestId('supplier-tab-sku')).toHaveText('ZZV-TAB-SKU-1');
    // ★ Decimal 문자열 그대로.
    await expect(row.getByTestId('supplier-tab-moq')).toHaveText('100');
    // ★ 공급조건 leadTimeDays 가 null 이라 거래처 기본값 7 이 적용된다 (D-9).
    await expect(row.getByTestId('supplier-tab-lead-time')).toHaveText('7');
    await expect(row.getByTestId('supplier-tab-supply-type')).toHaveText('턴키');
    await expect(row.getByTestId('supplier-tab-primary')).toHaveText('예');
    // ★ 승인된 **유효** 단가가 최근 단가로 나온다. 0원이라 `0 KRW` 다 —
    //   미승인 99999 도, 이미 마감된 승인가 1234.5678 도 아니고,
    //   "가격 없음"(`—`)도 아니다 (D-16·D-17).
    await expect(row.getByTestId('supplier-tab-price')).toHaveText('0 KRW');
    await expect(page.getByText('1234.5678')).toHaveCount(0);
    await expect(page.getByText('99999')).toHaveCount(0);
  });

  test('★ 미승인 가격은 최근 단가에 반영되지 않는다 — `—` 다 (D-16·D-17)', async ({ page }) => {
    await login(page, ADMIN);
    await openSupplierTab(page, TAB_SKU);

    const row = page
      .locator('[data-testid="supplier-tab-row"]')
      .filter({ hasText: 'ZZV-TAB-NOPRICE' });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('supplier-tab-sku')).toHaveText('ZZV-TAB-SKU-2');

    // ★★ 이 공급조건이 가진 유일한 가격은 **지금 발효 구간의 미승인 55555** 다.
    //     승인 필터가 빠지면 곧바로 `55555 KRW` 가 보인다.
    await expect(row.getByTestId('supplier-tab-price')).toHaveText('—');
    await expect(row.getByTestId('supplier-tab-price')).not.toContainText('55555');
    await expect(page.getByText('55555')).toHaveCount(0);

    // 값이 없는 칸들도 0 과 혼동되지 않는다 (G-03 null 쪽).
    await expect(row.getByTestId('supplier-tab-moq')).toHaveText('—');
    await expect(row.getByTestId('supplier-tab-lead-time')).toHaveText('—');
    await expect(row.getByTestId('supplier-tab-supply-type')).toHaveText('사급');
    await expect(row.getByTestId('supplier-tab-primary')).toHaveText('—');
  });

  test('★ 가격 chain 손상은 409 로 드러난다 — 최신 하나를 골라 숨기지 않는다 (D-18·D-23)', async ({
    page,
  }) => {
    await login(page, ADMIN);
    await openSupplierTab(page, CONFLICT_SKU);

    const banner = page.getByTestId('error-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-error-code', 'SUPPLIER_PRICE_CHAIN_CONFLICT');

    // ⛔ 손상을 감춘 채 표를 그리지 않는다 — 1000/2000 중 어느 쪽도 보이면 안 된다.
    //    `LIMIT 1` 로 최신 승인가를 골라 정상인 척하면 여기서 걸린다.
    await expect(page.getByTestId('supplier-tab-table')).toHaveCount(0);
    await expect(page.getByText('1000 KRW')).toHaveCount(0);
    await expect(page.getByText('2000 KRW')).toHaveCount(0);
    await expect(page.getByTestId('supplier-tab-manage-link')).toHaveCount(0);
  });

  test('★ 관리 링크는 거래처 공급조건 탭으로 간다 (D-22)', async ({ page }) => {
    await login(page, ADMIN);
    await openSupplierTab(page, TAB_SKU);

    const link = page.getByTestId('supplier-tab-manage-link').first();
    await expect(link).toHaveText('거래처 관리에서 보기');
    await expect(link).toHaveAttribute('href', /\/master\/suppliers\/[0-9a-f-]{36}\?tab=terms$/);

    await link.click();
    await expect(page).toHaveURL(/\/master\/suppliers\/[0-9a-f-]{36}\?tab=terms/);
    await expect(page.getByTestId('panel-terms')).toBeVisible();
  });

  test('★ mutation control 이 하나도 없다 (read-only summary)', async ({ page }) => {
    await login(page, ADMIN);
    await openSupplierTab(page, TAB_SKU);

    for (const forbidden of [
      '공급조건 추가',
      '기간 종료/단축',
      '새 버전 생성',
      '가격 등록',
      '가격 승인',
      '삭제',
    ]) {
      await expect(page.getByRole('button', { name: forbidden }), forbidden).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: '수정', exact: true })).toHaveCount(0);
    // ⛔ asOf 입력 UI 도 없다 (§43).
    await expect(page.getByLabel('기준일')).toHaveCount(0);
  });

  test('공급조건이 없는 SKU 는 빈 상태 문구를 보여준다', async ({ page }) => {
    await login(page, ADMIN);
    // ZZS-E2E-003 은 공급조건 픽스처가 없는 SKU 다.
    await openSupplierTab(page, 'ZZS-E2E-003');
    await expect(page.getByTestId('supplier-tab-empty')).toHaveText('등록된 공급조건이 없습니다.');
    await expect(page.getByTestId('supplier-tab-table')).toHaveCount(0);
  });
});

test.describe('권한 (T1-6B4 D-4)', () => {
  test('FINANCE — 두 permission 을 모두 가지므로 탭이 보인다', async ({ page }) => {
    await login(page, FINANCE);
    await openSupplierTab(page, TAB_SKU);
    await expect(page.getByTestId('supplier-tab-table')).toBeVisible();
  });

  test('SCM_STAFF — 두 permission 을 모두 가지므로 탭이 보인다', async ({ page }) => {
    await login(page, STAFF);
    await openSupplierTab(page, TAB_SKU);
    await expect(page.getByTestId('supplier-tab-table')).toBeVisible();
  });

  test('★ EXECUTIVE — SKU 상세는 열리지만 공급조건 탭은 숨겨진다', async ({ page }) => {
    await login(page, EXECUTIVE);
    await openDetail(page, TAB_SKU);

    // 상세 자체는 열린다 (`sku.read` 보유).
    await expect(page.getByTestId('detail-status')).toBeVisible();
    // ⛔ 공급조건 탭이 없다 — 외부매핑 탭과 같은 경계다.
    await expect(page.getByRole('tab', { name: '공급조건' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '외부시스템 매핑' })).toHaveCount(0);
    // ★ 바코드 탭은 보인다 — 탭마다 요구 capability 가 다르다.
    await expect(page.getByRole('tab', { name: '바코드' })).toBeVisible();
  });
});

test.describe('등록 화면 (§36)', () => {
  test('★ /master/skus/new 는 3탭 그대로 — 공급조건 탭이 없다', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/skus/new');

    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText(['기본정보', '코드·분류', '재고관리 설정']);
    await expect(page.getByRole('tab', { name: '공급조건' })).toHaveCount(0);
  });
});
