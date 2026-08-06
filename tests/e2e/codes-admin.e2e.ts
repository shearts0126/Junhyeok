import { expect, test, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * 공통코드 관리 화면 E2E (T0-8).
 *
 * 스텁 Supabase 로 실제 로그인 → 쿠키 → Proxy 1차 가드 → 화면 → API 2차 가드까지
 * 운영과 같은 경로를 통과한다. 앱 코드에 테스트 분기가 없다.
 */

const [ADMIN, STAFF] = E2E_USERS;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe.configure({ mode: 'serial' });

test.describe('ADMIN — 공통코드 관리', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/admin/codes');
  });

  test('화면 진입 — 그룹 목록과 기본 그룹(BRAND) 코드가 보인다', async ({ page }) => {
    await expect(page.getByRole('heading', { name: '공통코드 관리' })).toBeVisible();

    // 그룹 6종 + E2E 픽스처 그룹
    for (const groupName of ['브랜드', '대분류', '소분류', '부자재분류', '보관처', '채널']) {
      await expect(page.locator('aside').getByText(groupName, { exact: true })).toBeVisible();
    }

    // 기본 선택은 sortOrder 1 인 BRAND — 원본 코드 FB·BO 가 보인다
    await expect(page.locator('tr[data-code="FB"]')).toContainText('포뷰트');
    await expect(page.locator('tr[data-code="BO"]')).toContainText('바디오라');

    // ⛔ 삭제 버튼은 어디에도 없다
    await expect(page.getByRole('button', { name: '삭제' })).toHaveCount(0);
  });

  test('그룹 전환 — 대분류를 선택하면 12건이 보인다', async ({ page }) => {
    await page.locator('aside').getByText('대분류', { exact: true }).click();
    await expect(page.locator('tr[data-code="DV"]')).toContainText('디바이스');
    await expect(page.locator('tbody tr[data-code]')).toHaveCount(12);
  });

  test('코드 검색 — 명칭으로 거른다', async ({ page }) => {
    await page.locator('aside').getByText('소분류', { exact: true }).click();
    await expect(page.locator('tr[data-code="IR"]')).toBeVisible();

    await page.getByRole('searchbox', { name: '코드·명칭 검색' }).fill('태닝');
    await expect(page.locator('tbody tr[data-code]')).toHaveCount(1);
    await expect(page.locator('tr[data-code="TN"]')).toContainText('태닝');
  });

  test('신규 코드 생성 → 수정 → 비활성화 → 필터 → 재활성화', async ({ page }) => {
    // ── 생성 ──
    await page.getByRole('button', { name: '신규 코드 추가' }).click();
    await expect(
      page.getByText('코드 값은 저장 후 변경할 수 없습니다', { exact: false }),
    ).toBeVisible();

    await page.locator('input[name="code"]').fill('ZZE_NEW');
    await page.locator('input[name="name"]').fill('E2E 신규 브랜드');
    await page.locator('input[name="sortOrder"]').fill('100');
    await page.getByRole('button', { name: '저장' }).click();

    await expect(page.getByText("코드 'ZZE_NEW' 을(를) 추가했습니다.")).toBeVisible();
    await expect(page.locator('tr[data-code="ZZE_NEW"]')).toContainText('E2E 신규 브랜드');

    // ── 수정 ──
    await page.locator('tr[data-code="ZZE_NEW"]').getByRole('button', { name: '수정' }).click();
    const editForm = page.locator('form', { hasText: '코드 수정' });
    await expect(editForm.locator('input[disabled]')).toHaveValue('ZZE_NEW'); // 코드 변경 불가 표시
    await editForm.locator('input[name="name"]').fill('E2E 개정 브랜드');
    await editForm.getByRole('button', { name: '저장' }).click();

    await expect(page.getByText("코드 'ZZE_NEW' 을(를) 수정했습니다.")).toBeVisible();
    await expect(page.locator('tr[data-code="ZZE_NEW"]')).toContainText('E2E 개정 브랜드');

    // ── 비활성화 (확인 다이얼로그 수락) ──
    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('tr[data-code="ZZE_NEW"]').getByRole('button', { name: '비활성화' }).click();
    await expect(page.getByText("코드 'ZZE_NEW' 을(를) 비활성화했습니다.")).toBeVisible();

    // 활성 필터(기본)에서는 사라진다
    await expect(page.locator('tr[data-code="ZZE_NEW"]')).toHaveCount(0);

    // ── 비활성 필터에서 보이고, 재활성화 ──
    await page.getByRole('button', { name: '비활성', exact: true }).click();
    await expect(page.locator('tr[data-code="ZZE_NEW"]')).toContainText('비활성');
    await page.locator('tr[data-code="ZZE_NEW"]').getByRole('button', { name: '재활성화' }).click();
    await expect(page.getByText("코드 'ZZE_NEW' 을(를) 재활성화했습니다.")).toBeVisible();

    // 전체 필터에서 활성으로 표시된다
    await page.getByRole('button', { name: '전체', exact: true }).click();
    await expect(page.locator('tr[data-code="ZZE_NEW"]')).toContainText('활성');
  });

  test('중복 코드 생성 — 오류 배너와 requestId 가 표시된다', async ({ page }) => {
    await page.getByRole('button', { name: '신규 코드 추가' }).click();
    await page.locator('input[name="code"]').fill('FB'); // 이미 존재
    await page.locator('input[name="name"]').fill('중복 시도');
    await page.getByRole('button', { name: '저장' }).click();

    const banner = page.getByTestId('error-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('FB');
    // ★ requestId 로 서버 로그를 찾을 수 있어야 한다
    await expect(page.getByTestId('error-request-id')).toContainText('requestId:');
    // 내부 스택은 배너에 없다
    await expect(banner).not.toContainText('at ');
  });

  test('부모 비활성화 차단 — 하위 활성 코드가 있으면 409 메시지', async ({ page }) => {
    await page.locator('aside').getByText('E2E 상위', { exact: true }).click();
    await expect(page.locator('tr[data-code="EP1"]')).toBeVisible();

    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('tr[data-code="EP1"]').getByRole('button', { name: '비활성화' }).click();

    const banner = page.getByTestId('error-banner');
    await expect(banner).toContainText('하위 활성 코드');
    await expect(page.getByTestId('error-request-id')).toBeVisible();

    // 여전히 활성이다
    await page.getByRole('button', { name: '전체', exact: true }).click();
    await expect(page.locator('tr[data-code="EP1"]')).toContainText('활성');
  });
});

