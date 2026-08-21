import { expect, test, type Page } from '@playwright/test';

import { E2E_USERS } from './fixtures';

/**
 * BOM 관리 화면 E2E (T07-8) — `/master/boms` · `/master/boms/{id}`.
 *
 * 픽스처(setup-db ⑦·⑧):
 *   - `ZZS-E2E-020` 완제품 — `BomStatus` **7종**이 한 SKU 에 다 있다
 *   - `ZZS-E2E-024` 정상 원가 root — 구성품 `ZZS-E2E-023` 단가 ₩1500(VAT 별도)
 *   - `ZZS-E2E-025`·`026` — **의도적 순환** → 목록에서 `계산 불가`
 *   - `ZZS-E2E-027` — 편집 전용 DRAFT(라인 1건 · UNKNOWN · 입수량 30)
 *
 * 스텁 Supabase 로그인 → Proxy 1차 가드(`bom.read`) → 화면 → API 2차 가드까지
 * 운영과 같은 경로다.
 *
 * 핵심 시나리오:
 *   A. 목록 — 12열 · 필터 7종 · 기준원가 3형태 · **손상 격리**
 *   B. 상세 — 헤더 · 탭 4개 · 15열 · 실제 필요량 · 추천값
 *   C. 편집 — 라인 추가/수정/삭제 · 일괄확정 · 복제
 *   D. 권한 — EXECUTIVE 읽기전용 · SCM_STAFF 승인 불가
 */

const [ADMIN, STAFF, , , EXEC] = E2E_USERS;

