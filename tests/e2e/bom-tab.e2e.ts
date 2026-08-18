import { expect, test, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * SKU 상세 ⑦ BOM 탭 E2E (T1-6B5) — **read-only**.
 *
 * 근거: `docs/18_설계복구_BOM.md` §D-30.
 *
 * 픽스처(setup-db):
 *
 * ```
 *   ZZS-E2E-020 (완제품)  ── 상위 BOM 2건
 *        ZZB-1.0  ACTIVE [2020-01-01, ∞)   라인 3 (CONFIRMED·SUGGESTED·UNKNOWN)
 *        ZZB-2.0  DRAFT  [2030-01-01, 2031-01-01)  라인 0
 *   ZZS-E2E-021 (구성품)  ── ZZB-1.0 에 **두 번**(대체그룹 ZZG-A / ZZG-B)
 *                            + ZZB-SEMI-1.0 에 한 번  ⇒ where-used 3행
 *   ZZS-E2E-022 (반제품)  ── ZZB-1.0 의 구성품이면서 **자신도 상위 BOM** 을 갖는다
 * ```
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드(`bom.read`) → 화면 → API 2차 가드
 * (`bom.read`)까지 운영과 같은 경로다.
 *
 * ★ 핵심 검증 4가지
 *   ① 8탭 순서 — BOM 은 공급조건 뒤 · 변경이력 앞
 *   ② 두 섹션이 **서로 다른 질문**에 답한다 (상위 BOM ↔ 사용처)
 *   ③ 같은 BOM 이 대체그룹만 달리해 **두 행**으로 나온다 (dedup 금지)
 *   ④ **read-only** — mutation control 이 하나도 없다
 *
 * ⚠️ "탭 선택 후 권한 상실 → basic fallback" 은 여기 없다 — ⑥ 탭과 같은 이유로
 *    브라우저 세션에서 그 전이를 만들 수 없다. 규칙은 `detail-tabs.ts` 순수
 *    함수로 분리해 `bom-ui.test.ts` 가 고정한다.
 */

const [ADMIN, STAFF, FINANCE, , EXECUTIVE] = E2E_USERS;

const PARENT_SKU = 'ZZS-E2E-020';
const COMPONENT_SKU = 'ZZS-E2E-021';
const SEMI_SKU = 'ZZS-E2E-022';

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

async function openBomTab(page: Page, skuCode: string): Promise<void> {
  await openDetail(page, skuCode);
  await page.getByRole('tab', { name: 'BOM' }).click();
}

test.describe('SKU 상세 ⑦ BOM 탭 (ADMIN)', () => {
  test('★ 탭 위치 — 공급조건과 변경이력 사이이며 최종 8탭이다 (D-30)', async ({ page }) => {
    await login(page, ADMIN);
    await openDetail(page, PARENT_SKU);

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
  });

  test('★ 섹션 A — 이 SKU 의 BOM 2건, 상태·적용기간·확정 진행률', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    await expect(page.getByTestId('bom-tab-parent-table')).toBeVisible();
    const rows = page.locator('[data-testid="bom-tab-parent-row"]');
    await expect(rows).toHaveCount(2);

    // ★ 정렬은 effectiveFrom DESC — 미래 시작 DRAFT 가 먼저다.
    await expect(rows.nth(0).getByTestId('bom-tab-version')).toHaveText('ZZB-2.0');
    await expect(rows.nth(1).getByTestId('bom-tab-version')).toHaveText('ZZB-1.0');

    // DRAFT — 라인 0건, 종료일이 있는 기간.
    await expect(rows.nth(0).getByTestId('bom-tab-status')).toHaveAttribute('data-status', 'DRAFT');
    await expect(rows.nth(0).getByTestId('bom-tab-period')).toHaveText('2030-01-01 ~ 2031-01-01');
    await expect(rows.nth(0).getByTestId('bom-tab-line-count')).toHaveText('0');

    // ACTIVE — 라인 3건, 무기한.
    await expect(rows.nth(1).getByTestId('bom-tab-status')).toHaveAttribute(
      'data-status',
      'ACTIVE',
    );
    await expect(rows.nth(1).getByTestId('bom-tab-period')).toHaveText('2020-01-01 ~ 무기한');
    await expect(rows.nth(1).getByTestId('bom-tab-line-count')).toHaveText('3');
  });

  test('★★ 확정 진행률 — SUGGESTED 는 미확정에 포함된다 (확정 1 / 전체 3)', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    const activeRow = page.locator('[data-testid="bom-tab-parent-row"]').nth(1);
    const progress = activeRow.getByTestId('bom-tab-progress');
    // CONFIRMED 1 · SUGGESTED 1 · UNKNOWN 1 → 미확정 2, 확정 1.
    await expect(progress).toHaveAttribute('data-unconfirmed', '2');
    await expect(progress).toHaveText('확정 1 / 전체 3');
    // ⛔ "UNKNOWN 2건" 처럼 표시하지 않는다 — SUGGESTED 가 미입력으로 둔갑한다.
    await expect(progress).not.toContainText('UNKNOWN');
  });

  test('★★ 섹션 B — 같은 BOM 이 대체그룹만 달리해 두 행으로 나온다 (dedup 금지)', async ({
    page,
  }) => {
    await login(page, ADMIN);
    await openBomTab(page, COMPONENT_SKU);

    await expect(page.getByTestId('bom-tab-where-used-table')).toBeVisible();
    const rows = page.locator('[data-testid="bom-tab-where-used-row"]');
    // ZZB-1.0 에 2행(ZZG-A · ZZG-B) + ZZB-SEMI-1.0 에 1행.
    await expect(rows).toHaveCount(3);

    const groups = page.locator('[data-testid="bom-tab-alternate-group"]');
    await expect(groups).toHaveText(['ZZG-A', 'ZZG-B', '—']);
  });

  test('★ 소요량 — Decimal 문자열 그대로, UNKNOWN 은 `—` 이며 0 이 아니다', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, COMPONENT_SKU);

    const quantities = page.locator('[data-testid="bom-tab-quantity"]');
    // ★ API 가 Decimal 을 문자열로 직렬화하며 **후행 0 은 정규화**된다
    //   (`2.500000` → `2.5`). UI 는 받은 문자열을 **그대로** 쓰므로 화면도 `2.5` 다.
    await expect(quantities.nth(0)).toHaveText('2.5 EA');
    // ★ 정밀도는 보존된다 — 1/30 이 반올림되지 않는다.
    await expect(quantities.nth(1)).toHaveText('0.033333 EA');

    const statuses = page.locator('[data-testid="bom-tab-quantity-status"]');
    await expect(statuses.nth(0)).toHaveText('확정');
    await expect(statuses.nth(1)).toHaveText('추천');
  });

  test('★ UNKNOWN 라인은 소요량이 `—` 다 — 반제품 사용처에서 확인', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, SEMI_SKU);

    const rows = page.locator('[data-testid="bom-tab-where-used-row"]');
    await expect(rows).toHaveCount(1);
    // ZZB-1.0 line 3 — UNKNOWN · SERVICE.
    await expect(rows.nth(0).getByTestId('bom-tab-quantity')).toHaveText('—');
    await expect(rows.nth(0).getByTestId('bom-tab-quantity-status')).toHaveText('미입력');
  });

  test('★ 두 질문은 다르다 — 반제품은 상위 BOM 도 있고 사용처도 있다', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, SEMI_SKU);

    // 상위: ZZB-SEMI-1.0 1건.
    await expect(page.locator('[data-testid="bom-tab-parent-row"]')).toHaveCount(1);
    // 사용처: ZZB-1.0 의 라인 1건.
    await expect(page.locator('[data-testid="bom-tab-where-used-row"]')).toHaveCount(1);
  });

  test('★ 빈 상태 — 구성품 SKU 는 상위 BOM 이 없다', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, COMPONENT_SKU);

    await expect(page.getByTestId('bom-tab-parent-empty')).toBeVisible();
    await expect(page.getByTestId('bom-tab-parent-table')).toHaveCount(0);
    // 반대편 섹션은 정상 렌더된다 — 한쪽 빈 상태가 다른 쪽을 가리지 않는다.
    await expect(page.getByTestId('bom-tab-where-used-table')).toBeVisible();
  });

  test('★★ read-only — mutation control 이 하나도 없다 (D-30)', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    await expect(page.getByTestId('bom-tab-notice')).toBeVisible();

    // ⛔ BOM 생성·수정·라인 편집·소요량 확정·워크플로 버튼이 전부 없다.
    for (const name of [
      '신규',
      'BOM 생성',
      '라인 추가',
      '수정',
      '삭제',
      '저장',
      '승인 요청',
      '승인',
      '반려',
      '활성화',
      '사용종료',
      '복사',
      '일괄 확정',
      '전개',
      '원가',
    ]) {
      await expect(page.getByRole('button', { name }), name).toHaveCount(0);
    }
    // 페이지 이동 버튼 외에는 form control 이 없다(픽스처는 1페이지뿐).
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('input')).toHaveCount(0);
  });

  test('★ T07-8 미착수 — BOM 관리 화면으로 가는 링크가 없다 (deviation)', async ({ page }) => {
    await login(page, ADMIN);
    await openBomTab(page, PARENT_SKU);

    // `/master/boms` 는 T07-8 이 만든다 — 없는 화면으로 보내는 링크를 만들지 않는다.
    await expect(page.locator('a[href^="/master/boms"]')).toHaveCount(0);
  });
});

