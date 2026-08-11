import { expect, test, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * SKU 상세·등록 화면 E2E (T1-6A).
 *
 * 픽스처(setup-db, ZZS-): 001 ACTIVE / 002 DRAFT / 003 INACTIVE /
 * 004 DRAFT(submit) / 005·006 PENDING(approve·reject) / 007 PENDING(작성자=ADMIN,
 * 자가승인) / 008 DRAFT(품목구분 미매핑) / 009 거래이력 / 010 비활성 브랜드 참조.
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드 → 화면 → API 2차 가드까지 운영과 같은 경로다.
 */

const [ADMIN, STAFF, FINANCE, LEADER, EXECUTIVE] = E2E_USERS;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** 목록에서 코드로 상세로 이동한다 (링크 contract 도 함께 검증). */
async function openDetail(page: Page, skuCode: string): Promise<void> {
  await page.goto(`/master/skus?q=${skuCode}`);
  await page.locator(`tr[data-sku="${skuCode}"]`).getByRole('link', { name: skuCode }).click();
  await expect(page).toHaveURL(/\/master\/skus\/[0-9a-f-]{36}/);
}

test.describe.configure({ mode: 'serial' });

test.describe('목록 → 상세 연결', () => {
  test('SKU 코드 링크로 상세 진입 + ADMIN 에게 신규 SKU 버튼', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/skus');

    await expect(page.getByTestId('new-sku-link')).toBeVisible();
    await openDetail(page, 'ZZS-E2E-002');
    await expect(page.getByTestId('detail-status')).toHaveAttribute('data-status', 'DRAFT');
  });

  test('FINANCE 에게는 신규 SKU 버튼이 없다 (sku.create 없음)', async ({ page }) => {
    await login(page, FINANCE);
    await page.goto('/master/skus');
    await expect(page.locator('tr[data-sku="ZZS-E2E-001"]')).toBeVisible();
    await expect(page.getByTestId('new-sku-link')).toHaveCount(0);
  });
});

test.describe('★ /master/skus/new 접근권한 (sku.create)', () => {
  for (const [roleLabel, user] of [
    ['ADMIN', ADMIN],
    ['SCM_LEADER', LEADER],
    ['SCM_STAFF', STAFF],
  ] as const) {
    test(`${roleLabel} 는 신규 등록 화면에 접근할 수 있다`, async ({ page }) => {
      await login(page, user);
      const response = await page.goto('/master/skus/new');
      expect(response?.status(), roleLabel).toBe(200);
      await expect(page.getByRole('heading', { name: '신규 SKU 등록' })).toBeVisible();
      await expect(page.getByTestId('create-submit')).toBeEnabled();
    });
  }

  for (const [roleLabel, user] of [
    ['FINANCE', FINANCE],
    ['EXECUTIVE', EXECUTIVE],
  ] as const) {
    test(`★ ${roleLabel} 는 URL 직접 접근해도 403 — sku.read 만으로 열리지 않는다`, async ({
      page,
    }) => {
      await login(page, user);
      const response = await page.goto('/master/skus/new');
      expect(response?.status(), roleLabel).toBe(403);
      // 화면이 렌더되지 않는다 (저장 버튼 disable 로 막는 방식이 아니다)
      await expect(page.getByRole('heading', { name: '신규 SKU 등록' })).toHaveCount(0);
    });

    test(`${roleLabel} 목록에는 신규 SKU 버튼이 없고, 상세는 sku.read 로 열린다`, async ({
      page,
    }) => {
      await login(page, user);
      await page.goto('/master/skus');
      await expect(page.getByTestId('new-sku-link')).toHaveCount(0);

      // ★ 회귀 방지 — 상세(UUID)는 여전히 sku.read 로 접근 가능해야 한다
      const detail = await page.goto('/master/skus?q=ZZS-E2E-002');
      expect(detail?.status()).toBe(200);
      await page
        .locator('tr[data-sku="ZZS-E2E-002"]')
        .getByRole('link', { name: 'ZZS-E2E-002' })
        .click();
      await expect(page).toHaveURL(/\/master\/skus\/[0-9a-f-]{36}/);
      await expect(page.getByTestId('detail-status')).toHaveAttribute('data-status', 'DRAFT');
    });
  }
});