test.describe('read-only(SCM_STAFF) — 조회는 되고 변경은 차단', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, STAFF);
    await page.goto('/admin/codes');
  });

  test('화면 진입은 되지만 수정 UI 가 렌더링되지 않는다', async ({ page }) => {
    await expect(page.getByRole('heading', { name: '공통코드 관리' })).toBeVisible();
    await expect(page.locator('tr[data-code="FB"]')).toBeVisible();

    // 수정 UI 미노출
    await expect(page.getByRole('button', { name: '신규 코드 추가' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '수정' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '비활성화' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: '작업' })).toHaveCount(0);
  });

  test('★ UI 를 우회해 서버로 직접 변경 요청을 보내도 403', async ({ page }) => {
    const request = page.context().request;

    const created = await request.post('/api/codes/BRAND', {
      data: { code: 'ZZE_HACK', name: '권한 우회 시도' },
    });
    expect(created.status()).toBe(403);

    const patched = await request.patch('/api/codes/BRAND/FB', {
      data: { name: '권한 우회 수정' },
    });
    expect(patched.status()).toBe(403);

    // DELETE 는 manage 권한 요구 이전에 라우트 자체가 없다 — read-only 는 1차에서 403
    const deleted = await request.delete('/api/codes/BRAND/FB');
    expect(deleted.status()).toBe(403);

    // 조회는 된다
    const list = await request.get('/api/codes/BRAND');
    expect(list.status()).toBe(200);
  });
});
