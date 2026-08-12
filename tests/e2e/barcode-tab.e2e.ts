import { expect, test, type Page } from '@playwright/test';

import { E2E_DUPLICATE_BARCODE, E2E_USERS } from './fixtures';

/**
 * SKU 상세 ③ 바코드 탭 E2E (T1-6B1) — **T04-4B 중복 예외 승인 UI 포함**.
 *
 * 픽스처(setup-db):
 *   - `ZZS-E2E-011` 바코드 없음 — 일반 CRUD(등록·대표·비활성·재활성)
 *   - `ZZS-E2E-012` `E2E_DUPLICATE_BARCODE` 를 **ACTIVE** 로 보유 (중복 원본)
 *   - `ZZS-E2E-013` 같은 값을 등록하려다 409 → 중복 예외 요청 → 승인
 *   - `ZZS-E2E-014` SCM_STAFF 권한 시나리오
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드(`barcode.*`) → 화면 → API 2차 가드까지
 * 운영과 같은 경로다.
 *
 * 핵심 시나리오는 **일반 등록 409 → 명시적 중복 예외 요청 → PENDING → 승인**이며
 * (`docs/16` §9~§11), 409 만으로 후보가 자동 생성되지 않는 것을 함께 본다.
 */

const [ADMIN, STAFF, FINANCE, , EXECUTIVE] = E2E_USERS;