test.describe('신규 SKU 등록', () => {
  test('★ 정상 등록 → DRAFT 상세로 이동, 서버관리·음수허용 필드 payload 부재', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/skus/new');

    // 요청 payload 를 가로채 금지 필드 부재를 직접 확인한다.
    const posted: Array<Record<string, unknown>> = [];
    const keys: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/skus')) {
        posted.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
        const header = request.headers()['idempotency-key'];
        if (header !== undefined) keys.push(header);
      }
    });

    const skuCode = `ZZS-E2E-NEW-${Date.now()}`;
    await page.locator('input[name="skuCode"]').fill(skuCode);
    await page.locator('input[name="skuName"]').fill('E2E 신규 등록 상품');
    await page.locator('select[name="itemType"]').selectOption('FINISHED_GOOD');

    // 재고관리 탭에서 Decimal 문자열 입력
    await page.getByRole('tab', { name: '재고관리 설정' }).click();
    await page.locator('input[name="unitConversionQty"]').fill('2.500000');

    await page.getByTestId('create-submit').click();

    await expect(page).toHaveURL(/\/master\/skus\/[0-9a-f-]{36}/);
    await expect(page.getByTestId('detail-status')).toHaveAttribute('data-status', 'DRAFT');

    const payload = posted[0] ?? {};
    for (const forbidden of [
      'id',
      'status',
      'hasTransaction',
      'createdBy',
      'updatedBy',
      'approvedAt',
      'approvedBy',
      'deletedAt',
      'negativeStockAllowed',
    ]) {
      expect(Object.keys(payload), forbidden).not.toContain(forbidden);
    }
    // Decimal 은 문자열 그대로 전송
    expect(payload['unitConversionQty']).toBe('2.500000');
    // Idempotency-Key 를 실제로 보낸다
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('★ 중복 skuCode → 409 오류 표시 (상세로 이동하지 않음)', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/skus/new');

    await page.locator('input[name="skuCode"]').fill('ZZS-E2E-001'); // 이미 존재
    await page.locator('input[name="skuName"]').fill('중복 코드');
    await page.locator('select[name="itemType"]').selectOption('FINISHED_GOOD');
    await page.getByTestId('create-submit').click();

    await expect(page.getByTestId('error-banner')).toHaveAttribute(
      'data-error-code',
      'SKU_CODE_DUPLICATE',
    );
    await expect(page).toHaveURL(/\/master\/skus\/new/);
  });

  test('★ 검증 오류(앞뒤 공백) → fieldErrors 표시, 자동 trim 없음', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/skus/new');

    await page.locator('input[name="skuCode"]').fill(' ZZS-E2E-TRIM ');
    await page.locator('input[name="skuName"]').fill('공백 검증');
    await page.locator('select[name="itemType"]').selectOption('FINISHED_GOOD');
    await page.getByTestId('create-submit').click();

    await expect(page.getByTestId('error-banner')).toHaveAttribute(
      'data-error-code',
      'VALIDATION_ERROR',
    );
    await expect(page.getByTestId('error-fields')).toContainText('skuCode');
  });
});