test.describe('권한 (T1-6B5 · D-15)', () => {
  test('★ EXECUTIVE — BOM 탭이 보인다 (⑥ 공급조건과 정반대)', async ({ page }) => {
    await login(page, EXECUTIVE);
    await openDetail(page, PARENT_SKU);

    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(1);
    // ⑥ 공급조건은 여전히 숨는다 — 두 탭의 권한 계약이 다르다.
    await expect(page.getByRole('tab', { name: '공급조건' })).toHaveCount(0);
  });

  test('★ EXECUTIVE 도 BOM 내용을 읽는다', async ({ page }) => {
    await login(page, EXECUTIVE);
    await openBomTab(page, PARENT_SKU);
    await expect(page.locator('[data-testid="bom-tab-parent-row"]')).toHaveCount(2);
  });

  test('FINANCE — BOM 탭이 보인다 (read 전용)', async ({ page }) => {
    await login(page, FINANCE);
    await openDetail(page, PARENT_SKU);
    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(1);
  });

  test('SCM_STAFF — BOM 탭이 보인다', async ({ page }) => {
    await login(page, STAFF);
    await openDetail(page, PARENT_SKU);
    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(1);
  });
});

test.describe('등록 화면 (D-30)', () => {
  test('★ /master/skus/new 는 3탭 그대로 — BOM 탭이 없다', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/skus/new');

    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText(['기본정보', '코드·분류', '재고관리 설정']);
    await expect(page.getByRole('tab', { name: 'BOM' })).toHaveCount(0);
  });
});

test.describe('standalone BOM 화면 (T07-8 미착수)', () => {
  test('★ `/master/boms` 는 아직 없다 — T07-8 범위다', async ({ page }) => {
    await login(page, ADMIN);
    const response = await page.goto('/master/boms');
    // route handler 가 없으므로 404 다. route-policy 예약만 존재한다.
    expect(response?.status()).toBe(404);
  });
});