async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await page
    .context()
    .request.post('/api/auth/login', { data: { email: user.email, password: user.password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** 픽스처 SKU 로 필터링한 목록으로 이동한다 — 다른 spec 의 데이터와 섞이지 않는다. */
async function gotoListFor(page: Page, skuCode: string): Promise<void> {
  await page.goto(`/master/boms?q=${skuCode}`);
  await expect(page.getByTestId('bom-list')).toBeVisible();
}

/** 목록에서 버전으로 행을 찾아 상세로 들어간다. */
async function openDetail(page: Page, skuCode: string, version: string): Promise<void> {
  await gotoListFor(page, skuCode);
  await page
    .locator('[data-testid="bom-list"] tbody tr')
    .filter({ hasText: version })
    .getByRole('link')
    .click();
  await expect(page.getByRole('tab', { name: '구성품' })).toBeVisible();
}

function unique(): string {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

test.describe.configure({ mode: 'serial' });

// ═══════════════════════════════════════════════════════════════
// A. 목록
// ═══════════════════════════════════════════════════════════════

test.describe('A. BOM 목록 (ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
  });

  test('A1 — 화면 진입 · 미지원 UI 부재', async ({ page }) => {
    await page.goto('/master/boms');
    await expect(page.getByRole('heading', { name: 'BOM 관리' })).toBeVisible();

    // ⛔ API 가 지원하지 않는 컨트롤은 화면에 없다.
    await expect(page.getByLabel('페이지당 표시 수')).toHaveCount(0);
    await expect(page.getByLabel('정렬')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '엑셀 업로드' })).toHaveCount(0);
  });

  test('★ A2 — 목록 열은 정확히 12개다 (선택 열 제외)', async ({ page }) => {
    await gotoListFor(page, 'ZZS-E2E-020');
    const headers = page.locator('[data-testid="bom-list"] thead th');
    // 첫 열은 mutation 권한이 있을 때만 붙는 radio 선택 열이다.
    await expect(headers).toHaveText([
      '',
      '상태',
      '상위 SKU',
      '상품명',
      'BOM 유형',
      '버전',
      '적용 시작일',
      '적용 종료일',
      '구성품 수',
      '기준원가',
      '미확정 항목 수',
      '승인자',
      '수정일',
    ]);
  });

  test('★ A3 — BomStatus 7종이 모두 렌더된다 (축약 없음)', async ({ page }) => {
    await gotoListFor(page, 'ZZS-E2E-020');
    const body = await page.locator('[data-testid="bom-list"] tbody').innerText();
    for (const status of [
      'DRAFT',
      'PENDING_APPROVAL',
      'REJECTED',
      'APPROVED',
      'ACTIVE',
      'INACTIVE',
      'ARCHIVED',
    ]) {
      expect(body, status).toContain(status);
    }
  });

  test('★★ A4 — 정상 BOM 은 KRW 금액을 낸다 (VAT 구분 포함)', async ({ page }) => {
    await gotoListFor(page, 'ZZS-E2E-024');
    const row = page.locator('[data-testid="bom-list"] tbody tr').first();
    const cost = await row.locator('td').nth(9).innerText();
    expect(cost).toContain('₩1500');
    expect(cost).toContain('VAT 별도');
    // ⛔ 잠정이 아니다 — 모든 구성품 가격이 확정이다.
    expect(cost).not.toContain('잠정');
  });

  test('★★★ A5 — 순환 BOM 은 `계산 불가` 다 (R8-13)', async ({ page }) => {
    await gotoListFor(page, 'ZZS-E2E-025');
    const cost = await page
      .locator('[data-testid="bom-list"] tbody tr')
      .first()
      .locator('td')
      .nth(9)
      .innerText();

    expect(cost).toContain('계산 불가');
    expect(cost).toContain('순환 구조');
    // ⛔ 무결성 오류를 `—`·`0원`·`잠정` 으로 위장하지 않는다.
    expect(cost).not.toContain('₩0');
    expect(cost).not.toContain('잠정');
  });

  test('★★★ A6 — 손상 1건이 같은 페이지의 정상 행을 죽이지 않는다 (R8-15)', async ({ page }) => {
    // ZZS-E2E-02 로 검색하면 순환(025·026)과 정상(024)이 **한 페이지**에 온다.
    await gotoListFor(page, 'ZZS-E2E-02');
    const rows = page.locator('[data-testid="bom-list"] tbody tr');

    const brokenRow = rows.filter({ hasText: 'ZZS-E2E-025' }).first();
    await expect(brokenRow.locator('td').nth(9)).toContainText('계산 불가');

    // ★ 같은 응답 안의 정상 행은 금액을 그대로 갖는다.
    const healthyRow = rows.filter({ hasText: 'ZZS-E2E-024' }).first();
    await expect(healthyRow.locator('td').nth(9)).toContainText('₩1500');
  });

  test('★ A7 — 필터 7종이 URL 에 반영된다', async ({ page }) => {
    await page.goto('/master/boms');
    await page.getByLabel('상태').selectOption('ACTIVE');
    await expect(page).toHaveURL(/status=ACTIVE/);
    await page.getByLabel('BOM 유형').selectOption('KIT');
    await expect(page).toHaveURL(/bomType=KIT/);
    await page.getByLabel('미확정 수량').selectOption('true');
    await expect(page).toHaveURL(/hasUnknownQty=true/);
  });

  test('★★ A8 — 미지원 파라미터는 조용히 무시되지 않고 400 이 보인다', async ({ page }) => {
    await page.goto('/master/boms?sort=version');
    // ⛔ 화면이 파라미터를 삼켜 정상 목록을 보여 주면 안 된다.
    await expect(page.getByTestId('error-banner')).toBeVisible();
    await expect(page.getByTestId('bom-list')).toHaveCount(0);
  });

  test('★ A9 — 조건에 맞는 BOM 이 없으면 빈 상태를 알린다', async ({ page }) => {
    await page.goto('/master/boms?q=ZZS-NOPE-999');
    await expect(page.getByText('조건에 맞는 BOM 이 없습니다.')).toBeVisible();
  });

  test('★ A10 — 수정일이 채워진다 (audit 파생값)', async ({ page }) => {
    await gotoListFor(page, 'ZZS-E2E-024');
    const modified = await page
      .locator('[data-testid="bom-list"] tbody tr')
      .first()
      .locator('td')
      .last()
      .innerText();
    // audit 이 없는 픽스처는 createdAt 으로 떨어진다 — 어느 쪽이든 `—` 는 아니다.
    expect(modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// B. 상세 — 탭 4개
// ═══════════════════════════════════════════════════════════════

test.describe('B. BOM 상세 (ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
  });

  test('★ B1 — 헤더 사실과 탭 4개가 보인다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-1.0');
    await expect(page.getByRole('heading', { name: /ZZS-E2E-020 · ZZB-1\.0/ })).toBeVisible();
    for (const tab of ['구성품', '전개', '원가', '변경이력']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible();
    }
  });

  test('★★ B2 — ACTIVE 는 읽기전용 배너를 띄우고 편집 컨트롤이 없다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-1.0');
    await expect(page.getByTestId('active-readonly-banner')).toBeVisible();

    // ⛔ 편집 계열은 **렌더되지 않는다** (disabled 가 아니다).
    await expect(page.getByRole('button', { name: '헤더 수정' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '구성품 추가' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '선택 소요량 일괄 확정' })).toHaveCount(0);
    // 사용종료와 버전 복제만 열린다.
    await expect(page.getByRole('button', { name: '사용종료' })).toBeVisible();
  });

  test('★★ B3 — 라인 그리드는 15열이다 (ACTIVE 이므로 작업 열 없음)', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-1.0');
    const headers = page.locator('[data-testid="bom-line-grid"] thead th');
    await expect(headers).toHaveText([
      '순번',
      '구성품 SKU',
      '상품명',
      '소요량',
      '소요량 상태',
      '단위',
      '로스율',
      '실제 필요량',
      '구성품 유형',
      '공급유형',
      '대체그룹',
      '필수',
      '투입창고',
      '입수량',
      '상세사양',
    ]);
  });

  test('★★ B4 — 진행률은 SUGGESTED 를 미확정으로 센다 → "확정 1 / 전체 3"', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-1.0');
    await expect(page.getByTestId('confirm-progress')).toHaveText('확정 1 / 전체 3');
  });

  test('★★ B5 — UNKNOWN 행의 소요량·실제 필요량은 `—` 다 (0 이 아니다)', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-1.0');
    const row = page.getByTestId('line-3');
    await expect(row.locator('td').nth(3)).toHaveText('—');
    await expect(row.locator('td').nth(4)).toHaveText('UNKNOWN');
    await expect(row.locator('td').nth(7)).toHaveText('—');
  });

  test('★★★ B6 — 실제 필요량은 D-19 를 그대로 적용한다 (로스 0 이면 소요량과 같다)', async ({
    page,
  }) => {
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-1.0');
    // quantityPer 2.5 · lossRate 없음 · overallLossRate 없음 → 2.5
    await expect(page.getByTestId('line-1').locator('td').nth(7)).toHaveText('2.5');
    // ★ 0.033333 은 **재정규화되지 않는다** (TC-BOM-009).
    await expect(page.getByTestId('line-2').locator('td').nth(7)).toHaveText('0.033333');
  });

  test('★ B7 — 전개 탭이 트리를 낸다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-1.0');
    await page.getByRole('tab', { name: '전개' }).click();
    await expect(page.getByTestId('explode-tree')).toBeVisible();
    await expect(page.getByLabel('최대 레벨')).toBeVisible();
  });

  test('★★ B8 — 원가 탭은 통화·VAT 별 subtotal 을 내고 단일 총액을 만들지 않는다', async ({
    page,
  }) => {
    await openDetail(page, 'ZZS-E2E-024', 'ZZB-COST-1.0');
    await page.getByRole('tab', { name: '원가' }).click();
    await expect(page.getByTestId('cost-components')).toBeVisible();

    const subtotals = await page.getByTestId('cost-subtotals').innerText();
    expect(subtotals).toContain('KRW');
    expect(subtotals).toContain('1500');
    // ⛔ 전 통화를 합친 단일 총액 행이 없다.
    expect(subtotals).not.toContain('총계');
    expect(subtotals).not.toContain('합계');
  });

  test('★★ B9 — 비중은 같은 bucket 안에서 계산된다 → 단일 구성품이면 100%', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-024', 'ZZB-COST-1.0');
    await page.getByRole('tab', { name: '원가' }).click();
    const row = page.locator('[data-testid="cost-components"] tbody tr').first();
    await expect(row.locator('td').nth(7)).toHaveText('100%');
  });

  test('★★★ B10 — 단건 원가는 strict 다: 순환이면 배너로 오류를 보여 준다 (R8-2)', async ({
    page,
  }) => {
    await openDetail(page, 'ZZS-E2E-025', 'ZZB-CYC-A');
    await page.getByRole('tab', { name: '원가' }).click();

    await expect(page.getByTestId('error-banner')).toBeVisible();
    // ⛔ 상세에서 `계산 불가` 로 삼키지 않는다 — 목록과 정책이 다르다.
    await expect(page.getByTestId('cost-components')).toHaveCount(0);
  });

  test('★ B11 — 변경이력 탭이 타임라인을 낸다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-1.0');
    await page.getByRole('tab', { name: '변경이력' }).click();
    await expect(page.getByTestId('history-timeline')).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════