/** 이 spec 이 만든 바코드를 알아보는 고유 숫자값. */
const CRUD_BARCODE = `88099${String(Date.now()).slice(-8)}`;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** 목록 → 상세 → 바코드 탭. */
async function openBarcodeTab(page: Page, skuCode: string): Promise<void> {
  await page.goto(`/master/skus?q=${skuCode}`);
  await page.locator(`tr[data-sku="${skuCode}"]`).getByRole('link', { name: skuCode }).click();
  await expect(page).toHaveURL(/\/master\/skus\/[0-9a-f-]{36}/);
  await page.getByRole('tab', { name: '바코드' }).click();
  await expect(page.getByTestId('barcode-loading')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.describe('탭 구성 — 상세 6탭 / 등록 3탭', () => {
  test('★ 상세 탭에 바코드가 있고, 등록에는 없다', async ({ page }) => {
    // ⚠️ 이 파일이 알파벳 순으로 가장 먼저 실행되므로, 이 테스트 하나가
    //    `/master/skus/new` · `/master/skus` · `/master/skus/[id]` 세 라우트의
    //    dev 서버 최초 컴파일을 모두 떠안는다. 기본 30초로는 부족하다.
    test.slow();
    await login(page, ADMIN);

    await page.goto('/master/skus/new');
    const createTabs = page.getByRole('tab');
    await expect(createTabs).toHaveCount(3);
    await expect(createTabs.nth(0)).toHaveText('기본정보');
    await expect(createTabs.nth(1)).toHaveText('코드·분류');
    await expect(createTabs.nth(2)).toHaveText('재고관리 설정');
    // ⛔ 등록 화면에는 바코드 탭이 없다 — disabled placeholder 도 없다.
    await expect(page.getByRole('tab', { name: '바코드' })).toHaveCount(0);
    await expect(page.getByTestId('new-barcode-button')).toHaveCount(0);

    await openBarcodeTab(page, 'ZZS-E2E-011');
    const detailTabs = page.getByRole('tab');
    await expect(detailTabs).toHaveCount(6);
    await expect(detailTabs.nth(2)).toHaveText('바코드');

    // ⛔ 아직 없는 탭 — T06 / T07
    for (const absent of ['공급조건', 'BOM']) {
      await expect(page.getByRole('tab', { name: absent }), absent).toHaveCount(0);
    }
  });
});

test.describe('일반 바코드 CRUD (ADMIN)', () => {
  test('★ 등록 → ACTIVE → 대표 지정 → 비활성 → 재활성', async ({ page }) => {
    await login(page, ADMIN);
    await openBarcodeTab(page, 'ZZS-E2E-011');

    // ── 등록 ────────────────────────────────────────────────
    await page.getByTestId('new-barcode-button').click();
    await expect(page.getByTestId('barcode-create-dialog')).toBeVisible();
    await page.getByTestId('barcode-create-value').fill(CRUD_BARCODE);
    await page.getByTestId('barcode-create-type').selectOption('UNIT');
    await page.getByTestId('barcode-create-submit').click();

    const row = page.locator(`tr[data-barcode="${CRUD_BARCODE}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-status="ACTIVE"]')).toBeVisible();
    // 조회 전용 메타는 미입력이므로 — 로 나온다 (0·공란 아님).
    await expect(row.getByTestId('barcode-country')).toHaveText('—');
    await expect(row.getByTestId('barcode-channel')).toHaveText('—');
    await expect(row.getByTestId('barcode-period')).toHaveText('—');
    // 중복 예외가 아니다.
    await expect(row.getByTestId('duplicate-exception-badge')).toHaveCount(0);

    // ── 대표 지정 ────────────────────────────────────────────
    await expect(row.getByTestId('barcode-primary')).toHaveCount(0);
    await row.getByTestId('barcode-toggle-primary').click();
    await expect(row.getByTestId('barcode-primary')).toBeVisible();

    // ── 비활성 ──────────────────────────────────────────────
    await row.getByTestId('barcode-deactivate').click();
    await expect(row.locator('[data-status="INACTIVE"]')).toBeVisible();
    // 비활성 행에는 대표 지정·비활성 액션이 없다.
    await expect(row.getByTestId('barcode-toggle-primary')).toHaveCount(0);
    await expect(row.getByTestId('barcode-deactivate')).toHaveCount(0);

    // ── 재활성 ──────────────────────────────────────────────
    await row.getByTestId('barcode-reactivate').click();
    await expect(row.locator('[data-status="ACTIVE"]')).toBeVisible();
  });
});

test.describe('★ 중복 예외 전체 흐름 (ADMIN)', () => {
  test('★ 409 경고 → 명시적 요청 → PENDING → 승인 → 중복 예외 표시', async ({ page }) => {
    await login(page, ADMIN);
    await openBarcodeTab(page, 'ZZS-E2E-013');

    // ── ① 일반 등록 시도 → 409 ────────────────────────────────
    await page.getByTestId('new-barcode-button').click();
    await page.getByTestId('barcode-create-value').fill(E2E_DUPLICATE_BARCODE);
    await page.getByTestId('barcode-create-submit').click();

    // ── ② dialog 유지 · 입력값 유지 · 인라인 경고 ────────────────
    await expect(page.getByTestId('barcode-create-dialog')).toBeVisible();
    await expect(page.getByTestId('barcode-create-value')).toHaveValue(E2E_DUPLICATE_BARCODE);
    await expect(page.getByTestId('error-banner')).toHaveAttribute(
      'data-error-code',
      'BARCODE_DUPLICATE',
    );
    const warning = page.getByTestId('barcode-duplicate-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('다른 SKU');
    // ⛔ 상대 SKU 코드를 노출하지 않는다 — API 가 주지 않는다.
    await expect(warning).not.toContainText('ZZS-E2E-012');

    // ── ③ 자동 생성 없음 — 아직 이 SKU 에 행이 하나도 없다 ─────────
    await expect(page.locator('tr[data-testid="barcode-row"]')).toHaveCount(0);

    // ── ④ 명시적으로 눌러야 후보가 생긴다 ────────────────────────
    await page.getByTestId('barcode-request-duplicate').click();

    const row = page.locator(`tr[data-barcode="${E2E_DUPLICATE_BARCODE}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-status="PENDING_DUPLICATE"]')).toContainText(
      '중복 예외 승인 대기',
    );
    // PENDING 행에는 일반 수정 액션이 없다.
    await expect(row.getByTestId('barcode-toggle-primary')).toHaveCount(0);
    await expect(row.getByTestId('barcode-reactivate')).toHaveCount(0);
    await expect(row.getByTestId('barcode-deactivate')).toHaveCount(0);
    await expect(row.getByTestId('barcode-cancel-candidate')).toBeVisible();

    // ── ⑤ 승인 — 사유 필수 ──────────────────────────────────────
    await row.getByTestId('barcode-approve-duplicate').click();
    await expect(page.getByTestId('barcode-approve-dialog')).toBeVisible();
    await expect(page.getByTestId('approve-barcode')).toHaveText(E2E_DUPLICATE_BARCODE);
    await expect(page.getByTestId('approve-sku')).toHaveText('ZZS-E2E-013');
    // 공백만이면 제출할 수 없다.
    await page.getByTestId('approve-reason').fill('   ');
    await expect(page.getByTestId('approve-submit')).toBeDisabled();

    await page.getByTestId('approve-reason').fill('원본 중복 확인 완료 — 채널 공유');
    await page.getByTestId('approve-submit').click();

    // ── ⑥ ACTIVE + 중복 예외 + 사유 표시 ────────────────────────
    await expect(row.locator('[data-status="ACTIVE"]')).toBeVisible();
    await expect(row.getByTestId('duplicate-exception-badge')).toHaveText('중복 예외');
    await expect(row.getByTestId('duplicate-exception-reason')).toHaveText(
      '원본 중복 확인 완료 — 채널 공유',
    );

    // ── ⑦ 승인 취소(revoke) UI 는 없다 ─────────────────────────
    for (const absent of ['중복 예외 해제', '승인 취소', '예외 취소', '승인 철회']) {
      await expect(page.getByRole('button', { name: absent }), absent).toHaveCount(0);
    }
    // 승인자·승인시각도 표시하지 않는다 (UUID·컬럼·조회 API 가 없다).
    await expect(page.locator('body')).not.toContainText('승인시각');
    await expect(row).not.toContainText(E2E_USERS[0].id);
  });
});

test.describe('권한 — permission 기반 노출', () => {
  test('★ SCM_STAFF 는 등록·중복 예외 요청은 되지만 승인 버튼이 없다', async ({ page }) => {
    await login(page, STAFF);
    await openBarcodeTab(page, 'ZZS-E2E-014');

    await expect(page.getByTestId('new-barcode-button')).toBeVisible();
    await page.getByTestId('new-barcode-button').click();
    await page.getByTestId('barcode-create-value').fill(E2E_DUPLICATE_BARCODE);
    await page.getByTestId('barcode-create-submit').click();

    await expect(page.getByTestId('barcode-duplicate-warning')).toBeVisible();
    // 요청 CTA 는 `barcode.request_duplicate` 라 STAFF 에게도 보인다.
    await page.getByTestId('barcode-request-duplicate').click();

    const row = page.locator(`tr[data-barcode="${E2E_DUPLICATE_BARCODE}"]`);
    await expect(row.locator('[data-status="PENDING_DUPLICATE"]')).toBeVisible();
    // ★ 승인은 ADMIN·SCM_LEADER 뿐 — STAFF 에게는 버튼 자체가 없다.
    await expect(row.getByTestId('barcode-approve-duplicate')).toHaveCount(0);
    // 취소는 `barcode.deactivate` 라 가능하다.
    await expect(row.getByTestId('barcode-cancel-candidate')).toBeVisible();

    await row.getByTestId('barcode-cancel-candidate').click();
    await expect(row.locator('[data-status="INACTIVE"]')).toBeVisible();
  });

  for (const [user, label] of [
    [FINANCE, 'FINANCE'],
    [EXECUTIVE, 'EXECUTIVE'],
  ] as const) {
    test(`${label} 는 바코드를 조회만 하고 변경 UI 가 없다`, async ({ page }) => {
      await login(page, user);
      await openBarcodeTab(page, 'ZZS-E2E-012');

      // 조회는 된다 — 403 을 빈 목록으로 위장하지 않는다.
      await expect(page.getByTestId('barcode-forbidden')).toHaveCount(0);
      await expect(page.locator(`tr[data-barcode="${E2E_DUPLICATE_BARCODE}"]`)).toBeVisible();

      for (const control of [
        'new-barcode-button',
        'barcode-toggle-primary',
        'barcode-deactivate',
        'barcode-reactivate',
        'barcode-approve-duplicate',
        'barcode-cancel-candidate',
      ]) {
        await expect(page.getByTestId(control), control).toHaveCount(0);
      }
    });
  }
});