test.describe('상세 조회·수정', () => {
  test('★ 5개 탭(바코드·외부매핑 포함)만 존재 — 미래 탭·코드추천·음수허용 없음', async ({
    page,
  }) => {
    await login(page, ADMIN);
    await openDetail(page, 'ZZS-E2E-002');

    // ★ T1-6B1 에서 ③ 바코드, T1-6B2 에서 ④ 외부시스템 매핑이 더해졌다.
    //   순서는 원문 8탭의 논리 순서다.
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(5);
    await expect(tabs.nth(0)).toHaveText('기본정보');
    await expect(tabs.nth(1)).toHaveText('코드·분류');
    await expect(tabs.nth(2)).toHaveText('바코드');
    await expect(tabs.nth(3)).toHaveText('외부시스템 매핑');
    await expect(tabs.nth(4)).toHaveText('재고관리 설정');

    // ⛔ 변경이력(T1-6B3)·공급조건(T06)·BOM(T07) 은 아직 없다.
    for (const forbidden of ['공급조건', 'BOM', '변경이력']) {
      await expect(page.getByRole('tab', { name: forbidden }), forbidden).toHaveCount(0);
    }
    for (const forbidden of ['코드 추천', '폐기', '엑셀']) {
      await expect(page.getByRole('button', { name: forbidden }), forbidden).toHaveCount(0);
    }
    // ⛔ 음수허용은 어떤 형태로도 없다
    await expect(page.locator('[name="negativeStockAllowed"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('음수허용');
  });

  test('★ 잘못된 UUID → 400 / 없는 SKU → 404 (빈 화면 아님)', async ({ page }) => {
    await login(page, ADMIN);

    await page.goto('/master/skus/not-a-uuid');
    await expect(page.getByTestId('detail-error')).toContainText('잘못된 SKU 식별자');

    await page.goto('/master/skus/11111111-1111-4111-8111-111111111111');
    await expect(page.getByTestId('detail-error')).toContainText('찾을 수 없습니다');
  });

  test('★ FINANCE 는 읽기 전용 — 저장·워크플로 버튼 없음', async ({ page }) => {
    await login(page, FINANCE);
    await openDetail(page, 'ZZS-E2E-002');

    await expect(page.getByTestId('detail-save')).toHaveCount(0);
    await expect(page.getByTestId('action-submit')).toHaveCount(0);
    await expect(page.getByTestId('no-workflow-action')).toBeVisible();
  });

  test('★ 변경 없으면 저장 비활성 → 변경 시 활성 → 변경 필드만 PATCH', async ({ page }) => {
    await login(page, STAFF);
    await openDetail(page, 'ZZS-E2E-010'); // 비활성 브랜드를 참조 중인 SKU

    await expect(page.getByTestId('detail-save')).toBeDisabled();

    const patches: Array<Record<string, unknown>> = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().includes('/api/skus/')) {
        patches.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
      }
    });

    await page.locator('input[name="skuName"]').fill('E2E 비활성참조 SKU (수정)');
    await expect(page.getByTestId('detail-save')).toBeEnabled();
    await page.getByTestId('detail-save').click();

    await expect(page.getByTestId('notice')).toContainText('저장했습니다');
    // ★ 바뀐 필드만 — 건드리지 않은 비활성 brandId 는 전송되지 않아 저장이 막히지 않는다
    expect(patches[0]).toEqual({ skuName: 'E2E 비활성참조 SKU (수정)' });
  });

  test('★ ACTIVE SKU 는 일반 수정 제한 안내 + 저장 버튼 없음', async ({ page }) => {
    await login(page, ADMIN);
    await openDetail(page, 'ZZS-E2E-001');

    await expect(page.getByTestId('active-edit-restricted')).toContainText(
      '허용 필드 정책이 아직 확정되지 않아',
    );
    await expect(page.getByTestId('detail-save')).toHaveCount(0);
  });

  test('★ 거래 이력이 있으면 skuCode 읽기 전용', async ({ page }) => {
    await login(page, STAFF);
    await openDetail(page, 'ZZS-E2E-009');

    await expect(page.getByTestId('has-transaction')).toBeVisible();
    await expect(page.locator('input[name="skuCode"]')).toHaveAttribute('readonly', '');
  });
});