// C. 편집 — DRAFT 에서만
// ═══════════════════════════════════════════════════════════════

test.describe('C. BOM 편집 (ADMIN · DRAFT)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
  });

  test('★★ C1 — DRAFT 는 편집 컨트롤과 작업 열이 보인다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');
    await expect(page.getByRole('button', { name: '헤더 수정' })).toBeVisible();
    await expect(page.getByRole('button', { name: '구성품 추가' })).toBeVisible();
    await expect(page.getByRole('button', { name: '선택 소요량 일괄 확정' })).toBeVisible();
    await expect(page.getByRole('button', { name: '승인 요청' })).toBeVisible();

    const headers = page.locator('[data-testid="bom-line-grid"] thead th');
    await expect(headers).toHaveCount(16); // 15열 + 작업 열
    await expect(headers.last()).toHaveText('작업');
  });

  test('★★★ C2 — 입수량 30 이면 `1/30 = 0.033333` 을 **추천만** 한다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');
    const suggest = page.getByRole('button', { name: '추천 0.033333' });
    await expect(suggest).toBeVisible();

    // ⛔ 자동 저장이 아니다 — 누르기 전에는 입력이 비어 있다.
    const input = page.getByLabel('1 소요량');
    await expect(input).toHaveValue('');
    await suggest.click();
    await expect(input).toHaveValue('0.033333');
  });

  test('★★★ C3 — 일괄 확정이 성공하고 진행률이 갱신된다 (top-level 배열 계약)', async ({
    page,
  }) => {
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');
    await expect(page.getByTestId('confirm-progress')).toHaveText('확정 0 / 전체 1');

    await page.getByLabel('1 소요량').fill('2');
    await page.getByRole('button', { name: '선택 소요량 일괄 확정' }).click();

    await expect(page.getByTestId('confirm-progress')).toHaveText('확정 1 / 전체 1');
    await expect(page.getByTestId('line-1').locator('td').nth(4)).toHaveText('CONFIRMED');
  });

  test('★★ C4 — 구성품을 추가하면 그리드에 나타난다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');
    await page.getByRole('button', { name: '구성품 추가' }).click();

    const dialog = page.getByRole('dialog', { name: '구성품 추가' });
    await expect(dialog).toBeVisible();

    // ★ 구성품은 SKU 검색으로만 고른다 — ⛔ UUID 자유 입력 없음.
    await dialog.getByLabel('구성품 SKU 검색어').fill('ZZS-E2E-021');
    await dialog.getByRole('button', { name: '검색' }).click();
    await dialog.getByLabel('구성품 SKU 선택').selectOption({ index: 0 });

    await dialog.getByLabel('소요량').fill('5');
    await dialog.getByLabel('소요량 상태').selectOption('CONFIRMED');
    await dialog.getByRole('button', { name: '저장' }).click();

    await expect(page.getByTestId('line-2')).toBeVisible();
    await expect(page.getByTestId('line-2').locator('td').nth(1)).toHaveText('ZZS-E2E-021');
  });

  test('★★ C5 — 라인을 수정하면 값이 반영된다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');
    await page.getByTestId('line-2').getByLabel('2 수정').click();

    const dialog = page.getByRole('dialog', { name: '구성품 수정' });
    await dialog.getByLabel('소요량').fill('7');
    await dialog.getByLabel('로스율').fill('0.1');
    await dialog.getByRole('button', { name: '저장' }).click();

    await expect(page.getByTestId('line-2').locator('td').nth(3)).toHaveValue('7');
    // 실제 필요량 = 7 × 1.1 = 7.7
    await expect(page.getByTestId('line-2').locator('td').nth(7)).toHaveText('7.7');
  });

  test('★★ C6 — 라인을 삭제하면 그리드에서 사라진다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');
    page.once('dialog', (confirm) => void confirm.accept());
    await page.getByTestId('line-2').getByLabel('2 삭제').click();

    await expect(page.getByTestId('line-2')).toHaveCount(0);
    await expect(page.getByTestId('line-1')).toBeVisible();
  });

  test('★★ C7 — 삭제된 라인의 이력은 변경이력에 남는다 (U8-2)', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');
    await page.getByRole('tab', { name: '변경이력' }).click();

    const timeline = page.getByTestId('history-timeline');
    await expect(timeline).toContainText('BomLine');
    await expect(timeline).toContainText('DELETE');
  });

  test('★★ C8 — 헤더를 수정하면 상단 사실이 갱신된다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');
    await page.getByRole('button', { name: '헤더 수정' }).click();

    const dialog = page.getByRole('dialog', { name: '헤더 수정' });
    // ⛔ 상위 SKU·버전 입력이 아예 없다 (D-14).
    await expect(dialog.getByLabel('상위 SKU 검색어')).toHaveCount(0);
    await expect(dialog.getByLabel('버전')).toHaveCount(0);

    await dialog.getByLabel('기준수량').fill('10');
    await dialog.getByLabel('헤더 변경사유').fill('E2E 헤더 수정');
    await dialog.getByRole('button', { name: '저장' }).click();

    await expect(page.getByTestId('bom-meta-기준수량')).toHaveText('10');
    await expect(page.getByTestId('bom-meta-변경사유')).toHaveText('E2E 헤더 수정');
  });

  test('★★★ C9 — 버전 복제는 새 DRAFT 를 만들고 그 상세로 이동한다', async ({ page }) => {
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');
    const newVersion = `ZZB-CL-${unique()}`;

    await page.getByRole('button', { name: '버전 복제' }).click();
    const dialog = page.getByRole('dialog', { name: '버전 복제' });
    await dialog.getByLabel('새 버전').fill(newVersion);
    await dialog.getByLabel('복제 적용 시작일').fill('2035-01-01');
    await dialog.getByLabel('변경사유').fill('E2E 복제');
    await dialog.getByRole('button', { name: '복제' }).click();

    await expect(page.getByRole('heading', { name: new RegExp(newVersion) })).toBeVisible();
    await expect(page.getByTestId('bom-meta-상태')).toHaveText('DRAFT');
    // ★ 구성품이 함께 복사된다.
    await expect(page.getByTestId('line-1')).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════
// D. 권한
// ═══════════════════════════════════════════════════════════════

test.describe('D. 권한', () => {
  test('★★ D1 — EXECUTIVE 는 목록을 읽지만 mutation 컨트롤이 없다', async ({ page }) => {
    await login(page, EXEC);
    await gotoListFor(page, 'ZZS-E2E-020');

    // ⛔ 렌더되지 않는다 — disabled 로 남기지 않는다.
    for (const label of ['신규', '복사', '승인 요청', '승인', '활성화']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    }
    // 선택 radio 열도 없다.
    await expect(page.locator('[data-testid="bom-list"] thead th')).toHaveCount(12);
  });

  test('★★ D2 — EXECUTIVE 는 상세에서도 편집·승인 컨트롤이 없다', async ({ page }) => {
    await login(page, EXEC);
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-1.0');
    for (const label of [
      '헤더 수정',
      '구성품 추가',
      '승인 요청',
      '승인',
      '사용종료',
      '버전 복제',
    ]) {
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    }
    // 읽기는 된다.
    await expect(page.getByTestId('bom-line-grid')).toBeVisible();
  });

  test('★★ D3 — SCM_STAFF 는 편집·제출은 되지만 승인 계열이 없다', async ({ page }) => {
    await login(page, STAFF);
    await openDetail(page, 'ZZS-E2E-027', 'ZZB-EDIT-1.0');

    await expect(page.getByRole('button', { name: '구성품 추가' })).toBeVisible();
    await expect(page.getByRole('button', { name: '승인 요청' })).toBeVisible();
    // ⛔ `bom.approve` 가 없으므로 보관 버튼도 없다.
    await expect(page.getByRole('button', { name: '보관', exact: true })).toHaveCount(0);
  });

  test('★★ D4 — SCM_STAFF 는 PENDING_APPROVAL 에서 승인 버튼을 보지 못한다', async ({ page }) => {
    await login(page, STAFF);
    await openDetail(page, 'ZZS-E2E-020', 'ZZB-4.0');
    await expect(page.getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '반려', exact: true })).toHaveCount(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// E. SKU 상세 ⑦탭 → BOM 관리 링크 (D-30 항목 3)
// ═══════════════════════════════════════════════════════════════

test.describe('E. SKU BOM 탭 연결', () => {
  test('★★ E1 — SKU ⑦탭에서 BOM 관리 화면으로 이동한다', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/master/skus?q=ZZS-E2E-020');
    await page.getByRole('link', { name: 'ZZS-E2E-020' }).first().click();
    await page.getByRole('tab', { name: 'BOM' }).click();

    const link = page.getByTestId('bom-tab-manage-link').first();
    await expect(link).toBeVisible();
    await link.click();

    // T07-8 상세로 착지한다 — ⛔ 더 이상 404 가 아니다.
    await expect(page).toHaveURL(/\/master\/boms\/[0-9a-f-]{36}/);
    await expect(page.getByRole('tab', { name: '구성품' })).toBeVisible();
  });
});