test.describe('워크플로 액션', () => {
  test('★ DRAFT + sku.submit → 승인요청, 성공 후 상태 갱신 + 검증 리포트', async ({ page }) => {
    await login(page, STAFF);
    await openDetail(page, 'ZZS-E2E-004');

    await expect(page.getByTestId('action-submit')).toBeVisible();
    await expect(page.getByTestId('action-approve')).toHaveCount(0); // STAFF 는 승인 권한 없음

    await page.getByTestId('action-submit').click();
    await page.getByRole('textbox', { name: '워크플로 사유' }).fill('E2E 승인 요청');
    await page.getByTestId('action-confirm').click();

    // ★ 서버 결과로 갱신된 상태
    await expect(page.getByTestId('detail-status')).toHaveAttribute(
      'data-status',
      'PENDING_APPROVAL',
      { timeout: 15_000 },
    );

    // ★ V1~V9 리포트 — CHECK_UNAVAILABLE / NOT_APPLICABLE 을 숨기지 않는다
    const report = page.getByTestId('validation-report');
    await expect(report).toBeVisible();
    await expect(report.locator('[data-check="SKU_CODE_PATTERN_VIOLATION"]')).toHaveAttribute(
      'data-check-status',
      'CHECK_UNAVAILABLE',
    );
    await expect(report.locator('[data-check="BARCODE_DUPLICATE"]')).toHaveAttribute(
      'data-check-status',
      'NOT_APPLICABLE',
    );
    await expect(report.locator('[data-check="REQUIRED_FIELD_MISSING"]')).toHaveAttribute(
      'data-check-status',
      'PASS',
    );
  });

  test('★ 승인 전 검증 ERROR → 실패 + FAIL 항목 표시, 상태 유지', async ({ page }) => {
    await login(page, STAFF);
    await openDetail(page, 'ZZS-E2E-008'); // itemType 미매핑

    await page.getByTestId('action-submit').click();
    await page.getByTestId('action-confirm').click();

    await expect(page.getByTestId('error-banner')).toHaveAttribute(
      'data-error-code',
      'SKU_APPROVAL_VALIDATION_FAILED',
      { timeout: 15_000 },
    );
    await expect(
      page.getByTestId('validation-report').locator('[data-check="ITEM_TYPE_UNMAPPED"]'),
    ).toHaveAttribute('data-check-status', 'FAIL');
    await expect(page.getByTestId('detail-status')).toHaveAttribute('data-status', 'DRAFT');
  });

  test('★ PENDING + sku.approve → 승인/반려 노출, 승인 성공 후 ACTIVE', async ({ page }) => {
    await login(page, ADMIN);
    await openDetail(page, 'ZZS-E2E-005');

    await expect(page.getByTestId('action-approve')).toBeVisible();
    await expect(page.getByTestId('action-reject')).toBeVisible();
    // ⛔ archive(폐기) 버튼은 T1-4B — 어떤 상태에서도 없다
    await expect(page.getByTestId('action-archive')).toHaveCount(0);

    await page.getByTestId('action-approve').click();
    await page.getByTestId('action-confirm').click();

    await expect(page.getByTestId('detail-status')).toHaveAttribute('data-status', 'ACTIVE', {
      timeout: 15_000,
    });
  });

  test('★ 반려 — 사유 필수, 입력 후 REJECTED', async ({ page }) => {
    await login(page, ADMIN);
    await openDetail(page, 'ZZS-E2E-006');

    await page.getByTestId('action-reject').click();
    // 사유 없이 확인 → 클라이언트 필수 검증
    await page.getByTestId('action-confirm').click();
    await expect(page.getByTestId('error-banner')).toContainText('반려 사유를 입력하세요');

    await page.getByRole('textbox', { name: '워크플로 사유' }).fill('E2E 반려 사유');
    await page.getByTestId('action-confirm').click();
    await expect(page.getByTestId('detail-status')).toHaveAttribute('data-status', 'REJECTED', {
      timeout: 15_000,
    });
  });

  test('★ 자가승인 차단 — 작성자가 승인 시도하면 403 SELF_APPROVAL_FORBIDDEN', async ({ page }) => {
    await login(page, ADMIN);
    await openDetail(page, 'ZZS-E2E-007'); // createdBy = ADMIN

    // 버튼은 노출된다 — 최종 판정은 서버 트랜잭션이 한다
    await page.getByTestId('action-approve').click();
    await page.getByTestId('action-confirm').click();

    await expect(page.getByTestId('error-banner')).toHaveAttribute(
      'data-error-code',
      'SELF_APPROVAL_FORBIDDEN',
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('detail-status')).toHaveAttribute(
      'data-status',
      'PENDING_APPROVAL',
    );
  });

  test('★ ACTIVE + sku.deactivate → 사용중지, INACTIVE 는 액션 없음', async ({ page }) => {
    await login(page, ADMIN);
    await openDetail(page, 'ZZS-E2E-005'); // 앞 테스트에서 ACTIVE 가 됨

    await expect(page.getByTestId('action-deactivate')).toBeVisible();
    await page.getByTestId('action-deactivate').click();
    await page.getByRole('textbox', { name: '워크플로 사유' }).fill('E2E 사용중지');
    await page.getByTestId('action-confirm').click();

    await expect(page.getByTestId('detail-status')).toHaveAttribute('data-status', 'INACTIVE', {
      timeout: 15_000,
    });
    // INACTIVE 에는 확정된 전이가 없다 — action 을 발명하지 않는다
    await expect(page.getByTestId('no-workflow-action')).toBeVisible();
  });
});
